// Synthetic DOM/VM content check, not rendered/native validation.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { documentFor } = require("./check-chatgpt-ui");
const { renderer } = require("./check-ux-workflows");
const document = documentFor(fs.readFileSync(require.resolve("../renderer/index.html"), "utf8"));
const ui = renderer({ document, window: { morrow: { invoke: async () => null } }, setTimeout: () => 1, clearTimeout() {} });
ui.context.window.morrowFeaturesCatalog = require("../renderer/features-catalog");
ui.run("paintFeatureCatalog()");
for (const id of ["features-catalog", "settings-gmail-migration"]) {
  const text = document.getElementById(id).textContent;
  for (const pattern of [/Gmail.*Trash/, /Microsoft.*unchanged/, /OAuth/, /migration.*(?:unavailable|not available)/i]) assert.match(text, pattern);
}
assert.match(document.getElementById("settings-gmail-migration").textContent, /existing full scope bundle/);
console.log("gmail-mail-api-ui-ok: synthetic Features/Accounts help; migration remains unavailable");
