const { RESOURCE, getAuth } = require("./chatgpt-auth");
const { providerError } = require("./chatgpt-errors");

function createResponses({ auth = getAuth(), fetcher = (...args) => fetch(...args), now = Date.now } = {}) {
  const catalogs = new Map();
  async function send(lease, path, options = {}) {
    lease.check();
    let response;
    try {
      response = await fetcher(`${RESOURCE}${path}`, { ...options, redirect: "error",
        headers: { ...options.headers, authorization: `Bearer ${lease.token}` },
        signal: AbortSignal.any([lease.signal, AbortSignal.timeout(120000)]),
      });
    } catch {
      lease.check();
      throw new Error("ChatGPT connection was interrupted. Retry when ready; no other provider was used.");
    }
    lease.check();
    if (!response.ok) {
      let payload;
      try { payload = await response.json(); } catch { payload = null; }
      const error = providerError(payload, response.status, response.headers.get("openai-request-id") || response.headers.get("x-request-id"));
      if (error.code === "subscription_sharing_usage_limit_exceeded") lease.pause();
      throw error;
    }
    return response;
  }

  async function catalog(lease, force = false) {
    const cached = catalogs.get(lease.id);
    if (!force && cached && now() - cached.at < 5 * 60 * 1000) return cached.rows;
    const response = await send(lease, "/models");
    let payload;
    try { payload = await response.json(); } catch { throw new Error("ChatGPT returned an invalid model catalog. Retry later."); }
    lease.check();
    if (!Array.isArray(payload.models)) throw new Error("ChatGPT returned an invalid model catalog. Retry later.");
    const rows = [];
    for (const row of payload.models) {
      if (row?.visibility !== "list" || typeof row.slug !== "string" || !row.slug || rows.some(r => r.id === row.slug)) continue;
      rows.push({ id: row.slug, name: typeof row.display_name === "string" ? row.display_name : row.slug });
    }
    catalogs.set(lease.id, { at: now(), rows });
    return rows;
  }

  async function listModels(options = {}) {
    let lease;
    try {
      lease = await auth.lease(options);
      const rows = await catalog(lease, true);
      return { ok: true, models: rows.map(row => row.id), choices: rows };
    } catch (error) { return { ok: false, message: error.message }; }
    finally { lease?.release(); }
  }

  async function stream(messages, onChunk, options = {}) {
    const lease = await auth.lease(options);
    let reader;
    try {
      const rows = await catalog(lease);
      if (!options.model || !rows.some(row => row.id === options.model)) throw new Error("Fetch ChatGPT models in AI settings and choose one available to this account.");
      const input = [];
      for (const message of messages) {
        if (!["system", "developer", "user", "assistant"].includes(message.role) || typeof message.content !== "string") throw new Error("This ChatGPT adapter supports text messages only.");
        input.push({ role: message.role === "system" ? "developer" : message.role, content: message.content });
      }
      const response = await send(lease, "/responses", {
        method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ model: options.model, input, store: false, stream: true }),
      });
      if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("ChatGPT returned an invalid or empty event stream.");
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let completed = false;
      const event = (frame) => {
        const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (!data || data === "[DONE]") return;
        let payload;
        try { payload = JSON.parse(data); } catch { throw new Error("ChatGPT returned a malformed stream event."); }
        lease.check();
        if (payload.type === "response.failed" || payload.type === "error") {
          const error = providerError(payload.response || payload, response.status, response.headers.get("openai-request-id") || response.headers.get("x-request-id"));
          if (error.code === "subscription_sharing_usage_limit_exceeded") lease.pause();
          throw error;
        }
        if (payload.type === "response.incomplete") throw new Error("ChatGPT response was incomplete. Retry when ready.");
        if (payload.type === "response.output_text.delta" && typeof payload.delta === "string") onChunk(payload.delta);
        if (payload.type === "response.refusal.delta") throw new Error("ChatGPT declined this request.");
        if (payload.type === "response.completed") {
          if (payload.response?.status && payload.response.status !== "completed") throw new Error("ChatGPT response did not complete successfully.");
          completed = true;
        }
      };
      while (!completed) {
        const part = await reader.read();
        lease.check();
        buffer += decoder.decode(part.value || new Uint8Array(), { stream: !part.done });
        buffer = buffer.replace(/\r\n/g, "\n"); // CR/LF may be split across transport chunks
        if (buffer.length > 2 * 1024 * 1024) throw new Error("ChatGPT stream event exceeded the local size limit.");
        let split;
        while ((split = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          event(frame);
          if (completed) break;
        }
        if (part.done) {
          if (buffer.trim()) event(buffer);
          if (!completed) throw new Error("ChatGPT stream ended without a completed response. Retry when ready.");
        }
      }
      lease.check();
    } finally {
      if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      lease.release();
    }
  }

  async function complete(messages, options = {}) {
    let output = "";
    await stream(messages, piece => { output += piece; }, options);
    return output;
  }
  return { complete, stream, listModels };
}

let instance;
module.exports = { createResponses, getResponses: () => instance || (instance = createResponses()) };
