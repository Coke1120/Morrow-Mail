// Offline renderer regressions: synthetic DOM/IPC, including local-day boundaries.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { renderer } = require("./check-ux-workflows");

function fixture() {
  const nodes = new Map();
  const document = { activeElement: null, getElementById: node,
    querySelector: selector => selector === "dialog[open]" ? [...nodes.values()].find(n => n.open) : null };
  function node(id) {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, { id, value: "", textContent: "", open: false, checked: false, hidden: false,
        disabled: false, options: [{ value: "primary" }], events: {}, attrs: {},
        classList: { add: n => classes.add(n), remove: (...ns) => ns.forEach(n => classes.delete(n)),
          contains: n => classes.has(n), toggle() {} },
        focus() { document.activeElement = this; }, scrollIntoView() {}, closest() { return null; },
        getAttribute(k) { return this.attrs[k]; }, setAttribute(k, v) { this.attrs[k] = String(v); },
        addEventListener(k, fn) { this.events[k] = fn; }, querySelector() { return null; }, querySelectorAll() { return []; },
        showModal() { this.open = true; }, close() { this.open = false; this.events.close?.(); } });
    }
    return nodes.get(id);
  }
  const ui = renderer({ document });
  const source = fs.readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8");
  for (const [id, event] of [["calendar-event-dialog", "close"], ["calendar-cancel", "click"]]) {
    const listener = source.match(new RegExp('\\$\\("' + id + '"\\)\\.addEventListener\\("' + event + '", \\(\\) => \\{[\\s\\S]*?\\n  \\}\\);'));
    assert.ok(listener, id + " listener"); ui.run(listener[0]);
  }
  ui.run(`state.accounts=[{id:'box',email:'box@example.test',platform:'imap'},
      {id:'other',email:'other@example.test',platform:'imap'}];
    state.accountId=state.calendarAccountId=state.calendarChecksAccountId='box';
    state.calendarId='primary';state.calendarIds=['primary'];state.calendarCursor=new Date(2026,9,1);
    state.view='mail';globalThis.calls=[];globalThis.reads=[];globalThis.writes=[];globalThis.notices=[];
    showStatus=(text,error)=>notices.push({text,error});saveCalendarChecks=()=>{};
    openDialog=id=>$(id).showModal();closeDialog=id=>$(id).close();
    fillCalendarAccounts=()=>{};setPageBusy=()=>{};paintCalendar=()=>{};paintCalendarShell=()=>{};
    globalThis.oldPayload={api:true,accountId:'box',calendarIds:['primary'],calendars:[{id:'primary'}],events:[]};
    state.calendarPayload=oldPayload;
    globalThis.key=calendarCacheKey(calendarAccount(),monthRange(2026,9),['primary']);
    globalThis.secondKey=calendarCacheKey(calendarAccount(),monthRange(2026,10),['primary','second']);
    globalThis.otherKey=calendarCacheKey({id:'other'},monthRange(2026,9),['primary']);
    rememberCalendar(key,oldPayload);rememberCalendar(secondKey,oldPayload);
    rememberCalendar(otherKey,{...oldPayload,accountId:'other'});
    call=(channel,payload)=>{
      calls.push({channel,payload});
      if(channel==='calendar:status')return Promise.resolve({});
      return new Promise((resolve,reject)=>(channel==='calendar:list'?reads:writes).push({resolve,reject}));
    };
    openCalendarEditor(null,'2026-10-25');$('calendar-pick').value='primary';
    $('calendar-event-title').value='Synthetic meeting';
    globalThis.submit={preventDefault(){}};
  `);
  return { ui, node, document, cancel: () => node("calendar-cancel").events.click() };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

async function cancelThenReopen() {
  for (const editing of [false, true]) {
    const { ui, cancel } = fixture();
    if (editing) ui.run(`openCalendarEditor({id:'event',calendarId:'primary',title:'Existing',
      start:'2026-10-25T09:00:00',end:'2026-10-25T10:00:00'})`);
    ui.run("globalThis.saving=submitCalendarForm(submit)"); cancel();
    ui.run("writes[0].resolve({id:'saved'})"); await ui.run("saving");
    assert.equal(ui.run("calendarCache.has(key) || calendarCache.has(secondKey)"), false, "success invalidates saved mailbox months after Cancel");
    assert.equal(ui.run("calendarCache.has(otherKey)"), true, "another mailbox keeps its cache");
    assert.equal(ui.run("notices.length"), 0, "old editor does not replace newer status");
    const reopened = ui.run("loadCalendar({preferCache:true})");
    assert.equal(ui.run("reads.length"), 1, "reopening cannot reuse the pre-save month");
    ui.run("reads[0].resolve({...oldPayload,events:[{id:'saved'}]})"); await reopened;
    assert.equal(ui.run("state.calendarPayload.events[0].id"), "saved");
  }
}

async function canceledVisibleCalendar() {
  const { ui, cancel, node } = fixture();
  ui.run("globalThis.saving=submitCalendarForm(submit)"); cancel(); ui.run("state.view='calendar';writes[0].resolve({})");
  await tick();
  assert.equal(ui.run("reads.length"), 1, "a closed editor on the visible calendar refreshes the current month");
  ui.run("reads[0].resolve({...oldPayload,events:[{id:'saved'}]})"); await ui.run("saving");
  assert.equal(node("calendar-event-dialog").open, false);
  assert.equal(ui.run("state.calendarPayload.events.length"), 1);
}

async function newerEditorAndStaleRead() {
  const { ui, cancel, node } = fixture();
  const oldRead = ui.run("loadCalendar()");
  ui.run("globalThis.saving=submitCalendarForm(submit)"); cancel();
  ui.run("openCalendarEditor(null,'2026-11-03');$('calendar-event-title').value='Newer unsaved event';state.view='calendar'");
  node("calendar-form-status").textContent = "Newer feedback";
  ui.run("writes[0].resolve({})"); await ui.run("saving");
  assert.equal(ui.run("calendarCache.has(key)"), false);
  assert.equal(node("calendar-event-dialog").open, true);
  assert.equal(node("calendar-event-title").value, "Newer unsaved event");
  assert.equal(node("calendar-form-status").textContent, "Newer feedback");
  assert.equal(ui.run("reads.length"), 1, "old save does not repaint under a newer editor");
  ui.run("state.calendarPayload={...oldPayload,marker:'newer'};reads[0].resolve(oldPayload)"); await oldRead;
  assert.equal(ui.run("calendarCache.has(key)"), false, "a pre-save list response cannot restore invalidated data");
  assert.equal(ui.run("state.calendarPayload.marker"), "newer");
  cancel(); ui.run("state.view='mail'");
  const fresh = ui.run("loadCalendar({preferCache:true})");
  assert.equal(ui.run("reads.length"), 2, "new reads do not coalesce with the discarded pre-save request");
  ui.run("reads[1].resolve({...oldPayload,events:[{id:'saved'}]})"); await fresh;
}

async function accountSwitchAndFailure() {
  const { ui, node } = fixture();
  ui.run("globalThis.saving=submitCalendarForm(submit);state.calendarAccountId='other';state.calendarChecksAccountId='other';state.calendarPayload={accountId:'other',events:[]}");
  ui.run("writes[0].resolve({})"); await ui.run("saving");
  assert.equal(ui.run("calendarCache.has(key)"), false);
  assert.equal(ui.run("calendarCache.has(otherKey)"), true);
  assert.equal(ui.run("state.calendarPayload.accountId"), "other");
  assert.equal(ui.run("reads.length || notices.length"), 0);
  assert.equal(node("calendar-event-dialog").open, true);
  const failed = fixture();
  failed.ui.run("globalThis.saving=submitCalendarForm(submit);writes[0].reject(new Error('Synthetic rejection'))");
  await failed.ui.run("saving");
  assert.equal(failed.ui.run("calendarCache.has(key)"), true, "a rejected write preserves the known month");
  assert.match(failed.node("calendar-form-status").textContent, /Synthetic rejection/);
}

async function reorderedMonthReads() {
  for (const failedOldRead of [false, true]) {
    const { ui, cancel } = fixture();
    const old = ui.run("loadCalendar()");
    ui.run("globalThis.saving=submitCalendarForm(submit)"); cancel();
    ui.run("writes[0].resolve({})"); await ui.run("saving");
    const fresh = ui.run("loadCalendar({preferCache:true})");
    assert.equal(ui.run("reads.length"), 2, "post-save read cannot join an older pending request");
    ui.run("reads[1].resolve({...oldPayload,events:[{id:'confirmed'}]})"); await fresh;
    ui.run(failedOldRead ? "reads[0].reject(new Error('Old read failed'))" : "reads[0].resolve(oldPayload)");
    await old;
    assert.equal(ui.run("state.calendarPayload.events[0].id"), "confirmed");
    assert.equal(ui.run("calendarCache.get(key).payload.events[0].id"), "confirmed");
  }
}

async function validationBeforeDescriptionDiff() {
  const { ui, node, document } = fixture();
  ui.run(`openCalendarEditor({id:'event',calendarId:'primary',title:'Preview',titleTruncated:true,
    description:'Read-only preview',descriptionTruncated:true,start:'2026-10-25T09:00:00',end:'2026-10-25T10:00:00'})`);
  node("calendar-end").value = "2026-10-25T08:00";
  await ui.run("submitCalendarForm(submit)");
  assert.match(node("calendar-form-status").textContent, /Pick a start and a later end/);
  assert.doesNotMatch(node("calendar-form-status").textContent, /incomplete/);
  assert.equal(document.activeElement, node("calendar-form-status"));
  assert.equal(node("calendar-description").value, "Read-only preview");
  assert.equal(ui.run("calls.length"), 0);
  node("calendar-end").value = "2026-10-25T10:00";
  ui.run("globalThis.saving=submitCalendarForm(submit)");
  assert.equal(ui.run("calls[0].channel"), "calendar:updateEvent");
  assert.equal(ui.run("Object.hasOwn(calls[0].payload,'title') || Object.hasOwn(calls[0].payload,'description')"), false, "correcting dates preserves complete title/description values");
  ui.run("writes[0].resolve({})"); await tick();
  ui.run("reads[0].resolve(oldPayload)"); await ui.run("saving");
  assert.equal(node("calendar-event-dialog").open, false);
}

function mailControls() {
  const { ui, node, document } = fixture(); node("calendar-event-dialog").open = false;
  ui.run("state.view='mail'");
  let clicks = 0, moves = 0;
  const row = node("mail-row"); row.classList.add("cursor"); row.click = () => clicks++;
  row.scrollIntoView = () => moves++;
  node("messages").querySelectorAll = () => [row];
  for (const id of ["list-next", "list-prev", "refresh", "scheduled-open", "filter-chip", "select-visible", "reader-link", "custom-button"]) {
    const target = node(id); const selector = id === "select-visible" ? "input" : id === "reader-link" ? "a[href]" : id === "custom-button" ? "[role='button']" : "button";
    target.closest = query => query.split(",").some(q => q.trim() === selector) ? target : null;
    document.activeElement = target;
    for (const key of ["Enter", "ArrowDown", "ArrowUp"]) {
      let prevented = false;
      ui.context.keyEvent = { key, target, preventDefault() { prevented = true; } };
      ui.run("onShellKey(keyEvent)");
      assert.equal(prevented, false, id + " keeps " + key);
      assert.equal(document.activeElement, target);
    }
  }
  assert.equal(clicks + moves, 0);
  const target = node("message-list"); document.activeElement = target;
  ui.context.keyEvent = { key: "Enter", target, preventDefault() {} }; ui.run("onShellKey(keyEvent)");
  assert.equal(clicks, 1, "list background still opens its highlighted message");
  document.activeElement = row; ui.context.keyEvent.target = row;
  ui.run("onShellKey(keyEvent)"); assert.equal(clicks, 1, "focused mail row uses native Enter once");
  ui.context.keyEvent.key = "ArrowDown"; ui.run("onShellKey(keyEvent)"); assert.equal(moves, 1);
}

function dayBoundaries() {
  const ui = renderer();
  function covers(start, end, day, expected, allDay = false) {
    ui.context.event = { start, end, allDay }; ui.context.day = day;
    assert.equal(ui.run("eventCoversDay(event,day)"), expected, JSON.stringify({ tz: process.env.TZ, start, end, day }));
  }
  covers("2026-10-31T23:00:00", "2026-11-01T01:00:00", "2026-10-31", true);
  covers("2026-10-31T23:00:00", "2026-11-01T01:00:00", "2026-11-01", true);
  covers("2026-10-31T23:00:00", "2026-11-01T00:00:00", "2026-11-01", false);
  covers("2026-10-31T23:00:00", "2026-11-03T01:00:00", "2026-11-02", true);
  covers("2026-10-31T23:00:00", "2026-11-03T01:00:00", "2026-11-04", false);
  covers("2026-10-31", "2026-11-02", "2026-11-01", true, true);
  covers("2026-10-31", "2026-11-02", "2026-11-02", false, true);
  covers("2026-10-25T09:00:00", "", "2026-10-25", true);
  covers("invalid", "invalid", "2026-10-25", false);
  if (process.env.TZ === "America/New_York") {
    covers("2026-03-08T03:30:00-04:00", "2026-03-09T00:30:00-04:00", "2026-03-09", true);
    covers("2026-03-09T00:10:00-04:00", "2026-03-09T00:20:00-04:00", "2026-03-08", false);
    covers("2026-11-01T23:30:00-05:00", "2026-11-02T00:00:00-05:00", "2026-11-01", true);
    covers("2026-11-01T23:30:00-05:00", "2026-11-02T00:00:00-05:00", "2026-11-02", false);
    covers("2026-11-01T01:30:00-04:00", "2026-11-01T01:15:00-05:00", "2026-11-01", true);
  }
  if (process.env.TZ === "Asia/Hong_Kong") covers("2026-10-31T15:30:00Z", "2026-10-31T16:30:00Z", "2026-11-01", true);
  if (process.env.TZ === "America/Sao_Paulo") {
    covers("2018-11-04T01:00:00-02:00", "2018-11-05T00:00:00-02:00", "2018-11-04", true);
    covers("2018-11-05T00:10:00-02:00", "2018-11-05T00:20:00-02:00", "2018-11-04", false);
  }
}

async function run() {
  const failures = [];
  for (const test of [cancelThenReopen, canceledVisibleCalendar, newerEditorAndStaleRead, accountSwitchAndFailure, reorderedMonthReads, validationBeforeDescriptionDiff, mailControls]) {
    try { await test(); } catch (e) { failures.push(test.name); console.error(test.name + ": " + e.message); }
  }
  for (const tz of ["UTC", "America/New_York", "Asia/Hong_Kong", "America/Sao_Paulo"]) {
    const result = spawnSync(process.execPath, [__filename, "--days"], { env: { ...process.env, TZ: tz }, encoding: "utf8", timeout: 5000 });
    if (result.status !== 0) { failures.push(tz); console.error(result.stderr || result.error); }
  }
  assert.deepEqual(failures, [], "calendar and keyboard regressions");
  console.log("calendar-keyboard-followup-ok (Cancel/read races, local dates in 4 time zones, focused controls, form errors; no live I/O)");
}
module.exports = { run };
if (require.main === module) {
  const timer = setTimeout(() => { console.error("Unresolved UI fixture"); process.exit(1); }, 10000);
  Promise.resolve().then(() => process.argv.includes("--days") ? dayBoundaries() : run())
    .catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(timer));
}
