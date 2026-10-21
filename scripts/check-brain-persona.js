const assert = require("assert");
const {
  SECTION_ROW_CAP,
  WRITING_CAP,
  personaSystemPrompt,
  normalizeWriting,
  normalizeSections,
  mergeRefreshSections,
  applyGenerated,
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
assert.match(rebuildPrompt, /Distill an Email Brain persona from scratch/);
assert.match(rebuildPrompt, /3 to 6 short tone rules/);
assert.match(rebuildPrompt, /communication-style, work-patterns, key-relationships, and decision-preferences/);
assert.match(rebuildPrompt, /Do not invent facts that are not in the mail/);
assert.match(rebuildPrompt, /at most 8/);
assert.match(rebuildPrompt, /does not edit mailbox messages/);

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

console.log("brain persona distill checks passed");
