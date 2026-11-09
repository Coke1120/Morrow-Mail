const { failure } = require("./validate");

// Byte ceilings are serialized UTF-8 sizes, not tokenizer estimates. The
// separately reported provider-token ceiling and output/call/time guards remain.
const LIMITS = Object.freeze({ messages: 1000, threads: 200, calls: 32, sourceBytes: 512000, inputBytes: 512000, inputTokens: 128000,
  outputTokens: 32000, requestBytes: 16000, outputPerCall: 4096, chunkBytes: 12000,
  requestMs: 120000, jobMs: 600000 });
const kinds = new Set(["source-bytes", "metadata-bytes", "focus-bytes", "request-bytes", "planned-input-bytes",
  "chunk-count", "call-count", "input-bytes", "input-tokens", "output-tokens", "duration-ms", "consolidation-bytes"]);

function budget(kind, actual, limit) {
  return Object.assign(failure("timeline-budget"), { budget: { kind, actual, limit } });
}
// Only fixed labels and bounded counts may cross IPC. Never forward provider text,
// validation paths, addresses, prompts, URLs or credentials as diagnostic details.
function budgetDetails(error) {
  const value = error?.budget;
  if (error?.code !== "timeline-budget" || !kinds.has(value?.kind)
      || !Number.isSafeInteger(value.actual) || value.actual < 0
      || !Number.isSafeInteger(value.limit) || value.limit < 0) return undefined;
  return { kind: value.kind, actual: value.actual, limit: value.limit };
}

module.exports = { LIMITS, budget, budgetDetails };
