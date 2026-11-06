// Only fixed categories cross the renderer boundary or enter a retry prompt.
// Never echo provider output, mail, AJV paths or offending values.
const categories = Object.freeze({
  parse: "Return one complete JSON object only, with no prose, comments or trailing content. Use valid JSON escaping and unique keys.",
  schema: "Use exactly the required fields. Keep every text value on one line and between 1 and 500 characters. Thread events need summary, open_actions and unclear; each array has at most 25 items. Case sections have at most 12 items, with text, uncertainty and source_message_ids. Compact repeated evidence instead of concatenating partial summaries.",
  reference: "Use only the supplied source tokens or UUIDs. Thread output needs exactly one event per supplied token, without repeats or omissions. Case citations must support the item, and mentioned dates must match the original cited text exactly.",
  incomplete: "The previous response was incomplete. Return the entire required JSON object within the output limit. Keep entries concise, preserve required sources and uncertainty, and remove repetition.",
});
const stages = new Set(["extraction", "consolidation", "case"]);
const longest = Object.keys(categories).reduce((left, right) => categories[left].length >= categories[right].length ? left : right);

function retryFeedback(category = longest) {
  const key = Object.hasOwn(categories, category) ? category : longest;
  return ` Previous output failed validation (${key}). ${categories[key]}`;
}
function validationDetails(error) {
  const value = error?.validation;
  return error?.code === "timeline-validation" && stages.has(value?.stage)
    && Object.hasOwn(categories, value?.category) && value?.attempts === 2
    ? { stage: value.stage, category: value.category, attempts: 2 } : null;
}

module.exports = { retryFeedback, validationDetails };
