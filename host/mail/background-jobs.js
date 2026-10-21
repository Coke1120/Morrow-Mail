// Background sync walks every listed folder. The caller passes folders in a
// stable order. Each pass starts at the saved index so a large folder cannot
// keep the first turn forever. The open folder is inserted second when it is
// not already that turn, and a pass that stops early resumes at the first
// folder that did not get a turn.

function mod(index, count) {
  const value = Number(index);
  const safe = Number.isFinite(value) ? value : 0;
  return ((safe % count) + count) % count;
}

function planBackgroundFolders(folders, activePath, cursor) {
  const listed = (Array.isArray(folders) ? folders : []).filter((folder) => folder && folder.path);
  const count = listed.length;
  if (!count) {
    return {
      jobs: [],
      nextCursor() { return 0; },
      cursorFor() { return 0; },
    };
  }
  const start = mod(cursor, count);
  const activeIndex = activePath ? listed.findIndex((folder) => folder.path === activePath) : -1;
  const ring = [];
  for (let step = 0; step < count; step += 1) ring.push((start + step) % count);
  const jobs = [listed[ring[0]]];
  if (activeIndex >= 0 && activeIndex !== ring[0]) jobs.push(listed[activeIndex]);
  for (const index of ring.slice(1)) {
    if (index === activeIndex) continue;
    jobs.push(listed[index]);
  }
  return {
    jobs,
    nextCursor(visited) {
      const seen = visited instanceof Set ? visited : new Set(visited || []);
      for (const index of ring) {
        if (!seen.has(listed[index].path)) return index;
      }
      return (start + 1) % count;
    },
    cursorFor(folderPath) {
      const index = listed.findIndex((folder) => folder.path === folderPath);
      return index >= 0 ? index : start;
    },
  };
}

module.exports = { planBackgroundFolders };
