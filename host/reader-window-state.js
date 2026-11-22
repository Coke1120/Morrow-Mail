// Last reader BrowserWindow frame. Separate from window-state.json so a reader
// move cannot change the shell's saved size, position, or zoom.
const fs = require("fs");
const path = require("path");
const { userDataDir } = require("./paths");
const { sanitize } = require("./window-state");

function emptyState() {
  return { x: null, y: null, width: null, height: null };
}

function statePath() {
  return path.join(userDataDir(), "reader-window-state.json");
}

function boundsFrom(parsed) {
  const { x, y, width, height } = sanitize(parsed);
  return { x, y, width, height };
}

function read() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(statePath(), "utf8"));
  } catch (error) {
    if (error && (error.code === "ENOENT" || error instanceof SyntaxError)) return emptyState();
    throw error;
  }
  return boundsFrom(parsed);
}

function update(patch) {
  const current = read();
  const incoming = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
  const merged = { ...current };
  for (const key of ["x", "y", "width", "height"]) {
    if (Object.prototype.hasOwnProperty.call(incoming, key)) merged[key] = incoming[key];
  }
  const next = boundsFrom(merged);
  const dest = statePath();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, dest);
  return next;
}

module.exports = {
  emptyState,
  read,
  update,
  statePath,
};
