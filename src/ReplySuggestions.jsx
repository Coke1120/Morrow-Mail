import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { prepareDraft } from './message-draft.js';

export default function ReplySuggestions({ state, onCompose, disabled = false, onDirtyChange, onConfigureIdentity }) {
  const owner = state.account?.mode === 'live' ? state.account.id : '';
  const currentOwner = useRef(owner), inFlight = useRef(false), revision = useRef(0);
  const contextKey = JSON.stringify([owner, disabled, state.accounts?.find(item => item.id === owner)?.settings, state.settings, state.workspace?.brain, state.workspace?.styleLearning?.profile]);
  const currentContext = useRef(contextKey), preparing = useRef(null);
  currentContext.current = contextKey;
  const [value, setValue] = useState(null), [options, setOptions] = useState(null), [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  currentOwner.current = owner;
  const dirty = !!options && !!value && JSON.stringify(options) !== JSON.stringify(value.settings);
  const job = value?.job, running = ['queued', 'running'].includes(job?.status);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    setValue(null); setOptions(null); setSelected([]); setError('');
    if (!owner) return;
    let active = true, timer;
    const controller = new AbortController();
    async function refresh() {
      const version = revision.current;
      try {
        const next = await api('/reply-suggestions', { account: owner, signal: controller.signal });
        if (active && currentOwner.current === owner && version === revision.current) { setValue(next); setOptions(previous => previous || next.settings); }
      } catch (cause) { if (active && currentOwner.current === owner && version === revision.current) setError(cause.message); }
      finally { if (active) timer = setTimeout(refresh, 2000); }
    }
    refresh();
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [owner]);
  useEffect(() => { preparing.current?.abort(); preparing.current = null; }, [contextKey]);
  useEffect(() => () => { currentOwner.current = null; preparing.current?.abort(); preparing.current = null; }, []);
  async function action(path, body = {}) {
    if (!owner || inFlight.current || disabled) return;
    if (path === 'run' && !window.confirm(`Generate reply suggestions for ${owner}?\n${job.sampleCount} messages · estimated tokens ≤ ${job.estimatedTokens} · budget ${job.tokenBudget}\nModel: ${value.model.model}\nEndpoint: ${value.model.baseUrl}\nUses the reviewed, bounded downloaded history, confirmed identity and any permitted approved writing style. No mail will be sent. Continue?`)) return;
    inFlight.current = true; revision.current++; setBusy(true); setError('');
    const context = contextKey;
    const controller = new AbortController(); preparing.current = controller;
    const valid = () => currentOwner.current === owner && currentContext.current === context && !controller.signal.aborted;
    try {
      const next = await api(`/reply-suggestions/${path}`, { method: 'POST', account: owner, signal: controller.signal, body: JSON.stringify(body) });
      if (!valid()) return;
      if (path === 'use') {
        if (next.message?.accountId !== owner) throw new Error('The suggestion belongs to a different mailbox. Reopen it from its original account.');
        const draft = await prepareDraft(next.message, 'reply', { body: next.text, signal: controller.signal });
        if (valid()) onCompose(draft);
      } else { setValue(next); if (path === 'settings') setOptions(next.settings); }
    } catch (cause) { if (valid()) setError(cause.message); }
    finally { if (preparing.current === controller) preparing.current = null; revision.current++; inFlight.current = false; if (currentOwner.current != null) setBusy(false); }
  }
  const locked = busy || disabled;
  const previewBlocked = locked || dirty || running || !value?.permitted || !value?.identityReady || !selected.length || selected.length > (value?.settings.maxMessages || 0);
  return <section className="settings-fields" aria-label="Reply suggestions">
    <h1 className="settings-section-title">Reply suggestions</h1>
    <p className="settings-intro">Review mail that may need a reply, then open a draft in its original account. Suggestions are fallible; nothing is sent automatically.</p>
    {!owner ? <p>Choose an individual connected mailbox to review its suggestions.</p> : !value || !options ? <p role="status">Loading reply suggestions…</p> : <>
      <p><strong>{owner}</strong> · {value.identityReady ? `Confirmed identity: ${value.identity?.displayName || owner}` : 'Confirm your identity in Learning settings first.'}</p>
      {onConfigureIdentity && <button className="button secondary" onClick={onConfigureIdentity} disabled={locked || dirty}>Review identity in Learning…</button>}
      <fieldset className="settings-fields" disabled={locked || running}>
        <legend>Explicit batch permission</legend>
        <label className="settings-permission"><input type="checkbox" checked={options.enabled} onChange={event => setOptions({ ...options, enabled: event.target.checked })} /><span>Enable reply suggestions for this account</span></label>
        <label className="settings-field">Maximum messages per batch<input type="number" min="1" max="10" value={options.maxMessages} onChange={event => setOptions({ ...options, maxMessages: Number(event.target.value) })} /></label>
        <label className="settings-field">Token budget per batch<input type="number" min="4000" max="64000" step="1000" value={options.tokenBudget} onChange={event => setOptions({ ...options, tokenBudget: Number(event.target.value) })} /></label>
        <button className="button secondary" disabled={!dirty} onClick={() => action('settings', options)}>Save suggestion settings</button>
      </fieldset>
      <p className="settings-help">Enabling does not start AI. Each batch needs preview and confirmation. Approved writing style is used only while its Brain, Sent and body permissions remain enabled. Estimates conservatively include UTF-8 input bytes and response allowance; model billing may differ. Saving these settings clears older previews and proposals.</p>
      {!value.permitted && <p>Requires AI enabled, Reply, Inbox, sender and body access in AI permissions.</p>}
      {running && <p role="status">Working in the background: {job.completed} / {job.sampleCount} assessed. You can leave this view while Morrow stays open. Cancel stops remaining work; an in-flight request may still use tokens.</p>}
      {job && <div className="settings-test-result" role="status">
        <strong>{job.status} · {job.completed} / {job.sampleCount} assessed</strong>
        <p>Estimated tokens ≤ {job.estimatedTokens} · budget {job.tokenBudget} · reserved {job.spentTokens}</p>
        {job.error && <p>{job.error}</p>}
        {job.status === 'prepared' && <>
          <p>Model: {value.model.model} · {value.model.baseUrl}</p>
          <p>Only downloaded, permitted same-correspondent history (including your Sent replies when permitted) is considered. Per reply: at most {value.contextLimit} messages and the saved AI context cap; target body ≤ 5,000 characters, other bodies ≤ 2,000. The model does not read every matching message.</p>
          <details><summary>Review selected mail and context coverage</summary>{job.samples.map(sample => <article key={sample.message.id}><strong>{sample.message.subject || '(Subject withheld)'}</strong><p>{sample.history.usedMessages} used / {sample.history.matchedMessages} matching downloaded messages</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{sample.excerpt}</pre></article>)}</details>
          <button className="button primary" disabled={locked || dirty || !value.identityReady || !job.reviewValid} onClick={() => action('run', { previewId: job.id })}>Generate Reviewed Batch · Uses AI</button>
        </>}
        {['prepared', 'queued', 'running'].includes(job.status) && <button className="button secondary" disabled={locked} onClick={() => action('cancel')}>Cancel Remaining Work</button>}
      </div>}
      <h2>Suggestions to review</h2>
      {!value.proposals.length && <p>No current reply proposals. Completed assessments may find that no reply is needed.</p>}
      {value.proposals.map(proposal => <article className="settings-test-result" key={proposal.id}>
        <strong>{proposal.message.subject || '(Subject withheld)'}</strong><p>{proposal.message.fromName || proposal.message.fromEmail} · {proposal.message.date}</p>
        <p>{proposal.reason}</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{proposal.text}</pre>
        <p className="settings-help">{proposal.history.usedMessages} / {proposal.history.matchedMessages} matching downloaded messages used. Review facts, recipients and commitments before sending.</p>
        <div className="settings-actions"><button className="button primary" disabled={locked || dirty || !onCompose} onClick={() => action('use', { id: proposal.id })}>{proposal.status === 'used' ? 'Open Another Draft' : 'Use in Draft'}</button><button className="button secondary" disabled={locked} onClick={() => action('dismiss', { id: proposal.id })}>Dismiss</button></div>
      </article>)}
      <h2>Inbox candidates</h2>
      <p className="settings-help">Showing eligible candidates among the newest {value.candidateLimit} downloaded Inbox messages. This is not an unanswered-mail guarantee; locally recorded replies are excluded where available.</p>
      <button className="button secondary" disabled={locked || running || !value.permitted} onClick={() => setSelected(value.candidates.slice(0, value.settings.maxMessages).map(message => message.id))}>Select Newest {value.settings.maxMessages}</button>
      <div style={{ maxHeight: 360, overflowY: 'auto' }}>{value.candidates.map(message => <label className="settings-permission" key={message.viewId}>
        <input type="checkbox" disabled={locked || running} checked={selected.includes(message.id)} onChange={event => setSelected(ids => event.target.checked ? [...ids, message.id] : ids.filter(id => id !== message.id))} />
        <span>{message.fromName || message.fromEmail} — {message.subject || '(Subject withheld)'}<small style={{ display: 'block' }}>{message.date}</small></span>
      </label>)}</div>
      <button className="button secondary" disabled={previewBlocked} onClick={() => action('preview', { messageIds: selected })}>Preview Selected Mail · No AI Call</button>
    </>}
    {busy && <p role="status">Saving or preparing review…</p>}{error && <p role="alert" className="settings-error">{error}</p>}
  </section>;
}
