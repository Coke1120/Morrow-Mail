const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function run() {
  const files = new Map();
  let refuseWrite = false;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../host/mail/win-secrets.js"), "utf8"), {
    module,
    require(name) {
      if (name === "./secret-service") return require("../host/mail/secret-service");
      assert.equal(name, "child_process");
      return {
        spawnSync(command, args, options) {
          assert.equal(command, "powershell.exe");
          assert.equal(options.windowsHide, true);
          const script = args.at(-1);
          const dir = script.match(/Join-Path \$env:LOCALAPPDATA '([^']+)'/)[1];
          const expression = script.match(/Join-Path \$dir \('((?:''|[^'])*)' -replace '([^']+)','_'\)/);
          assert.ok(expression);
          const filename = expression[1].replace(/''/g, "'").replace(new RegExp(expression[2], "g"), "_");
          assert.doesNotMatch(filename, /[<>:"/\\|?*\x00-\x1f]/, "DPAPI uses ordinary Windows files, not alternate data streams");
          const key = `${dir}/${filename}`;
          if (script.includes("WriteAllBytes")) {
            if (refuseWrite) return { status: 1, stderr: "Fixture disk failure" };
            const bytes = script.match(/GetBytes\('((?:''|[^'])*)'\)/)[1].replace(/''/g, "'");
            files.set(key, bytes);
            return { status: 0, stdout: "" };
          }
          if (script.includes("ReadAllBytes")) {
            return files.has(key) ? { status: 0, stdout: files.get(key) } : { status: 2, stdout: "" };
          }
          assert.ok(script.includes("Remove-Item"));
          files.delete(key);
          return { status: 0, stdout: "" };
        },
      };
    },
  });
  const store = module.exports;
  for (const purpose of ["", ":organize", ":calendar", ":rules", ":vacation"]) {
    const account = `oauth-fixture${purpose}`;
    const token = `fixture's ${purpose || "mailbox"} token`;
    store.setPassword(account, token);
    assert.equal(store.getPassword(account), token);
  }
  assert.equal(files.size, 5, "each grant must have a separate credential file");
  store.deletePassword("oauth-fixture:vacation");
  assert.equal(store.getPassword("oauth-fixture:vacation"), null);
  assert.equal(store.getPassword("oauth-fixture"), "fixture's mailbox token");
  const legacy = "genmail-rea\\secrets/genmail-exact_legacy_calendar";
  files.set(legacy, "legacy-token");
  refuseWrite = true;
  assert.equal(store.getPassword("legacy:calendar"), "legacy-token");
  assert.equal(files.has(legacy), true, "failed migration must retain the old credential");
  refuseWrite = false;
  assert.equal(store.getPassword("legacy:calendar"), "legacy-token");
  assert.equal(files.has(legacy), false);
  assert.equal(files.get("morrow-mail\\secrets/morrow-mail_legacy_calendar"), "legacy-token");
}

module.exports = { run };
