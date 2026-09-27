import { messageContent } from './footer.js';
import { sanitizeMessageHTML } from './message-html.js';
import { createHash, randomBytes } from 'node:crypto';
import { simpleParser } from 'mailparser';
import { recipients } from './recipients.js';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';

const providers = {
  google: {
    name: 'Google',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    api: 'https://gmail.googleapis.com/gmail/v1/users/me',
    scope: 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
    organizeScope: 'openid email https://www.googleapis.com/auth/gmail.modify',
    calendarScope: 'openid email https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events',
  },
  microsoft: {
    name: 'Microsoft',
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    api: 'https://graph.microsoft.com/v1.0/me',
    scope: 'offline_access User.Read Mail.Read Mail.Send',
    organizeScope: 'offline_access User.Read Mail.ReadWrite Mail.Send',
    calendarScope: 'offline_access User.Read Calendars.ReadWrite',
  },
};

function providerConfig(provider) {
  if (!Object.hasOwn(providers, provider)) throw new Error('Unsupported mailbox provider.');
  return providers[provider];
}

export async function providerRequest(url, options, name, oauth = false) {
  let response;
  try {
    response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  } catch {
    throw Object.assign(new Error(`${name} could not be reached. Check your connection and try again.`), { code: 'provider_network' });
  }
  if (!response.ok) {
    const message = response.status === 401 ? `${name} authorization expired. Reconnect your account.`
      : response.status === 429 ? `${name} is rate limiting requests. Try again shortly.`
        : `${name} rejected the request (HTTP ${response.status}). Check your account authorization and app configuration.`;
    const error = Object.assign(new Error(message), { providerStatus: response.status });
    if (oauth && [400, 401].includes(response.status)) {
      const body = await responseJSON(response, name, 32768).catch(() => null);
      error.code = ['invalid_grant', 'interaction_required', 'consent_required'].includes(body?.error) ? 'oauth_reconnect_required'
        : ['invalid_client', 'unauthorized_client', 'invalid_scope'].includes(body?.error) ? 'oauth_configuration' : 'oauth_refresh_failed';
    } else await response.body?.cancel();
    throw error;
  }
  return responseJSON(response, name);
}

async function responseJSON(response, name, maximumBytes = 8 * 1024 * 1024) {
  if (Number(response.headers.get('content-length')) > maximumBytes) {
    await response.body?.cancel();
    throw new Error(`${name} returned a response that is too large.`);
  }
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of response.body || []) {
      bytes += chunk.byteLength;
      if (bytes > maximumBytes) throw new Error('Response limit exceeded.');
      chunks.push(chunk);
    }
  } catch {
    throw Object.assign(new Error(`${name} returned an incomplete or oversized response. Try a smaller request.`), bytes > maximumBytes ? {} : { code: 'provider_network' });
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${name} returned an unreadable response.`);
  }
}

function apiRequest(mail, path, options = {}) {
  const provider = providerConfig(mail.provider);
  return providerRequest(`${provider.api}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${mail.accessToken}`, ...options.headers },
  }, provider.name);
}

function oauthPurpose(purpose) {
  if (!['mail', 'calendar'].includes(purpose)) throw new Error('Unsupported OAuth purpose.');
  return purpose;
}

export function oauthStart(provider, config, redirectUri, purpose = 'mail') {
  const definition = providerConfig(provider);
  oauthPurpose(purpose);
  if (typeof config?.clientId !== 'string' || !config.clientId.trim()) throw new Error('An OAuth client ID is required.');
  const savedConfig = { clientId: config.clientId.trim() };
  if (purpose === 'calendar') savedConfig.purpose = purpose;
  if (purpose === 'mail') savedConfig.mailScope = config.organize === true ? definition.organizeScope : definition.scope;
  if (config.clientSecret) savedConfig.clientSecret = String(config.clientSecret);
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const url = new URL(definition.authorize);
  url.search = new URLSearchParams({
    client_id: savedConfig.clientId, redirect_uri: redirectUri,
    response_type: 'code', scope: purpose === 'calendar' ? definition.calendarScope : savedConfig.mailScope, state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    ...(provider === 'google' ? { access_type: 'offline', prompt: 'consent' } : { prompt: 'select_account' }),
  }).toString();
  return { url: url.toString(), state, verifier, config: savedConfig, purpose };
}

async function exchange(provider, config, fields) {
  const definition = providerConfig(provider);
  const purpose = oauthPurpose(config.purpose || 'mail');
  const result = await providerRequest(definition.token, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId, ...fields,
      ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
      ...(provider === 'microsoft' ? { scope: purpose === 'calendar' ? definition.calendarScope : config.mailScope || definition.scope } : {}),
    }),
  }, definition.name, true);
  if (!result?.access_token || !Number.isFinite(Number(result.expires_in)) || Number(result.expires_in) <= 0) {
    throw new Error(`${definition.name} returned an invalid authorization token.`);
  }
  return {
    accessToken: result.access_token,
    grantedScopes: typeof result.scope === 'string' ? result.scope : config.grantedScopes || config.mailScope || definition.scope,
    ...(result.refresh_token ? { refreshToken: result.refresh_token } : {}),
    expiresAt: Date.now() + Number(result.expires_in) * 1000,
  };
}

export async function oauthFinish(provider, { code, verifier, config, redirectUri, purpose = config?.purpose || 'mail' }) {
  oauthPurpose(purpose);
  if (typeof code !== 'string' || !code || !/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) throw new Error('Invalid OAuth callback.');
  const scopedConfig = { ...config, ...(purpose === 'calendar' ? { purpose } : {}) };
  const tokens = await exchange(provider, scopedConfig, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri });
  const mail = { provider, ...scopedConfig, ...tokens };
  const profile = provider === 'google' && purpose === 'calendar'
    ? await providerRequest('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${mail.accessToken}` } }, 'Google')
    : await apiRequest(mail, provider === 'google' ? '/profile' : '?$select=mail,userPrincipalName');
  const email = provider === 'google' ? (purpose === 'calendar' ? profile?.email : profile?.emailAddress) : profile?.mail || profile?.userPrincipalName;
  if (typeof email !== 'string' || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email)) throw new Error('The provider did not return an account email address.');
  return { ...mail, email: email.toLowerCase() };
}

export async function refreshMail(mail) {
  providerConfig(mail.provider);
  if (mail.accessToken && Number(mail.expiresAt) > Date.now() + 60_000) return { ...mail };
  if (!mail.refreshToken) throw Object.assign(new Error('Your mailbox authorization expired. Reconnect your mailbox.'), { code: 'oauth_reconnect_required' });
  return { ...mail, ...await exchange(mail.provider, mail, { grant_type: 'refresh_token', refresh_token: mail.refreshToken }) };
}

function category(subject, headers = []) {
  if (headers.some(header => /^(list-id|list-unsubscribe)$/i.test(header.name))) return 'newsletters';
  return /\b(receipt|invoice|order|delivery|notification|verification|security alert|payment|shipping)\b/i.test(subject) ? 'updates' : 'primary';
}

function dateString(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString();
}

function preview(body) {
  return body.replace(/\s+/g, ' ').trim().slice(0, 180);
}

function bodyParts(part, result = []) {
  if (!part || part.filename || part.headers?.some(header => /^content-disposition$/i.test(header.name) && /^attachment\b/i.test(header.value))) return result;
  if (['text/plain', 'text/html'].includes(part.mimeType) && part.body?.data) result.push(part);
  for (const child of part.parts || []) bodyParts(child, result);
  return result;
}

async function partText(part) {
  const type = part.headers?.find(header => /^content-type$/i.test(header.name))?.value || `${part.mimeType}; charset=utf-8`;
  const parsed = await simpleParser(`Content-Type: ${type.replace(/[\r\n]/g, ' ')}\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(part.body.data, 'base64url').toString('base64')}`, { skipTextToHtml: true });
  return { text: parsed.text || '', html: typeof parsed.html === 'string' ? parsed.html : '' };
}

export function googleFolder(labelIds = []) {
  const labels = Array.isArray(labelIds) ? labelIds : [];
  return labels.includes('TRASH') ? 'trash' : labels.includes('SPAM') ? 'spam' : labels.includes('DRAFT') ? 'drafts' : labels.includes('INBOX') ? 'inbox' : labels.includes('SENT') ? 'sent' : 'archive';
}

export async function normalizeGoogleMessage(message) {
  const labelIds = message.labelIds === undefined ? [] : message.labelIds;
  if (!Array.isArray(labelIds) || labelIds.length > 1000 || labelIds.some(id => typeof id !== 'string' || !id)) throw new Error('The mailbox returned invalid message labels.');
  const folder = googleFolder(labelIds);
  const headers = message.payload?.headers || [];
  const metadata = await simpleParser(headers
    .filter(header => /^[\w-]+$/.test(header.name) && !/^content-|^mime-version$/i.test(header.name))
    .map(header => `${header.name}: ${String(header.value).replace(/[\r\n]/g, ' ')}`).join('\r\n') + '\r\n\r\n', { skipTextToHtml: true });
  const parts = bodyParts(message.payload);
  const plain = parts.filter(part => part.mimeType === 'text/plain');
  const decoded = await Promise.all(parts.map(partText));
  const body = decoded.filter((_, index) => !plain.length || parts[index].mimeType === 'text/plain').map(part => part.text).join('\n\n').trim().slice(0, 100000) || '(No inline text was available. Open this message in your original mailbox to read any attachments or large message bodies.)';
  const bodyHtml = sanitizeMessageHTML(decoded.map(part => part.html).join('\n'));
  const from = metadata.from?.value?.[0];
  const subject = metadata.subject || '(No subject)';
  return {
    id: `google:${message.id}`, fromName: from?.name || from?.address || 'Unknown sender', fromEmail: from?.address || '',
    to: metadata.to?.text || '', cc: metadata.cc?.text || '', bcc: metadata.bcc?.text || '', subject, body, bodyHtml, preview: preview(body), date: dateString(Number(message.internalDate) || metadata.date),
    folder, providerSent: labelIds.includes('SENT'), providerDraft: labelIds.includes('DRAFT'), automated: headers.some(h => /^(auto-submitted|list-id|list-unsubscribe)$/i.test(h.name) && h.value !== 'no'), read: !labelIds.includes('UNREAD'), starred: labelIds.includes('STARRED'),
    category: category(subject, headers), labels: [], providerLabelIds: labelIds, ...(metadata.messageId ? { messageId: metadata.messageId } : {}),
  };
}

export async function normalizeMicrosoftMessage(message) {
  const from = message.from?.emailAddress || message.sender?.emailAddress || {};
  let body = message.body?.content || '';
  const bodyHtml = message.body?.contentType?.toLowerCase() === 'html' ? sanitizeMessageHTML(body) : '';
  if (message.body?.contentType?.toLowerCase() === 'html') {
    body = (await simpleParser(`Content-Type: text/html; charset=utf-8\r\n\r\n${body}`, { skipTextToHtml: true })).text || '';
  }
  body = body.slice(0, 100000) || '(This message has no readable text.)';
  const subject = message.subject || '(No subject)';
  return {
    id: `microsoft:${message.id}`, fromName: from.name || from.address || 'Unknown sender', fromEmail: from.address || '',
    to: (message.toRecipients || []).map(recipient => recipient.emailAddress?.address).filter(Boolean).join(', '),
    cc: (message.ccRecipients || []).map(r => r.emailAddress?.address).filter(Boolean).join(', '),
    bcc: (message.bccRecipients || []).map(r => r.emailAddress?.address).filter(Boolean).join(', '),
    subject, body, bodyHtml, preview: preview(body), date: dateString(message.receivedDateTime), folder: 'inbox',
    read: !!message.isRead, starred: message.flag?.flagStatus === 'flagged', category: category(subject, message.internetMessageHeaders),
    labels: [], ...(message.internetMessageId ? { messageId: message.internetMessageId } : {}),
  };
}

export async function fetchProviderMessages(mail) {
  return (await fetchProviderPage(mail)).messages;
}

export async function fetchProviderPage(mail, { folder = 'inbox', since, before, cursor } = {}) {
  if (!(mail.provider === 'google' ? ['all', 'inbox', 'sent', 'drafts', 'starred'] : ['inbox', 'sent']).includes(folder)) throw new Error('Unsupported import folder.');
  if (mail.provider === 'google') {
    const query = new URLSearchParams({ maxResults: '50', includeSpamTrash: 'false' });
    if (folder !== 'all') query.set('labelIds', { inbox: 'INBOX', sent: 'SENT', drafts: 'DRAFT', starred: 'STARRED' }[folder]);
    if (since || before) query.set('q', [since && `after:${Math.floor(Date.parse(since) / 1000)}`, before && `before:${Math.ceil(Date.parse(before) / 1000)}`].filter(Boolean).join(' '));
    if (cursor) query.set('pageToken', cursor);
    const list = await apiRequest(mail, `/messages?${query}`), messages = [];
    const entries = list?.messages === undefined ? [] : list.messages;
    if (!Array.isArray(entries) || entries.length > 50 || entries.some(item => typeof item?.id !== 'string' || !item.id)) throw new Error('The mailbox returned an invalid message page.');
    const labelNames = entries.length ? new Map((await googleLabels(mail)).filter(label => label.type === 'user').map(label => [label.id, label.name])) : new Map();
    for (let index = 0; index < entries.length; index += 5) {
      messages.push(...await Promise.all(entries.slice(index, index + 5).map(async item => {
        const message = await normalizeGoogleMessage(await apiRequest(mail, `/messages/${encodeURIComponent(item.id)}?format=full`));
        message.labels = message.providerLabelIds.map(id => labelNames.get(id)).filter(Boolean);
        return message;
      })));
    }
    return { messages, nextCursor: list.nextPageToken || null };
  }
  providerConfig(mail.provider);
  const dateField = folder === 'sent' ? 'sentDateTime' : 'receivedDateTime';
  const path = `/mailFolders/${folder === 'sent' ? 'sentitems' : 'inbox'}/messages`;
  const query = new URLSearchParams({ '$top': '50', '$orderby': `${dateField} desc`, '$select': 'id,from,sender,toRecipients,ccRecipients,bccRecipients,subject,body,receivedDateTime,sentDateTime,isRead,flag,internetMessageId,internetMessageHeaders' });
  if (since || before) query.set('$filter', [since && `${dateField} ge ${since}`, before && `${dateField} lt ${before}`].filter(Boolean).join(' and '));
  const target = cursor || `https://graph.microsoft.com/v1.0/me${path}?${query}`;
  const url = new URL(target);
  if (url.origin !== 'https://graph.microsoft.com' || url.pathname !== `/v1.0/me${path}` || url.username || url.password || url.hash) throw new Error('Invalid mailbox pagination URL.');
  const result = await providerRequest(url.href, { headers: { Authorization: `Bearer ${mail.accessToken}`, Prefer: 'outlook.body-content-type="html", IdType="ImmutableId"' } }, 'Microsoft');
  return { messages: await Promise.all((result.value || []).map(async item => ({ ...await normalizeMicrosoftMessage(item), folder, date: dateString(item[dateField]), automated: (item.internetMessageHeaders || []).some(h => /^(auto-submitted|list-id|list-unsubscribe)$/i.test(h.name) && h.value !== 'no') }))), nextCursor: result['@odata.nextLink'] || null };
}

export async function sendProviderMessage(mail, { to, cc = '', bcc = '', subject, body, footer, replyMessageId, fromName }) {
  providerConfig(mail.provider);
  if (![mail.email].every(email => typeof email === 'string' && /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(email))) throw new Error('A valid sender and recipient email address are required.');
  if (typeof subject !== 'string' || /[\r\n]/.test(subject) || typeof body !== 'string') throw new Error('Invalid email subject or body.');
  if (replyMessageId && (typeof replyMessageId !== 'string' || /[\r\n]/.test(replyMessageId))) throw new Error('Invalid reply message ID.');
  const addresses = recipients({ to, cc, bcc });
  const composed = new MailComposer({
    from: { name: fromName || '', address: mail.email }, ...addresses, subject, ...messageContent({ body, footer }),
    ...(replyMessageId ? { inReplyTo: replyMessageId, references: replyMessageId } : {}),
    disableFileAccess: true, disableUrlAccess: true,
  }).compile();
  // API delivery has no separate SMTP envelope: the provider needs Bcc in MIME.
  composed.keepBcc = true;
  const raw = await composed.build();
  if (mail.provider === 'google') {
    await apiRequest(mail, '/messages/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ raw: raw.toString('base64url') }) });
  } else {
    // Graph's MIME endpoint saves sent messages by default and preserves RFC reply headers.
    await apiRequest(mail, '/sendMail', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: raw.toString('base64') });
  }
  return { messageId: composed.messageId() };
}

export function canOrganizeMail(mail) {
  if (!mail.provider || mail.provider === 'imap') return !!mail.email;
  const scopes = (mail.grantedScopes || mail.mailScope || '').split(/\s+/);
  return scopes.includes(mail.provider === 'google' ? 'https://www.googleapis.com/auth/gmail.modify' : 'Mail.ReadWrite');
}

async function googleLabels(mail) {
  const result = await apiRequest(mail, '/labels');
  if (!Array.isArray(result?.labels) || result.labels.length > 1000 || result.labels.some(label => typeof label?.id !== 'string' || !label.id || typeof label.name !== 'string' || !label.name)) throw new Error('The mailbox returned too many or invalid labels.');
  return result.labels;
}

export async function listProviderFolders(mail) {
  if (!canOrganizeMail(mail)) throw new Error('Reconnect this mailbox with “Allow moving mail and managing labels” enabled.');
  if (mail.provider === 'google') {
    const labels = await googleLabels(mail);
    return [{ id: 'INBOX', name: 'Inbox', kind: 'inbox' }, { id: '__archive', name: 'Archive (remove Inbox)', kind: 'archive' },
      ...labels.filter(label => label.type === 'system' && label.id === 'SPAM').map(label => ({ id: label.id, name: 'Spam', kind: 'spam' })),
      ...labels.filter(label => label.type === 'user').map(label => ({ id: label.id, name: label.name, kind: 'label' }))];
  }
  const folders = [], pending = [{ path: '/mailFolders', prefix: '' }], seen = new Set();
  // ponytail: bounded folder discovery; add search/paging if a mailbox exceeds 300 folders.
  while (pending.length) {
    const { path, prefix } = pending.shift();
    const original = new URL(providers.microsoft.api + path);
    let next = path + '?$top=100&$select=id,displayName,childFolderCount';
    for (let page = 0; next; page++) {
      if (page >= 10 || seen.has(next)) throw new Error('The mailbox returned too many or repeated folder pages.');
      seen.add(next);
      const result = await apiRequest(mail, next);
      if (!Array.isArray(result?.value)) throw new Error('The mailbox returned invalid folders.');
      for (const folder of result.value) {
        if (typeof folder.id !== 'string' || !folder.id) throw new Error('The mailbox returned an invalid folder ID.');
        const name = prefix + String(folder.displayName || 'Untitled folder');
        folders.push({ id: folder.id, name, kind: 'folder' });
        if (folders.length > 300) throw new Error('This mailbox exceeds the 300 folder limit.');
        if (folder.childFolderCount > 0) pending.push({ path: `/mailFolders/${encodeURIComponent(folder.id)}/childFolders`, prefix: name + ' / ' });
      }
      next = '';
      if (result['@odata.nextLink']) {
        const url = new URL(result['@odata.nextLink']);
        if (url.origin !== original.origin || url.pathname !== original.pathname || url.username || url.password || url.hash) throw new Error('The mailbox returned an unsafe folder page.');
        next = url.pathname.slice('/v1.0/me'.length) + url.search;
      }
    }
  }
  const inbox = await apiRequest(mail, '/mailFolders/inbox?$select=id');
  const junk = await apiRequest(mail, '/mailFolders/junkemail?$select=id');
  if ([inbox, junk].some(folder => typeof folder?.id !== 'string' || !folder.id)) throw new Error('The mailbox returned an invalid folder ID.');
  return folders.map(folder => ({ ...folder, kind: folder.id === inbox.id ? 'inbox' : folder.id === junk.id ? 'spam' : folder.kind }));
}

export async function organizeProviderMessage(mail, message, destination, mode) {
  if (!canOrganizeMail(mail)) throw new Error('Mailbox organization permission is required. Reconnect in Settings.');
  const remote = message.remoteId || message.id;
  if (!remote.startsWith(mail.provider + ':')) throw new Error('Only imported messages can be moved on the provider.');
  const path = `/messages/${encodeURIComponent(remote.slice(mail.provider.length + 1))}`;
  if (mail.provider === 'google') {
    if (mode !== 'move' && destination.kind !== 'label') throw new Error('Choose a custom Gmail label.');
    const addLabelIds = mode === 'removeLabel' || destination.kind === 'archive' ? [] : [destination.id];
    const removeLabelIds = mode === 'removeLabel' ? [destination.id] : mode === 'move' ? [destination.id === 'INBOX' ? 'SPAM' : 'INBOX'] : [];
    const result = await apiRequest(mail, path + '/modify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ addLabelIds, removeLabelIds }) });
    if (!Array.isArray(result?.labelIds)) throw new Error('The provider did not confirm the resulting labels.');
    return { providerLabelIds: result.labelIds, folder: googleFolder(result.labelIds), providerSent: result.labelIds.includes('SENT'), providerDraft: result.labelIds.includes('DRAFT'), providerFolderName: result.labelIds.includes('INBOX') ? 'Inbox' : 'Gmail · outside Inbox' };
  }
  if (mode !== 'move') throw new Error('Outlook supports folder moves.');
  const headers = { Prefer: 'IdType="ImmutableId"', 'Content-Type': 'application/json' };
  const current = await apiRequest(mail, path + '?$select=id,parentFolderId', { headers });
  const moved = current?.parentFolderId === destination.id ? current : await apiRequest(mail, path + '/move', { method: 'POST', headers, body: JSON.stringify({ destinationId: destination.id }) });
  if (!moved?.id) throw new Error('The provider did not confirm the moved message.');
  return { remoteId: `microsoft:${moved.id}`, providerFolderId: destination.id, providerFolderName: destination.name, folder: destination.kind === 'inbox' ? 'inbox' : destination.kind === 'spam' ? 'spam' : 'archive' };
}
