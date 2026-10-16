const { BrowserWindow } = require("electron");
const { complete, extractJson } = require("./openai-client");

const active = new Map();

function emit(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send("mail:translate:event", payload);
  }
}

function ok(data) {
  return { success: true, data };
}

function answer(channel, args) {
  const params = args && args.length ? args[0] : undefined;
  switch (channel) {
    case "mail:translateStart":
      return startTranslate(params);
    case "mail:translateCancel": {
      const controller = active.get(params && params.reqId);
      if (controller) controller.abort();
      return ok(true);
    }
    default:
      return undefined;
  }
}

function startTranslate(params) {
  const reqId = params && params.reqId;
  if (!reqId) return { success: false, error: { message: "Missing reqId" } };
  const nodes = params && Array.isArray(params.nodes) ? params.nodes : [];
  if (nodes.length === 0) {
    emit({ reqId, type: "done" });
    return ok({ reqId });
  }
  const controller = new AbortController();
  active.set(reqId, controller);
  emit({ reqId, type: "progress", percent: 0, current: 0, total: nodes.length });
  setImmediate(() => {
    runTranslate(reqId, params, controller.signal).catch(() => {});
  });
  return ok({ reqId });
}

async function runTranslate(reqId, params, signal) {
  const nodes = params.nodes || [];
  try {
    const target = params.targetLanguage || "English";
    const text = await complete([
      {
        role: "system",
        content: `Translate each node into ${target}. Reply with JSON only: {"translations":[{"node_id":string,"text":string}]}. Keep every node_id unchanged.`,
      },
      {
        role: "user",
        content: JSON.stringify(nodes.map((node) => ({
          node_id: node.node_id,
          text: String(node.text || "").slice(0, 2000),
        }))),
      },
    ], { signal, temperature: 0.2 });
    if (signal.aborted) return;
    const parsed = extractJson(text);
    const rows = Array.isArray(parsed.translations) ? parsed.translations : [];
    const byId = new Map(rows.map((row) => [row.node_id, String(row.text || "")]));
    nodes.forEach((node, index) => {
      const translated = byId.get(node.node_id);
      const found = typeof translated === "string" && translated.length > 0;
      emit({
        reqId,
        type: "node",
        nodeId: node.node_id,
        translatedText: found ? translated : "",
        status: found ? "success" : "error",
        ...(found ? {} : { error: "The model omitted this segment." }),
      });
      emit({
        reqId,
        type: "progress",
        percent: Math.round(((index + 1) / nodes.length) * 100),
        current: index + 1,
        total: nodes.length,
      });
    });
    emit({ reqId, type: "done" });
  } catch (error) {
    if (signal.aborted) return;
    emit({
      reqId,
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    active.delete(reqId);
  }
}

module.exports = { answer };
