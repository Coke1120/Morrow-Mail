const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the real scheduler and test observer with gated synthetic workers.
// The separate persistence fixture still runs real SQLite replay/checkpoint I/O.
const root = path.join(__dirname, '..');
let clock = 0;
let startupTimeout = 10000;
class Clock extends Date { static now() { return clock; } }
const timer = (fn, ms, ...args) => setTimeout(fn, ms === 10000 ? startupTimeout : ms, ...args);
const native = require;
const persistenceModule = { exports: {} };
const persistenceContext = vm.createContext({
  module: persistenceModule, exports: persistenceModule.exports, console: { warn() {} }, process,
  Buffer, Uint8Array, Date: Clock, setTimeout: timer, clearTimeout,
  __filename: path.join(root, 'host/mail/persistence.js'),
  require(name) {
    if (name === 'better-sqlite3') return class { constructor() { throw new Error('No database needed by bounded scheduler fixtures'); } };
    if (name === '../performance-diagnostics') return { sync: (_label, fn) => fn() };
    return native(name);
  },
});
vm.runInContext(fs.readFileSync(path.join(root, 'host/mail/persistence.js'), 'utf8'), persistenceContext);
const { Persistence } = persistenceModule.exports;
const scriptModule = { exports: {} };
const scriptContext = vm.createContext({
  module: scriptModule, exports: scriptModule.exports, console, process, Buffer, Uint8Array,
  Date: Clock, setTimeout: timer, clearTimeout,
  __filename: path.join(root, 'scripts/check-mail-persistence.js'), __dirname: path.join(root, 'scripts'),
  require(name) {
    if (name === '../host/mail/db') return {};
    if (name === '../host/mail/persistence') return persistenceModule.exports;
    return native(name);
  },
});
const fixtureSource = fs.readFileSync(path.join(root, 'scripts/check-mail-persistence.js'), 'utf8');
vm.runInContext(fixtureSource + '\nmodule.exports.observe = observeBackgroundCheckpoint;', scriptContext);
const observe = scriptModule.exports.observe;
const original = Persistence.prototype.checkpoint;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morrow-checkpoint-observer-'));
const watchdog = setTimeout(() => { throw new Error('Bounded observer fixtures stalled'); }, 5000);

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function store(name) {
  const file = path.join(dir, name);
  fs.writeFileSync(file + '.journal.pending', 'synthetic sealed input');
  const persistence = new Persistence(file);
  persistence.sequence = 300;
  const dispatched = deferred();
  const worker = deferred();
  persistence.dispatchCheckpoint = () => { dispatched.resolve(); return worker.promise; };
  return { file, persistence, dispatched, worker };
}

(async () => {
  try {
    const fixture = store('late-completion');
    let settled = false;
    const observed = observe(fixture.file, () => fixture.persistence.schedule(0));
    observed.then(() => { settled = true; }, () => { settled = true; });
    await fixture.dispatched.promise;
    // Advance the old poll's wall clock beyond 15 seconds without delaying the test.
    const oldDeadline = Clock.now() + 15000;
    clock += 20000;
    assert.equal(Clock.now() < oldDeadline, false);
    await new Promise(setImmediate);
    assert.equal(settled, false, 'a dispatched worker still owns its bounded completion');
    fixture.worker.resolve({ sequence: 300, bytes: 1 });
    const completed = await observed;
    assert.equal(completed.report.sequence, 300);
    assert.equal(fs.existsSync(fixture.file + '.journal.pending'), false);
    assert.equal(Persistence.prototype.checkpoint, original);
    await fixture.persistence.close();
    console.log('PASS: actual background scheduler completion survives a synthetic >15s wall-clock advance');

    const failed = store('worker-error');
    const error = new Error('synthetic worker failure');
    const pending = observe(failed.file, () => failed.persistence.schedule(0));
    const rejected = assert.rejects(pending, (value) => value === error);
    await failed.dispatched.promise;
    failed.worker.reject(error);
    await rejected;
    assert.equal(fs.existsSync(failed.file + '.journal.pending'), true);
    assert.equal(Persistence.prototype.checkpoint, original);
    await failed.persistence.close();
    console.log('PASS: worker failures propagate and retain sealed input');

    const invalid = store('invalid-report');
    const malformed = observe(invalid.file, () => invalid.persistence.schedule(0));
    const malformedRejected = assert.rejects(malformed, /Invalid mail checkpoint result/);
    await invalid.dispatched.promise;
    invalid.worker.resolve({ sequence: 'invalid' });
    await malformedRejected;
    assert.equal(fs.existsSync(invalid.file + '.journal.pending'), true);
    assert.equal(Persistence.prototype.checkpoint, original);
    await invalid.persistence.close();
    console.log('PASS: malformed production worker reports fail and retain sealed input');

    startupTimeout = 10;
    await assert.rejects(observe(path.join(dir, 'never-started'), () => {}), /did not start/);
    assert.equal(Persistence.prototype.checkpoint, original);
    console.log('PASS: absent scheduling remains a bounded failure');
  } finally {
    clearTimeout(watchdog);
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
