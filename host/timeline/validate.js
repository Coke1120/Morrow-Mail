const Ajv = require("ajv/dist/2020");
const formats = require("ajv-formats");
const schema = require("../../shared/timeline-schema/1.0.0.schema.json");
const caseSchema = require("../../shared/timeline-schema/1.1.0.schema.json");

const MAX_BYTES = 2 * 1024 * 1024;
const ajv = new Ajv({ strict: true, allErrors: true, validateFormats: true });
formats(ajv);
const documentCheck = ajv.compile(schema);
const caseDocumentCheck = ajv.compile(caseSchema);
const documentChecks = new Map([["1.0.0", documentCheck], ["1.1.0", caseDocumentCheck]]);
const caseReportCheck = ajv.compile({ $ref: "urn:morrow-mail:timeline:1.1.0#/$defs/case_report" });
const metadataCheck = ajv.compile({ $ref: "urn:morrow-mail:timeline:1.0.0#/$defs/event" });
const semanticText = schema.$defs.text;
const candidateCheck = ajv.compile({
  type: "object", additionalProperties: false, required: ["events"],
  properties: { events: { type: "array", minItems: 1, maxItems: 1000, items: {
    type: "object", additionalProperties: false, required: ["source_token", "summary", "open_actions", "unclear"],
    properties: {
      source_token: { type: "string", minLength: 1, maxLength: 100 }, summary: semanticText,
      open_actions: { type: "array", maxItems: 25, items: semanticText },
      unclear: { type: "array", maxItems: 25, items: semanticText },
    },
  } } },
});

function failure(code = "timeline-validation", paths = []) {
  return Object.assign(new Error(code), { code, paths: paths.slice(0, 8) });
}

function parseJson(input) {
  let text;
  try {
    text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch { throw failure(); }
  if (Buffer.byteLength(text) > MAX_BYTES) throw failure("timeline-size");
  let position = 0;
  function whitespace() { while (/\s/.test(text[position] || "") && position < text.length) position++; }
  function string() {
    const start = position++;
    while (position < text.length) {
      const character = text[position++];
      if (character === "\\") position++;
      else if (character === '"') return JSON.parse(text.slice(start, position));
    }
    throw failure();
  }
  function value(depth) {
    if (depth > 16) throw failure("timeline-depth");
    whitespace();
    const character = text[position];
    if (character === '"') { string(); return; }
    if (character === "{" || character === "[") {
      const object = character === "{";
      const end = object ? "}" : "]";
      const keys = new Set();
      position++;
      whitespace();
      if (text[position] === end) { position++; return; }
      while (position < text.length) {
        if (object) {
          if (text[position] !== '"') throw failure();
          const key = string();
          if (keys.has(key)) throw failure("timeline-duplicate-key");
          keys.add(key);
          whitespace();
          if (text[position++] !== ":") throw failure();
        }
        value(depth + 1);
        whitespace();
        if (text[position] === end) { position++; return; }
        if (text[position++] !== ",") throw failure();
        whitespace();
      }
      throw failure();
    }
    const start = position;
    while (position < text.length && !/[\s,}\]]/.test(text[position])) position++;
    if (start === position) throw failure();
    JSON.parse(text.slice(start, position));
  }
  try {
    value(0);
    whitespace();
    if (position !== text.length) throw failure();
    return JSON.parse(text);
  } catch (error) { if (error.code) throw error; throw failure(); }
}

function checkSchema(check, value) {
  if (!check(value)) throw failure("timeline-validation", check.errors.map(error => `${error.instancePath}:${error.keyword}`));
}

function validateDocument(document) {
  const check = documentChecks.get(document?.schema_version);
  if (!check) throw failure("timeline-version");
  checkSchema(check, document);
  try { new Intl.DateTimeFormat("en", { timeZone: document.display_timezone }).format(); }
  catch { throw failure("timeline-timezone"); }
  const threads = new Map(document.source_threads.map(thread => [thread.thread_id, thread.selected_message_count]));
  const eventIds = new Set(), messageIds = new Set(), counts = new Map();
  if (threads.size !== document.source_threads.length) throw failure();
  for (const event of document.events) {
    if (!threads.has(event.source_thread_id) || eventIds.has(event.event_id) || messageIds.has(event.source_message_id)) throw failure();
    if ((event.date_source === "unknown") !== (event.occurred_at === null)) throw failure();
    eventIds.add(event.event_id);
    messageIds.add(event.source_message_id);
    counts.set(event.source_thread_id, (counts.get(event.source_thread_id) || 0) + 1);
  }
  const coverage = document.coverage;
  if (coverage.selected_message_count !== coverage.included_message_count + coverage.omitted_message_count
      || coverage.included_message_count !== document.events.length
      || [...threads.values()].reduce((total, count) => total + count, 0) !== coverage.selected_message_count
      || [...counts].some(([thread, count]) => count > threads.get(thread))) throw failure();
  if (document.case_report) {
    if (document.events.some(event => !event.phase) || document.case_scope.limited_search_count > document.case_scope.search_count) throw failure();
    validateCaseReport(document.case_report, [...messageIds]);
  }
  if (Buffer.byteLength(JSON.stringify(document)) > MAX_BYTES) throw failure("timeline-size");
  return document;
}

function validateCaseReport(value, sourceIds, sourceText = null) {
  checkSchema(caseReportCheck, value);
  const allowed = new Set(sourceIds);
  for (const item of [...value.current_status, ...value.follow_ups, ...value.gaps, ...value.dates]) {
    if (item.source_message_ids.some(id => !allowed.has(id))) throw failure("timeline-references");
  }
  if (sourceText && value.dates.some(item => !item.source_message_ids.some(id => sourceText.get(id)?.includes(item.date_text)))) throw failure("timeline-references");
  return value;
}

function validateCandidates(value, tokens) {
  checkSchema(candidateCheck, value);
  const expected = new Set(tokens), seen = new Set();
  for (const event of value.events) {
    if (!expected.has(event.source_token) || seen.has(event.source_token)) throw failure("timeline-references");
    seen.add(event.source_token);
  }
  if (seen.size !== expected.size) throw failure("timeline-references");
  return value.events;
}

module.exports = { schema, MAX_BYTES, failure, parseJson, validateDocument, validateCandidates, validateCaseReport,
  validateMetadata: value => checkSchema(metadataCheck, { ...value, summary: "Pending", open_actions: [], unclear: [] }) };
