"use strict";

// Features claims must agree with the actual host allowlist. UI command examples
// run through the real CLI parser with intercepted transports and synthetic files.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { parseDocument, DomUtils } = require("htmlparser2");

function run() {
  const catalog = require("../host/bot/catalog");
  const constants = require("../host/bot/constants");
  const contract = require("../shared/bot-contract-v1.json");
  const source = fs.readFileSync(require.resolve("../renderer/app.js"), "utf8");
  const html = fs.readFileSync(require.resolve("../renderer/index.html"), "utf8");
  const dom = parseDocument(html);
  const byId = id => DomUtils.findOne(node => node.attribs?.id === id, dom.children, true);
  const text = node => DomUtils.textContent(node).replace(/\s+/g, " ").trim();
  const operations = DomUtils.findAll(node => Object.hasOwn(node.attribs || {}, "data-bot-operation"), byId("cli-operations").children).map(text);
  assert.equal(operations.length, new Set(operations).size, "do not duplicate capability entries");
  assert.deepEqual(operations.slice().sort(), catalog.operations().slice().sort(), "update the CLI tab when host operations change");
  assert.deepEqual(operations.slice().sort(), Object.keys(contract.operations).sort());
  const unavailable = text(byId("cli-unavailable"));
  for (const phrase of ["attachment upload/attach/download", "mailbox draft create/edit/delete", "full thread", "reply-all/forward", "read/unread", "move/archive/delete", "calendar"]) assert.ok(unavailable.includes(phrase), phrase);
  const accountSafety = text(byId("cli-account-safety"));
  for (const phrase of ["connected, granted mailbox", "NOT_FOUND", "direct message IDs", "proposal lists", "do not automatically delete retained legacy data"]) assert.ok(accountSafety.includes(phrase), phrase);
  const providerSemantics = text(byId("cli-provider-semantics"));
  for (const phrase of ["may contact providers", "providerCalls", "true when mail.send", "Cached reads stay local", "not a per-request network count", "replay/join", "OAuth refresh", "not absence of provider traffic"]) assert.ok(providerSemantics.includes(phrase), phrase);
  const diagnostics = text(byId("ipc-diagnostics-note"));
  for (const phrase of ["known channel names/counts", "Request values, renderer text and URLs are omitted", "Other Debug entries"]) assert.ok(diagnostics.includes(phrase), phrase);
  const connection = text(byId("cli-connection"));
  assert.ok(connection.includes(constants.SERVE_CAPABILITY));
  assert.ok(connection.includes(`${constants.HOST}:${constants.PORT}`));
  for (const phrase of ["v1.92+", "HTTPS", "readBridge: true", "0600", "installation ID", "Check connection", "does not configure Serve", "Keep Funnel off"]) assert.ok(connection.includes(phrase), phrase);
  const safety = text(byId("cli-send-safety"));
  for (const phrase of ["after From resolution", "before claiming", "after mailbox/credential waits", "before mail-provider submission", "cannot be recalled", "same ID and content", "SEND_OUTCOME_UNKNOWN", "partial delivery"]) assert.ok(safety.includes(phrase), phrase);
  for (const id of ["cli-connection", "cli-send-safety", "cli-json-examples"]) {
    assert.equal(byId(id).name, "details");
    assert.ok(DomUtils.findOne(node => node.name === "summary" && text(node), byId(id).children));
  }
  const examples = new Map(DomUtils.findAll(node => node.attribs?.["data-cli-json"], dom.children)
    .map(node => [node.attribs["data-cli-json"], JSON.parse(DomUtils.textContent(node))]));
  const context = {};
  vm.runInNewContext(source.slice(source.indexOf("function cliNote("), source.indexOf("function editableField(")), context);
  const rows = JSON.parse(JSON.stringify(context.cliCatalog()));
  const { invoke } = require("./check-bot-client");
  let checked = 0;
  for (const row of rows.filter(row => row.group === "Bot bridge")) {
    // These examples use only ordinary flags and single-quoted placeholders;
    // tokenize them without running a shell or looking up any local credential.
    const args = row.command.match(/'[^']*'|\S+/g).map(value => value.replace(/^'|'$/g, ""));
    assert.equal(args.shift(), "node");
    assert.equal(args.shift(), "scripts/morrow-bot-call.js");
    const value = flag => args[args.indexOf(flag) + 1];
    const operation = value("--operation");
    const spec = catalog.operation(operation);
    assert.ok(spec, operation);
    const params = examples.get(value("--params-file").replace(/^\.\//, ""));
    assert.ok(params, "each example needs a displayed JSON file");
    assert.ok(Object.keys(params).every(key => spec.params.includes(key)), operation);
    args[args.indexOf("--token-file") + 1] = "/synthetic-token";
    args[args.indexOf("--params-file") + 1] = "/synthetic-params";
    args[args.indexOf("--installation") + 1] = "11111111-1111-4111-8111-111111111111";
    if (operation === "mail.send") args[args.indexOf("--request-id") + 1] = "22222222-2222-4222-8222-222222222222";
    const result = invoke(undefined, { argv: args, params });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.requests.length, 1);
    assert.deepEqual(result.requests[0].body.params, params);
    assert.equal(result.requests[0].body.operation, operation);
    checked++;
  }
  assert.equal(checked, 4);
  const card = require("../renderer/features-catalog").items.find(row => row.id === "bot-bridge");
  assert.match(card.blurb, /separate send permission/i);
  assert.match(card.blurb, /inert drafts/);
  assert.match(card.blurb, /connected, granted mailboxes/);
  const accounts = require("../renderer/features-catalog").items.find(row => row.id === "multi-account");
  assert.match(accounts.blurb, /pending reconnects/);
  assert.match(accounts.blurb, /new connection after removal/);
  const trace = require("../renderer/features-catalog").items.find(row => row.id === "ipc-diagnostics");
  assert.match(trace.blurb, /Request values, renderer text and URLs are omitted/);
  assert.match(trace.blurb, /Other Debug entries/);
  console.log(`cli-capabilities-ok: ${operations.length} host operations; ${checked} intercepted command examples`);
}

module.exports = { run };
if (require.main === module) run();
