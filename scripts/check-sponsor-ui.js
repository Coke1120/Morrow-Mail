// Sponsor entry points in Features and Settings. No network, credentials, or mailbox I/O.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const SPONSORS = "https://github.com/sponsors/Coke1120";
const COFFEE = "https://buymeacoffee.com/coke1120";
const LINK = (href, label) => `href="${href}" target="_blank" rel="noreferrer">${label}</a>`;

const catalog = require("../renderer/features-catalog.js");
const card = catalog.items.find((row) => row && row.id === "sponsor-support");
assert.ok(card, "features catalog missing sponsor-support");
assert.equal(card.category, "Support");
assert.equal(card.title, "Support the project");
assert.match(card.blurb, /GitHub Sponsors/);
assert.match(card.blurb, /Buy Me a Coffee/);
assert.match(card.blurb, /These links open in your browser/);
assert.ok(!card.blurb.includes(SPONSORS), "sponsor URL belongs in the rendered link, not plain text");
assert.ok(!card.blurb.includes(COFFEE), "coffee URL belongs in the rendered link, not plain text");

const html = fs.readFileSync(path.join(root, "renderer/index.html"), "utf8");
const about = html.slice(html.indexOf('id="about-dialog"'), html.indexOf('id="changelog"'));
assert.ok(about.includes('<nav class="about-links" aria-label="Support">'));
assert.ok(about.includes('<span class="hint">Support</span>'));
assert.ok(about.includes(LINK(SPONSORS, "GitHub Sponsors")));
assert.ok(about.includes(LINK(COFFEE, "Buy Me a Coffee")));

const nav = html.slice(html.indexOf('id="settings-nav"'), html.indexOf('class="settings-account-context"'));
const botTab = nav.indexOf('id="settings-tab-bot"');
const supportTab = nav.indexOf('id="settings-tab-support" data-fold="support" role="tab" aria-controls="settings-support"');
assert.ok(botTab >= 0 && supportTab > botTab, "Support tab follows Bot access");
assert.ok(nav.includes('>Support</button>'));

const supportAt = html.indexOf('<section class="fold" id="settings-support"');
const statusAt = html.indexOf('id="settings-status"');
assert.ok(html.indexOf('id="settings-bot"') < supportAt && supportAt < statusAt, "Support fold follows Bot access");
const fold = html.slice(supportAt, statusAt);
assert.ok(fold.includes('class="fold"') && fold.includes('data-fold="support"') && fold.includes('role="tabpanel"'));
assert.ok(fold.includes('aria-labelledby="settings-tab-support"'));
assert.ok(fold.includes('<nav class="about-links" aria-label="Support">'));
assert.ok(fold.includes(LINK(SPONSORS, "GitHub Sponsors")));
assert.ok(fold.includes(LINK(COFFEE, "Buy Me a Coffee")));
assert.equal(html.split(SPONSORS).length - 1, 2);
assert.equal(html.split(COFFEE).length - 1, 2);

const app = fs.readFileSync(path.join(root, "renderer/app.js"), "utf8");
assert.match(app, /if \(name === "support"\) return Promise\.resolve\(\);/);
assert.match(app, /settings-account-context"\)\.hidden = !\["mailbox", "ooo"\]\.includes\(name\)/);
assert.match(app, /\["mailbox", "ooo"\]\.includes\(name\) \? settingsAccount\(\)/);
assert.equal([...app.matchAll(/\["mailbox", "ooo"\]/g)].length, 2);

const boot = fs.readFileSync(path.join(__dirname, "check-boot-path.js"), "utf8");
assert.ok(boot.includes('"scripts/check-sponsor-ui.js"'));
assert.ok(boot.includes('path.join(__dirname, "check-sponsor-ui.js")'));

console.log("sponsor-ui-ok");
