"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const fixtures = require("./fixtures");

const scripts = path.join(__dirname, "..");
const shards = {
  ...fixtures,
  boot: run => run("check-boot-path.js", 0, ["--inline-checks"]),
};

function runShard(name) {
  const started = Date.now();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-" + name + "-"));
  const env = { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  try {
    shards[name]((file, timeout = 30_000, args = []) => {
      const start = Date.now();
      const result = spawnSync(process.execPath, [path.join(scripts, file), ...args], {
        env, timeout, stdio: "inherit",
      });
      const label = `[${name}] ${file} (${Date.now() - start} ms)`;
      if (result.error) console.error(label, result.error.message);
      assert.ifError(result.error);
      assert.equal(result.status, 0, `${label} failed: ${result.signal || result.status}`);
      console.log(label);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
  console.log(`boot-shard-ok ${name} (${Date.now() - started} ms)`);
}

function runShards(args) {
  const names = Object.keys(shards);
  if (args.length) {
    if (args.length !== 2 || args[0] !== "--shard" || !names.includes(args[1])) {
      throw new Error(`Usage: node scripts/check-boot-path.js [--shard ${names.join("|")}]`);
    }
    runShard(args[1]);
    return;
  }
  // On a single checkout, fixtures using port 47831 or the repository OAuth
  // resource must not overlap. CI gives each shard its own checkout and VM.
  for (const name of names) runShard(name);
  console.log("ui-path-ok");
}

module.exports = { runShards };
