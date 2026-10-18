// sql.js keeps its database in memory. Commit small, replayable SQL transactions
// to disk; build full SQLite checkpoints in a worker, never on the flag/sync path.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");

const MAGIC = Buffer.from("MORROWJ1");
const HEADER_SIZE = 80;
const CHECKPOINT_BYTES = 8 * 1024 * 1024;
const CHECKPOINT_TRANSACTIONS = 256;
const CHECKPOINT_TIMEOUT_MS = 60000;

function syncDirectory(file) {
  // Node cannot open directory handles for FlushFileBuffers on Windows. File
  // fsync + same-directory rename is still used there (as with the old store).
  if (process.platform === "win32") return;
  const fd = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeAll(fd, data, position = null) {
  let offset = 0;
  let at = position;
  while (offset < data.length) {
    const written = at == null
      ? fs.writeSync(fd, data, offset, data.length - offset)
      : fs.writeSync(fd, data, offset, data.length - offset, at);
    if (!written) throw new Error("Mail journal write made no progress.");
    offset += written;
    if (at != null) at += written;
  }
}

function snapshot(database, file) {
  const data = database.export();
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    writeAll(fd, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  syncDirectory(file);
  return data.byteLength;
}

async function loadDatabase(file) {
  const init = require("sql.js");
  const wasmDir = path.dirname(require.resolve("sql.js"));
  const SQL = await init({ locateFile: (name) => path.join(wasmDir, name) });
  return fs.existsSync(file) ? new SQL.Database(fs.readFileSync(file)) : new SQL.Database();
}

function state(database) {
  const table = database.exec("SELECT name FROM sqlite_master WHERE name = 'morrow_storage'");
  if (!table.length) return null;
  const result = database.exec("SELECT generation, sequence FROM morrow_storage WHERE id = 1");
  if (!result.length) throw new Error("Mail storage checkpoint state is missing.");
  const [generation, sequence] = result[0].values[0];
  return { generation, sequence };
}

function encode(generation, sequence, commands) {
  const blobs = [];
  const json = Buffer.from(JSON.stringify({ generation, sequence, commands: commands.map(({ sql, bindings }) => ({
    sql,
    bindings: bindings.map((params) => params.map((value) => {
      if (!(value instanceof Uint8Array)) return value;
      const blob = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      blobs.push(blob);
      return { bytes: blob.length };
    })),
  })) }));
  const length = json.length + blobs.reduce((sum, blob) => sum + blob.length, 0);
  const header = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(header);
  header.writeUInt32BE(length, 8);
  header.writeUInt32BE(json.length, 12);
  const hash = crypto.createHash("sha256").update(json);
  for (const blob of blobs) hash.update(blob);
  hash.digest().copy(header, 48);
  crypto.createHash("sha256").update(header.subarray(0, 16)).update(header.subarray(48)).digest().copy(header, 16);
  return [header, json, ...blobs];
}

function readAll(fd, length, position) {
  const data = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const n = fs.readSync(fd, data, read, length - read, position + read);
    if (!n) throw new Error("Mail journal ended unexpectedly.");
    read += n;
  }
  return data;
}

// A short final frame is an interrupted append. A complete but invalid frame,
// wrong database generation, or sequence gap is corruption: fail closed.
function replay(database, file, { repairTail = false } = {}) {
  if (!fs.existsSync(file)) return;
  const current = state(database);
  if (!current) throw new Error("Mail journal has no matching SQLite checkpoint.");
  const fd = fs.openSync(file, repairTail ? "r+" : "r");
  try {
    const size = fs.fstatSync(fd).size;
    let offset = 0;
    let previous = null;
    while (offset < size) {
      if (size - offset < HEADER_SIZE) break;
      const header = readAll(fd, HEADER_SIZE, offset);
      if (!header.subarray(0, 8).equals(MAGIC)) throw new Error("Invalid mail journal header.");
      const headerHash = crypto.createHash("sha256").update(header.subarray(0, 16)).update(header.subarray(48)).digest();
      if (!headerHash.equals(header.subarray(16, 48))) throw new Error("Mail journal header checksum mismatch.");
      const length = header.readUInt32BE(8);
      const jsonLength = header.readUInt32BE(12);
      if (!jsonLength || jsonLength > length) throw new Error("Invalid mail journal length.");
      if (length > size - offset - HEADER_SIZE) break;
      const payload = readAll(fd, length, offset + HEADER_SIZE);
      const hash = crypto.createHash("sha256").update(payload).digest();
      if (!hash.equals(header.subarray(48))) throw new Error("Mail journal checksum mismatch.");
      const record = JSON.parse(payload.subarray(0, jsonLength).toString());
      if (record.generation !== current.generation || !Number.isSafeInteger(record.sequence)
          || record.sequence < 1 || (previous != null && record.sequence !== previous + 1)) {
        throw new Error("Mail journal generation or sequence mismatch.");
      }
      previous = record.sequence;
      if (record.sequence > current.sequence) {
        if (record.sequence !== current.sequence + 1) throw new Error("Mail journal has a transaction gap.");
        let blobOffset = jsonLength;
        database.run("BEGIN");
        try {
          for (const { sql, bindings } of record.commands) {
            const stmt = database.prepare(sql);
            try {
              for (const params of bindings) stmt.run(params.map((value) => {
                if (value === null || typeof value !== "object") return value;
                if (!Number.isSafeInteger(value.bytes) || value.bytes < 0 || blobOffset + value.bytes > payload.length) {
                  throw new Error("Invalid mail journal blob.");
                }
                const blob = payload.subarray(blobOffset, blobOffset + value.bytes);
                blobOffset += value.bytes;
                return blob;
              }));
            } finally { stmt.free(); }
          }
          if (blobOffset !== payload.length) throw new Error("Unexpected mail journal data.");
          database.run("UPDATE morrow_storage SET sequence = ? WHERE id = 1", [record.sequence]);
          database.run("COMMIT");
          current.sequence = record.sequence;
        } catch (error) {
          database.run("ROLLBACK");
          throw error;
        }
      }
      offset += HEADER_SIZE + length;
    }
    if (offset !== size) {
      if (!repairTail) throw new Error("Incomplete sealed mail journal.");
      fs.ftruncateSync(fd, offset);
      fs.fsyncSync(fd);
    }
  } finally { fs.closeSync(fd); }
}

class Persistence {
  constructor(file) {
    this.file = file;
    this.journal = `${file}.journal`;
    this.pending = `${file}.journal.pending`;
    this.fd = null;
    this.bytes = 0;
    this.transactions = 0;
    this.timer = null;
    this.running = null;
    this.worker = null;
    this.job = null;
    this.closed = false;
    this.initialized = false;
  }

  async open() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const database = await loadDatabase(this.file);
    try {
      const saved = state(database);
      if (saved) {
        replay(database, this.pending);
        replay(database, this.journal, { repairTail: true });
        Object.assign(this, state(database));
        this.transactions = this.sequence - saved.sequence;
        this.initialized = true;
        this.openJournal();
        this.schedule();
      } else if (fs.existsSync(this.journal) || fs.existsSync(this.pending)) {
        throw new Error("Mail journal has no matching SQLite checkpoint.");
      }
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  initialize(database) {
    this.generation = crypto.randomUUID();
    this.sequence = 0;
    database.run("CREATE TABLE morrow_storage (id INTEGER PRIMARY KEY CHECK (id = 1), generation TEXT NOT NULL, sequence INTEGER NOT NULL)");
    database.run("INSERT INTO morrow_storage VALUES (1, ?, 0)", [this.generation]);
    snapshot(database, this.file);
    this.initialized = true;
    this.openJournal();
  }

  openJournal() {
    if (this.fd != null) return;
    // Use r+ so rewind/ftruncate works on Windows. Append-only (a+) handles do not
    // reliably support SetEndOfFile there, which made partial journal writes mark
    // storage uncertain and close the live DB during check-mail-persistence.
    if (!fs.existsSync(this.journal)) fs.writeFileSync(this.journal, Buffer.alloc(0), { mode: 0o600 });
    this.fd = fs.openSync(this.journal, "r+", 0o600);
    try {
      try { fs.fchmodSync(this.fd, 0o600); } catch { /* Windows may ignore mode */ }
      this.bytes = fs.fstatSync(this.fd).size;
      fs.fsyncSync(this.fd);
      syncDirectory(this.journal);
    } catch (error) {
      fs.closeSync(this.fd);
      this.fd = null;
      throw error;
    }
  }

  append(commands) {
    this.openJournal();
    const offset = this.bytes;
    const parts = encode(this.generation, this.sequence + 1, commands);
    try {
      let at = offset;
      for (const part of parts) {
        writeAll(this.fd, part, at);
        at += part.length;
      }
      fs.fsyncSync(this.fd);
      this.bytes = at;
    } catch (error) {
      // Never append behind a partial/uncertain write, even after ENOSPC.
      try { this.rewind(offset); } catch { error.storageUncertain = true; }
      throw error;
    }
    return offset;
  }

  rewind(offset) {
    fs.ftruncateSync(this.fd, offset);
    fs.fsyncSync(this.fd);
    this.bytes = offset;
  }

  committed() {
    this.sequence += 1;
    this.transactions += 1;
    this.schedule();
  }

  schedule(delay = 1000) {
    if (this.closed || this.timer || this.running) return;
    if (this.bytes < CHECKPOINT_BYTES && this.transactions < CHECKPOINT_TRANSACTIONS && !fs.existsSync(this.pending)) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.checkpoint().catch((error) => {
        console.warn("[mail] Checkpoint deferred; durable journal retained:", error.code || error.name);
        this.schedule(30000);
      });
    }, delay);
    this.timer.unref();
  }

  async checkpoint() {
    const target = this.sequence;
    let report;
    do { report = await this.checkpointOnce(); }
    while (!this.closed && report && report.sequence < target);
    return report;
  }

  checkpointOnce() {
    if (this.running) return this.running;
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.openJournal();
    if (!fs.existsSync(this.pending)) {
      if (!this.bytes) return;
      fs.closeSync(this.fd);
      this.fd = null;
      fs.renameSync(this.journal, this.pending);
      syncDirectory(this.pending);
      this.openJournal();
      this.transactions = 0;
    }
    let succeeded = false;
    this.running = this.dispatchCheckpoint().then((report) => {
      if (!report || !Number.isSafeInteger(report.sequence)) throw new Error("Invalid mail checkpoint result.");
      fs.unlinkSync(this.pending);
      syncDirectory(this.pending);
      succeeded = true;
      return report;
    }).finally(() => {
      this.running = null;
      if (succeeded) this.schedule();
    });
    return this.running;
  }

  dispatchCheckpoint() {
    if (!this.worker) {
      const worker = new Worker(__filename, { workerData: { morrowCheckpointWorker: true } });
      this.worker = worker;
      const finish = (error, report) => {
        if (this.worker !== worker || !this.job) return;
        const job = this.job;
        this.job = null;
        clearTimeout(job.timeout);
        worker.unref();
        if (error) job.reject(error);
        else job.resolve(report);
      };
      worker.on("message", ({ error, report }) => {
        if (error) finish(Object.assign(new Error(error.message), { code: error.code }));
        else finish(null, report);
      });
      worker.on("error", (error) => {
        finish(error);
        if (this.worker === worker) this.worker = null;
        worker.unref();
      });
      worker.on("exit", () => {
        finish((this.job && this.job.failure) || new Error("Mail checkpoint worker stopped."));
        if (this.worker === worker) this.worker = null;
      });
    }
    const worker = this.worker;
    return new Promise((resolve, reject) => {
      this.job = { resolve, reject, timeout: setTimeout(() => {
        this.job.failure = new Error("Mail checkpoint timed out; durable journal retained.");
        worker.terminate();
      }, CHECKPOINT_TIMEOUT_MS) };
      worker.ref();
      try {
        worker.postMessage({ file: this.file, pending: this.pending });
      } catch (error) {
        clearTimeout(this.job.timeout);
        this.job = null;
        this.worker = null;
        worker.terminate();
        worker.unref();
        reject(error);
      }
    });
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.fd != null) fs.closeSync(this.fd);
    this.fd = null;
    // Every acknowledged transaction is already fsynced. No exit-time export.
    // A subsequent open waits for disk work to finish, not worker teardown.
    // Electron can stall tearing down a worker even after its completion reply.
    const done = this.running ? this.running.catch(() => {}) : Promise.resolve();
    return done.finally(() => {
      if (this.worker) {
        this.worker.terminate();
        this.worker.unref();
        this.worker = null;
      }
    });
  }
}

if (!isMainThread && workerData && workerData.morrowCheckpointWorker) {
  parentPort.on("message", async ({ file, pending }) => {
    let database;
    try {
      database = await loadDatabase(file);
      replay(database, pending);
      const bytes = snapshot(database, file);
      const report = { bytes, sequence: state(database).sequence };
      database.close();
      database = null;
      // All disk and DB work is complete before acknowledging. Reuse this worker
      // for later checkpoints instead of repeatedly starting/tearing down WASM.
      parentPort.postMessage({ report });
    } catch (error) {
      try { if (database) database.close(); } catch { /* report the original failure */ }
      parentPort.postMessage({ error: { message: error.message, code: error.code } });
    }
  });
}

module.exports = { Persistence };
