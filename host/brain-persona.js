// Generated Email Brain persona shaping. Mailbox messages are never written here.
// Section rows are capped at SECTION_ROW_CAP (8), the same slice normalizeSections
// already used. Refresh is a soft distill: prefer the model's rows, and restore a
// prior section only when the new pass returned no section rows. Rebuild does not
// restore prior generated rows.

const SECTION_ROW_CAP = 8;
const SECTION_CAP = 8;
const WRITING_CAP = 8;
const VOICE_QUOTE_CAP = 6;
const ROW_SCAN_CAP = 48;

const DOSSIER = [
  { id: "communication-style", title: "Communication style" },
  { id: "work-patterns", title: "Work patterns" },
  { id: "key-relationships", title: "Key relationships" },
  { id: "decision-preferences", title: "Decision preferences" },
];

const PERSONA_SHAPE = "Shape: {\"ownerName\":string,\"writing\":string[],\"voiceQuotes\":string[],\"sections\":[{\"id\":string,\"title\":string,\"rows\":[{\"label\":string,\"value\":string}]}]}. ";

function personaSystemPrompt(mode) {
  if (mode === "rebuild") {
    return [
      "Distill an Email Brain persona from scratch into a tight usable profile.",
      "This replaces the generated persona. It does not edit mailbox messages.",
      "Weight sent mail and replies for voice. Short quotes from sent mail may show tone.",
      "Do not treat inbox-only mail as the user's voice.",
      "Do not invent facts that are not in the mail.",
      "Merge overlapping facts into one concise row. Dedupe near-duplicate labels and values. Compress; do not list every message.",
      "writing is 3 to 6 short tone rules from sent mail.",
      `sections must include communication-style, work-patterns, key-relationships, and decision-preferences, each with a few concise rows (at most ${SECTION_ROW_CAP}).`,
      "User writing rules are stored separately and must not be rewritten.",
      "Reply with JSON only, no markdown.",
      PERSONA_SHAPE,
    ].join(" ");
  }
  return [
    "Distill the living Email Brain profile from the mail sample and the prior profile.",
    "Return the full tightened persona, not a delta of new facts to append.",
    "Merge overlapping facts into one concise row. Prefer newer sent-mail evidence when voice or facts change.",
    "Drop or rewrite auto facts that the new mail contradicts or that are clearly stale.",
    "Dedupe near-duplicate labels and values.",
    `Compress each section to at most ${SECTION_ROW_CAP} short rows.`,
    "Weight sent mail and replies for voice. Do not treat inbox-only mail as the user's voice.",
    "Do not invent facts that are not in the mail or the prior profile.",
    "Do not replace the whole persona with an empty profile. Keep sections the mail or prior profile still supports, and leave user writing rules out of this JSON.",
    "Reply with JSON only, no markdown.",
    PERSONA_SHAPE,
    "sections include communication-style, work-patterns, key-relationships, and decision-preferences when the mail or prior profile supports them.",
    "writing is 3 to 6 short tone rules from sent mail.",
  ].join(" ");
}

function compactFact(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function factTokens(text) {
  return compactFact(text).split(" ").filter((part) => part.length > 1 || /^\d+$/.test(part));
}

function jaccard(left, right) {
  if (!left.length || !right.length) return 0;
  const a = new Set(left);
  const b = new Set(right);
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  const union = a.size + b.size - shared;
  return union ? shared / union : 0;
}

function containsFact(longer, shorter) {
  if (!shorter || !longer) return false;
  if (shorter === longer) return true;
  if (!longer.includes(shorter)) return false;
  if (shorter.length >= 12) return true;
  return shorter.length >= 8 && shorter.length >= Math.ceil(longer.length * 0.6);
}

function factsNearDuplicate(leftLabel, leftValue, rightLabel, rightValue) {
  const labelA = compactFact(leftLabel);
  const labelB = compactFact(rightLabel);
  const valueA = compactFact(leftValue);
  const valueB = compactFact(rightValue);
  if (!labelA && !valueA) return true;
  if (labelA === labelB && valueA === valueB) return true;
  const labelsClose = !!(labelA && labelB && (labelA === labelB || labelA.includes(labelB) || labelB.includes(labelA)));
  const sameSlot = labelsClose || (!labelA && !labelB);
  if (valueA && valueA === valueB && valueA.length >= 12 && (labelsClose || !labelA || !labelB)) return true;
  if (!sameSlot) return false;
  if (containsFact(valueA, valueB) || containsFact(valueB, valueA)) return true;
  const tokensA = factTokens(valueA);
  const tokensB = factTokens(valueB);
  return tokensA.length >= 3 && tokensB.length >= 3 && jaccard(tokensA, tokensB) >= 0.8;
}

function dedupeFacts(entries, cap, same) {
  const kept = [];
  for (const entry of entries) {
    if (kept.some((other) => same(entry, other))) continue;
    kept.push(entry);
    if (kept.length >= cap) break;
  }
  return kept;
}

function normalizeWriting(list) {
  const raw = (Array.isArray(list) ? list : [])
    .map((item) => String(item && typeof item === "object" ? item.value : item || "").trim())
    .filter(Boolean);
  return dedupeFacts(raw, WRITING_CAP, (left, right) => factsNearDuplicate("", left, "", right));
}

function normalizeQuotes(list) {
  const raw = (Array.isArray(list) ? list : [])
    .map((item) => String(item || "").trim().slice(0, 200))
    .filter(Boolean);
  return dedupeFacts(raw, VOICE_QUOTE_CAP, (left, right) => factsNearDuplicate("", left, "", right));
}

function normalizeRows(list, sectionId) {
  const id = String(sectionId || "section").slice(0, 40);
  const mapped = (Array.isArray(list) ? list : []).slice(0, ROW_SCAN_CAP).map((item, index) => ({
    id: String((item && item.id) || `${id}:${index}`).slice(0, 80),
    label: String((item && item.label) || "").trim().slice(0, 80),
    value: String((item && (item.value || item.text)) || "").trim().slice(0, 400),
  })).filter((entry) => entry.value || entry.label);
  return dedupeFacts(mapped, SECTION_ROW_CAP, (left, right) => factsNearDuplicate(left.label, left.value, right.label, right.value));
}

function normalizeSections(list) {
  const incoming = Array.isArray(list) ? list : [];
  const byId = new Map();
  for (const section of incoming) {
    if (!section || typeof section !== "object") continue;
    const id = String(section.id || "").trim().slice(0, 40);
    if (id) byId.set(id, section);
  }
  const ordered = [];
  for (const canon of DOSSIER) {
    ordered.push(byId.get(canon.id) || { id: canon.id, title: canon.title, rows: [] });
    byId.delete(canon.id);
  }
  for (const section of incoming) {
    const id = section && String(section.id || "").trim();
    if (id && byId.has(id)) ordered.push(byId.get(id));
  }
  return ordered.slice(0, SECTION_CAP).map((section) => {
    const id = String(section.id || "section").slice(0, 40);
    return {
      id,
      title: String(section.title || "Notes").slice(0, 80),
      rows: normalizeRows(section.rows, id),
    };
  });
}

function sectionHasRows(section) {
  return !!(section && Array.isArray(section.rows) && section.rows.length);
}

function usefulPriorRows(section) {
  if (!sectionHasRows(section)) return null;
  const rows = normalizeRows(section.rows, section.id);
  return rows.length ? rows : null;
}

function mergeRefreshSections(prior, next) {
  const priorList = Array.isArray(prior) ? prior : [];
  const nextList = Array.isArray(next) ? next : [];
  const old = new Map(priorList.map((section) => [section && section.id, section]));
  const distilled = nextList.some(sectionHasRows);
  const seen = new Set();
  const merged = nextList.map((section) => {
    const id = section && section.id;
    seen.add(id);
    if (sectionHasRows(section)) return section;
    if (distilled) return section;
    const kept = usefulPriorRows(old.get(id));
    return kept ? { ...section, rows: kept } : section;
  });
  if (!distilled) {
    for (const section of priorList) {
      if (!section || seen.has(section.id)) continue;
      const kept = usefulPriorRows(section);
      if (kept) merged.push({ ...section, rows: kept });
    }
  }
  return merged;
}

function messageCount(sample) {
  return sample && Array.isArray(sample.messages) ? sample.messages.length : 0;
}

function buildGenerated(prior, parsed, sample, mode) {
  const refresh = mode === "refresh";
  const nextSections = normalizeSections(parsed && parsed.sections);
  let sections = nextSections;
  if (refresh && prior) sections = mergeRefreshSections(prior.sections, sections);
  sections = normalizeSections(sections);
  const distilled = nextSections.some(sectionHasRows);
  const writingProvided = !!(parsed && Array.isArray(parsed.writing));
  let writing = normalizeWriting(writingProvided ? parsed.writing : []);
  if (refresh && !writing.length && (!writingProvided || !distilled)) {
    writing = normalizeWriting(prior && prior.writing);
  }
  const quotesProvided = !!(parsed && Array.isArray(parsed.voiceQuotes));
  let voiceQuotes = normalizeQuotes(quotesProvided ? parsed.voiceQuotes : []);
  if (refresh && !voiceQuotes.length && (!quotesProvided || !distilled)) {
    voiceQuotes = normalizeQuotes(prior && prior.voiceQuotes);
  }
  const count = messageCount(sample);
  const named = parsed && typeof parsed.ownerName === "string" && parsed.ownerName.trim();
  return {
    ownerName: named ? named.slice(0, 80) : (prior && prior.ownerName) || "You",
    writing,
    voiceQuotes,
    sections,
    emailsAnalyzed: mode === "rebuild"
      ? count
      : Math.min(500, ((prior && prior.emailsAnalyzed) || 0) + count),
    updatedAt: new Date().toISOString(),
    mode,
  };
}

function applyGenerated(store, parsed, sample, mode) {
  store.generated = buildGenerated(store && store.generated, parsed, sample, mode);
}

module.exports = {
  SECTION_ROW_CAP,
  SECTION_CAP,
  WRITING_CAP,
  VOICE_QUOTE_CAP,
  DOSSIER,
  personaSystemPrompt,
  normalizeWriting,
  normalizeQuotes,
  normalizeSections,
  mergeRefreshSections,
  buildGenerated,
  applyGenerated,
};
