const assert = require("node:assert/strict");
const net = require("node:net");
const sieve = require("../host/mail/sieve-vacation");
const vacation = require("../host/mail/vacation-api");

const mail = { email: "owner@example.invalid", password: "app-password", imapHost: "imap.example.com" };
const greeting = '"IMPLEMENTATION" "fixture"\r\n"SIEVE" "fileinto vacation date relational"\r\n"SASL" "PLAIN"\r\n"SASL-IR"\r\n"STARTTLS"\r\nOK "ready"\r\n';

function bufferReader(socket) {
  let buffer = Buffer.alloc(0);
  const readers = [];
  let failed = null;
  const fail = (error) => {
    failed = failed || error;
    while (readers.length) readers.shift().reject(failed);
  };
  const flush = () => {
    while (readers.length && !failed) {
      const reader = readers[0];
      if (reader.bytes == null) {
        const index = buffer.indexOf("\r\n");
        if (index < 0) return;
        const line = buffer.subarray(0, index).toString("utf8");
        buffer = buffer.subarray(index + 2);
        readers.shift();
        reader.resolve(line);
      } else if (buffer.length < reader.bytes) return;
      else {
        const data = buffer.subarray(0, reader.bytes);
        buffer = buffer.subarray(reader.bytes);
        readers.shift();
        reader.resolve(data);
      }
    }
  };
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    flush();
  });
  socket.on("error", fail);
  const enqueue = (reader) => new Promise((resolve, reject) => {
    if (failed) reject(failed);
    else {
      readers.push({ ...reader, resolve, reject });
      flush();
    }
  });
  return { line: () => enqueue({}), bytes: (bytes) => enqueue({ bytes }) };
}

function withServer(handler) {
  const server = net.createServer();
  const closed = new Promise((resolve) => {
    server.on("close", resolve);
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const done = new Promise((finish, fail) => {
        server.once("connection", (socket) => handler(socket).then(finish, fail));
      });
      const socket = net.connect(server.address());
      resolve({
        socket,
        done,
        async close() {
          server.close();
          await closed;
        },
      });
    });
    server.on("error", reject);
  });
}

async function run() {
  const plain = sieve.buildVacation({ subject: 'Away "today"', message: "Back soon.", start: "", end: "", useDate: false });
  assert.equal(sieve.parseVacation(plain).message, "Back soon.");
  assert.equal(sieve.parseVacation(plain).subject, 'Away "today"');
  const dated = sieve.buildVacation({
    subject: "",
    message: "Line\n.keep",
    start: "2090-10-01T08:00:00.000Z",
    end: "2090-10-02T09:00:00.000Z",
    useDate: true,
  });
  const parsed = sieve.parseVacation(dated);
  assert.equal(parsed.mode, "scheduled");
  assert.equal(parsed.message, "Line\n.keep");
  assert.equal(parsed.start, "2090-10-01T00:00:00.000Z");
  assert.equal(parsed.end, "2090-10-03T00:00:00.000Z");
  const midnight = sieve.buildVacation({
    subject: "",
    message: "Hi",
    start: "2090-10-01T00:00:00.000Z",
    end: "2090-10-02T00:00:00.000Z",
    useDate: true,
  });
  const snapped = sieve.parseVacation(midnight);
  assert.equal(snapped.end, "2090-10-02T00:00:00.000Z");
  assert.equal(sieve.parseVacation(sieve.buildVacation({
    subject: snapped.subject,
    message: snapped.message,
    start: snapped.start,
    end: snapped.end,
    useDate: true,
  })).end, snapped.end);
  assert.equal(sieve.parseVacation('keep; vacation "nope";\n'), null);
  assert.equal(vacation.plainFromHtml("<b>Provider formatted</b>"), "Provider formatted");
  assert.equal(vacation.revisionOf("same"), vacation.revisionOf("same"));
  assert.notEqual(vacation.revisionOf("same"), vacation.revisionOf("other"));

  const calls = [];
  const described = await vacation.read("google", "token", async (url, init) => {
    calls.push({ url: String(url), method: init.method || "GET", redirect: init.redirect });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          enableAutoReply: true,
          responseSubject: "Away",
          responseBodyPlainText: "",
          responseBodyHtml: "<b>Provider formatted</b>",
          restrictToContacts: false,
          restrictToDomain: false,
          startTime: "3810528000000",
        });
      },
    };
  });
  assert.equal(calls[0].redirect, "error");
  assert.match(calls[0].url, /\/settings\/vacation$/);
  assert.equal(described.settings.message, "Provider formatted");
  assert.equal(described.settings.start, "2090-10-01T08:00:00.000Z");

  const session = await withServer(async (socket) => {
    const io = bufferReader(socket);
    socket.write(greeting);
    assert.equal(await io.line(), "STARTTLS");
    socket.write("OK\r\n");
    assert.equal(await io.line(), "CAPABILITY");
    socket.write(greeting);
    const auth = await io.line();
    assert.equal(Buffer.from(auth.split('"')[3], "base64").toString(), `\0${mail.email}\0${mail.password}`);
    socket.write("OK\r\n");
    assert.equal(await io.line(), "LISTSCRIPTS");
    socket.write('"other-filters" ACTIVE\r\nOK\r\n');
    socket.end();
  });
  await assert.rejects(
    sieve.runVacation(session.socket, mail, { action: "put", script: 'require ["vacation"];\nvacation :days 1 "Hi";\n' }, async (value) => value),
    /will not replace/,
  );
  await session.done;
  await session.close();

  let stored = "";
  const write = await withServer(async (socket) => {
    const io = bufferReader(socket);
    socket.write(greeting);
    assert.equal(await io.line(), "STARTTLS");
    socket.write("OK\r\n");
    assert.equal(await io.line(), "CAPABILITY");
    socket.write(greeting);
    await io.line();
    socket.write("OK\r\n");
    assert.equal(await io.line(), "LISTSCRIPTS");
    socket.write("OK\r\n");
    const upload = await io.line();
    assert.match(upload, /^PUTSCRIPT "morrow-vacation" \{(\d+)\+\}$/);
    stored = (await io.bytes(Number(upload.match(/\{(\d+)/)[1]))).toString("utf8");
    socket.write("OK\r\n");
    assert.equal(await io.line(), 'SETACTIVE "morrow-vacation"');
    socket.write("OK\r\n");
    assert.equal(await io.line(), 'GETSCRIPT "morrow-vacation"');
    const bytes = Buffer.from(stored);
    socket.write(`{${bytes.length}}\r\n`);
    socket.write(bytes);
    socket.write("OK\r\n");
    assert.equal(await io.line(), "LOGOUT");
    socket.end();
  });
  const result = await sieve.runVacation(
    write.socket,
    mail,
    { action: "put", script: sieve.buildVacation({ subject: "Away", message: "Hello", start: "", end: "", useDate: false }) },
    async (value) => value,
  );
  await write.done;
  await write.close();
  assert.equal(result.active, "morrow-vacation");
  assert.equal(result.script, stored);
  assert.match(stored, /vacation :days 1 :subject "Away" "Hello";/);

  const refused = await withServer(async (socket) => {
    socket.write('"IMPLEMENTATION" "fixture"\r\n"SIEVE" "vacation"\r\n"SASL" "PLAIN"\r\nOK\r\n');
    socket.end();
  });
  await assert.rejects(
    sieve.runVacation(refused.socket, mail, { action: "read" }, async (value) => value),
    /verified vacation connection/,
  );
  await refused.done;
  await refused.close();
}

module.exports = { run };
