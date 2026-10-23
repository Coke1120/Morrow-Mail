const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const changelog = require("../shared/changelog");

const root = path.join(__dirname, "..");

function functionSource(source, name) {
  const start = source.indexOf("function " + name + "(");
  assert.ok(start >= 0, "missing " + name);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("unclosed " + name);
}

function testDecision() {
  const version = require("../package.json").version;
  const notes = changelog.notesFor(version);
  assert.ok(notes.length > 0, "add shared/changelog.js lines for " + version);
  assert.equal(changelog.notesFor("0.2.31").length, 0);
  assert.equal(changelog.notesFor("").length, 0);
  assert.equal(changelog.shouldOffer({ version, seen: "", listOk: true }), true);
  assert.equal(changelog.shouldOffer({ version, seen: " " + version + " ", listOk: true }), false);
  assert.equal(changelog.shouldOffer({ version, seen: "0.2.31", listOk: true }), true);
  assert.equal(changelog.shouldOffer({ version, seen: "", listOk: false }), false);
  assert.equal(changelog.shouldOffer({ version: "0.2.31", seen: "", listOk: true }), false);
  assert.equal(changelog.shouldOffer({ version: "", seen: "", listOk: true }), false);
  assert.equal(changelog.shouldOffer(null), false);
}

function testSettings() {
  const prev = process.env.MORROW_USER_DATA;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-changelog-"));
  process.env.MORROW_USER_DATA = dir;
  const settingsPath = require.resolve("../host/settings");
  delete require.cache[settingsPath];
  try {
    const { answer } = require("../host/settings");
    const file = path.join(dir, "settings.json");
    assert.equal(fs.existsSync(file), false);
    assert.equal(answer("morrow:configGetChangelogSeen", []), "");
    assert.equal(fs.existsSync(file), false);
    assert.equal(answer("morrow:configSetChangelogSeen", ["0.2.32"]), "0.2.32");
    assert.equal(answer("morrow:configGetChangelogSeen", []), "0.2.32");
    assert.throws(() => answer("morrow:configSetChangelogSeen", ["v0.2.32"]), /1\.2\.3/);
    assert.equal(answer("morrow:configGetChangelogSeen", []), "0.2.32");
    fs.writeFileSync(file, JSON.stringify({ changelogSeen: "nope", theme: "dark" }));
    assert.equal(answer("morrow:configGetChangelogSeen", []), "");
    assert.equal(answer("config:getTheme", []), "dark");
  } finally {
    delete require.cache[settingsPath];
    if (prev === undefined) delete process.env.MORROW_USER_DATA;
    else process.env.MORROW_USER_DATA = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testWiring() {
  const app = fs.readFileSync(path.join(root, "renderer/app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "renderer/index.html"), "utf8");
  const preload = fs.readFileSync(path.join(root, "renderer/preload.js"), "utf8");
  const settings = fs.readFileSync(path.join(root, "host/settings.js"), "utf8");
  const loadList = functionSource(app, "loadList");
  const body = loadList.slice(0, loadList.lastIndexOf("finally"));
  const tail = loadList.slice(loadList.lastIndexOf("finally"));
  assert.equal(body.split("noteMailListLoaded(").length - 1, 3);
  assert.equal(tail.includes("noteMailListLoaded"), false);
  assert.ok(app.includes('"morrow:configGetChangelogSeen"'));
  assert.ok(app.includes('"morrow:configSetChangelogSeen"'));
  assert.ok(preload.includes('"morrow:configGetChangelogSeen"'));
  assert.ok(preload.includes('"morrow:configSetChangelogSeen"'));
  assert.ok(settings.includes("changelogSeen"));
  assert.ok(html.includes('id="changelog"'));
  assert.ok(html.includes('id="changelog-ok"') && html.includes('id="changelog-close"'));
  assert.ok(html.indexOf('src="../shared/changelog.js"') < html.indexOf('src="./app.js"'));
}

function run() {
  testDecision();
  testSettings();
  testWiring();
}

if (require.main === module) {
  try {
    run();
    console.log("changelog-ok");
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

module.exports = { run };
