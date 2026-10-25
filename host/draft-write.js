const { BrowserWindow } = require("electron");
const { stream, complete, extractJson } = require("./openai-client");
const { writingBrief } = require("./brain");

const active = new Map();

function emit(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send("aiDraftWrite:event", payload);
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function ok(data) {
  return { success: true, data };
}

function fail(error) {
  return {
    success: false,
    error: { message: error instanceof Error ? error.message : String(error) },
  };
}

function originalEmailText(email, limit) {
  const from = email && email.from ? email.from : "";
  const subject = email && email.subject ? email.subject : "";
  const body = String((email && (email.text_body || email.textBody || email.snippet)) || "");
  const text = `From: ${from}\nSubject: ${subject}\n${body}`.trim();
  const cap = limit > 0 ? limit : 1500;
  return text.length > cap ? text.slice(0, cap) : text;
}

function instructionFrom(body) {
  const raw = body && typeof body === "object" ? body : {};
  const reply = raw.mode === "reply";
  const lines = [];
  if (raw.mode) lines.push(`Mode: ${raw.mode}`);
  if (raw.user_prompt) lines.push(`Instruction: ${raw.user_prompt}`);
  if (raw.user_selection_text) lines.push(`Selected text: ${raw.user_selection_text}`);
  if (raw.existing_draft_content) lines.push(`Current draft: ${String(raw.existing_draft_content).slice(0, 4000)}`);
  if (raw.text_before_cursor) lines.push(`Text before cursor: ${String(raw.text_before_cursor).slice(0, 2000)}`);
  if (raw.text_after_cursor) lines.push(`Text after cursor: ${String(raw.text_after_cursor).slice(0, 2000)}`);
  if (raw.subject) lines.push(`Subject: ${raw.subject}`);
  if (Array.isArray(raw.chat_history) && raw.chat_history.length) {
    lines.push(`History: ${JSON.stringify(raw.chat_history).slice(0, 2000)}`);
  }
  const email = raw.email || raw.originalEmail || raw.original_email;
  if (email && typeof email === "object") {
    if (reply) lines.push(`Original email:\n${originalEmailText(email, 8000)}`);
    else {
      lines.push(`Email: ${JSON.stringify({
        subject: email.subject || "",
        from: email.from || "",
        snippet: email.snippet || email.text_body || "",
      }).slice(0, 2000)}`);
    }
  }
  const text = lines.length ? lines.join("\n") : JSON.stringify(raw);
  const cap = reply ? 14000 : 8000;
  return text.length > cap ? text.slice(0, cap) : text;
}

function systemPrompt(body) {
  const raw = body && typeof body === "object" ? body : {};
  const reply = raw.mode === "reply";
  const rules = writingBrief();
  return [
    "You draft email. Reply with the message body only, in plain sentences.",
    "No subject line, no markdown fences, no XML tags.",
    reply
      ? "Write a comprehensive reply to the original email. Address the points it raises. Do not quote the original message. Follow the instruction for tone and what to cover."
      : "",
    rules ? `Follow these writing rules:\n${rules}` : "",
  ].filter(Boolean).join(" ");
}

function draftRequest(body) {
  return { system: systemPrompt(body), user: instructionFrom(body) };
}

async function startDraft(params) {
  const reqId = params && params.reqId;
  if (!reqId) return fail(new Error("Missing reqId"));
  const controller = new AbortController();
  active.set(reqId, controller);
  setImmediate(() => {
    runDraft(reqId, params.body, controller.signal).catch(() => {});
  });
  return ok({ reqId });
}

async function runDraft(reqId, body, signal) {
  let plain = "";
  try {
    const request = draftRequest(body);
    await stream([
      { role: "system", content: request.system },
      { role: "user", content: request.user },
    ], (piece) => {
      plain += piece;
      emit({ reqId, type: "chunk", data: escapeHtml(piece).replace(/\n/g, "<br>") });
    }, { signal });
    if (!plain.trim()) {
      emit({ reqId, type: "error", message: "The model returned an empty draft." });
      return;
    }
    emit({ reqId, type: "done" });
  } catch (error) {
    if (signal.aborted) return;
    emit({ reqId, type: "error", message: error instanceof Error ? error.message : String(error) });
  } finally {
    active.delete(reqId);
  }
}

async function suggestions(params) {
  if (params?.source === "compose-open" && !require("./ai-context").isBackground()) return require("./ai-context").background(() => suggestions(params));
  try {
    const email = params && params.email ? params.email : {};
    const text = await complete([
      {
        role: "system",
        content: "Suggest three short reply prompts for this email. Reply with JSON only: {\"suggestions\":[string,string,string]}.",
      },
      {
        role: "user",
        content: JSON.stringify({
          subject: email.subject || "",
          from: email.from || "",
          snippet: email.snippet || email.text_body || "",
        }),
      },
    ]);
    const parsed = extractJson(text);
    const list = Array.isArray(parsed.suggestions) ? parsed.suggestions.map((item) => String(item)).slice(0, 4) : [];
    return ok({ suggestions: list });
  } catch (error) {
    return fail(error);
  }
}

function answer(channel, args) {
  const params = args && args.length ? args[0] : undefined;
  switch (channel) {
    case "aiDraftWrite:start":
      if (!params || !params.reqId) return fail(new Error("Missing reqId"));
      return startDraft(params);
    case "aiDraftWrite:cancel": {
      const controller = active.get(params && params.reqId);
      if (controller) controller.abort();
      return ok(true);
    }
    case "aiDraftWrite:replySuggestions":
      return suggestions(params);
    default:
      return undefined;
  }
}

module.exports = { answer: (...args) => require("./ai-context").operation(() => answer(...args)), escapeHtml, draftRequest };
