import { createHash, randomUUID } from 'node:crypto';

const invalid = message => { throw Object.assign(new Error(message), { status: 400 }); };
const retryDelays = [30_000, 120_000, 300_000];
const clearFailure = { error: '', errorCode: null, recoveryAction: null, nextRetryAt: null, retryCount: 0 };
const importErrors = {
  authorization: 'Reconnect this mailbox, then start a new import.',
  invalid_cursor: 'The mailbox page changed or repeated. Start a new import; cached mail is retained.',
  invalid_page: 'The provider returned an invalid import page. Start a new import; cached mail is retained.',
  sent_unavailable: 'This server does not identify a Sent folder. Choose Inbox only and start a new import.',
  rate_limited: 'The provider is limiting requests. Saved progress is retained.',
  provider_unavailable: 'The provider is temporarily unavailable. Saved progress is retained.',
  network_error: 'The provider could not be reached. Saved progress is retained.',
  storage_error: 'Import could not save this page. Check available disk space, then resume. Saved progress is retained.',
  connection_changed: 'Connection changed. Start a new import.',
  import_failed: 'Import could not finish this page. Check the connection, then resume. Saved progress is retained.',
};
function importFailure(error, stage) {
  const result = (errorCode, recoveryAction = 'resume', retry = false) => ({ errorCode, error: importErrors[errorCode], recoveryAction, retry });
  if (stage === 'commit') return result('storage_error');
  const status = error.providerStatus ?? error.status;
  if ([401, 403].includes(status)) return result('authorization', 'reconnect');
  if (error.code === 'import_cursor' || error.message === 'The IMAP folder changed. Start the import again.') return result('invalid_cursor', 'restart');
  if (error.code === 'import_page') return result('invalid_page', 'restart');
  if (/^(?:The|This) IMAP server does not identify a Sent folder\./.test(error.message || '')) return result('sent_unavailable', 'restart');
  if (stage === 'fetch' && status === 429) return result('rate_limited', 'retry', true);
  if (stage === 'fetch' && error.providerStatus >= 500 && error.providerStatus <= 599) return result('provider_unavailable', 'retry', true);
  if (stage === 'fetch' && error.code === 'provider_network') return result('network_error', 'retry', true);
  return result('import_failed');
}
export function importOptions(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['months', 'inbox', 'sent', 'allMail'].includes(key))) invalid('Invalid import options.');
  const options = { months: 3, inbox: true, sent: true, allMail: false, ...value };
  if (![0, 1, 3, 6, 12].includes(options.months) || typeof options.inbox !== 'boolean' || typeof options.sent !== 'boolean' || typeof options.allMail !== 'boolean' || !(options.allMail || options.inbox || options.sent)) invalid('Choose all history or 1, 3, 6, or 12 months and at least one folder.');
  return options;
}
export function monthsAgo(months, now = Date.now()) {
  const date = new Date(now), day = date.getUTCDate();
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() - months);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.toISOString();
}

export function createHistory({ store, connection, currentMail, fetchPage, importMessages, lock, now = Date.now }) {
  const read = account => store.getSettings().imports?.[account];
  const write = (account, value) => store.setSettings({ imports: { ...store.getSettings().imports, [account]: value } });
  const folders = job => job.options.allMail ? ['all'] : ['inbox', 'sent'].filter(key => job.options[key]);
  const current = (account, job) => read(account)?.id === job.id && read(account)?.status === 'running' && !!connection(account) && job.connectionId === connection(account).connectionId;
  function start(account, input) {
    const options = importOptions(input);
    const mail = connection(account);
    if (!mail) invalid('Choose a connected mailbox.');
    if (options.allMail && !['google', 'microsoft', 'imap', undefined, ''].includes(mail.provider)) invalid('Unsupported mailbox provider.');
    const before = new Date(now()).toISOString();
    write(account, { id: randomUUID(), options, since: options.months === 0 ? '' : monthsAgo(options.months, now()), before, folderIndex: 0, cursor: null, visited: [], status: 'running', imported: 0, pages: 0, processed: 0, connectionId: mail.connectionId, updatedAt: before, ...clearFailure });
  }
  function control(account, action) {
    const job = read(account);
    if (!job || job.status === 'complete' || !['pause', 'resume'].includes(action)) invalid('No import to pause or resume.');
    if (action === 'resume' && (!connection(account) || job.connectionId !== connection(account).connectionId)) invalid('Start a new import for this connection.');
    write(account, { ...job, id: randomUUID(), status: action === 'pause' ? 'paused' : 'running', ...clearFailure, updatedAt: new Date(now()).toISOString() });
  }
  function status(account) {
    const job = read(account);
    if (!job) return null;
    const { options, since, before, status, imported, updatedAt } = job;
    const errorCode = Object.hasOwn(importErrors, job.errorCode) ? job.errorCode : status === 'failed' ? 'import_failed' : null;
    const error = errorCode ? importErrors[errorCode] : '';
    const recoveryAction = status === 'running' && job.nextRetryAt ? 'retry' : ['failed', 'paused'].includes(status) ? errorCode === 'authorization' ? 'reconnect' : ['invalid_cursor', 'invalid_page', 'sent_unavailable', 'connection_changed'].includes(errorCode) ? 'restart' : 'resume' : null;
    const provider = connection(account) ? connection(account).provider || 'imap' : null;
    const coverage = { provider, folders: folders(job), excludes: ['spam', 'trash'], folderLimit: options.allMail && ['microsoft', 'imap'].includes(provider) ? 300 : null };
    return { options, since, before, status, imported, updatedAt, coverage, error, errorCode, recoveryAction, nextRetryAt: job.nextRetryAt ?? null, retryCount: job.retryCount ?? 0, currentFolder: folders(job)[job.folderIndex] ?? null, phase: status === 'running' ? (job.nextRetryAt ? 'retrying' : 'queued') : status, pages: job.pages ?? null, processed: job.processed ?? null, lastPageChecked: job.lastPageChecked ?? null, lastPageAdded: job.lastPageAdded ?? null };
  }
  async function tick() {
    // One read-only page per tick keeps interactive mailbox operations responsive.
    const entry = Object.entries(store.getSettings().imports || {}).filter(([account, job]) => connection(account) && job.status === 'running' && (!job.nextRetryAt || Date.parse(job.nextRetryAt) <= now() || job.connectionId !== connection(account).connectionId)).sort((a, b) => a[1].updatedAt.localeCompare(b[1].updatedAt))[0];
    if (!entry) return;
    const [account, job] = entry;
    let entered = false, stage = 'refresh';
    try {
      await lock(async () => {
        entered = true;
        if (read(account)?.id !== job.id || read(account)?.status !== 'running') return;
        if (!connection(account) || job.connectionId !== connection(account).connectionId) { write(account, { ...job, ...clearFailure, status: 'paused', error: 'Connection changed. Start a new import.', errorCode: 'connection_changed', recoveryAction: 'restart', updatedAt: new Date(now()).toISOString() }); return; }
        const scope = folders(job);
        const mail = await currentMail(account);
        if (!current(account, job)) return;
        stage = 'fetch';
        const result = await fetchPage(mail, { folder: scope[job.folderIndex], since: job.since, before: job.before, cursor: job.cursor });
        if (!current(account, job)) return;
        if (!Array.isArray(result?.messages) || result.messages.length > 50) throw Object.assign(new Error('Invalid import page.'), { code: 'import_page' });
        if (result.nextCursor && JSON.stringify(result.nextCursor) === JSON.stringify(job.cursor)) throw Object.assign(new Error('Repeated import page.'), { code: 'import_cursor' });
        const cursorHash = result.nextCursor ? createHash('sha256').update(JSON.stringify(result.nextCursor)).digest('hex') : null;
        if (cursorHash && (job.visited || []).includes(cursorHash)) throw Object.assign(new Error('Repeated import page.'), { code: 'import_cursor' });
        stage = 'commit';
        store.transaction(() => {
          const imported = importMessages(connection(account), result.messages.filter(message => message.date >= job.since && message.date < job.before)).length;
          const folderIndex = result.nextCursor ? job.folderIndex : job.folderIndex + 1;
          write(account, { ...job, imported: job.imported + imported, pages: job.pages == null ? null : job.pages + 1, processed: job.processed == null ? null : job.processed + result.messages.length, lastPageChecked: result.messages.length, lastPageAdded: imported, cursor: result.nextCursor || null, visited: cursorHash ? [...(job.visited || []), cursorHash] : [], folderIndex, status: folderIndex >= scope.length ? 'complete' : 'running', ...clearFailure, updatedAt: new Date(now()).toISOString() });
        });
      });
    } catch (error) {
      if (!entered && error.status === 409) return; // Only acquisition failure means the mailbox is busy.
      if (!current(account, job)) return;
      const { retry, ...failure } = importFailure(error, stage);
      const retryCount = job.retryCount ?? 0, delay = retry && retryDelays[retryCount];
      write(account, { ...job, ...failure, status: delay ? 'running' : 'failed', recoveryAction: delay ? 'retry' : failure.recoveryAction === 'retry' ? 'resume' : failure.recoveryAction, retryCount: delay ? retryCount + 1 : retryCount, nextRetryAt: delay ? new Date(now() + delay).toISOString() : null, updatedAt: new Date(now()).toISOString() });
    }
  }
  return { start, control, status, tick, options: account => read(account)?.options };
}
