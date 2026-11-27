"use strict";

// Optional real renderer QA (synthetic IPC, no account credentials or network).
const { chromium } = require(process.env.MORROW_PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs"), http = require("node:http"), path = require("node:path");
const root = path.resolve(__dirname, "..");

async function run() {
  const server = http.createServer((req, res) => {
    const target = path.resolve(root, "." + new URL(req.url, "http://localhost").pathname);
    if (!target.startsWith(root + path.sep)) return res.writeHead(403).end();
    if (req.url === "/favicon.ico") return res.writeHead(204).end();
    try {
      let body = fs.readFileSync(target);
      if (target === path.join(root, "renderer/app.js")) body = body.toString().replace(/boot\(\)\.catch\([^\n]+\);\s*$/, "");
      res.setHeader("Content-Type", target.endsWith(".js") ? "text/javascript" : target.endsWith(".css") ? "text/css" : "text/html");
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.MORROW_CHROMIUM || "/usr/bin/chromium", args: ["--no-sandbox"] });
    const errors = [], external = [];
    for (const [zone, fold] of [["Asia/Tokyo", false], ["America/New_York", true]]) {
      const page = await browser.newPage({ timezoneId: zone, viewport: { width: 1024, height: 720 }, reducedMotion: "reduce" });
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/*", route => {
        if (new URL(route.request().url()).origin === `http://127.0.0.1:${server.address().port}`) return route.continue();
        external.push(route.request().url()); return route.abort();
      });
      await page.addInitScript(() => { window.morrow = { on() {}, invoke() { throw new Error("Live IPC forbidden"); } }; });
      await page.goto(`http://127.0.0.1:${server.address().port}/renderer/index.html`);
      await page.evaluate(async () => {
        state.accounts = ["box", "other"].map(id => ({ id, bodyEpoch: 3, email: id + "@example.test", platform: "imap", authKind: "oauth2", imapSmtpProfile: "gmail", folders: { primary: [], more: [] } }));
        state.accountId = state.calendarAccountId = "box";
        state.calendarCursor = new Date(2027, 0, 1);
        state.view = "mail";
        globalThis.calendarCalls = []; globalThis.notices = [];
        showStatus = (message, error) => notices.push({ message, error });
        call = async (channel, payload) => {
          calendarCalls.push({ channel, payload });
          if (channel === "calendar:status") return { google: true };
          if (channel === "calendar:list") return { api: true, accountId: payload.accountId, calendars: [{ id: "primary", name: "Work" }], calendarIds: ["primary"], events: [] };
          if (channel === "calendar:createEvent") return { id: "synthetic" };
          throw Error("Unexpected IPC " + channel);
        };
        wire();
        await loadCalendar();
        calendarCalls.length = 0;
        globalThis.prepareMenu = text => {
          state.email = { id: "selected", accountId: "box", bodyEpoch: state.accounts[0].bodyEpoch, folderId: "Inbox", subject: "Booking", from: "Fixture <fixture@example.test>", date: "2027-01-10T08:00:00Z", hasBody: true, bodyComplete: true, textBody: text };
          renderReader(false);
          const body = $("reader").querySelector(".body");
          const selection = window.getSelection(), range = document.createRange();
          range.selectNodeContents(body);
          selection.removeAllRanges();
          selection.addRange(range);
          body.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 60, clientY: 180 }));
        };
      });

      const prepare = page.getByRole("menuitem", { name: "Prepare calendar event…" });
      const dialog = page.getByRole("dialog", { name: "Add event", exact: true });
      const excerpt = page.locator("#calendar-reader-excerpt");
      const text = fold ? "Rehearsal: 2027-11-07T01:15-05:00 to 2027-11-07T01:35-05:00"
        : "Tool induction is on 12 January 2027, 11:15–11:35 UTC+08:00";
      await page.evaluate(text => prepareMenu(text), text);
      await prepare.click();
      assert.equal(await dialog.isVisible(), true);
      assert.equal(await excerpt.innerText(), text);
      assert.equal(await page.locator("#calendar-reader-source").evaluate(node => node === document.activeElement), true);
      assert.deepEqual(await page.evaluate(() => calendarCalls), [], "selection opens no IPC or network requests");
      assert.equal(await page.locator("#calendar-description").inputValue(), "");
      if (fold) {
        assert.equal(await page.locator("#calendar-start").inputValue(), "", "DST overlap has no unsafe prefill");
        assert.equal(await page.locator("#calendar-end").inputValue(), "");
        assert.match(await page.locator("#calendar-reader-timing").innerText(), /No unambiguous start and end/);
        await dialog.getByRole("button", { name: "Cancel" }).click();
        assert.deepEqual(await page.evaluate(() => calendarCalls), []);
      } else {
        assert.equal(await page.locator("#calendar-event-title").inputValue(), "Tool induction");
        assert.equal(await page.locator("#calendar-start").inputValue(), "2027-01-12T12:15");
        assert.equal(await page.locator("#calendar-end").inputValue(), "2027-01-12T12:35");
        assert.match(await page.locator("#calendar-reader-timing").innerText(), /Asia\/Tokyo/);
        await page.locator("#calendar-event-title").fill("Tool induction (reviewed)");
        await dialog.getByRole("button", { name: "Add event", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
        const writes = await page.evaluate(() => calendarCalls.filter(row => row.channel === "calendar:createEvent"));
        assert.equal(writes.length, 1);
        const payload = writes[0].payload;
        assert.equal(payload.accountId, "box");
        assert.equal(payload.calendarId, "primary");
        assert.equal(payload.title, "Tool induction (reviewed)");
        assert.equal(payload.start, "2027-01-12T03:15:00.000Z");
        assert.equal(payload.end, "2027-01-12T03:35:00.000Z");
        assert.equal(payload.description, "");
        assert.equal(Object.hasOwn(payload, "attendees"), false);
        assert.equal(JSON.stringify(payload).includes("UTC+08:00"), false);
        await page.evaluate(text => prepareMenu("Deadline: " + text), text);
        await prepare.click();
        assert.equal(await page.locator("#calendar-start").inputValue(), "");
        await page.evaluate(() => { calendarCalls.length = 0; state.email = null; });
        await dialog.getByRole("button", { name: "Add event", exact: true }).click();
        assert.match(await page.locator("#calendar-form-status").innerText(), /source message or calendar mailbox changed/);
        assert.deepEqual(await page.evaluate(() => calendarCalls), [], "source changed, no provider call");
        await dialog.getByRole("button", { name: "Cancel" }).click();
        await dialog.waitFor({ state: "hidden" });
        await page.evaluate(text => { state.calendarAccountId = "other"; prepareMenu(text); }, text);
        await prepare.click();
        await page.waitForFunction(() => notices.some(row => row.message.includes("load its calendars")));
        assert.equal(await dialog.isVisible(), false);
        assert.deepEqual(await page.evaluate(() => calendarCalls), []);
        await page.evaluate(() => { state.calendarAccountId = "box"; notices.length = 0; });
        // A cached list from an earlier account incarnation cannot be reused.
        await page.evaluate(text => { state.accounts[0].bodyEpoch += 1; prepareMenu(text); }, text);
        await prepare.click();
        await page.waitForFunction(() => notices.some(row => row.message.includes("load its calendars")));
        assert.equal(await dialog.isVisible(), false);
        assert.deepEqual(await page.evaluate(() => calendarCalls), []);
        await page.evaluate(() => openCalendarEditor(null, "2027-01-13"));
        assert.equal(await page.locator("#calendar-reader-source").isVisible(), false);
        assert.equal(await page.locator("#calendar-start").inputValue(), "2027-01-13T09:00");
        await dialog.getByRole("button", { name: "Cancel" }).click();
        await page.evaluate(() => showFeatures());
        assert.match(await page.locator("#features-catalog").innerText(), /Prepare a calendar event from selected mail/);
      }
      await page.close();
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    console.log("reader-calendar-selection-browser-ok");
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
