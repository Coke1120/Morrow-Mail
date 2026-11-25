"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { JSDOM } = require("jsdom");
const { renderer } = require("./check-ux-workflows");

const moduleSource = fs.readFileSync(require.resolve("../renderer/reader-table-columns"), "utf8");
const entrySelector = "[data-reader-table-columns]";
const mail = '<table><thead><tr><th>Cartons</th><th>Waybill</th><th>Unloading bay</th></tr></thead>' +
  '<tbody><tr><td>0</td><td>00817</td><td></td></tr>' +
  '<tr><td>12</td><td>00922</td><td>North  &lt;bay&gt;</td></tr></tbody></table>';

function table(data, header = "<th>Waybill</th><th>Bay</th>") {
  return `<table><thead><tr>${header}</tr></thead><tbody>${data}</tbody></table>`;
}

function fixture(t) {
  const { window } = new JSDOM('<main id="reader"></main><aside id="peek"></aside>');
  t.after(() => window.close());
  const { document } = window;
  const clipboard = [];
  Object.defineProperty(window.navigator, "clipboard", { value: {
    async writeText(text) { clipboard.push(text); }
  } });
  const ui = renderer({ window, document });
  ui.run(moduleSource);
  ui.run("state.prefs.images = false; state.remoteAllowed = {}; state.accounts = [];");
  const reader = document.querySelector("#reader");
  return { ...ui, document, reader, clipboard, paint(html, { id = "mail", pane = "reader" } = {}) {
    ui.context.email = { id, htmlBody: html, textBody: "Plain version" };
    ui.context.pane = document.getElementById(pane);
    ui.run("pane.replaceChildren(); renderBody(pane, email)");
    return Array.from(ui.context.pane.querySelectorAll(entrySelector));
  } };
}

async function open(entry) {
  const opened = new Promise(resolve => entry.addEventListener("toggle", resolve, { once: true }));
  entry.open = true;
  await opened;
  return {
    checks: Array.from(entry.querySelectorAll("input[type=checkbox]")),
    copy: entry.querySelector("button"),
    preview: () => Array.from(entry.querySelectorAll("tbody tr"), row =>
      Array.from(row.cells, cell => cell.textContent))
  };
}

test("each table previews columns in click order and copies corrected data without headers", async t => {
  const f = fixture(t);
  const [first, second] = f.paint(mail + table("<tr><td>11</td><td>East</td></tr>"));
  assert.match(first.querySelector("summary").textContent, /Table 1.*Cartons, Waybill, Unloading bay/);
  assert.match(second.querySelector("summary").textContent, /Table 2.*Waybill, Bay/);
  const { checks: [cartons, waybill, bay], copy, preview } = await open(first);
  assert.equal(copy.disabled, true);
  cartons.click();
  waybill.click();
  bay.click();
  cartons.click();
  cartons.click();
  assert.match(first.textContent, /1\. Waybill → 2\. Unloading bay → 3\. Cartons/);
  assert.deepEqual(preview(), [["00817", "", "0"], ["00922", "North  <bay>", "12"]]);
  assert.equal(first.querySelector("tbody bay"), null);
  assert.deepEqual(f.clipboard, []);
  copy.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.clipboard, ["00817\t\t0\n00922\tNorth  <bay>\t12"]);
  assert.match(first.querySelector('[role="status"]').textContent, /Copied 2 data rows/);
  assert.equal((await open(second)).copy.disabled, true);
});

test("declines layout, nested and ambiguous headers, irregular rows and original spans lost to sanitizing", async t => {
  const f = fixture(t);
  const row = "<tr><td>00817</td><td>North</td></tr>";
  const layout = "<table><tr><td>Layout</td><td>" + mail + "</td></tr></table>";
  const [ragged, oversizedSpan, valid] = f.paint(layout +
    table(row, "<th>Bay</th><th> bay </th>") +
    table(row, "<th>Waybill</th><th> </th>") +
    table(row, "<th colspan=2>Waybill</th><th>Bay</th>") +
    table("<tr><td>00817</td></tr>") +
    table("<tr><td colspan=25>00817</td><td>North</td></tr>") + mail);
  assert.equal(f.reader.querySelectorAll(entrySelector).length, 3);
  assert.equal(f.reader.querySelector("[colspan='25']"), null);
  for (const entry of [ragged, oversizedSpan]) {
    assert.equal((await open(entry)).copy, null);
    assert.match(entry.textContent, /copy it manually/);
  }
  assert.ok((await open(valid)).copy);
  assert.deepEqual(f.clipboard, []);
});

test("omits hidden data rows and checks spreadsheet values only in selected columns", async t => {
  const f = fixture(t);
  const visible = "<tr><td>001</td><td>North</td></tr>";
  const [good, hiddenCell, formula, tab, originalHidden] = f.paint(
    table('<tr style="display:none"><td>Hidden row</td><td></td></tr>' + visible) +
    table('<tr><td>1<span style="opacity:0">Hidden cell text</span></td><td>North</td></tr>') +
    table("<tr><td> =1+1</td><td>North</td></tr>") +
    table("<tr><td>1&#9;2</td><td>North</td></tr>") +
    table(visible, "<th><span hidden>Hidden header</span>Waybill</th><th>Bay</th>"));
  const { checks, preview, copy } = await open(good);
  checks[0].click();
  assert.deepEqual(preview(), [["001"]]);
  copy.click();
  assert.deepEqual(f.clipboard, ["001"]);
  for (const entry of [hiddenCell, formula, tab]) {
    const panel = await open(entry);
    panel.checks[0].click();
    assert.equal(panel.copy.disabled, true);
    assert.doesNotMatch(entry.textContent, /Hidden cell text|Hidden header|=1\+1/);
    panel.checks[0].click();
    panel.checks[1].click();
    panel.copy.click();
  }
  assert.deepEqual(f.clipboard, ["001", "North", "North", "North"]);
  assert.equal((await open(originalHidden)).copy, null);
  assert.doesNotMatch(originalHidden.textContent, /Hidden header/);
});

test("keeps controls outside mail and invalidates stale previews across Reader paints", async t => {
  const f = fixture(t);
  assert.deepEqual(f.paint(mail, { pane: "peek" }), []);
  const [entry] = f.paint(mail);
  const { checks, copy } = await open(entry);
  checks[1].click();
  assert.equal(f.reader.querySelector(".body").querySelector(entrySelector), null);
  assert.doesNotMatch(f.reader.querySelector(".body").textContent, /Paste order|Copy visible/);
  f.reader.querySelector(".body tbody tr").style.display = "none";
  copy.click();
  assert.match(entry.querySelector('[role="status"]').textContent, /table changed/);
  f.reader.querySelector('[data-action="plain-body"]').click();
  assert.equal(f.reader.querySelector(entrySelector), null);
  copy.click();
  f.reader.querySelector('[data-action="plain-body"]').click();
  assert.equal((await open(f.reader.querySelector(entrySelector))).copy.disabled, true);
  f.paint(table("<tr><td>009</td><td>West</td></tr>"), { id: "next" });
  copy.click();
  assert.deepEqual(f.clipboard, []);
});
