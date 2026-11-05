// Error bodies are untrusted diagnostics, not application data. Native Fetch
// streams are bounded before allocation; the text fallback supports test adapters.
const MAX_BYTES = 16 * 1024;
const READ_MS = 1500;

async function errorJson(response, signal) {
  let reader, timer, abort;
  try {
    if (signal?.aborted || Number(response.headers?.get?.("content-length")) > MAX_BYTES) return null;
    const stopped = new Promise(resolve => {
      timer = setTimeout(() => resolve(null), READ_MS);
      abort = () => resolve(null);
      signal?.addEventListener("abort", abort, { once: true });
    });
    const reading = (async () => {
      let text;
      if (response.body?.getReader) {
        reader = response.body.getReader();
        const chunks = [];
        let length = 0;
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          if (!(part.value instanceof Uint8Array) || (length += part.value.byteLength) > MAX_BYTES) return null;
          chunks.push(Buffer.from(part.value));
        }
        text = Buffer.concat(chunks, length).toString("utf8");
      } else {
        text = typeof response.text === "function" ? await response.text() : "";
        if (typeof text !== "string" || Buffer.byteLength(text) > MAX_BYTES) return null;
      }
      try { return JSON.parse(text); } catch { return null; }
    })();
    return await Promise.race([reading, stopped]);
  } catch { return null; }
  finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
    try { reader?.cancel().catch(() => {}); } catch { /* no provider errors escape */ }
    try { reader?.releaseLock(); } catch { /* cancellation can still be settling */ }
  }
}

module.exports = { errorJson, MAX_BYTES, READ_MS };
