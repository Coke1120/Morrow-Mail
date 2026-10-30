// Offline renderer regressions. Synthetic DOM/IPC only; no browser or host.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { renderer } = require("./check-ux-workflows");

function fixture() {
  const nodes = new Map();
  const document = {
    activeElement: null,
    getElementById: node,
    createElement: () => element(),
    querySelector(selector) {
      if (selector === "dialog[open]") return [...nodes.values()].find(row => row.open) || null;
      if (selector === ".workspace") return node("workspace");
      return null;
    },
  };
  function element(id = "") {
    const classes = new Set();
    return {
      id, value: "", textContent: "", checked: false, hidden: false, disabled: false,
      open: false, dataset: {}, attrs: {}, children: [], options: [], events: {},
      classList: {
        add: value => classes.add(value), remove: value => classes.delete(value),
        contains: value => classes.has(value),
        toggle(value, force) {
          const on = force === undefined ? !classes.has(value) : force;
          on ? classes.add(value) : classes.delete(value); return on;
        },
      },
      focus() { document.activeElement = this; }, scrollIntoView() {},
      append(...rows) { this.children.push(...rows); },
      appendChild(row) { this.children.push(row); },
      replaceChildren(...rows) { this.children = rows; },
      setAttribute(key, value) { this.attrs[key] = String(value); },
      getAttribute(key) { return this.attrs[key] ?? null; },
      removeAttribute(key) { delete this.attrs[key]; },
      addEventListener(key, handler) { this.events[key] = handler; },
      querySelector() { return null; }, querySelectorAll() { return []; },
      closest() { return null; },
      showModal() { this.open = true; }, close() { this.open = false; },
    };
  }
  function node(id) { if (!nodes.has(id)) nodes.set(id, element(id)); return nodes.get(id); }
  const ui = renderer({ document });
  return { ui, node, document, event: () => ({ preventDefault() {} }) };
}

function signatures() {
  const f = fixture();
  f.node("signatures").open = true;
  f.ui.run(`
    state.accounts = [{id:'box',email:'box@example.test',platform:'imap'},
      {id:'other-box',email:'other@example.test',platform:'imap'}];
    state.accountId = signatureEditorAccountId = 'box';
    showSignatureEditor = () => {};
    refreshComposeSignatures = async () => {};
    globalThis.calls = []; globalThis.pending = [];
    call = (channel,payload) => {
      calls.push({channel,payload:JSON.parse(JSON.stringify(payload))});
      if(channel === 'mail:listSignatures') return Promise.resolve({signatures:[]});
      return new Promise((resolve,reject) => pending.push({resolve,reject}));
    };
    globalThis.sigA = {id:'sig-a',name:'Signature A',text:'A original'};
    globalThis.sigB = {id:'sig-b',name:'Signature B',text:'B edited'};
  `);
  return f;
}

async function signatureSwitch() {
  const { ui, node, event } = signatures();
  ui.context.submit = event();
  ui.run(`startSignatureEdit(sigA,false); globalThis.saveA=submitSignature(submit);`);
  assert.equal(node("signature-save").disabled, true);
  ui.run(`startSignatureEdit(sigB,false); pending[0].resolve({id:'sig-a'});`);
  await ui.run("saveA");
  assert.equal(node("signature-name").value, "Signature B");
  assert.equal(node("signature-body").value, "B edited");
  assert.equal(node("signature-save").disabled, false);
  ui.run("globalThis.saveB=submitSignature(submit)");
  assert.equal(ui.run("calls.at(-1).payload.id"), "sig-b", "B keeps its own save target after A completes");
  ui.run("pending[1].resolve({id:'sig-b'})"); await ui.run("saveB");
}

async function signatureReordered() {
  for (const order of [[1, 0], [0, 1]]) {
    const { ui, node, event } = signatures();
    ui.context.submit = event();
    ui.run(`startSignatureEdit(sigA,false); globalThis.saveA=submitSignature(submit);
      startSignatureEdit(sigB,false); globalThis.saveB=submitSignature(submit);`);
    for (const index of order) {
      ui.run(`pending[${index}].resolve({id:'sig-${index ? "b" : "a"}'})`);
      await ui.run(index ? "saveB" : "saveA");
      if (index === 0 && order[0] === 0) assert.equal(node("signature-save").disabled, true, "A cannot unlock B's pending save");
    }
    ui.run("globalThis.saveAgain=submitSignature(submit)");
    assert.equal(ui.run("calls.at(-1).payload.id"), "sig-b", "an older completion cannot retarget a newer save");
    assert.equal(node("signature-name").value, "Signature B");
    ui.run("pending[2].resolve({id:'sig-b'})"); await ui.run("saveAgain");
  }
}

async function signatureRepeatedAdd() {
  const { ui, node, event } = signatures();
  ui.context.submit = event();
  node("signature-name").value = "New signature";
  node("signature-body").value = "Keep this text";
  ui.run("globalThis.add=submitSignature(submit)");
  const duplicate = ui.run("submitSignature(submit)");
  assert.equal(ui.run("calls.length"), 1, "pending Add submits once");
  assert.equal(node("signature-save").disabled, true);
  assert.equal(node("signature-save").textContent, "Saving…");
  ui.run("pending[0].reject(new Error('Fixture save failure'))"); await ui.run("add");
  await duplicate;
  assert.equal(node("signature-save").disabled, false);
  assert.match(node("signatures-status").textContent, /Fixture save failure/);
  assert.equal(node("signature-body").value, "Keep this text");
  ui.run("globalThis.retry=submitSignature(submit); pending[1].resolve({id:'created'});");
  await ui.run("retry");
  ui.run("globalThis.edit=submitSignature(submit)");
  assert.equal(ui.run("calls.at(-1).payload.id"), "created", "a successful Add becomes an edit");
  ui.run("pending[2].resolve({id:'created'})"); await ui.run("edit");
}

async function signatureStaleFailureAndClose() {
  for (const changed of ["edit", "clear", "close", "account"]) {
    const { ui, node, event } = signatures();
    ui.context.submit = event();
    ui.run("startSignatureEdit(sigA,false); globalThis.save=submitSignature(submit)");
    if (changed === "edit") ui.run("startSignatureEdit(sigB,false)");
    if (changed === "clear") ui.run("clearSignatureForm()");
    if (changed === "close") {
      node("signatures").open = false;
      // Reopening runs clearSignatureForm even for the same mailbox.
      ui.run("clearSignatureForm(); startSignatureEdit(sigB,false)");
      node("signatures").open = true;
    }
    if (changed === "account") ui.run("signatureEditorAccountId='other-box'; clearSignatureForm(); startSignatureEdit(sigB,false)");
    node("signatures-status").textContent = "New editor feedback";
    ui.run("pending[0].reject(new Error('Old editor failure'))"); await ui.run("save");
    assert.equal(node("signatures-status").textContent, "New editor feedback", changed);
    assert.equal(node("signature-save").disabled, false, changed);
  }
}

async function signatureListOrder() {
  const { ui, node } = signatures();
  ui.run(`globalThis.reads=[];
    call=()=>new Promise(resolve=>reads.push(resolve));
    globalThis.oldRead=loadSignatureEditor(); globalThis.newRead=loadSignatureEditor();
    reads[1]({signatures:[sigB]});`);
  await ui.run("newRead");
  ui.run("reads[0]({signatures:[sigA]})"); await ui.run("oldRead");
  assert.equal(node("signature-list").children[0].children[0].textContent, "Signature B");
}

function keyboard() {
  const { ui, node, document } = fixture();
  let clicks = 0, scrolls = 0, prevented = 0;
  const row = node("mail-row"); row.classList.add("cursor");
  row.click = () => clicks++; row.scrollIntoView = () => scrolls++;
  node("messages").querySelectorAll = () => [row];
  ui.run(`paintSyncControl=()=>{}; refreshAiSetupState=()=>{};
    hidePane=id=>{$(id).hidden=true}; revealPanel=id=>{$(id).hidden=false};`);
  const target = node("calendar-event");
  ui.context.keyEvent = { key: "Enter", target, preventDefault() { prevented++; } };
  for (const view of ["calendar", "brain", "agent", "folders", "log", "features"]) {
    ui.context.nextView = view;
    ui.run("showPrimary(nextView,nextView+'-panel')");
    document.activeElement = target;
    for (const key of ["ArrowDown", "ArrowUp", "Enter"]) {
      ui.context.keyEvent.key = key; ui.run("onShellKey(keyEvent)");
      assert.equal(document.activeElement, target, "non-mail focus remains on its control: " + view);
    }
  }
  assert.equal(prevented, 0); assert.equal(clicks, 0); assert.equal(scrolls, 0);
  ui.run("showPrimary('mail','shell')");
  ui.context.keyEvent.key = "ArrowDown"; ui.run("onShellKey(keyEvent)");
  assert.equal(document.activeElement, row); assert.equal(scrolls, 1);
  document.activeElement = target;
  ui.context.keyEvent.key = "Enter"; ui.run("onShellKey(keyEvent)");
  assert.equal(clicks, 1, "Mail still opens its highlighted message");
  document.activeElement = row; ui.run("onShellKey(keyEvent)");
  assert.equal(clicks, 1, "focused message retains native Enter instead of a second synthetic click");
  target.closest = selector => selector.includes("input") ? target : null;
  document.activeElement = target;
  ui.context.keyEvent.key = "ArrowDown"; ui.run("onShellKey(keyEvent)");
  assert.equal(document.activeElement, target, "typing fields retain arrow keys");
  target.closest = () => null; node("dialog").open = true;
  ui.run("onShellKey(keyEvent)"); assert.equal(document.activeElement, target, "dialogs retain focus");
}

function calendar() {
  const f = fixture();
  f.node("calendar-event-dialog").open = true;
  f.node("calendar-pick").value = "primary";
  f.node("calendar-event-title").value = "Synthetic meeting";
  f.node("calendar-start").value = "2026-10-25T09:00";
  f.node("calendar-end").value = "2026-10-25T10:00";
  f.ui.run(`state.accounts=[{id:'box',email:'box@example.test',platform:'imap'}];
    state.accountId='box'; state.calendarId='primary'; state.calendarIds=['primary'];
    globalThis.calls=[]; globalThis.notices=[];
    showStatus=(text,error)=>notices.push({text,error});
    loadCalendar=async()=>{};
    call=async(channel,payload)=>{calls.push({channel,payload});return {};};`);
  return f;
}

async function calendarErrors() {
  for (const invalid of ["title", "dates"]) {
    const { ui, node, document, event } = calendar();
    if (invalid === "title") node("calendar-event-title").value = "";
    else node("calendar-end").value = "2026-10-25T08:00";
    ui.context.submit = event(); await ui.run("submitCalendarForm(submit)");
    assert.match(node("calendar-form-status").textContent, invalid === "title" ? /Add a title/ : /later end/);
    assert.equal(node("calendar-form-status").classList.contains("error"), true);
    assert.equal(document.activeElement, node("calendar-form-status"));
    assert.equal(node("calendar-event-dialog").open, true);
    assert.equal(ui.run("calls.length"), 0);
  }
  for (const edit of [false, true]) {
    const { ui, node, document, event } = calendar();
    ui.context.submit = event();
    if (edit) ui.run(`calendarEditingId='event';calendarEditingIdentity={id:'event',accountId:'box',calendarId:'primary',description:'',location:''};`);
    ui.run(`call=async(channel,payload)=>{calls.push({channel,payload});throw new Error('Fixture save failed; try again later.');};`);
    await ui.run("submitCalendarForm(submit)");
    assert.equal(ui.run("calls[0].channel"), edit ? "calendar:updateEvent" : "calendar:createEvent");
    assert.match(node("calendar-form-status").textContent, /Fixture save failed/);
    assert.equal(document.activeElement, node("calendar-form-status"));
    assert.equal(node("calendar-event-dialog").open, true);
    assert.equal(node("calendar-event-title").value, "Synthetic meeting");
    assert.equal(node("calendar-start").value, "2026-10-25T09:00");
    assert.equal(ui.run("state.busy || calendarWritePending"), false, "form can retry after failure");
    ui.run(`call=async(channel,payload)=>{calls.push({channel,payload});return {};};`);
    await ui.run("submitCalendarForm(submit)");
    assert.equal(node("calendar-form-status").textContent, "");
    assert.equal(node("calendar-event-dialog").open, false);
  }
}

async function calendarStaleError() {
  for (const changed of ["editor", "closed", "account"]) {
    const { ui, node, document, event } = calendar(); ui.context.submit = event();
    ui.run(`call=()=>new Promise((_resolve,reject)=>{globalThis.rejectSave=reject});
      globalThis.saving=submitCalendarForm(submit);`);
    if (changed === "editor") ui.run("calendarEditorGeneration++");
    if (changed === "closed") node("calendar-event-dialog").open = false;
    if (changed === "account") ui.run("state.accounts.push({id:'other-box',platform:'imap'});state.calendarAccountId='other-box'");
    node("calendar-form-status").textContent = "New event feedback";
    document.activeElement = node("calendar-event-title");
    ui.run("rejectSave(new Error('Old event save failed'))"); await ui.run("saving");
    assert.equal(node("calendar-form-status").textContent, "New event feedback", changed);
    assert.equal(document.activeElement, node("calendar-event-title"), changed);
  }
  const { ui } = calendar();
  let prevented = false;
  ui.context.submit = { preventDefault() { prevented = true; } };
  ui.run("state.busy=true"); await ui.run("submitCalendarForm(submit)");
  assert.equal(prevented, true, "even a busy form prevents native navigation");
}

function help() {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "renderer/index.html"), "utf8");
  const app = fs.readFileSync(path.join(root, "renderer/app.js"), "utf8");
  assert.match(html.match(/<p id="calendar-form-status"[^>]*>/)?.[0] || "", /role="alert"[^>]*tabindex="-1"/);
  assert.match(app, /\$\("calendar-create"\)\.addEventListener\("submit", submitCalendarForm\)/);
  const catalog = require("../renderer/features-catalog");
  assert.match(catalog.items.find(row => row.id === "signatures").blurb, /Saving/);
  assert.match(catalog.items.find(row => row.id === "calendar").blurb, /errors.*dialog/i);
  const { ui, node } = fixture();
  ui.context.window.morrowFeaturesCatalog = catalog;
  ui.run("paintFeatureCatalog(); paintShortcuts()");
  const text = el => [el.textContent, ...el.children.map(text)].join(" ");
  assert.match(text(node("features-catalog")), /Signatures.*Saving…/);
  assert.match(text(node("features-catalog")), /Save errors appear in the event dialog/);
  assert.match(text(node("features-catalog")), /On the Mail page/);
  assert.match(text(node("features-catalog")), /Timed events appear on each local date they overlap/);
  assert.match(text(node("features-catalog")), /Closing a pending save does not cancel it/);
  assert.match(text(node("features-catalog")), /Invalid dates are reported before description preview restrictions/);
  assert.match(node("shortcuts-note").textContent, /list.*Mail page/i);
  assert.match(node("shortcuts-note").textContent, /Focused buttons and links keep their own keys/);
  assert.match(html, /<form id="calendar-create" aria-describedby="calendar-save-note">/);
  assert.match(html, /id="calendar-save-note"[^>]*>Cancel closes this editor, not a pending save or delete/);
}

async function run() {
  const checks = [signatureSwitch, signatureReordered, signatureRepeatedAdd, signatureStaleFailureAndClose,
    signatureListOrder, keyboard, calendarErrors, calendarStaleError, help];
  const failures = [];
  let timer;
  try {
    await Promise.race([
      (async () => {
        for (const check of checks) {
          try { await check(); }
          catch (error) { failures.push(check.name); console.error(check.name + ": " + error.message); }
        }
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("UI fixture left an operation unresolved")), 10000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  assert.deepEqual(failures, [], "renderer UI regressions");
  console.log("ui-editor-feedback-ok (signature races, mail-only keys, calendar inline errors; no live I/O)");
}
module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
