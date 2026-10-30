const { parentPort } = require("node:worker_threads");
const suggest = require("../../shared/recipient-suggest");

const copies = new Map();
const messages = new Map();
const addresses = new Map();
let ranked = null;

function apply(rows) {
  const touched = new Set();
  for (const row of rows) {
    const previous = copies.get(row.id);
    if (previous) {
      messages.get(previous).delete(row.id);
      touched.add(previous);
      copies.delete(row.id);
    }
    if (row.removed || Number(row.is_draft) === 1) continue;
    const key = `${row.account_id}\0${row.gmail_id || row.id}`;
    if (!messages.has(key)) messages.set(key, new Map());
    messages.get(key).set(row.id, row);
    copies.set(row.id, key);
    touched.add(key);
  }
  for (const key of touched) {
    const group = messages.get(key);
    const previous = group.people || [];
    const next = suggest.rank([...group.values()]);
    for (const person of previous) {
      const slot = addresses.get(person.email);
      slot.sightings.delete(key);
      slot.dirty = true;
      if (!slot.sightings.size) addresses.delete(person.email);
    }
    for (const person of next) {
      if (!addresses.has(person.email)) addresses.set(person.email, { email: person.email, sightings: new Map(), dirty: true });
      addresses.get(person.email).sightings.set(key, person);
      addresses.get(person.email).dirty = true;
    }
    group.people = next;
    if (!group.size) messages.delete(key);
  }
  ranked = null;
}

function query(text) {
  if (!ranked) {
    for (const slot of addresses.values()) {
      if (!slot.dirty) continue;
      slot.count = slot.sightings.size;
      slot.lastSeen = 0;
      slot.name = "";
      for (const person of slot.sightings.values()) {
        if (person.lastSeen >= slot.lastSeen) {
          slot.lastSeen = person.lastSeen;
          if (person.name) slot.name = person.name;
        } else if (!slot.name && person.name) slot.name = person.name;
      }
      slot.dirty = false;
    }
    const score = slot => slot.lastSeen + (slot.count - 1) * suggest.EXTRA_SIGHTING_MS;
    ranked = [...addresses.values()].sort((left, right) => score(right) - score(left)
      || right.lastSeen - left.lastSeen || left.email.localeCompare(right.email));
  }
  return suggest.filter(ranked, text);
}

parentPort.on("message", ({ id, type, data }) => {
  try {
    if (type === "reset") { copies.clear(); messages.clear(); addresses.clear(); ranked = null; }
    if (type === "apply") apply(data);
    parentPort.postMessage({ id, data: type === "query" ? query(data) : null });
  } catch {
    parentPort.postMessage({ id, error: "Local recipient suggestions could not be read. Retry." });
  }
});
