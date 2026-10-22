const { complete, extractJson } = require("./openai-client");
const translateLang = require("../shared/translate-lang");

const SEGMENT_CHARS = 1600;
const BATCH_CHARS = 3200;
const active = new Map();

function emit(payload) {
  try {
    const electron = require("electron");
    const BrowserWindow = electron && electron.BrowserWindow;
    if (BrowserWindow && typeof BrowserWindow.getAllWindows === "function") {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) continue;
        win.webContents.send("mail:translate:event", payload);
      }
    }
  } catch { /* plain Node checks have no BrowserWindow */ }
  try {
    require("./translate-window").note(payload);
  } catch { /* the window host is optional for a unit check */ }
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
  setImmediate(() => {
    runTranslate(reqId, params, controller.signal).catch(() => {});
  });
  return ok({ reqId });
}

function isAbort(error, signal) {
  if (signal && signal.aborted) return true;
  if (!error) return false;
  return error.name === "AbortError" || error.code === "aborted";
}

function abortError() {
  const error = new Error("Translation cancelled.");
  error.code = "aborted";
  return error;
}

function isFatal(error) {
  if (!error) return false;
  if (error.code === "ai-unconfigured") return true;
  return /API key/i.test(String(error.message || ""));
}

function breakAt(rest, cap, token) {
  const at = rest.lastIndexOf(token, cap - token.length);
  if (at < Math.floor(cap * 0.4)) return -1;
  return at + token.length;
}

function splitSegment(text, limit) {
  const source = String(text || "");
  const cap = Math.max(1, Number(limit) || SEGMENT_CHARS);
  if (!source) return [];
  if (source.length <= cap) return [source];
  const parts = [];
  let rest = source;
  while (rest.length > cap) {
    let cut = breakAt(rest, cap, "\n\n");
    if (cut < 1) cut = breakAt(rest, cap, "\n");
    if (cut < 1) cut = breakAt(rest, cap, " ");
    if (cut < 1 || cut > rest.length) cut = Math.min(cap, rest.length);
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) parts.push(rest);
  return parts;
}

function planTranslate(nodes) {
  const pieces = [];
  const list = Array.isArray(nodes) ? nodes : [];
  for (const node of list) {
    const id = node && node.node_id ? String(node.node_id) : "";
    const text = String((node && node.text) || "");
    if (!id || !text) continue;
    splitSegment(text, SEGMENT_CHARS).forEach((chunk, index) => {
      pieces.push({ node_id: id + "#" + index, parent_id: id, text: chunk });
    });
  }
  const batches = [];
  let batch = [];
  let size = 0;
  for (const piece of pieces) {
    if (batch.length && size + piece.text.length > BATCH_CHARS) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(piece);
    size += piece.text.length;
  }
  if (batch.length) batches.push(batch);
  return { pieces: pieces, batches: batches };
}

function systemPrompt(target) {
  return `Translate each node into ${target}. Reply with JSON only: {"translations":[{"node_id":string,"text":string}]}. Keep every node_id unchanged.`;
}

async function translateSegments(nodes, options) {
  const opts = options || {};
  const completeFn = typeof opts.complete === "function" ? opts.complete : complete;
  const signal = opts.signal;
  const target = translateLang.instruction(opts.targetLanguage);
  const list = Array.isArray(nodes) ? nodes : [];
  const plan = planTranslate(list);
  const plannedIds = new Set(plan.pieces.map((piece) => piece.node_id));
  const byParent = new Map();
  for (const piece of plan.pieces) {
    if (!byParent.has(piece.parent_id)) byParent.set(piece.parent_id, []);
    byParent.get(piece.parent_id).push(piece);
  }
  const pieceText = new Map();
  const total = plan.pieces.length;
  let finished = 0;

  function bump(count) {
    if (!count) return;
    finished += count;
    if (typeof opts.onPiece === "function") opts.onPiece(finished, total);
  }

  if (typeof opts.onPiece === "function") opts.onPiece(0, total);
  if (!plan.pieces.length) {
    return list.map((node) => ({ node_id: node.node_id, text: "" }));
  }

  async function translateBatch(batch, depth) {
    if (signal && signal.aborted) throw abortError();
    let raw;
    try {
      raw = await completeFn([
        { role: "system", content: systemPrompt(target) },
        {
          role: "user",
          content: JSON.stringify(batch.map((piece) => ({ node_id: piece.node_id, text: piece.text }))),
        },
      ], { signal: signal, temperature: 0.2, max_tokens: 4096 });
    } catch (error) {
      if (isAbort(error, signal) || isFatal(error)) throw isAbort(error, signal) ? abortError() : error;
      throw error;
    }
    if (signal && signal.aborted) throw abortError();
    let parsed;
    try {
      parsed = extractJson(String(raw || ""));
    } catch (error) {
      return recover(batch, depth, error);
    }
    const rows = parsed && Array.isArray(parsed.translations) ? parsed.translations : null;
    if (!rows) return recover(batch, depth, new Error("The model omitted this segment."));
    const byId = new Map();
    for (const row of rows) {
      if (row && typeof row.node_id === "string") byId.set(row.node_id, typeof row.text === "string" ? row.text : "");
    }
    const missing = batch.some((piece) => piece.text && !byId.get(piece.node_id));
    if (missing) return recover(batch, depth, new Error("The model omitted this segment."));
    const out = batch.map((piece) => ({
      node_id: piece.node_id,
      parent_id: piece.parent_id,
      text: piece.text ? byId.get(piece.node_id) : "",
    }));
    let planned = 0;
    for (const piece of batch) if (plannedIds.has(piece.node_id)) planned += 1;
    bump(planned);
    return out;
  }

  async function recover(batch, depth, error) {
    if (isFatal(error) || isAbort(error, signal)) throw error;
    if (batch.length > 1) {
      const mid = Math.floor(batch.length / 2);
      const left = await translateBatch(batch.slice(0, mid), depth + 1);
      const right = await translateBatch(batch.slice(mid), depth + 1);
      return left.concat(right);
    }
    const piece = batch[0];
    if (depth < 6 && piece && piece.text.length > 1) {
      const smaller = splitSegment(piece.text, Math.max(1, Math.floor(piece.text.length / 2)));
      const shrinks = smaller.length > 1 && smaller.every((part) => part.length < piece.text.length);
      if (shrinks) {
        const children = smaller.map((part, index) => ({
          node_id: piece.node_id + "." + index,
          parent_id: piece.parent_id,
          text: part,
        }));
        const rows = await translateBatch(children, depth + 1);
        bump(plannedIds.has(piece.node_id) ? 1 : 0);
        return [{
          node_id: piece.node_id,
          parent_id: piece.parent_id,
          text: rows.map((row) => row.text).join(""),
        }];
      }
    }
    throw error instanceof Error ? error : new Error("The model omitted this segment.");
  }

  for (const batch of plan.batches) {
    const rows = await translateBatch(batch, 0);
    for (const row of rows) pieceText.set(row.node_id, row.text);
  }
  return list.filter((node) => node && node.node_id).map((node) => {
    const pieces = byParent.get(String(node.node_id)) || [];
    return {
      node_id: node.node_id,
      text: pieces.map((piece) => pieceText.get(piece.node_id) || "").join(""),
    };
  });
}

async function runTranslate(reqId, params, signal) {
  const nodes = params.nodes || [];
  try {
    const results = await translateSegments(nodes, {
      targetLanguage: params.targetLanguage,
      signal: signal,
      onPiece(current, total) {
        emit({
          reqId: reqId,
          type: "progress",
          percent: total ? Math.round((current / total) * 100) : 0,
          current: current,
          total: total,
        });
      },
    });
    if (signal.aborted) {
      emit({ reqId: reqId, type: "error", message: "Translation cancelled." });
      return;
    }
    for (const row of results) {
      emit({
        reqId: reqId,
        type: "node",
        nodeId: row.node_id,
        translatedText: row.text,
        status: "success",
      });
    }
    emit({ reqId: reqId, type: "done" });
  } catch (error) {
    if (isAbort(error, signal)) {
      emit({ reqId: reqId, type: "error", message: "Translation cancelled." });
      return;
    }
    emit({
      reqId: reqId,
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    active.delete(reqId);
  }
}

module.exports = {
  answer: answer,
  splitSegment: splitSegment,
  planTranslate: planTranslate,
  translateSegments: translateSegments,
  SEGMENT_CHARS: SEGMENT_CHARS,
  BATCH_CHARS: BATCH_CHARS,
};
