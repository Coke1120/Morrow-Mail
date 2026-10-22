const assert = require("assert");
const {
  SECTION_ROW_CAP,
  WRITING_CAP,
  TRIAGE_SYSTEM,
  personaSystemPrompt,
  triageSystemPrompt,
  normalizeWriting,
  normalizeSections,
  mergeRefreshSections,
  applyGenerated,
  isWeakNickname,
  mergeIdentity,
  collectIdentityEmails,
  identityPriorForPrompt,
  identityBriefFrom,
  forgetIdentity,
  rewriteIdentityItem,
} = require("../host/brain-persona");

assert.strictEqual(SECTION_ROW_CAP, 8);
assert.strictEqual(WRITING_CAP, 8);

const refreshPrompt = personaSystemPrompt("refresh");
const rebuildPrompt = personaSystemPrompt("rebuild");
assert.match(refreshPrompt, /Distill the living Email Brain profile/);
assert.match(refreshPrompt, /not a delta of new facts to append/);
assert.match(refreshPrompt, /Dedupe near-duplicate/);
assert.match(refreshPrompt, /Compress each section to at most 8/);
assert.match(refreshPrompt, /Prefer newer sent-mail evidence/);
assert.match(refreshPrompt, /clearly stale/);
assert.doesNotMatch(refreshPrompt, /Keep prior facts unless/);
assert.match(refreshPrompt, /user writing rules/i);
assert.match(refreshPrompt, /Read sent mail first for the owner's names/);
assert.match(refreshPrompt, /Then read inbox mail for how other people address the owner/);
assert.match(refreshPrompt, /Leave email addresses out of identity/);
assert.match(refreshPrompt, /Omit nicknames of one or two characters/);
assert.match(refreshPrompt, /"identity":\{"ownerName":string,"displayNames":string\[\],"nicknames":string\[\],"orgs":string\[\]\}/);
assert.match(rebuildPrompt, /Distill an Email Brain persona from scratch/);
assert.match(rebuildPrompt, /3 to 6 short tone rules/);
assert.match(rebuildPrompt, /communication-style, work-patterns, key-relationships, and decision-preferences/);
assert.match(rebuildPrompt, /Do not invent facts that are not in the mail/);
assert.match(rebuildPrompt, /at most 8/);
assert.match(rebuildPrompt, /does not edit mailbox messages/);
assert.match(rebuildPrompt, /Read sent mail first for the owner's names/);
assert.match(rebuildPrompt, /Then read inbox mail for how other people address the owner/);
assert.match(rebuildPrompt, /Leave email addresses out of identity/);
assert.match(rebuildPrompt, /Omit nicknames of one or two characters/);
const triageToday = [
  "You sort inbox mail into the user's categories.",
  "Use only the messages and categories in the user JSON.",
  "Do not invent messages.",
  "Do not send mail.",
  "Reply with JSON only, no markdown.",
  "Shape: {\"items\":[{\"messageId\":string,\"categoryId\":string,\"summary\":string,\"followUps\":[{\"messageId\":string,\"kind\":\"draft\"|\"open\"|\"flag-attachment\",\"label\":string,\"body\":string}]}]}.",
  "Assign each message exactly once. summary is one short sentence from that message.",
].join(" ");
assert.strictEqual(TRIAGE_SYSTEM, triageToday);
assert.strictEqual(triageSystemPrompt(null), triageToday);
assert.doesNotMatch(triageSystemPrompt(null), /incidental name collision/);
const weightedTriage = triageSystemPrompt({ ownerName: "Ada Lovelace", aka: ["Ada"] });
assert.match(weightedTriage, /Choose Needs You for a direct ask, named responsibility, or a primary action on that owner/);
assert.match(weightedTriage, /Do not choose Needs You for FYI, newsletter, or noreply mail when the only reason is an incidental name collision/);
assert.strictEqual(weightedTriage, triageToday + " " + weightedTriage.slice(triageToday.length + 1));

function rowsOf(sections, id) {
  const section = sections.find((item) => item.id === id);
  assert.ok(section, id);
  return section.rows;
}

const overshot = [];
for (let index = 0; index < 12; index += 1) {
  overshot.push({ label: `Fact ${index}`, value: `Distinct detail number ${index} from sent mail` });
}
overshot.push({ label: "Fact 0", value: "Distinct detail number 0 from sent mail" });
overshot.push({ label: "Fact 0", value: "Distinct detail number 0 from sent mail." });
const capped = normalizeSections([{ id: "work-patterns", title: "Work patterns", rows: overshot }]);
const cappedRows = rowsOf(capped, "work-patterns");
assert.strictEqual(cappedRows.length, SECTION_ROW_CAP);
assert.strictEqual(new Set(cappedRows.map((row) => row.label)).size, cappedRows.length);
assert.strictEqual(cappedRows[0].label, "Fact 0");
assert.strictEqual(cappedRows[7].label, "Fact 7");

const blanks = normalizeSections([{
  id: "communication-style",
  title: "Communication style",
  rows: [
    { label: "", value: "" },
    { label: " ", value: " " },
    { label: "Tone", value: "Direct" },
  ],
}]);
assert.deepStrictEqual(rowsOf(blanks, "communication-style").map((row) => row.value), ["Direct"]);

const near = normalizeSections([{
  id: "key-relationships",
  title: "Key relationships",
  rows: [
    { label: "Ada", value: "Asks for the weekly notes" },
    { label: "Ada", value: "Asks for weekly notes" },
    { label: "Ada", value: "Sends signed contracts" },
    { label: "Bea", value: "Sends the invoice" },
  ],
}]);
assert.deepStrictEqual(rowsOf(near, "key-relationships").map((row) => `${row.label}:${row.value}`), [
  "Ada:Asks for the weekly notes",
  "Ada:Sends signed contracts",
  "Bea:Sends the invoice",
]);

assert.deepStrictEqual(normalizeWriting([
  "Short and direct.",
  "Short and direct",
  "Keep it short and direct.",
  "Be warm.",
  { value: "  Be warm.  " },
]), ["Short and direct.", "Be warm."]);

const priorSections = [
  {
    id: "communication-style",
    title: "Communication style",
    rows: [
      { id: "communication-style:0", label: "Tone", value: "Old direct tone that should not append" },
      { id: "communication-style:1", label: "Length", value: "Another old tone fact" },
    ],
  },
  {
    id: "work-patterns",
    title: "Work patterns",
    rows: [
      { label: "Hours", value: "Old morning block that should not return" },
      { label: "Place", value: "Old desk note that should not return" },
    ],
  },
  {
    id: "side-notes",
    title: "Side notes",
    rows: [{ label: "Old", value: "Stale side fact that must leave after a distill" }],
  },
];
const distilledNext = normalizeSections([{
  id: "communication-style",
  title: "Communication style",
  rows: [{ label: "Tone", value: "Warm and brief" }],
}]);
const soft = normalizeSections(mergeRefreshSections(priorSections, distilledNext));
assert.deepStrictEqual(rowsOf(soft, "communication-style").map((row) => row.value), ["Warm and brief"]);
assert.strictEqual(rowsOf(soft, "work-patterns").length, 0);
assert.ok(!soft.some((section) => section.id === "side-notes"));
assert.ok(!JSON.stringify(soft).includes("should not"));
assert.ok(!JSON.stringify(soft).includes("Stale side"));

const bloatedPrior = [{
  id: "decision-preferences",
  title: "Decision preferences",
  rows: overshot,
}];
const emptyNext = normalizeSections([]);
assert.ok(emptyNext.every((section) => section.rows.length === 0));
const restored = normalizeSections(mergeRefreshSections(bloatedPrior, emptyNext));
const restoredRows = rowsOf(restored, "decision-preferences");
assert.strictEqual(restoredRows.length, SECTION_ROW_CAP);
assert.ok(!restoredRows.some((row) => row.label === "Fact 8"));

const priorRow = { id: "communication-style:0", label: "Tone", value: "Direct" };
const priorGenerated = {
  ownerName: "Ada",
  writing: ["Old tone that should leave.", "Old tone that should leave.", "Be warm."],
  voiceQuotes: ["Old quote that should leave."],
  emailsAnalyzed: 10,
  sections: [{ id: "communication-style", title: "Communication style", rows: [priorRow] }],
};
const priorSnapshot = JSON.parse(JSON.stringify(priorGenerated));
const messages = [{ id: "m-sent", subject: "Notes", snippet: "I'll send the notes today" }];
const messageSnapshot = JSON.stringify(messages);
const rules = [{ id: "how-you-write:user:1", value: "Sticky rule." }];
const store = { userRules: rules, generated: priorGenerated, activity: [] };

applyGenerated(store, {
  ownerName: "",
  writing: ["Short and direct."],
  voiceQuotes: ["I'll send the notes today."],
  sections: [{
    id: "communication-style",
    title: "Communication style",
    rows: [
      { label: "Tone", value: "Warm and brief" },
      { label: "Tone", value: "Warm and brief." },
    ],
  }],
}, { messages }, "refresh");

assert.strictEqual(store.userRules, rules);
assert.strictEqual(rules[0].value, "Sticky rule.");
assert.deepStrictEqual(priorGenerated, priorSnapshot);
assert.strictEqual(JSON.stringify(messages), messageSnapshot);
assert.strictEqual(store.generated.ownerName, "Ada");
assert.strictEqual(store.generated.emailsAnalyzed, 11);
assert.strictEqual(store.generated.mode, "refresh");
assert.deepStrictEqual(store.generated.writing, ["Short and direct."]);
assert.deepStrictEqual(rowsOf(store.generated.sections, "communication-style").map((row) => row.value), ["Warm and brief"]);
assert.ok(!JSON.stringify(store.generated).includes("Old tone"));
assert.ok(!JSON.stringify(store.generated).includes("Old quote"));

const keptWriting = {
  userRules: [{ id: "how-you-write:user:9", value: "Sticky rule." }],
  generated: {
    ownerName: "Ada",
    writing: ["Keep this auto tone.", "Keep this auto tone."],
    voiceQuotes: ["Keep this quote."],
    emailsAnalyzed: 4,
    sections: priorSections,
  },
};
applyGenerated(keptWriting, { sections: [] }, { messages: [{ id: "m1" }] }, "refresh");
assert.deepStrictEqual(keptWriting.generated.writing, ["Keep this auto tone."]);
assert.deepStrictEqual(keptWriting.generated.voiceQuotes, ["Keep this quote."]);
assert.strictEqual(keptWriting.userRules[0].value, "Sticky rule.");
assert.ok(rowsOf(keptWriting.generated.sections, "communication-style").some((row) => row.value.includes("Old direct tone")));
assert.ok(rowsOf(keptWriting.generated.sections, "work-patterns").some((row) => row.value.includes("Old morning block")));
assert.strictEqual(keptWriting.generated.emailsAnalyzed, 5);

const rebuilt = {
  userRules: rules,
  generated: JSON.parse(JSON.stringify(priorGenerated)),
};
applyGenerated(rebuilt, {
  ownerName: "Ada Lovelace",
  writing: ["New rebuilt tone."],
  voiceQuotes: ["Fresh quote."],
  sections: [{
    id: "decision-preferences",
    title: "Decision preferences",
    rows: [{ label: "Speed", value: "Decide from the notes" }],
  }],
}, { messages }, "rebuild");
assert.strictEqual(rebuilt.userRules, rules);
assert.strictEqual(rebuilt.userRules[0].value, "Sticky rule.");
assert.strictEqual(rebuilt.generated.ownerName, "Ada Lovelace");
assert.strictEqual(rebuilt.generated.emailsAnalyzed, 1);
assert.strictEqual(rebuilt.generated.mode, "rebuild");
assert.deepStrictEqual(rebuilt.generated.writing, ["New rebuilt tone."]);
assert.deepStrictEqual(rebuilt.generated.voiceQuotes, ["Fresh quote."]);
assert.deepStrictEqual(rowsOf(rebuilt.generated.sections, "decision-preferences").map((row) => row.value), ["Decide from the notes"]);
assert.strictEqual(rowsOf(rebuilt.generated.sections, "communication-style").length, 0);
assert.ok(!JSON.stringify(rebuilt.generated).includes("Old tone"));
assert.ok(!JSON.stringify(rebuilt.generated.sections).includes("Direct"));

const cleared = {
  userRules: [{ id: "how-you-write:user:2", value: "Sticky rule." }],
  generated: {
    ownerName: "Ada",
    writing: ["Stale auto tone."],
    voiceQuotes: ["Stale quote."],
    emailsAnalyzed: 9,
    sections: [{ id: "communication-style", title: "Communication style", rows: [{ label: "Tone", value: "Stale direct" }] }],
  },
};
applyGenerated(cleared, {
  writing: [],
  voiceQuotes: [],
  sections: [{ id: "communication-style", title: "Communication style", rows: [{ label: "Tone", value: "Brief" }] }],
}, { messages: [{ id: "a" }, { id: "b" }] }, "refresh");
assert.deepStrictEqual(cleared.generated.writing, []);
assert.deepStrictEqual(cleared.generated.voiceQuotes, []);
assert.strictEqual(cleared.userRules[0].value, "Sticky rule.");
assert.deepStrictEqual(rowsOf(cleared.generated.sections, "communication-style").map((row) => row.value), ["Brief"]);

assert.strictEqual(isWeakNickname("Al"), true);
assert.strictEqual(isWeakNickname("Jo"), true);
assert.strictEqual(isWeakNickname("A.L."), true);
assert.strictEqual(isWeakNickname("ok"), true);
assert.strictEqual(isWeakNickname("Okay"), true);
assert.strictEqual(isWeakNickname("Mr."), true);
assert.strictEqual(isWeakNickname("you"), true);
assert.strictEqual(isWeakNickname("Ada"), false);

const priorIdentity = {
  ownerName: "Ada",
  writing: ["Keep voice."],
  voiceQuotes: [],
  sections: [],
  identity: {
    ownerName: "Ada",
    displayNames: [],
    nicknames: [{ id: "identity:nicknames:ada", value: "Ada", source: "auto" }],
    orgs: [{ id: "identity:orgs:old-org", value: "Old Org", source: "auto" }],
    emails: [
      { id: "identity:emails:ada@example.com", address: "ada@example.com", source: "account", accountId: "acct-1", kind: "primary" },
      { id: "identity:emails:old@example.com", address: "old@example.com", source: "account", accountId: "acct-1", kind: "alias" },
    ],
  },
};
const accountEmails = [
  { address: "ada@example.com", source: "account", accountId: "acct-1", kind: "primary" },
  { address: "ada@other.com", source: "model", accountId: "acct-1", kind: "alias" },
];
const worked = { generated: JSON.parse(JSON.stringify(priorIdentity)), userRules: [{ id: "rule", value: "Sticky rule." }] };
applyGenerated(worked, {
  ownerName: "Top Level",
  identity: {
    ownerName: "Ada Lovelace",
    displayNames: ["A. Lovelace", "Al"],
    nicknames: ["Al", "ok", "Ada"],
    orgs: ["Analytical Engines"],
    emails: ["stranger@example.com"],
  },
}, { messages: [{ id: "m-sent" }] }, "refresh", accountEmails);
assert.strictEqual(worked.userRules[0].value, "Sticky rule.");
assert.strictEqual(worked.generated.ownerName, "Ada Lovelace");
assert.strictEqual(worked.generated.identity.ownerName, "Ada Lovelace");
assert.deepStrictEqual(worked.generated.identity.displayNames.map((row) => row.value), ["A. Lovelace", "Al"]);
assert.strictEqual(worked.generated.identity.displayNames[0].id, "identity:displayNames:a-lovelace");
assert.strictEqual(worked.generated.identity.displayNames[0].source, "auto");
assert.strictEqual(worked.generated.identity.displayNames[1].id, "identity:displayNames:al");
assert.deepStrictEqual(worked.generated.identity.nicknames.map((row) => row.value), ["Ada"]);
assert.strictEqual(worked.generated.identity.nicknames[0].id, "identity:nicknames:ada");
assert.deepStrictEqual(worked.generated.identity.orgs.map((row) => ({ id: row.id, value: row.value, source: row.source })), [
  { id: "identity:orgs:analytical-engines", value: "Analytical Engines", source: "auto" },
]);
assert.deepStrictEqual(worked.generated.identity.emails.map((row) => row.address), ["ada@example.com", "ada@other.com"]);
assert.ok(worked.generated.identity.emails.every((row) => row.source === "account"));
assert.ok(!JSON.stringify(worked.generated.identity).includes("stranger@example.com"));
assert.ok(!JSON.stringify(worked.generated.identity.emails).includes("old@example.com"));
assert.ok(!worked.generated.identity.nicknames.some((row) => row.value === "Al" || row.value === "ok"));

const locked = mergeIdentity(priorIdentity, {
  ownerName: "Ada",
  identity: {
    ownerName: "Ada",
    displayNames: [],
    nicknames: [],
    orgs: [],
    emails: ["stranger@example.com"],
  },
}, [{ address: "Ada <ada@example.com>", accountId: "acct-1", kind: "primary" }]);
assert.ok(locked.emails.some((row) => row.address === "ada@example.com" && row.source === "account"));
assert.ok(!locked.emails.some((row) => row.address === "stranger@example.com"));
assert.deepStrictEqual(locked.nicknames, []);

const incomplete = { generated: JSON.parse(JSON.stringify(priorIdentity)) };
applyGenerated(incomplete, {}, { messages: [{ id: "m1" }] }, "refresh", accountEmails);
assert.deepStrictEqual(incomplete.generated.identity.nicknames.map((row) => row.value), ["Ada"]);
assert.deepStrictEqual(incomplete.generated.identity.orgs.map((row) => row.value), ["Old Org"]);
assert.deepStrictEqual(incomplete.generated.identity.emails.map((row) => row.address), ["ada@example.com", "ada@other.com"]);
assert.ok(!incomplete.generated.identity.nicknames.some((row) => row.value === "Al"));

const keptMail = mergeIdentity(priorIdentity, {
  ownerName: "Ada Lovelace",
  identity: {
    ownerName: "Ada Lovelace",
    displayNames: [],
    nicknames: [],
    orgs: [],
  },
}, null);
assert.strictEqual(keptMail.ownerName, "Ada Lovelace");
assert.deepStrictEqual(keptMail.emails.map((row) => row.address), ["ada@example.com", "old@example.com"]);
assert.ok(keptMail.emails.every((row) => row.source === "account"));
const keptMissing = mergeIdentity(priorIdentity, { ownerName: "Ada Lovelace" }, null);
assert.deepStrictEqual(keptMissing.nicknames.map((row) => row.value), ["Ada"]);
assert.deepStrictEqual(keptMissing.orgs.map((row) => row.value), ["Old Org"]);
assert.deepStrictEqual(keptMissing.emails.map((row) => row.address), ["ada@example.com", "old@example.com"]);

const rebuiltIdentity = { generated: JSON.parse(JSON.stringify(priorIdentity)), userRules: [] };
applyGenerated(rebuiltIdentity, {
  ownerName: "Ada Lovelace",
  writing: ["Rebuilt tone."],
  sections: [],
}, { messages: [{ id: "m1" }] }, "rebuild", accountEmails);
assert.deepStrictEqual(rebuiltIdentity.generated.writing, ["Rebuilt tone."]);
assert.deepStrictEqual(rebuiltIdentity.generated.identity.nicknames.map((row) => row.value), ["Ada"]);
assert.deepStrictEqual(rebuiltIdentity.generated.identity.emails.map((row) => row.address), ["ada@example.com", "ada@other.com"]);

const forgottenNick = forgetIdentity(priorIdentity.identity, "identity:nicknames:ada");
assert.strictEqual(forgottenNick.removed, true);
assert.deepStrictEqual(forgottenNick.identity.nicknames, []);
assert.strictEqual(forgottenNick.identity.emails.length, 2);
const forgottenMail = forgetIdentity(priorIdentity.identity, "identity:emails:ada@example.com");
assert.strictEqual(forgottenMail.removed, false);
assert.strictEqual(forgottenMail.identity, priorIdentity.identity);
assert.strictEqual(forgetIdentity(null, "identity:nicknames:ada").removed, false);

const weakFix = rewriteIdentityItem(priorIdentity.identity, "identity:nicknames:ada", "Al");
assert.strictEqual(weakFix.error, "That nickname is too short or too generic to keep.");
assert.strictEqual(weakFix.identity, priorIdentity.identity);
assert.strictEqual(weakFix.wrote, false);
const mailFix = rewriteIdentityItem(priorIdentity.identity, "identity:emails:ada@example.com", "nope@example.com");
assert.strictEqual(mailFix.error, "Account addresses stay with the connected mailbox.");
assert.strictEqual(mailFix.identity, priorIdentity.identity);
const renamed = rewriteIdentityItem(priorIdentity.identity, "identity:nicknames:ada", "Augusta");
assert.strictEqual(renamed.wrote, true);
assert.strictEqual(renamed.identity.nicknames[0].value, "Augusta");
assert.strictEqual(renamed.identity.nicknames[0].id, "identity:nicknames:augusta");
assert.strictEqual(renamed.identity.nicknames[0].source, "auto");

const manyNames = Array.from({ length: 10 }, (_item, index) => `Name ${index} distinct`);
const cappedIdentity = mergeIdentity(null, {
  ownerName: "",
  identity: { ownerName: "", displayNames: manyNames, nicknames: [], orgs: [] },
}, []);
assert.strictEqual(cappedIdentity.displayNames.length, SECTION_ROW_CAP);
assert.strictEqual(cappedIdentity.ownerName, "You");
assert.deepStrictEqual(cappedIdentity.emails, []);

const brief = identityBriefFrom(worked.generated);
assert.strictEqual(brief.ownerName, "Ada Lovelace");
assert.deepStrictEqual(brief.aka, ["A. Lovelace", "Al", "Ada"]);
assert.deepStrictEqual(brief.emails, ["ada@example.com", "ada@other.com"]);
assert.deepStrictEqual(brief.orgs, ["Analytical Engines"]);
assert.strictEqual(identityBriefFrom({ identity: { ownerName: "You", displayNames: [], nicknames: [], orgs: [], emails: [] } }), null);
assert.strictEqual(identityBriefFrom(null), null);
assert.deepStrictEqual(identityBriefFrom({
  identity: {
    ownerName: "You",
    displayNames: [{ value: "Ada" }],
    nicknames: [{ value: "ada" }, { value: "Addie" }],
    orgs: [],
    emails: [{ address: "ada@example.com" }],
  },
}), { aka: ["Ada", "Addie"], emails: ["ada@example.com"] });
assert.deepStrictEqual(identityPriorForPrompt(worked.generated), {
  ownerName: "Ada Lovelace",
  displayNames: ["A. Lovelace", "Al"],
  nicknames: ["Ada"],
  orgs: ["Analytical Engines"],
});

const composeSettings = {
  ccByDomain: {},
  bccByDomain: {},
  accounts: {
    "acct-1": {
      aliases: [{ address: "alias@example.com", domain: "" }],
      preferredFromAddress: "pref@example.com",
      defaultDomain: "",
    },
    "acct-2": {
      aliases: [{ address: "ada@example.com", domain: "" }],
      preferredFromAddress: "",
      defaultDomain: "",
    },
  },
};
const priorSend = [
  { address: "send@example.com", source: "account", accountId: "acct-1", kind: "sendAs" },
  { address: "gone@example.com", source: "account", accountId: "acct-old", kind: "primary" },
];
const unknownSend = collectIdentityEmails([
  { id: "acct-1", email: "ada@example.com", send_as_json: null },
], composeSettings, priorSend);
assert.deepStrictEqual(unknownSend.map((row) => `${row.address}:${row.kind}:${row.accountId}`), [
  "ada@example.com:primary:acct-1",
  "send@example.com:sendAs:acct-1",
  "alias@example.com:alias:acct-1",
  "pref@example.com:alias:acct-1",
]);
assert.ok(unknownSend.every((row) => row.source === "account"));
const knownEmpty = collectIdentityEmails([
  { id: "acct-1", email: "ada@example.com", send_as_json: "[]" },
], composeSettings, priorSend);
assert.ok(!knownEmpty.some((row) => row.address === "send@example.com"));
assert.ok(knownEmpty.some((row) => row.address === "ada@example.com" && row.kind === "primary"));
const cachedSend = collectIdentityEmails([
  {
    id: "acct-1",
    email: "ada@example.com",
    send_as_json: JSON.stringify({
      email: "ada@example.com",
      identities: [
        { email: "send@example.com", verified: true },
        { email: "pending@example.com", verificationStatus: "pending" },
        { email: "nope@example.com", verified: false },
      ],
    }),
  },
], composeSettings, priorSend);
assert.ok(cachedSend.some((row) => row.address === "send@example.com" && row.kind === "sendAs"));
assert.ok(!cachedSend.some((row) => row.address === "pending@example.com" || row.address === "nope@example.com"));
const badCache = collectIdentityEmails([
  { id: "acct-1", email: "ada@example.com", send_as_json: "{not-json" },
], composeSettings, priorSend);
assert.ok(badCache.some((row) => row.address === "send@example.com" && row.kind === "sendAs"));
const ranked = collectIdentityEmails([
  {
    id: "acct-1",
    email: "ada@example.com",
    send_as_json: JSON.stringify([{ email: "shared@example.com", verified: true }]),
  },
  { id: "acct-2", email: "shared@example.com", send_as_json: "[]" },
], composeSettings, []);
assert.deepStrictEqual(ranked.map((row) => `${row.address}:${row.kind}:${row.accountId}`), [
  "ada@example.com:primary:acct-1",
  "alias@example.com:alias:acct-1",
  "pref@example.com:alias:acct-1",
  "shared@example.com:primary:acct-2",
]);
assert.deepStrictEqual(collectIdentityEmails([], composeSettings, priorSend), []);

console.log("brain persona distill checks passed");
