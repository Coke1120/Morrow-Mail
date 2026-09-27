const { readFileSync, writeFileSync, renameSync } = require('node:fs');
function validKey(key) { return typeof key === 'string' && key.length <= 512 && (key === 'morrow.mail.layout' || key === 'morrow.pendingCalendar' || key === 'morrow.calendar.checked' || key.startsWith('morrow.account.collapsed.')); }
function clientState(file, operation, key, value) {
  if (!validKey(key) || !['get', 'set', 'remove'].includes(operation)) throw new Error('Invalid client state request.');
  let state = {};
  try { const raw = readFileSync(file, 'utf8'); if (raw.length > 262144) throw new Error('Client state is too large.'); state = JSON.parse(raw); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (operation === 'get') return Object.hasOwn(state, key) ? state[key] : null;
  if (operation === 'set') {
    if (key === 'morrow.mail.layout' && !['right', 'bottom', 'focus'].includes(value)) throw new Error('Invalid reading layout.');
    if (typeof value !== 'string' || value.length > 32768) throw new Error('Client state is too large.');
    state[key] = value;
  } else delete state[key];
  const encoded = JSON.stringify(state);
  if (encoded.length > 262144) throw new Error('Client state is too large.');
  writeFileSync(file + '.tmp', encoded, { mode: 0o600, flush: true });
  renameSync(file + '.tmp', file);
  return null;
}
module.exports = { clientState };
