// Generated Email Brain persona shaping. Mailbox messages are never written here.
// Section rows are capped at SECTION_ROW_CAP (8), the same slice normalizeSections
// already used. Refresh is a soft distill: prefer the model's rows, and restore a
// prior section only when the new pass returned no section rows. Rebuild does not
// restore prior generated rows.
// Identity auto lists use that same cap. Account emails are merged by the host
// after the model returns. This file does not read the mail database.

const policy = require("../shared/compose-policy");

const SECTION_ROW_CAP = 8;
const SECTION_CAP = 8;
const WRITING_CAP = 8;
const VOICE_QUOTE_CAP = 6;
const ROW_SCAN_CAP = 48;
const IDENTITY_ID_CAP = 80;
const AKA_CAP = 16;

const DOSSIER = [
  { id: "communication-style", title: "Communication style" },
  { id: "work-patterns", title: "Work patterns" },
  { id: "key-relationships", title: "Key relationships" },
  { id: "decision-preferences", title: "Decision preferences" },
];

const PERSONA_SHAPE = "Shape: {\"ownerName\":string,\"writing\":string[],\"voiceQuotes\":string[],\"sections\":[{\"id\":string,\"title\":string,\"rows\":[{\"label\":string,\"value\":string}]}],\"identity\":{\"ownerName\":string,\"displayNames\":string[],\"nicknames\":string[],\"orgs\":string[]}}. ";

const IDENTITY_INSTRUCTION = "Fill identity from the mail. Read sent mail first for the owner's names: the From display name and the signature. Then read inbox mail for how other people address the owner, including nicknames and organizations. Put that in identity.ownerName, identity.displayNames, identity.nicknames, and identity.orgs. Leave email addresses out of identity; the host adds the mailbox addresses. Do not invent names that are not in the mail or the prior profile. Do not edit mailbox messages. Omit nicknames of one or two characters and generic tokens such as hi, ok, and re.";

const TRIAGE_SYSTEM = [
  "You sort inbox mail into the user's categories.",
  "Use only the messages and categories in the user JSON.",
  "Do not invent messages.",
  "Do not send mail.",
  "Reply with JSON only, no markdown.",
  "Shape: {\"items\":[{\"messageId\":string,\"categoryId\":string,\"summary\":string,\"followUps\":[{\"messageId\":string,\"kind\":\"draft\"|\"open\"|\"flag-attachment\",\"label\":string,\"body\":string}]}]}.",
  "Assign each message exactly once. summary is one short sentence from that message.",
].join(" ");

const TRIAGE_IDENTITY = "Identity in the user JSON is the mailbox owner: name, also known as, and email addresses, plus organizations when present. Choose Needs You for a direct ask, named responsibility, or a primary action on that owner. Do not choose Needs You for FYI, newsletter, or noreply mail when the only reason is an incidental name collision.";

const WEAK_NICKNAMES = new Set([
  "me", "my", "i", "hi", "hey", "hiya", "yo", "ok", "okay", "the", "and", "you",
  "mr", "ms", "mrs", "dr", "re", "fw", "fwd", "cc", "to", "from",
]);

const IDENTITY_FIELDS = ["displayNames", "nicknames", "orgs"];
const KIND_RANK = { primary: 3, sendAs: 2, alias: 1 };

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
      IDENTITY_INSTRUCTION,
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
    IDENTITY_INSTRUCTION,
    "Reply with JSON only, no markdown.",
    PERSONA_SHAPE,
    "sections include communication-style, work-patterns, key-relationships, and decision-preferences when the mail or prior profile supports them.",
    "writing is 3 to 6 short tone rules from sent mail.",
  ].join(" ");
}

function triageSystemPrompt(brief) {
  if (brief == null) return TRIAGE_SYSTEM;
  return `${TRIAGE_SYSTEM} ${TRIAGE_IDENTITY}`;
}

function compactFact(text) {
  return String(text || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
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
  if ((!labelA && !valueA) || (!labelB && !valueB)) {
    return String(leftLabel || "").trim() === String(rightLabel || "").trim()
      && String(leftValue || "").trim() === String(rightValue || "").trim();
  }
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

function nicknameCompact(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s\p{P}]+/gu, "");
}

function isWeakNickname(value) {
  const trimmed = String(value || "").trim().toLowerCase();
  const compact = nicknameCompact(value);
  if ([...compact].length <= 2) return true;
  return WEAK_NICKNAMES.has(trimmed) || WEAK_NICKNAMES.has(compact);
}

function identitySlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function identityRowId(field, slug, taken) {
  const prefix = `identity:${field}:`;
  let n = 1;
  while (n < 100) {
    const suffix = n === 1 ? "" : `-${n}`;
    const id = `${prefix}${slug}`.slice(0, IDENTITY_ID_CAP - suffix.length) + suffix;
    if (!taken.has(id)) return id;
    n += 1;
  }
  return `${prefix}${slug}`.slice(0, IDENTITY_ID_CAP);
}

function identityValue(item) {
  return String(item && typeof item === "object" ? item.value : item || "").trim().slice(0, 80);
}

function normalizeIdentityValues(field, list, dropWeak) {
  const raw = [];
  for (const item of Array.isArray(list) ? list : []) {
    const text = identityValue(item);
    if (!text) continue;
    if (dropWeak && isWeakNickname(text)) continue;
    if (!identitySlug(text)) continue;
    raw.push(text);
  }
  const unique = dedupeFacts(raw, SECTION_ROW_CAP, (left, right) => factsNearDuplicate("", left, "", right));
  const taken = new Set();
  return unique.map((value) => {
    const id = identityRowId(field, identitySlug(value), taken);
    taken.add(id);
    return { id, value, source: "auto" };
  });
}

function copyAuto(priorIdentity, field) {
  const rows = priorIdentity && Array.isArray(priorIdentity[field]) ? priorIdentity[field] : [];
  return rows.slice(0, SECTION_ROW_CAP).map((row) => ({
    id: String(row && row.id || ""),
    value: identityValue(row),
    source: "auto",
  })).filter((row) => row.id && row.value);
}

function emailKind(value) {
  return value === "primary" || value === "sendAs" || value === "alias" ? value : "alias";
}

function emailId(addr) {
  return `identity:emails:${addr}`.slice(0, IDENTITY_ID_CAP);
}

function copyEmails(list) {
  return (Array.isArray(list) ? list : []).filter((row) => row && row.address).map((row) => ({
    id: String(row.id || emailId(String(row.address))).slice(0, IDENTITY_ID_CAP),
    address: String(row.address),
    source: "account",
    accountId: String(row.accountId || ""),
    kind: emailKind(row.kind),
  }));
}

function normalizeEmails(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const best = new Map();
  for (const row of list) {
    const addr = policy.address(row && row.address);
    if (!addr) continue;
    const kind = emailKind(row && row.kind);
    const current = best.get(addr);
    if (!current || KIND_RANK[kind] > KIND_RANK[current.kind]) {
      best.set(addr, { kind, accountId: String(row && row.accountId || "") });
    }
  }
  const emitted = new Set();
  const out = [];
  for (const row of list) {
    const addr = policy.address(row && row.address);
    if (!addr || emitted.has(addr)) continue;
    const winner = best.get(addr);
    if (emailKind(row && row.kind) !== winner.kind) continue;
    if (String(row && row.accountId || "") !== winner.accountId) continue;
    emitted.add(addr);
    out.push({
      id: emailId(addr),
      address: addr,
      source: "account",
      accountId: winner.accountId,
      kind: winner.kind,
    });
  }
  return out;
}

function namedText(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 80) : "";
}

function identityComplete(identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return false;
  if (typeof identity.ownerName !== "string") return false;
  return IDENTITY_FIELDS.every((field) => Array.isArray(identity[field]));
}

function resolvedOwnerName(prior, parsed, complete) {
  const fromIdentity = complete ? namedText(parsed && parsed.identity && parsed.identity.ownerName) : "";
  const fromTop = namedText(parsed && parsed.ownerName);
  const fromPrior = namedText(prior && prior.ownerName);
  return fromIdentity || fromTop || fromPrior || "You";
}

function priorIdentityOf(prior) {
  if (!prior || typeof prior !== "object" || Array.isArray(prior)) return null;
  if (prior.identity && typeof prior.identity === "object" && !Array.isArray(prior.identity)) return prior.identity;
  return null;
}

function mergeIdentity(prior, parsed, accountEmails) {
  const priorIdentity = priorIdentityOf(prior);
  const parsedIdentity = parsed && parsed.identity;
  const complete = identityComplete(parsedIdentity);
  const ownerName = resolvedOwnerName(prior, parsed, complete);
  return {
    ownerName,
    displayNames: complete ? normalizeIdentityValues("displayNames", parsedIdentity.displayNames) : copyAuto(priorIdentity, "displayNames"),
    nicknames: complete ? normalizeIdentityValues("nicknames", parsedIdentity.nicknames, true) : copyAuto(priorIdentity, "nicknames"),
    orgs: complete ? normalizeIdentityValues("orgs", parsedIdentity.orgs) : copyAuto(priorIdentity, "orgs"),
    emails: accountEmails == null ? copyEmails(priorIdentity && priorIdentity.emails) : normalizeEmails(accountEmails),
  };
}

function sendAsRead(account) {
  const raw = account ? account.send_as_json : undefined;
  if (raw == null || raw === "") return { known: false, rows: [] };
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { known: false, rows: [] };
    }
  }
  if (Array.isArray(parsed)) return { known: true, rows: parsed };
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.identities)) {
    const accountEmail = policy.address(account && account.email);
    const cacheEmail = policy.address(parsed.email);
    if (cacheEmail && accountEmail && cacheEmail === accountEmail) return { known: true, rows: parsed.identities };
  }
  return { known: false, rows: [] };
}

function acceptedSendAs(rows) {
  const found = [];
  for (const item of Array.isArray(rows) ? rows : []) {
    if (item && typeof item === "object") {
      if (item.verificationStatus === "pending" || item.verified === false) continue;
      const email = policy.address(item.email || item.sendAsEmail);
      if (email) found.push(email);
      continue;
    }
    const email = policy.address(item);
    if (email) found.push(email);
  }
  return found;
}

function rowsForAccount(account, settings, priorEmails) {
  const accountId = String(account && account.id || "");
  const read = sendAsRead(account);
  const sendAsRows = read.known ? read.rows.map((item) => (
    typeof item === "string" ? { email: item, verified: true } : item
  )) : [];
  const listed = policy.identities({
    id: accountId,
    email: account && account.email,
    sendAs: sendAsRows,
  }, settings || {});
  const primary = policy.address(account && account.email);
  const sendAsSet = new Set(read.known ? acceptedSendAs(sendAsRows) : []);
  const rows = [];
  for (const item of listed) {
    const email = policy.address(item && item.email);
    if (!email) continue;
    let kind = "alias";
    if (primary && email === primary) kind = "primary";
    else if (sendAsSet.has(email)) kind = "sendAs";
    rows.push({ address: email, source: "account", accountId, kind });
  }
  if (!read.known) {
    const kept = [];
    for (const row of priorEmails) {
      if (!row || String(row.accountId || "") !== accountId || row.kind !== "sendAs") continue;
      const email = policy.address(row.address);
      if (!email) continue;
      kept.push({ address: email, source: "account", accountId, kind: "sendAs" });
    }
    const insertAt = rows.findIndex((row) => row.kind !== "primary");
    rows.splice(insertAt === -1 ? rows.length : insertAt, 0, ...kept);
  }
  return rows;
}

function collectIdentityEmails(accounts, settings, priorEmails) {
  const prior = Array.isArray(priorEmails) ? priorEmails : [];
  const prefs = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  const flat = [];
  for (const account of Array.isArray(accounts) ? accounts : []) {
    if (!account || typeof account !== "object") continue;
    flat.push(...rowsForAccount(account, prefs, prior));
  }
  return normalizeEmails(flat);
}

function identityPriorForPrompt(prior) {
  const identity = priorIdentityOf(prior);
  const values = (field) => {
    const list = identity && Array.isArray(identity[field]) ? identity[field] : [];
    return list.map((row) => identityValue(row)).filter(Boolean).slice(0, SECTION_ROW_CAP);
  };
  let ownerName = "";
  if (identity && namedText(identity.ownerName)) ownerName = namedText(identity.ownerName);
  else if (prior && typeof prior.ownerName === "string") ownerName = prior.ownerName.trim();
  return {
    ownerName,
    displayNames: values("displayNames"),
    nicknames: values("nicknames"),
    orgs: values("orgs"),
  };
}

function identityBriefFrom(generated) {
  const identity = generated && generated.identity;
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return null;
  const ownerName = namedText(identity.ownerName);
  const aka = [];
  const seenAka = new Set();
  for (const row of [...(Array.isArray(identity.displayNames) ? identity.displayNames : []), ...(Array.isArray(identity.nicknames) ? identity.nicknames : [])]) {
    const value = identityValue(row);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seenAka.has(key)) continue;
    seenAka.add(key);
    aka.push(value);
    if (aka.length >= AKA_CAP) break;
  }
  const emails = [];
  const seenEmail = new Set();
  for (const row of Array.isArray(identity.emails) ? identity.emails : []) {
    const addr = String(row && row.address || "").trim();
    if (!addr) continue;
    const key = addr.toLowerCase();
    if (seenEmail.has(key)) continue;
    seenEmail.add(key);
    emails.push(addr);
  }
  const orgs = [];
  const seenOrg = new Set();
  for (const row of Array.isArray(identity.orgs) ? identity.orgs : []) {
    const value = identityValue(row);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seenOrg.has(key)) continue;
    seenOrg.add(key);
    orgs.push(value);
  }
  const brief = {};
  if (ownerName && ownerName !== "You") brief.ownerName = ownerName;
  if (aka.length) brief.aka = aka;
  if (emails.length) brief.emails = emails;
  if (orgs.length) brief.orgs = orgs;
  if (!brief.ownerName && !brief.aka && !brief.emails && !brief.orgs) return null;
  return brief;
}

function forgetIdentity(identity, itemId) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return { identity, removed: false };
  const id = String(itemId || "");
  if (!id || id.startsWith("identity:emails:")) return { identity, removed: false };
  for (const field of IDENTITY_FIELDS) {
    const rows = Array.isArray(identity[field]) ? identity[field] : [];
    const index = rows.findIndex((row) => row && row.id === id);
    if (index < 0) continue;
    const nextRows = rows.slice(0, index).concat(rows.slice(index + 1));
    return { identity: { ...identity, [field]: nextRows }, removed: true };
  }
  return { identity, removed: false };
}

function identityFixTarget(itemId) {
  const id = String(itemId || "");
  if (id.startsWith("identity:emails:")) return "emails";
  for (const field of IDENTITY_FIELDS) {
    if (id.startsWith(`identity:${field}:`)) return "auto";
  }
  return "";
}

function rewriteIdentityItem(identity, itemId, value) {
  const target = identityFixTarget(itemId);
  if (target === "emails") {
    return { identity, wrote: false, error: "Account addresses stay with the connected mailbox." };
  }
  if (target !== "auto") return { identity, wrote: false, error: "" };
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return { identity, wrote: false, error: "" };
  const field = IDENTITY_FIELDS.find((name) => String(itemId).startsWith(`identity:${name}:`));
  const rows = Array.isArray(identity[field]) ? identity[field] : [];
  const index = rows.findIndex((row) => row && row.id === itemId);
  if (index < 0) return { identity, wrote: false, error: "" };
  const nextValue = identityValue(value);
  if (!nextValue || !identitySlug(nextValue)) {
    return { identity, wrote: false, error: "The model returned an empty rewrite." };
  }
  if (field === "nicknames" && isWeakNickname(nextValue)) {
    return { identity, wrote: false, error: "That nickname is too short or too generic to keep." };
  }
  const taken = new Set(rows.filter((row) => row && row.id !== itemId).map((row) => row.id));
  const nextRows = rows.slice();
  nextRows[index] = {
    id: identityRowId(field, identitySlug(nextValue), taken),
    value: nextValue,
    source: "auto",
  };
  return { identity: { ...identity, [field]: nextRows }, wrote: true, error: "" };
}

function messageCount(sample) {
  return sample && Array.isArray(sample.messages) ? sample.messages.length : 0;
}

function buildGenerated(prior, parsed, sample, mode, accountEmails) {
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
  const identity = mergeIdentity(prior, parsed, accountEmails);
  return {
    ownerName: identity.ownerName,
    writing,
    voiceQuotes,
    sections,
    emailsAnalyzed: mode === "rebuild"
      ? count
      : Math.min(500, ((prior && prior.emailsAnalyzed) || 0) + count),
    updatedAt: new Date().toISOString(),
    mode,
    identity,
  };
}

function applyGenerated(store, parsed, sample, mode, accountEmails) {
  store.generated = buildGenerated(store && store.generated, parsed, sample, mode, accountEmails);
}

module.exports = {
  SECTION_ROW_CAP,
  SECTION_CAP,
  WRITING_CAP,
  VOICE_QUOTE_CAP,
  DOSSIER,
  TRIAGE_SYSTEM,
  personaSystemPrompt,
  triageSystemPrompt,
  normalizeWriting,
  normalizeQuotes,
  normalizeSections,
  mergeRefreshSections,
  isWeakNickname,
  mergeIdentity,
  collectIdentityEmails,
  identityPriorForPrompt,
  identityBriefFrom,
  forgetIdentity,
  identityFixTarget,
  rewriteIdentityItem,
  buildGenerated,
  applyGenerated,
};
