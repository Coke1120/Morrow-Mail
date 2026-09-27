import { api } from './api.js';

export async function prepareDraft({ accountId, id }, mode, { body, signal } = {}) {
  if (typeof accountId !== 'string' || !accountId.trim() || accountId === 'all' || typeof id !== 'string' || !id) throw new Error('Reopen this message from its original mailbox.');
  const replying = mode === 'reply' || mode === 'replyAll';
  if (!['reply', 'replyAll', 'forward', 'copy'].includes(mode) || (body !== undefined && (!replying || typeof body !== 'string'))) throw new Error('Invalid draft preparation request.');
  const { draft } = await api('/drafts/prepare', { account: accountId, method: 'POST', signal, body: JSON.stringify({ messageId: id, mode, ...(body !== undefined ? { body } : {}) }) });
  if (signal?.aborted) throw new DOMException('Draft preparation cancelled.', 'AbortError');
  if (!draft || typeof draft.accountId !== 'string' || draft.accountId.toLowerCase() !== accountId.toLowerCase()
    || !['to', 'cc', 'bcc', 'subject', 'body'].every(key => typeof draft[key] === 'string')
    || (replying ? draft.replyToId !== id : draft.replyToId !== undefined)
    || (mode === 'forward' && draft.forwarding !== true) || (mode === 'copy' && draft.sourceDraft !== true)
    || ['id', 'providerDraft', 'deliveryRequestId'].some(key => Object.hasOwn(draft, key))) throw new Error('The prepared draft could not be verified. Reopen the original message and try again.');
  return draft;
}
