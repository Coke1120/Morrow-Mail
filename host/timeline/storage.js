const crypto = require("node:crypto");
const { validateDocument, parseJson, failure } = require("./validate");

function migrate({ run, all }) {
  run("CREATE TABLE IF NOT EXISTS timeline_meta (name TEXT PRIMARY KEY, value TEXT NOT NULL)");
  run(`CREATE TABLE IF NOT EXISTS timelines (id TEXT PRIMARY KEY, document_json TEXT NOT NULL,
    revision INTEGER NOT NULL, generated_at TEXT NOT NULL, digest TEXT NOT NULL, prompt_version TEXT NOT NULL, usage_json TEXT NOT NULL)`);
  run(`CREATE TABLE IF NOT EXISTS timeline_source_ids (local_key TEXT PRIMARY KEY, public_id TEXT NOT NULL UNIQUE, account_id TEXT NOT NULL)`);
  run(`CREATE TABLE IF NOT EXISTS timeline_sources (timeline_id TEXT NOT NULL, account_id TEXT NOT NULL,
    message_id TEXT NOT NULL, thread_id TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(timeline_id, message_id))`);
  run("CREATE INDEX IF NOT EXISTS timeline_sources_account ON timeline_sources(account_id, timeline_id)");
  run(`CREATE TABLE IF NOT EXISTS timeline_jobs (id TEXT PRIMARY KEY, owner INTEGER NOT NULL, state TEXT NOT NULL,
    created_at TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0)`);
  run("UPDATE timeline_jobs SET state = 'interrupted' WHERE state = 'running'");
  run("INSERT OR IGNORE INTO timeline_meta(name, value) VALUES ('namespace', ?)", [crypto.randomUUID()]);
  const columns = new Map([
    ["timeline_meta", ["name", "value"]],
    ["timelines", ["id", "document_json", "revision", "generated_at", "digest", "prompt_version", "usage_json"]],
    ["timeline_source_ids", ["local_key", "public_id", "account_id"]],
    ["timeline_sources", ["timeline_id", "account_id", "message_id", "thread_id", "fingerprint"]],
    ["timeline_jobs", ["id", "owner", "state", "created_at", "calls"]],
  ]);
  for (const [table, required] of columns) {
    const actual = new Set(all(`PRAGMA table_info(${table})`).map(row => row.name));
    if (required.some(column => !actual.has(column))) throw failure("timeline-storage-version");
  }
  if (all("PRAGMA index_info(timeline_sources_account)").map(row => row.name).join(",") !== "account_id,timeline_id") throw failure("timeline-storage-version");
}

function createStore({ run, get, all, transaction }) {
  function remove(id) {
    run("DELETE FROM timeline_sources WHERE timeline_id = ?", [id]);
    run("DELETE FROM timelines WHERE id = ?", [id]);
  }
  return {
    namespace: () => get("SELECT value FROM timeline_meta WHERE name = 'namespace'").value,
    identity(account, kind, identity) {
      const key = JSON.stringify([account.id, account.created_at, kind, identity]);
      return transaction(() => {
        const existing = get("SELECT public_id FROM timeline_source_ids WHERE local_key = ?", [key]);
        if (existing) return existing.public_id;
        const id = crypto.randomUUID();
        run("INSERT INTO timeline_source_ids(local_key, public_id, account_id) VALUES (?, ?, ?)", [key, id, account.id]);
        return id;
      });
    },
    save(document, sources, { digest, promptVersion, usage }) {
      validateDocument(document);
      return transaction(() => {
        run(`INSERT INTO timelines(id, document_json, revision, generated_at, digest, prompt_version, usage_json)
          VALUES (?, ?, 1, ?, ?, ?, ?)`, [document.timeline_id, JSON.stringify(document), document.generated_at, digest, promptVersion, JSON.stringify(usage)]);
        for (const source of sources) run(`INSERT INTO timeline_sources(timeline_id, account_id, message_id, thread_id, fingerprint)
          VALUES (?, ?, ?, ?, ?)`, [document.timeline_id, source.account_id, source.id, source.thread_id || source.id, source.fingerprint]);
      });
    },
    list: () => all("SELECT id, generated_at, revision FROM timelines ORDER BY generated_at DESC, id DESC LIMIT 100"),
    get(id) {
      const row = get("SELECT document_json, revision FROM timelines WHERE id = ?", [id]);
      if (!row) throw failure("timeline-not-found");
      return { document: validateDocument(parseJson(row.document_json)), revision: row.revision };
    },
    delete: id => transaction(() => remove(id)),
    removeAccount(accountId) {
      for (const row of all("SELECT DISTINCT timeline_id FROM timeline_sources WHERE account_id = ?", [accountId])) remove(row.timeline_id);
      run("DELETE FROM timeline_source_ids WHERE account_id = ?", [accountId]);
    },
    startJob(id, owner) {
      transaction(() => {
        run("DELETE FROM timeline_jobs WHERE state != 'running'");
        run("INSERT INTO timeline_jobs(id, owner, state, created_at) VALUES (?, ?, 'running', ?)", [id, owner, new Date().toISOString()]);
      });
    },
    finishJob: (id, state, calls = 0) => transaction(() => run("UPDATE timeline_jobs SET state = ?, calls = ? WHERE id = ?", [state, calls, id])),
  };
}

module.exports = { migrate, createStore };
