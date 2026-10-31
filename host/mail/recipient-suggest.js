const { Worker } = require("node:worker_threads");
const db = require("./db");

let worker = null;
let sequence = 0;
let epoch = "";
let revision = -1;
let pending = null;
const requests = new Map();

function call(type, data) {
  if (!worker) {
    const current = worker = new Worker(require.resolve("./recipient-suggest-worker"));
    current.on("message", message => {
      const request = requests.get(message.id);
      if (!request) return;
      requests.delete(message.id);
      if (!requests.size) current.unref();
      if (message.error) request.reject(new Error(message.error)); else request.resolve(message.data);
    });
    const failed = () => {
      if (worker !== current) return;
      worker = null;
      epoch = "";
      revision = -1;
      for (const request of requests.values()) request.reject(new Error("Local recipient suggestions are unavailable. Retry."));
      requests.clear();
    };
    current.on("error", failed);
    current.on("exit", failed);
    current.unref();
  }
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    requests.set(id, { resolve, reject });
    worker.ref();
    worker.postMessage({ id, type, data });
  });
}

function stamp() {
  const [generation, value] = db.recipientHeaderStamp().split(":");
  return { epoch: `${db.file()}\0${generation}`, revision: Number(value) };
}

async function refresh() {
  const target = stamp();
  const assertCurrent = () => {
    if (stamp().epoch !== target.epoch) throw new Error("The local mailbox changed. Retry recipient suggestions.");
  };
  if (epoch !== target.epoch) {
    epoch = "";
    await call("reset");
    assertCurrent();
    let after = "";
    while (true) {
      const rows = db.recipientHeaderRows(after);
      if (!rows.length) break;
      after = rows[rows.length - 1].id;
      await call("apply", rows);
      assertCurrent();
    }
    epoch = target.epoch;
    revision = target.revision;
  }
  const through = stamp().revision;
  while (revision < through) {
    const rows = db.recipientHeaderChanges(revision, through);
    if (!rows.length) { revision = through; break; }
    await call("apply", rows);
    assertCurrent();
    revision = rows[rows.length - 1].revision;
  }
}

async function list(query) {
  if (typeof query !== "string" || !query.trim()) return [];
  if (!pending) pending = refresh().catch(error => { epoch = ""; throw error; }).finally(() => { pending = null; });
  await pending;
  return call("query", String(query).slice(0, 200));
}

module.exports = { list };
