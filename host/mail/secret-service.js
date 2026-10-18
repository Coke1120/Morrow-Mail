const SERVICE = "morrow-mail";
const LEGACY_SERVICE = "genmail-exact";

function migrateRead(read, write, remove) {
  const current = read(SERVICE);
  if (current != null) return current;
  const legacy = read(LEGACY_SERVICE);
  if (legacy == null) return null;
  try {
    write(SERVICE, legacy);
    remove(LEGACY_SERVICE);
  } catch {
    // Leave the legacy item so the next read can try the copy again.
  }
  return legacy;
}

module.exports = { SERVICE, LEGACY_SERVICE, migrateRead };
