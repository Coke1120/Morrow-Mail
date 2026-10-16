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

function instructionFrom(body) {
  const raw = body && typeof body === "object" ? body : {};
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
    lines.push(`Email: ${JSON.stringify({
      subject: email.subject || "",
      from: email.from || "",
      snippet: email.snippet || email.text_body || "",
    }).slice(0, 2000)}`);
  }
  const text = lines.length ? lines.join("\n") : JSON.stringify(raw);
  return text.length > 8000 ? text.slice(0, 8000) : text;
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
    const rules = writingBrief();
    await stream([
      {
        role: "system",
        content: [
          "You draft email. Reply with the message body only, in plain sentences.",
          "No subject line, no markdown fences, no XML tags.",
          rules ? `Follow these writing rules:\n${rules}` : "",
        ].filter(Boolean).join(" "),
      },
      { role: "user", content: instructionFrom(body) },
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

module.exports = { answer, escapeHtml };
