// Synthetic Gmail service shared by offline cache/engine checks. No sockets or credentials.
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { createRequire } = require("node:module");
const { createGmailMailApi } = require("../host/mail/gmail-mail-api");
const ROOT = "/gmail/v1/users/me";
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
function message(id, labels = ["INBOX"], rfc = `<${id}@fixture.invalid>`) {
  return { id, threadId: `thread-${id}`, internalDate: "1792886400000", snippet: `Synthetic ${id}`, labelIds: labels,
    payload: { mimeType: "text/plain", headers: [{ name: "Message-ID", value: rfc }, { name: "From", value: "sender@fixture.invalid" },
      { name: "To", value: "owner@fixture.invalid" }, { name: "Subject", value: `Synthetic ${id}` }, { name: "Date", value: "Sun, 25 Oct 2026 00:00:00 +0000" }],
    body: { data: Buffer.from(`Synthetic body ${id}`).toString("base64url") } } };
}
function server(initial = []) {
  const messages = new Map(initial.map(row => [row.id, structuredClone(row)]));
  const drafts = new Map(), calls = [], mime = [];
  const labels = [{ id: "INBOX", name: "INBOX", type: "system" }, { id: "SENT", name: "SENT", type: "system" },
    { id: "DRAFT", name: "DRAFT", type: "system" }, { id: "TRASH", name: "TRASH", type: "system" }, { id: "SPAM", name: "SPAM", type: "system" }, { id: "Label_work", name: "Work", type: "user" }];
  let counter = 100, historyId = "100", history = [], pageSize = 500, expire = false, hold;
  async function fetcher(input, options = {}) {
    const url = new URL(String(input));
    if (url.origin !== "https://gmail.googleapis.com" || !url.pathname.startsWith(ROOT)) throw new Error(`Forbidden fixture network destination: ${url.origin}`);
    const route = url.pathname.slice(ROOT.length), method = options.method || "GET";
    calls.push({ route, method, query: url.searchParams, body: options.body ? JSON.parse(options.body) : null, signal: options.signal });
    assertSafe(route, method);
    if (hold) { const pending = hold; hold = null; await pending; }
    if (route === "/profile") return json({ emailAddress: "owner@fixture.invalid", historyId });
    if (route === "/history") {
      if (expire) { expire = false; return json({}, 404); }
      return json({ historyId, history });
    }
    if (route === "/labels" && method === "GET") return json({ labels });
    if (route === "/labels" && method === "POST") {
      const label = { id: `Label_${++counter}`, name: JSON.parse(options.body).name, type: "user" };
      labels.push(label); return json(label);
    }
    if (route.startsWith("/labels/") && method === "PATCH") {
      const label = labels.find(row => row.id === decodeURIComponent(route.split("/")[2]));
      Object.assign(label, JSON.parse(options.body)); return json(label);
    }
    if (route === "/messages") {
      const query = url.searchParams.get("q") || "", wanted = url.searchParams.getAll("labelIds");
      let rows = [...messages.values()].filter(row => wanted.every(label => row.labelIds.includes(label)));
      if (query.startsWith("rfc822msgid:")) rows = rows.filter(row => row.payload.headers.some(h => h.name.toLowerCase() === "message-id" && h.value.replace(/^<|>$/g, "") === query.slice(12)));
      else if (url.searchParams.get("includeSpamTrash") !== "true") rows = rows.filter(row => !row.labelIds.some(id => ["TRASH", "SPAM"].includes(id)));
      const offset = Number(url.searchParams.get("pageToken") || 0), limit = Math.min(pageSize, Number(url.searchParams.get("maxResults") || 100));
      return json({ messages: rows.slice(offset, offset + limit).map(row => ({ id: row.id, threadId: row.threadId })),
        ...(offset + limit < rows.length ? { nextPageToken: String(offset + limit) } : {}) });
    }
    if (route === "/messages/send" || (route === "/drafts" && method === "POST")) {
      const body = JSON.parse(options.body), raw = Buffer.from(body.raw || body.message?.raw, "base64url"); mime.push(raw);
      const header = /^message-id:\s*(.+)$/mi.exec(raw.toString())?.[1]?.trim();
      const id = `created-${++counter}`, saved = message(id, [route.includes("/send") ? "SENT" : "DRAFT"], header);
      messages.set(id, saved);
      if (route.includes("/send")) return json(saved);
      const draft = { id: `draft-${counter}`, message: saved }; drafts.set(draft.id, draft); return json(draft);
    }
    if (route.startsWith("/drafts/") && method === "GET") return drafts.has(route.split("/")[2]) ? json(drafts.get(route.split("/")[2])) : json({}, 404);
    if (route === "/drafts") return json({ drafts: [...drafts.values()] });
    const match = /^\/messages\/([^/]+)(?:\/(.*))?$/.exec(route);
    if (match) {
      const row = messages.get(decodeURIComponent(match[1])), action = match[2];
      if (!row) return json({}, 404);
      if (action?.startsWith("attachments/")) return json({ data: Buffer.from("Synthetic attachment").toString("base64url") });
      if (action === "modify") {
        const body = JSON.parse(options.body);
        if ([...body.addLabelIds, ...body.removeLabelIds].some(id => ["SENT", "DRAFT"].includes(id)) || row.labelIds.includes("DRAFT")) return json({}, 400);
        row.labelIds = [...new Set([...row.labelIds.filter(id => !body.removeLabelIds.includes(id)), ...body.addLabelIds])];
      }
      if (action === "trash") row.labelIds = [...new Set([...row.labelIds.filter(id => id !== "INBOX"), "TRASH"])];
      if (action === "untrash") row.labelIds = row.labelIds.filter(id => id !== "TRASH");
      return json(row);
    }
    throw new Error(`Unhandled synthetic Gmail route ${method} ${route}`);
  }
  function assertSafe(route, method) { if (method === "DELETE" && !route.startsWith("/labels/")) throw new Error("Fixture forbids permanent mail deletion"); }
  return { fetcher, messages, drafts, calls, mime, labels,
    api: () => createGmailMailApi({ accessToken: async () => "synthetic-token", fetchImpl: fetcher }),
    pageSize: value => { pageSize = value; }, history: (events, next = "101") => { history = events; historyId = next; },
    expire: () => { expire = true; }, hold: promise => { hold = promise; } };
}

function vmLoad(filename, replacements) {
  const module = { exports: {} }, load = createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), { module, exports: module.exports,
    require: name => Object.hasOwn(replacements, name) ? replacements[name] : load(name), __dirname: path.dirname(filename),
    Buffer, TextDecoder, TextEncoder, URL, process, console, setTimeout, clearTimeout, setImmediate });
  return module.exports;
}

function cacheRuntime() {
  try { return { db: require("../host/mail/db"), createSession: require("../host/mail/gmail-session").createSession, native: true }; }
  catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }
  // This VM has no installed app dependencies. Exercise the production SQL with
  // Node's SQLite; CI runs these same cases against the real persistence/parser.
  const { DatabaseSync } = require("node:sqlite");
  class FixturePersistence {
    constructor() { this.initialized = false; }
    async open() {
      const sql = new DatabaseSync(":memory:");
      return { run: (text, params = []) => sql.prepare(text).run(...params), close: () => sql.close(),
        getRowsModified: () => sql.prepare("SELECT changes() AS n").get().n,
        prepare(text) {
          const stmt = sql.prepare(text); let args = [], rows, current;
          return { bind: values => { args = values; rows = stmt.iterate(...args); }, step: () => { const row = rows.next(); current = row.value; return !row.done; },
            getAsObject: () => ({ ...current }), run: values => stmt.run(...values), free() {} };
        } };
    }
    initialize() {} close() { return Promise.resolve(); }
  }
  const db = vmLoad(require.resolve("../host/mail/db"), { "./persistence": { Persistence: FixturePersistence } });
  const parse = async bytes => {
    const headers = Object.fromEntries(bytes.toString().trim().split(/\r?\n/).map(line => { const i = line.indexOf(":"); return [line.slice(0, i).toLowerCase(), line.slice(i + 1).trim()]; }));
    const addresses = value => ({ value: String(value || "").split(",").filter(Boolean).map(address => ({ address: address.trim() })) });
    return { messageId: headers["message-id"], subject: headers.subject, date: new Date(headers.date), inReplyTo: headers["in-reply-to"],
      from: addresses(headers.from), to: addresses(headers.to), cc: addresses(headers.cc), bcc: addresses(headers.bcc) };
  };
  return { db, native: false, createSession: vmLoad(require.resolve("../host/mail/gmail-session"), { "./db": db, mailparser: { simpleParser: parse } }).createSession };
}

module.exports = { server, message, cacheRuntime };
