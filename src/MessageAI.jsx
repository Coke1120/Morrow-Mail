import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Sparkles } from 'lucide-react';
import Modal from './Modal';
import { api } from './api';
import { prepareDraft } from './message-draft';

export function messageAIContext(state, message, action, includeHistory = false, loaded = true) {
  const settings = state?.settings || {}, policy = settings.policy || {};
  const owner = state?.accounts?.find(account => account.id === message?.accountId);
  let reason = '';
  if (!loaded || !message?.id) reason = 'Wait for this message to finish loading.';
  else if (!owner || owner.settings?.configured === false || !['all', message.accountId].includes(state?.account?.id)) reason = 'Reconnect and select the original mailbox to use this message.';
  else if (!['summary', 'reply', 'translate'].includes(action) || !policy.enabled || !policy.behaviors?.[action] || !policy.folders?.[message.folder]) reason = 'This action or folder is disabled in AI permissions.';
  else if (!['subject', 'body', 'sender'].some(field => policy.content?.[field])) reason = 'Allow subject, body, or sender content in AI permissions.';
  else if (includeHistory && (action !== 'reply' || !policy.content?.sender || !message.fromEmail)) reason = 'Suggest with History requires sender permission and a sender address.';
  else if (!settings.ai?.configured) reason = 'Choose an AI model in Settings before generating.';
  // Read/star changes do not change the source text or reply identity.
  const source = message && Object.fromEntries(['id', 'viewId', 'accountId', 'folder', 'subject', 'body', 'fromName', 'fromEmail', 'to', 'cc', 'bcc', 'date', 'labels', 'footer', 'providerDraft'].map(key => [key, message[key]]));
  return { reason, key: JSON.stringify([state?.account?.id, owner?.id, owner?.settings, source, policy, settings.ai, settings.preferences, settings.footer, state?.workspace?.brain, state?.workspace?.styleLearning?.profile]) };
}

export default function MessageAI({ state, message, action, includeHistory = false, loaded, disabled = false, onClose, onUse }) {
  const context = messageAIContext(state, message, action, includeHistory, loaded);
  const [original] = useState(() => ({ key: context.key, message }));
  const current = useRef(context), pending = useRef(null), invalidated = useRef(false);
  current.current = context;
  if (context.key !== original.key || context.reason || disabled) invalidated.current = true;
  const valid = () => !invalidated.current && !current.current.reason && current.current.key === original.key;
  const [busy, setBusy] = useState(false), [result, setResult] = useState(null), [error, setError] = useState('');
  const title = includeHistory ? 'Suggest with History' : { summary: 'Summarize message', reply: 'Suggest reply', translate: 'Translate message' }[action];
  const policy = state.settings.policy;
  function cancel() { pending.current?.abort(); pending.current = null; }
  function close() { invalidated.current = true; cancel(); onClose(); }
  async function generate() {
    if (pending.current || !valid()) return;
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setResult(null); setError('');
    try {
      const value = await api('/ai', { account: original.message.accountId, method: 'POST', signal: controller.signal, body: JSON.stringify({ action, messageId: original.message.id, ...(includeHistory ? { includeHistory: true } : {}) }) });
      if (pending.current === controller && !controller.signal.aborted && valid()) setResult(value);
    } catch (cause) {
      if (pending.current === controller && !controller.signal.aborted && valid()) setError(cause.message);
    } finally { if (pending.current === controller) { pending.current = null; setBusy(false); } }
  }
  async function useDraft() {
    if (!result?.text || pending.current || !valid()) return;
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError('');
    try {
      const draft = await prepareDraft(original.message, 'reply', { body: result.text, signal: controller.signal });
      if (pending.current === controller && !controller.signal.aborted && valid()) { onUse(draft); close(); }
    } catch (cause) {
      if (pending.current === controller && !controller.signal.aborted && valid()) setError(cause.message);
    } finally { if (pending.current === controller) { pending.current = null; setBusy(false); } }
  }
  useEffect(() => {
    let active = true;
    // A StrictMode rehearsal must not submit a second paid request.
    queueMicrotask(() => { if (active && !includeHistory) generate(); });
    return () => { active = false; cancel(); };
  }, []);
  useEffect(() => { if (!valid()) { cancel(); setBusy(false); setResult(null); setError(''); } }, [context.key, context.reason, disabled]);
  const usable = valid();
  return <Modal title={title} description={original.message.accountId} onClose={close} className="message-ai-modal">
    <div className="message-ai-content">
      <p className="message-ai-subject">{original.message.subject || '(No subject)'}</p>
      {includeHistory && <section className="message-ai-scope" aria-label="History scope">
        <p>Uses this message and downloaded mail from the same sender in this mailbox. It does not fetch or scan all mail on your provider.</p>
        <dl><dt>Sender</dt><dd>{original.message.fromEmail}</dd><dt>Saved folders</dt><dd>{Object.keys(policy.folders || {}).filter(folder => policy.folders[folder]).join(', ') || 'None'}</dd><dt>Email content</dt><dd>{['subject', 'body', 'sender'].filter(field => policy.content?.[field]).join(', ') || 'None'}</dd><dt>Context limit</dt><dd>Up to {policy.maxMessages} messages, including this message</dd></dl>
        <p>Newest matching messages fill the remaining slots. Long messages may be shortened. Only permitted content is sent to your saved model; the result reports how many matches were used.</p>
      </section>}
      <p className="message-ai-model">{state.settings.ai.model || 'No model'} · {action === 'translate' ? `Translate to ${state.settings.preferences?.translationLanguage || state.settings.preferences?.language || 'English'} · ` : ''}Uses AI; your provider may charge.</p>
      {!usable ? <p role="alert" className="inline-error">{context.reason || 'The source, mailbox, model, preferences or permissions changed. Close this dialog and open the action again.'}</p> : <>
        {busy && <p className="message-ai-progress" role="status"><LoaderCircle size={16} className="spinning" />{includeHistory ? 'Preparing a reply with permitted history…' : 'Preparing your result…'}</p>}
        {error && <p className="inline-error" role="alert">{error}</p>}
        {result?.text && <section aria-label="AI result" aria-live="polite">
          {result.source === 'demo' && <p>Illustrative demo output.</p>}
          {includeHistory && result.history?.scope === 'downloaded' && <p className="message-ai-model">Used {result.history.usedMessages} of {result.history.matchedMessages} matching downloaded messages · Limit {result.history.maxMessages}, including this message</p>}
          <div className="message-ai-text">{result.text}</div>
        </section>}
        <div className="message-ai-actions">
          {(includeHistory || error || result) && <button className="button secondary" disabled={busy} onClick={generate}><Sparkles size={15} />{result ? 'Generate again' : error ? 'Try again' : 'Generate reply'}</button>}
          {result?.text && action === 'reply' && <button className="button primary" disabled={busy} onClick={useDraft}>Use in Draft</button>}
        </div>
      </>}
      <p className="message-privacy">Review before using. Nothing is sent or saved automatically. Closing stops waiting; a model request already received may still be charged.</p>
    </div>
  </Modal>;
}
