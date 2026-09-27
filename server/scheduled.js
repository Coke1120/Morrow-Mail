// Durable, explicitly reviewed sends. The caller supplies the ordinary send path.
const ACTIVE = new Set(['scheduled', 'sending', 'uncertain']);
const GRACE_MS = 15 * 60_000;
const errors = {
  missed: 'The scheduled time was missed by more than 15 minutes. Review and schedule a new time.',
  connection_changed: 'The mailbox connection changed. Review this draft and schedule again.',
  draft_changed: 'The saved draft changed. Review it and schedule again.',
  uncertain: 'Delivery could not be confirmed. Check Sent before explicitly retrying the saved draft; retrying may send a duplicate.',
};
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9-]{8,100}$/.test(value);
function sendTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('Choose a valid send time in UTC.');
  return Date.parse(value);
}

export function createScheduled({ store, connection, prepare, fingerprint, outgoing, send, lock, ensureDraftIdle = () => {}, now = Date.now }) {
  let stopped = false;
  const inFlight = new Set();
  const jobs = () => store.getSettings().scheduledSends || [];
  const write = values => {
    const history = values.filter(job => !ACTIVE.has(job.status)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 100);
    store.setSettings({ scheduledSends: [...values.filter(job => ACTIVE.has(job.status)), ...history] });
  };
  const owned = (owner, id) => { const job = jobs().find(job => job.accountId === owner && job.id === id); if (!job) fail('Scheduled send not found.', 404); return job; };
  const realOwner = owner => { if (!owner || ['all', 'demo'].includes(owner) || !connection(owner)) fail('Choose a connected sending mailbox.', 409); };
  const project = job => ({ id: job.id, requestId: job.id, accountId: job.accountId, draftId: job.draftId, sendAt: job.sendAt, status: job.status, createdAt: job.createdAt, updatedAt: job.updatedAt, claimedAt: job.claimedAt || null, sentAt: job.sentAt || null, payload: job.payload, fromName: job.fromName, errorCode: Object.hasOwn(errors, job.errorCode) ? job.errorCode : null, error: errors[job.errorCode] || '', requiresSendReview: job.status === 'uncertain' });
  const result = job => { const message = store.getMessage(job.accountId, job.draftId); return { job: project(job), message: message && { ...message, accountId: job.accountId, viewId: JSON.stringify([job.accountId, message.id]) }, appOpenRequired: true, lateGraceMinutes: 15 }; };
  function guardDraft(owner, draftId, allowedScheduledId = null) {
    if (!draftId) return;
    const job = jobs().find(job => job.accountId === owner && job.draftId === draftId && ['scheduled', 'sending'].includes(job.status));
    if (job && !(job.status === 'sending' && job.id === allowedScheduledId)) fail('Cancel the scheduled send before editing or sending this draft.', 409);
  }
  function guardSend(owner, input, allowedScheduledId = null) {
    const job = jobs().find(job => job.accountId === owner && job.id === input.requestId && ['scheduled', 'sending'].includes(job.status));
    guardDraft(owner, input.draftId, allowedScheduledId);
    if (job) guardDraft(owner, job.draftId, allowedScheduledId);
  }
  function start(owner, input) {
    realOwner(owner);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['sendAt', 'requestId', 'draftId', 'to', 'cc', 'bcc', 'subject', 'body', 'footer', 'replyToId'].includes(key))) fail('Invalid scheduled message.');
    if (!identifier(input.requestId)) fail('Invalid send request ID.');
    const timestamp = sendTime(input.sendAt);
    const reviewed = prepare(owner, input), payload = structuredClone(reviewed.payload);
    const hash = fingerprint(payload), id = input.requestId;
    const draftId = input.draftId || `outbox:scheduled:${id}`;
    if (typeof draftId !== 'string' || draftId.length > 8192) fail('Invalid draft ID.');
    return store.transaction(() => {
      const previous = jobs().find(job => job.accountId === owner && job.id === id);
      if (previous) {
        if (previous.payloadHash !== hash || previous.sendAt !== input.sendAt || previous.draftId !== draftId) fail('This schedule request was already used for different content or time.', 409);
        return result(previous);
      }
      if (timestamp <= now()) fail('Choose a future send time.');
      if (jobs().filter(job => ACTIVE.has(job.status)).length >= 200) fail('Review or cancel existing scheduled sends before scheduling more.', 409);
      if (store.getMessage(owner, `sent:${id}`)) fail('This request was already sent. Start a new draft.', 409);
      guardDraft(owner, draftId); ensureDraftIdle(owner, draftId);
      if (input.draftId) {
        const draft = store.getMessage(owner, draftId);
        if (!draft) fail('Draft not found.', 404);
        if (draft.folder !== 'drafts' || draft.providerDraft === true) fail('Copy provider drafts to a local draft before scheduling.', 409);
      }
      if ((store.getSettings().deliveryAttempts || []).some(attempt => attempt.account === owner && (attempt.draftId === draftId || attempt.requestId === id))) fail('Review the unconfirmed delivery before scheduling this draft.', 409);
      if (payload.replyToId && !store.getMessage(owner, payload.replyToId)) fail('Reply message not found in this mailbox.', 404);
      const date = new Date(now()).toISOString();
      const job = { id, accountId: owner, draftId, sendAt: input.sendAt, status: 'scheduled', createdAt: date, updatedAt: date, connectionId: connection(owner).connectionId ?? null, payload, payloadHash: hash, fromName: reviewed.fromName || '', replyMessageId: reviewed.replyMessageId || '' };
      store.upsertMessage(owner, outgoing(owner, payload, { id: draftId, folder: 'drafts', fromName: job.fromName, scheduledSend: { id, sendAt: job.sendAt, status: job.status } }));
      write([...jobs(), job]);
      return result(job);
    });
  }
  function cancel(owner, id) {
    realOwner(owner);
    return store.transaction(() => {
      const job = owned(owner, id);
      if (job.status === 'cancelled') return result(job);
      if (!['scheduled', 'missed', 'blocked'].includes(job.status)) fail('This send has already started. Check Sent and review its delivery status.', 409);
      const changed = { ...job, status: 'cancelled', errorCode: null, updatedAt: new Date(now()).toISOString() };
      write(jobs().map(item => item.accountId === owner && item.id === id ? changed : item));
      markDraft(changed, 'cancelled');
      return result(changed);
    });
  }
  function markDraft(job, status) {
    const draft = store.getMessage(job.accountId, job.draftId);
    if (draft) store.upsertMessage(job.accountId, { ...draft, scheduledSend: { id: job.id, sendAt: job.sendAt, status } });
  }
  function finish(job, status, errorCode = null) {
    const date = new Date(now()).toISOString();
    store.transaction(() => {
      write(jobs().map(item => item.accountId === job.accountId && item.id === job.id ? { ...item, status, errorCode, updatedAt: date, ...(status === 'sent' ? { sentAt: date } : {}) } : item));
      markDraft(job, status);
    });
  }
  function reconcile(job) {
    const sent = store.getMessage(job.accountId, `sent:${job.id}`);
    if (sent && fingerprint(sent) === job.payloadHash) { finish(job, 'sent'); return; }
    // Even a crash before the provider call requires explicit review, never a replay.
    const config = store.getSettings(), attempts = config.deliveryAttempts || [];
    if (!attempts.some(attempt => attempt.account === job.accountId && (attempt.requestId === job.id || attempt.draftId === job.draftId))) {
      store.setSettings({ deliveryAttempts: [...attempts, { account: job.accountId, requestId: job.id, draftId: job.draftId, payloadHash: job.payloadHash, createdAt: job.claimedAt || new Date(now()).toISOString() }] });
    }
    store.upsertMessage(job.accountId, outgoing(job.accountId, job.payload, { id: job.draftId, folder: 'drafts', fromName: job.fromName, deliveryStatus: 'unconfirmed', deliveryRequestId: job.id }));
    finish(job, 'uncertain', 'uncertain');
  }
  function recover() {
    store.transaction(() => { for (const job of jobs()) {
      if (job.status === 'sending') reconcile(job);
      else if (job.status === 'uncertain') {
        const sent = store.getMessage(job.accountId, `sent:${job.id}`);
        if (sent && fingerprint(sent) === job.payloadHash) finish(job, 'sent');
      }
    } });
  }
  async function runTick() {
    if (stopped) return;
    let entered = false;
    try {
      await lock(async () => {
        entered = true; if (stopped) return;
        recover();
        const job = jobs().filter(job => job.status === 'scheduled' && Date.parse(job.sendAt) <= now()).sort((a, b) => a.sendAt.localeCompare(b.sendAt))[0];
        if (!job) return;
        const draft = store.getMessage(job.accountId, job.draftId), mail = connection(job.accountId);
        if (now() - Date.parse(job.sendAt) > GRACE_MS) { finish(job, 'missed', 'missed'); return; }
        if (!mail || (mail.connectionId ?? null) !== job.connectionId) { finish(job, 'blocked', 'connection_changed'); return; }
        if (!draft || draft.folder !== 'drafts' || draft.providerDraft === true || fingerprint(draft) !== job.payloadHash) { finish(job, 'blocked', 'draft_changed'); return; }
        ensureDraftIdle(job.accountId, job.draftId);
        store.transaction(() => {
          const claimed = { ...job, status: 'sending', claimedAt: new Date(now()).toISOString(), updatedAt: new Date(now()).toISOString() };
          write(jobs().map(item => item.accountId === job.accountId && item.id === job.id ? claimed : item));
          markDraft(job, 'sending');
        });
        try {
          await send(job.accountId, { ...job.payload, requestId: job.id, draftId: job.draftId }, { mailboxLocked: true, scheduledId: job.id, fromName: job.fromName, replyMessageId: job.replyMessageId });
        } catch { /* The ordinary send path retains its own uncertain-delivery record. */ }
        store.transaction(() => reconcile(owned(job.accountId, job.id)));
      });
    } catch (error) { if (!entered && error.status === 409) return; throw error; }
  }
  function tick() {
    if (stopped) return Promise.resolve();
    const work = runTick(); inFlight.add(work);
    work.then(() => inFlight.delete(work), () => inFlight.delete(work));
    return work;
  }
  return { start, cancel, guardDraft, guardSend, recover, tick, stop: () => { stopped = true; return Promise.allSettled([...inFlight]).then(() => {}); }, list: owner => { realOwner(owner); return { scheduled: jobs().filter(job => job.accountId === owner).sort((a, b) => a.sendAt.localeCompare(b.sendAt)).map(project), appOpenRequired: true, lateGraceMinutes: 15 }; } };
}
