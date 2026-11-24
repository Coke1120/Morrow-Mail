"use strict";

const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const renderer = path.join(__dirname, "../../renderer");
const fields = ["id", "title", "category", "blurb"];
const filenamePattern = /^\d{3}-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.json$/;

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function readFeatures(directory, readRow) {
  // Sort the fixed-width bucket and ID without the extension so prefix IDs come first.
  const stems = fs.readdirSync(directory)
    .filter(name => name.endsWith(".json"))
    .map(name => name.slice(0, -5))
    .sort();
  if (!stems.length) throw new Error(`No feature manifests in ${directory}`);
  const ids = new Set();
  return stems.map(stem => {
    const name = `${stem}.json`;
    const file = path.join(directory, name);
    const match = filenamePattern.exec(name);
    if (!match) throw new Error(`Invalid feature manifest filename: ${file}`);
    const [, id] = match;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`Cannot read feature manifest ${file}: ${error.message}`, { cause: error });
    }
    const row = readRow(data, id, file);
    if (ids.has(id)) throw new Error(`Duplicate feature ID "${id}" in ${file}`);
    ids.add(id);
    return row;
  });
}

function readExpectedFeatures(directory = path.join(__dirname, "features")) {
  return readFeatures(directory, (row, id, file) => {
    if (!Array.isArray(row) || row.length !== fields.length || !row.every(hasText)) {
      throw new Error(`Expected a tuple of four nonempty strings in ${file}`);
    }
    if (row[0] !== id) throw new Error(`Feature ID must match filename in ${file}`);
    return row;
  });
}

function generateFeatureCatalog(
  directory = path.join(renderer, "features"),
  output = path.join(renderer, "features-catalog.js"),
) {
  const items = readFeatures(directory, (row, id, file) => {
    if (!row || Array.isArray(row) || typeof row !== "object" ||
        Object.keys(row).length !== fields.length || !fields.every(field => hasText(row[field]))) {
      throw new Error(`Expected exactly id, title, category and blurb as nonempty strings in ${file}`);
    }
    if (row.id !== id) throw new Error(`Feature ID must match filename in ${file}`);
    return Object.fromEntries(fields.map(field => [field, row[field]]));
  });
  const source = `/* Generated from renderer/features/*.json. */
(function () {
  const api = ${JSON.stringify({ items }, null, 2)};
  if (typeof module === "object" && module.exports) module.exports = api;
  else (typeof window === "object" ? window : globalThis).morrowFeaturesCatalog = api;
})();
`;
  try {
    if (fs.readFileSync(output, "utf8") === source) return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  // Keep the temporary file on the same filesystem. electron-builder skips ._* files.
  const temporary = path.join(path.dirname(output), `._${path.basename(output)}.${randomUUID()}`);
  try {
    fs.writeFileSync(temporary, source, { flag: "wx" });
    fs.renameSync(temporary, output);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

if (require.main === module) generateFeatureCatalog();

module.exports = {
  beforePack: () => generateFeatureCatalog(),
  generateFeatureCatalog,
  readExpectedFeatures,
};
