const fs = require("fs");
const path = require("path");
const { userDataDir } = require("./paths");

const ZOOM_MIN = -8;
const ZOOM_MAX = 9;

function emptyState() {
  return {
    x: null,
    y: null,
    width: null,
    height: null,
    maximized: false,
    fullscreen: false,
    zoomLevel: 0,
  };
}

function statePath() {
  return path.join(userDataDir(), "window-state.json");
}

function clampZoom(level) {
  const n = Number(level);
  if (!Number.isFinite(n)) return 0;
  const stepped = Math.round(n * 100) / 100;
  if (stepped < ZOOM_MIN) return ZOOM_MIN;
  if (stepped > ZOOM_MAX) return ZOOM_MAX;
  return stepped;
}

function dimension(value, min, max) {
  const n = Math.round(Number(value));
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

function coordinate(value) {
  return dimension(value, -100000, 100000);
}

function sanitize(parsed) {
  const out = emptyState();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  out.zoomLevel = clampZoom(parsed.zoomLevel);
  out.maximized = parsed.maximized === true;
  out.fullscreen = parsed.fullscreen === true;
  out.width = dimension(parsed.width, 640, 16000);
  out.height = dimension(parsed.height, 480, 16000);
  out.x = coordinate(parsed.x);
  out.y = coordinate(parsed.y);
  return out;
}

function read() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(statePath(), "utf8"));
  } catch (error) {
    if (error && (error.code === "ENOENT" || error instanceof SyntaxError)) return emptyState();
    throw error;
  }
  return sanitize(parsed);
}

function update(patch) {
  const next = sanitize({ ...read(), ...(patch && typeof patch === "object" ? patch : {}) });
  const dest = statePath();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, dest);
  return next;
}

function visibleOn(bounds, x, y, area) {
  const left = Math.max(x, area.x);
  const top = Math.max(y, area.y);
  const right = Math.min(x + bounds.width, area.x + area.width);
  const bottom = Math.min(y + bounds.height, area.y + area.height);
  return right - left >= 48 && bottom - top >= 48;
}

function workAreas(displays) {
  return (Array.isArray(displays) ? displays : [])
    .map((display) => display && display.workArea)
    .filter((area) => area && dimension(area.width, 1, 100000) && dimension(area.height, 1, 100000) && coordinate(area.x) != null && coordinate(area.y) != null);
}

// A saved position is kept only when enough of the window still sits on a display.
function place(saved, displays, fallback) {
  const state = sanitize(saved);
  const width = state.width || (fallback && fallback.width) || 1200;
  const height = state.height || (fallback && fallback.height) || 800;
  const bounds = { width, height };
  const areas = workAreas(displays);
  if (state.x != null && state.y != null && areas.some((area) => visibleOn(bounds, state.x, state.y, area))) {
    bounds.x = state.x;
    bounds.y = state.y;
  }
  return {
    bounds,
    maximized: state.maximized,
    fullscreen: state.fullscreen,
    zoomLevel: state.zoomLevel,
  };
}

module.exports = {
  clampZoom,
  read,
  update,
  place,
  sanitize,
  ZOOM_MIN,
  ZOOM_MAX,
};
