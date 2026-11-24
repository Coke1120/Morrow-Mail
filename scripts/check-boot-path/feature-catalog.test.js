"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const { generateFeatureCatalog, readExpectedFeatures } = require("./feature-catalog");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-features-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const product = path.join(root, "product");
  const expected = path.join(root, "expected");
  const output = path.join(root, "features-catalog.js");
  fs.mkdirSync(product);
  fs.mkdirSync(expected);
  return {
    write(filename, directories = [product, expected], blurb = "Reviewed → Save") {
      const id = filename.slice(4, -5);
      const row = { id, title: id, category: "Mail", blurb };
      for (const directory of directories) {
        const data = directory === product ? row : [row.id, row.title, row.category, row.blurb];
        fs.writeFileSync(path.join(directory, filename), JSON.stringify(data));
      }
    },
    product,
    expected,
    output,
    generate: () => generateFeatureCatalog(product, output),
    readExpected: () => readExpectedFeatures(expected),
    compare() {
      this.generate();
      const source = fs.readFileSync(output, "utf8");
      const commonJS = { module: { exports: {} } };
      vm.runInNewContext(source, commonJS);
      const rows = Array.from(commonJS.module.exports.items, row => [row.id, row.title, row.category, row.blurb]);
      assert.deepStrictEqual(rows, this.readExpected());
      return source;
    },
  };
}

test("inserting paired manifests preserves deterministic bucket and ID order", t => {
  const files = fixture(t);
  files.write("900-zulu.json");
  files.write("001-first.json");
  files.compare();
  files.write("900-alpha.json");
  const source = files.compare();
  const browser = { window: {} };
  vm.runInNewContext(source, browser);
  assert.deepStrictEqual(Array.from(browser.window.morrowFeaturesCatalog.items, row => row.id),
    ["first", "alpha", "zulu"]);
  const modified = fs.statSync(files.output).mtimeMs;
  assert.equal(files.compare(), source);
  assert.equal(fs.statSync(files.output).mtimeMs, modified);
});

test("one-sided manifests and changes to claims fail ordered parity", t => {
  const files = fixture(t);
  files.write("001-first.json");
  files.write("900-product-only.json", [files.product]);
  assert.throws(() => files.compare(), { code: "ERR_ASSERTION" });
  files.write("900-product-only.json", [files.expected]);
  files.write("900-expected-only.json", [files.expected]);
  assert.throws(() => files.compare(), { code: "ERR_ASSERTION" });
  files.write("900-expected-only.json", [files.product], "Changed claim");
  assert.throws(() => files.compare(), { code: "ERR_ASSERTION" });
});

test("empty catalogs and duplicate IDs across buckets fail validation", t => {
  const files = fixture(t);
  assert.throws(files.generate, /No feature manifests/);
  assert.throws(files.readExpected, /No feature manifests/);
  files.write("001-first.json");
  const source = files.compare();
  files.write("900-first.json");
  assert.throws(files.generate, /Duplicate feature ID "first"/);
  assert.throws(files.readExpected, /Duplicate feature ID "first"/);
  assert.equal(fs.readFileSync(files.output, "utf8"), source);
});
