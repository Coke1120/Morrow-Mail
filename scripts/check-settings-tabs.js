// Settings keyboard access (#151): roving tabindex in the markup plus the real
// ArrowLeft/ArrowRight/Home/End handlers for both tablists, without a browser.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "renderer/index.html"), "utf8");

function attrs(source) {
  const found = {};
  for (const match of source.matchAll(/([\w-]+)="([^"]*)"/g)) found[match[1]] = match[2];
  return found;
}

function tablist(startId, closeTag) {
  const start = html.indexOf(`id="${startId}"`);
  assert.ok(start >= 0, `${startId} missing from renderer/index.html`);
  const end = html.indexOf(closeTag, start);
  assert.ok(end > start, `${startId} is not closed`);
  return [...html.slice(start, end).matchAll(/<button\b[^>]*>/g)]
    .map((match) => attrs(match[0]))
    .filter((tab) => tab.role === "tab");
}

function assertRoving(list, name) {
  assert.ok(list.length >= 2, `${name} has too few tabs`);
  const selected = list.filter((tab) => tab["aria-selected"] === "true");
  assert.equal(selected.length, 1, `${name} needs exactly one selected tab`);
  for (const tab of list) {
    const expected = tab === selected[0] ? "0" : "-1";
    assert.equal(tab.tabindex, expected, `${name} ${tab.id} must be tabindex="${expected}"`);
    assert.ok(html.includes(`id="${tab["aria-controls"]}"`), `${name} ${tab.id} controls a missing panel`);
  }
  assert.equal(new Set(list.map((tab) => tab.id)).size, list.length, `${name} repeats a tab id`);
  return selected[0];
}

const settings = tablist("settings-nav", "</nav>");
const bot = tablist("bot-sections", "</div>");
assertRoving(settings, "settings-nav");
const staticBotTab = assertRoving(bot, "bot-sections");
assert.equal(staticBotTab.id, "bot-tab-local", "Bot access opens on the local section");

function makeDocument() {
  const nodes = new Map();
  const doc = {
    activeElement: null,
    getElementById: (id) => nodes.get(id) || null,
  };
  return { doc, nodes };
}

function makeTab(doc, spec) {
  const tab = {
    id: spec.id,
    tabIndex: spec.tabIndex,
    dataset: spec.dataset,
    focused: 0,
    attrs: { "aria-selected": spec.selected ? "true" : "false", "aria-controls": spec.controls },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; },
    focus() { this.focused += 1; doc.activeElement = this; },
  };
  return tab;
}

function makeNav(tabs) {
  return {
    dataset: {},
    handlers: {},
    querySelectorAll: (selector) => (selector === '[role="tab"]' ? tabs : []),
    querySelector(selector) {
      if (selector !== '[role="tab"][aria-selected="true"]') return null;
      return tabs.find((tab) => tab.getAttribute("aria-selected") === "true") || null;
    },
    addEventListener(type, handler) { this.handlers[type] = handler; },
    contains: (node) => tabs.includes(node),
  };
}

function press(nav, key) {
  const event = {
    key,
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
  };
  nav.handlers.keydown(event);
  return event;
}

const { doc, nodes } = makeDocument();
const settingsTabs = settings.map((tab) => makeTab(doc, {
  id: tab.id,
  dataset: { fold: tab["data-fold"] },
  tabIndex: Number(tab.tabindex),
  selected: tab["aria-selected"] === "true",
  controls: tab["aria-controls"],
}));
const settingsNav = makeNav(settingsTabs);
nodes.set("settings-nav", settingsNav);

const botTabs = bot.map((tab) => makeTab(doc, {
  id: tab.id,
  dataset: { botSection: tab["data-bot-section"] },
  tabIndex: Number(tab.tabindex),
  selected: tab["aria-selected"] === "true",
  controls: tab["aria-controls"],
}));
const botNav = makeNav(botTabs);
nodes.set("bot-sections", botNav);
for (const tab of botTabs) nodes.set(tab.getAttribute("aria-controls"), { hidden: true });

const context = vm.createContext({ window: { morrow: {} }, document: doc, console, setTimeout, clearTimeout });
const source = fs.readFileSync(path.join(root, "renderer/app.js"), "utf8")
  .replace(/boot\(\)\.catch\([^\n]+\);\s*$/, "");
vm.runInContext(source, context);
const run = (code) => vm.runInContext(code, context);
run(`globalThis.foldCalls = []; setSettingsFold = (name) => foldCalls.push(name);`);
run("wireSettingsFolds(); wireBotSections();");

// Settings sections: roving focus follows ArrowLeft/ArrowRight/Home/End.
doc.activeElement = settingsTabs[0];
let event = press(settingsNav, "ArrowRight");
assert.equal(doc.activeElement, settingsTabs[1], "ArrowRight moves to the next Settings section");
assert.equal(run("foldCalls").at(-1), "mail");
assert.equal(event.prevented, true);
assert.equal(settingsTabs[1].focused, 1, "the newly selected tab receives focus");

press(settingsNav, "ArrowLeft");
assert.equal(doc.activeElement, settingsTabs[0], "ArrowLeft moves back to the previous Settings section");
press(settingsNav, "ArrowLeft");
assert.equal(doc.activeElement, settingsTabs.at(-1), "ArrowLeft wraps to the last Settings section");
press(settingsNav, "Home");
assert.equal(doc.activeElement, settingsTabs[0]);
press(settingsNav, "End");
assert.equal(doc.activeElement, settingsTabs.at(-1));
press(settingsNav, "ArrowRight");
assert.equal(doc.activeElement, settingsTabs[0], "ArrowRight wraps to the first Settings section");

const before = run("foldCalls.length");
event = press(settingsNav, "ArrowUp");
assert.equal(event.prevented, false, "settings tabs are horizontal; vertical arrows are left to the panel");
assert.equal(run("foldCalls.length"), before);
assert.equal(doc.activeElement, settingsTabs[0]);

// Bot access sections: the real showBotSection keeps one tab in the tab order.
run("showBotSection('local')");
assert.equal(botTabs[0].tabIndex, 0);
assert.equal(botTabs[0].getAttribute("aria-selected"), "true");
assert.equal(nodes.get("bot-panel-local").hidden, false);

doc.activeElement = botTabs[0];
event = press(botNav, "ArrowRight");
assert.equal(doc.activeElement, botTabs[1], "ArrowRight moves to the next Bot section");
assert.equal(botTabs[1].tabIndex, 0);
assert.equal(botTabs[0].tabIndex, -1);
assert.equal(botTabs[1].getAttribute("aria-selected"), "true");
assert.equal(botTabs[0].getAttribute("aria-selected"), "false");
assert.equal(nodes.get("bot-panel-local").hidden, true);
assert.equal(nodes.get("bot-panel-tailscale").hidden, false);
assert.equal(event.stopped, true, "Bot arrow keys do not bubble into shell shortcuts");

press(botNav, "ArrowLeft");
assert.equal(doc.activeElement, botTabs[0]);
press(botNav, "End");
assert.equal(doc.activeElement, botTabs.at(-1));
assert.equal(botTabs.at(-1).dataset.botSection, "agent");
assert.equal(botTabs[3].tabIndex, 0);
press(botNav, "Home");
assert.equal(doc.activeElement, botTabs[0]);

// Reopening the fold restores the roving tabindex from the selected tab.
const grantsTab = botTabs.find((tab) => tab.dataset.botSection === "grants");
run("showBotSection('grants')");
grantsTab.tabIndex = -1;
run("syncBotSectionPanels(true)");
assert.equal(grantsTab.tabIndex, 0, "reopening Bot access makes the selected sub-tab tabbable");
assert.equal(botTabs.filter((tab) => tab.tabIndex === 0).length, 1);
assert.equal(grantsTab.getAttribute("aria-selected"), "true");
assert.equal(nodes.get("bot-panel-grants").hidden, false);

console.log("settings-tabs-ok (static roving tabindex, Settings + Bot arrow/Home/End, fold reopen)");
