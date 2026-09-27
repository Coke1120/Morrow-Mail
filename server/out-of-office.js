import { createHash } from 'node:crypto';
import { convert } from 'html-to-text';
import { providerRequest } from './providers.js';

export const OUT_OF_OFFICE_SCOPES = { google: 'https://www.googleapis.com/auth/gmail.settings.basic', microsoft: 'MailboxSettings.ReadWrite' };
const roots = { google: 'https://gmail.googleapis.com/gmail/v1/users/me/settings/vacation', microsoft: 'https://graph.microsoft.com/v1.0/me/mailboxSettings' };
const links = { google: 'https://mail.google.com/mail/u/0/#settings/general', microsoft: 'https://outlook.live.com/mail/0/options/mail/automaticReplies' };
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const scopes = mail => new Set((typeof mail.grantedScopes === 'string' ? mail.grantedScopes : '').split(/\s+/).map(scope => scope.toLowerCase().replace(/^https:\/\/graph\.microsoft\.com\//, '')));
export function capability(mail, accountId) {
  const provider = mail.provider || 'imap', supported = Object.hasOwn(roots, provider);
  const granted = scopes(mail), requiredScope = OUT_OF_OFFICE_SCOPES[provider] || '';
  const canWrite = supported && granted.has(requiredScope.toLowerCase());
  const canRead = canWrite || provider === 'microsoft' && granted.has('mailboxsettings.read');
  return { accountId, provider, supported, canRead, canWrite, requiresReconnect: supported && !canWrite, requiredScope, providerUrl: links[provider] || null };
}
function permission() { fail('Reconnect this mailbox with explicit Out of Office settings permission, then refresh. Your existing mail connection is retained.', 403); }
function text(value, limit, name) {
  if (typeof value !== 'string' || [...value].length > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail(`Enter a plain-text ${name} of at most ${limit} characters.`);
  return value.replace(/\r\n?/g, '\n');
}
function date(value) {
  if (value === '') return '';
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) fail('Use a valid date and time with a UTC timezone.');
  const parsed = new Date(value);
  if (!Number.isFinite(+parsed) || parsed.toISOString().slice(0, 19) !== value.slice(0, 19)) fail('Use a valid date and time.');
  return parsed.toISOString();
}
const html = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/\n/g, '<br>');

// Only this explicit, validated subset can be submitted to a provider.
export function providerPayload(provider, body, now = Date.now()) {
  if (!body || typeof body !== 'object' || body.confirmed !== true || !['save', 'disable'].includes(body.action)) fail('Review and confirm Save, Enable or Disable before changing provider settings.');
  if (body.action === 'disable') return provider === 'google' ? { enableAutoReply: false } : { automaticRepliesSetting: { status: 'disabled' } };
  if (!['disabled', 'always', 'scheduled'].includes(body.mode)) fail('Choose Disabled, Always or Scheduled.');
  const subject = text(body.subject, 200, 'subject'), message = text(body.message, 10000, 'reply'), externalMessage = text(body.externalMessage, 10000, 'external reply');
  if (subject.includes('\n')) fail('The subject must fit on one line.');
  if (!['all', 'contacts', ...(provider === 'microsoft' ? ['none'] : [])].includes(body.audience) || typeof body.restrictToDomain !== 'boolean') fail('Choose a valid reply audience.');
  let start = '', end = '';
  if (body.mode === 'scheduled') {
    start = date(body.start); end = date(body.end);
    if (provider === 'microsoft' ? !start || !end : !start && !end) fail('Enter the automatic reply schedule. Outlook requires both start and end.');
    if (start && end && start >= end) fail('The end must be after the start.');
    if (end && Date.parse(end) <= now) fail('Choose an end time in the future.');
  }
  if (body.mode !== 'disabled' && (!message.trim() || provider === 'microsoft' && body.audience !== 'none' && !externalMessage.trim())) fail('Enter a reply message for each enabled audience.');
  if (provider === 'google') return { enableAutoReply: body.mode !== 'disabled', responseSubject: subject, responseBodyPlainText: message, restrictToContacts: body.audience === 'contacts', restrictToDomain: body.restrictToDomain, ...(start ? { startTime: String(Date.parse(start)) } : {}), ...(end ? { endTime: String(Date.parse(end)) } : {}) };
  return { automaticRepliesSetting: { status: { disabled: 'disabled', always: 'alwaysEnabled', scheduled: 'scheduled' }[body.mode], internalReplyMessage: html(message), externalReplyMessage: html(externalMessage), externalAudience: { none: 'none', contacts: 'contactsOnly', all: 'all' }[body.audience], ...(start ? { scheduledStartDateTime: { dateTime: start.slice(0, -1), timeZone: 'UTC' }, scheduledEndDateTime: { dateTime: end.slice(0, -1), timeZone: 'UTC' } } : {}) } };
}
function bounded(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Buffer.byteLength(JSON.stringify(raw)) > 128 * 1024) fail('The provider returned invalid or oversized automatic reply settings.', 502);
  return raw;
}
const revision = raw => createHash('sha256').update(JSON.stringify(raw)).digest('hex');
function plain(value) { return typeof value === 'string' ? convert(value, { wordwrap: false, selectors: [{ selector: 'img', format: 'skip' }, { selector: 'a', options: { ignoreHref: true } }] }).trim() : ''; }
function googleDate(value) { const n = Number(value); return Number.isFinite(n) && n > 0 && n < 4102444800000 ? new Date(n).toISOString() : ''; }
function microsoftDate(value) {
  if (!value?.dateTime || !['UTC', 'Etc/UTC', 'Etc/GMT'].includes(value.timeZone)) return '';
  const input = value.dateTime.replace(/Z$/, '').replace(/(\.\d{3})\d+$/, '$1') + 'Z';
  try { return date(input); } catch { return ''; }
}
function projection(mail, accountId, raw) {
  const google = mail.provider === 'google';
  const strings = google ? ['responseSubject', 'responseBodyPlainText', 'responseBodyHtml'] : ['status', 'internalReplyMessage', 'externalReplyMessage', 'externalAudience'];
  if (strings.some(key => raw[key] !== undefined && typeof raw[key] !== 'string') || (google ? typeof raw.enableAutoReply !== 'boolean' : !['disabled', 'alwaysenabled', 'scheduled'].includes(raw.status?.toLowerCase()))) fail('The provider returned incomplete automatic reply settings.', 502);
  const start = google ? googleDate(raw.startTime) : microsoftDate(raw.scheduledStartDateTime);
  const end = google ? googleDate(raw.endTime) : microsoftDate(raw.scheduledEndDateTime);
  const mode = google ? raw.enableAutoReply ? raw.startTime && raw.startTime !== '0' || raw.endTime && raw.endTime !== '0' ? 'scheduled' : 'always' : 'disabled' : ({ disabled: 'disabled', alwaysenabled: 'always', scheduled: 'scheduled' })[raw.status.toLowerCase()];
  const scheduleWarning = mode === 'scheduled' && (google ? !start && !end : !start || !end) ? 'The provider has a schedule that cannot be edited safely here. Re-enter its dates before saving, or manage it in provider settings. Disable remains available.' : '';
  return { ...capability(mail, accountId), revision: revision(raw), scheduleWarning, settings: { mode, start, end, subject: google ? raw.responseSubject || '' : '', message: google ? raw.responseBodyHtml ? plain(raw.responseBodyHtml) : raw.responseBodyPlainText || '' : plain(raw.internalReplyMessage), externalMessage: google ? '' : plain(raw.externalReplyMessage), audience: google ? raw.restrictToContacts ? 'contacts' : 'all' : ({ none: 'none', contactsonly: 'contacts', all: 'all' })[raw.externalAudience?.toLowerCase()] || 'none', restrictToDomain: google && raw.restrictToDomain === true } };
}

export function createOutOfOffice({ connections, currentMail, lock, request = providerRequest }) {
  function connection(account) {
    const accounts = connections();
    if (typeof account !== 'string' || ['all', 'demo', ''].includes(account) || !Object.hasOwn(accounts, account)) fail('Choose an individual connected mailbox using X-Genmail-Account.', 409);
    return accounts[account];
  }
  async function remote(mail, method = 'GET', body) {
    const google = mail.provider === 'google';
    const result = await request(roots[mail.provider] + (!google && method === 'GET' ? '/automaticRepliesSetting' : ''), { method, headers: { Authorization: `Bearer ${mail.accessToken}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }, google ? 'Gmail' : 'Outlook');
    return bounded(!google && method !== 'GET' ? result?.automaticRepliesSetting : result);
  }
  async function execute(account, body) {
    const initial = connection(account), info = capability(initial, account), writing = body !== undefined;
    if (!info.supported || !info.canRead) { if (writing) { if (!info.supported) fail('IMAP does not support server-managed automatic replies. Use your provider’s webmail settings.', 400); permission(); } return info; }
    if (writing && !info.canWrite) permission();
    const payload = writing ? providerPayload(initial.provider, body) : null;
    if (writing && (typeof body.revision !== 'string' || !/^[a-f0-9]{64}$/.test(body.revision))) fail('Refresh provider settings before saving.', 409);
    const mail = await currentMail(account);
    if (!(writing ? capability(mail, account).canWrite : capability(mail, account).canRead)) permission();
    let current;
    try { current = bounded(await remote(mail)); } catch (error) { if (error.providerStatus === 403) permission(); throw error; }
    if (JSON.stringify(connection(account)) !== JSON.stringify(mail)) fail('This mailbox connection changed. Refresh settings.', 409);
    if (!writing) return projection(mail, account, current);
    if (revision(current) !== body.revision) fail('Provider settings changed since you opened this page. Refresh and review them before saving.', 409);
    if (body.action === 'disable' && mail.provider === 'google') Object.assign(payload, Object.fromEntries(Object.entries(current).filter(([key]) => ['responseSubject', 'responseBodyPlainText', 'responseBodyHtml', 'restrictToContacts', 'restrictToDomain', 'startTime', 'endTime'].includes(key))));
    let updated;
    try { updated = await remote(mail, mail.provider === 'google' ? 'PUT' : 'PATCH', payload); }
    catch { fail('The provider change could not be confirmed. Refresh provider settings before retrying; Morrow will not retry automatically.', 502); }
    if (JSON.stringify(connection(account)) !== JSON.stringify(mail)) fail('This mailbox connection changed. Refresh provider settings to check the result.', 409);
    return projection(mail, account, updated);
  }
  return { get: account => lock(() => execute(account)), put: (account, body) => lock(() => execute(account, body ?? {})) };
}
