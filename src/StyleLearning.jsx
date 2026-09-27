import { useEffect, useId, useRef, useState } from 'react';

export const learningOptions = settings => Object.fromEntries(['enabled', 'weekly', 'months', 'maxSamples', 'tokenBudget'].map(key => [key, settings[key]]));
const emptyIdentity = () => ({ displayName: '', aliases: [], confirmed: false });

// onOpenSettings receives model / permissions / mail; parents must use guarded tab navigation.
export default function StyleLearning({ state, onUpdate, onDirtyChange, onBusyChange, onOpenSettings, disabled = false }) {
  const value = state.workspace.styleLearning, saved = learningOptions(value.settings), savedIdentity = value.settings.identity || emptyIdentity();
  const [options, setOptions] = useState(saved), [voice, setVoice] = useState(value.preview?.voice || '');
  const [identity, setIdentity] = useState(savedIdentity), [aliases, setAliases] = useState(savedIdentity.aliases.join('\n'));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const inFlight = useRef(false), currentOwner = useRef(state.account.id);
  currentOwner.current = state.account.id;
  useEffect(() => { currentOwner.current = state.account.id; return () => { currentOwner.current = null; }; }, [state.account.id]);
  const preview = value.preview;
  useEffect(() => { setOptions(saved); }, [state.account.id, JSON.stringify(saved)]);
  useEffect(() => { setVoice(preview?.voice || ''); }, [state.account.id, preview?.id, preview?.voice]);
  useEffect(() => { setIdentity(savedIdentity); setAliases(savedIdentity.aliases.join('\n')); }, [state.account.id, JSON.stringify(savedIdentity)]);
  const identityValue = { ...identity, aliases: aliases.split(/\r?\n/).map(name => name.trim()).filter(Boolean) };
  const identityDirty = JSON.stringify(identityValue) !== JSON.stringify(savedIdentity);
  const settingsDirty = JSON.stringify(options) !== JSON.stringify(saved);
  const dirty = settingsDirty || identityDirty || voice !== (preview?.voice || '');
  const analysisBlocked = dirty || !saved.enabled || !value.permitted || !state.settings.ai?.configured || preview?.status === 'running';
  const prerequisitesId = useId();
  const status = preview?.status === 'ready' ? 'Proposal ready' : value.profile ? `Approved style${value.profile.active ? '' : ' · inactive'}` : 'Not learned';
  const nextAction = state.account.mode !== 'live' ? 'Choose an individual connected account in the sidebar.' : ({
    prepared: 'Review the selected samples below, then choose Analyze these samples to use AI.',
    ready: 'Review and edit the proposal below, then Save approved style. Generating a proposal does not apply it.',
    running: 'Analysis is in progress. Wait for the proposal, then review it before saving.',
    failed: 'Analysis failed. Review the error and prepare fresh samples to retry explicitly; tokens may have been used.',
    interrupted: 'Analysis was interrupted. Prepare fresh samples to retry explicitly; tokens may have been used.',
  }[preview?.status] || (!saved.enabled ? 'Open Learning configuration, enable learning and save before preparing samples.'
    : !value.permitted || !state.settings.ai?.configured ? 'Complete the prerequisites below before preparing samples.'
      : value.profile ? (value.profile.active ? 'Your approved style is active for writing and replies. Learn again when you want to propose an update.' : 'Review learning permissions and source scope. Learn again if the original samples have changed.')
        : 'Preview your saved sample selection, or choose Learn Now to review it before AI analysis.'));
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => () => { onDirtyChange(false); onBusyChange(false); }, [onDirtyChange, onBusyChange]);
  async function action(path, body = {}, method = 'POST', learnNow = false) {
    if (inFlight.current || busy || disabled || state.account.mode !== 'live') return;
    if (['preview', 'generate'].includes(path) && analysisBlocked) return;
    const owner = state.account.id;
    const identityOnly = path === 'settings' && Object.keys(body).every(key => key === 'identity');
    if (identityOnly && preview && !window.confirm('Save identity and discard this style preview? Pending AI results will be invalidated. Your approved style will be retained.')) return;
    if ((path === 'preview' || (path === 'settings' && !identityOnly)) && preview?.status === 'ready' && !window.confirm('Replace the current style proposal? Your approved style will be retained.')) return;
    if (currentOwner.current !== owner) return;
    inFlight.current = true;
    setBusy(true); setError('');
    try {
      async function request(nextPath, nextBody, nextMethod = 'POST') {
        const response = await fetch(`/api/style/${nextPath}`, { method: nextMethod, headers: { 'Content-Type': 'application/json', 'X-Morrow-View': 'paged', 'X-Genmail-Account': owner }, body: JSON.stringify(nextBody) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Unable to complete style learning.');
        return result;
      }
      const result = await request(path, body, method);
      if (currentOwner.current !== owner) return;
      onUpdate(result);
      if (learnNow) {
        const learning = result.workspace.styleLearning, prepared = learning.preview;
        if (prepared?.status !== 'prepared' || !prepared.id || !learning.settings.enabled || !learning.permitted || !result.settings.ai?.configured) return;
        const excerpts = prepared.samples.slice(0, 2).map((sample, index) => `Sample ${index + 1}: ${sample.body.slice(0, 200)}${sample.body.length > 200 ? '…' : ''}`).join('\n\n');
        const confirmed = window.confirm(`Learn Now · Uses AI\nAccount: ${owner} · Your Sent bodies only\nModel: ${result.settings.ai.model}\nEndpoint: ${result.settings.ai.baseUrl}\n${prepared.sampleCount} / ${prepared.eligible} useful samples · Cap ${prepared.effectiveCap}\nEstimated tokens ≤ ${prepared.estimatedTokens.toLocaleString()} · Budget ${prepared.tokenBudget.toLocaleString()}\n\nUp to 2 short excerpts; all selected samples will be analyzed:\n${excerpts}\n\nCancel to review full samples below. Your approved style is retained until Save Approved Style. Continue with AI analysis?`);
        if (!confirmed || currentOwner.current !== owner) return;
        const generated = await request('generate', { previewId: prepared.id });
        if (currentOwner.current === owner) onUpdate(generated);
      }
    } catch (cause) { if (currentOwner.current === owner) setError(cause.message); }
    finally { inFlight.current = false; if (currentOwner.current !== null) setBusy(false); }
  }
  return <section className="settings-fields">
    <h2 className="settings-section-title">Learn my writing style</h2>
    <div className="settings-test-result" role="status">
      <p>Account: {state.account.mode === 'live' ? (state.account.email || state.account.id) : 'No individual account selected'}</p>
      <strong>{status}</strong>
      <p>{nextAction}</p>
      {preview && value.profile && <p>Your previously approved style is retained{value.profile.active ? ' and remains active' : ' but is inactive under current permissions or source scope'} until you explicitly save a new proposal.</p>}
    </div>
    {state.account.mode !== 'live' && onOpenSettings && <button className="button secondary" disabled={busy || disabled} onClick={() => onOpenSettings('mail')}>Connect a mailbox in Mail</button>}
    <fieldset className="settings-fields" disabled={busy || disabled || state.account.mode !== 'live'}>
      {preview && <div className="settings-test-result" role="status"><strong>{preview.status} · {preview.sampleCount} / {preview.eligible} useful samples</strong>
        {preview.status === 'ready' && <>
          <label className="settings-field">Review and edit proposed style<textarea rows="7" maxLength="2000" value={voice} onChange={e => setVoice(e.target.value)} /></label>
          <p>Provider-reported tokens: {preview.usage?.total_tokens ?? 'not supplied'}</p>
          <button className="button primary" disabled={!voice.trim() || voice.length > 2000 || settingsDirty} onClick={() => action('apply', { previewId: preview.id, voice })}>Save approved style</button>
          {settingsDirty && <p>Save or discard learning settings changes first. Saving settings replaces this proposal after confirmation.</p>}
          {(!voice.trim() || voice.length > 2000) && <p>The approved style must contain 1–2,000 characters.</p>}
        </>}
        <p>Estimated tokens ≤ {preview.estimatedTokens.toLocaleString()} · budget {preview.tokenBudget.toLocaleString()} · effective sample cap {preview.effectiveCap}. Quote/signature removal is heuristic; review the exact text below.</p>
        <details><summary>Review text sent to the model</summary>{preview.samples.map((sample, i) => <pre key={i} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{sample.body}</pre>)}</details>
        {preview.error && <p>{preview.error}</p>}
        {preview.status === 'prepared' && <button className="button primary" aria-describedby={prerequisitesId} disabled={analysisBlocked} onClick={() => action('generate', { previewId: preview.id })}>Analyze these samples · uses AI</button>}
      </div>}
      <div className="settings-actions">
        <button className={`button ${['prepared', 'ready'].includes(preview?.status) ? 'secondary' : 'primary'}`} aria-describedby={prerequisitesId} disabled={analysisBlocked} onClick={() => action('preview', {}, 'POST', true)}>Learn Now · Uses AI</button>
        <button className="button secondary" aria-describedby={prerequisitesId} disabled={analysisBlocked} onClick={() => action('preview')}>Preview samples · no AI call</button>
      </div>
      <div id={prerequisitesId} className="settings-help">
        {state.account.mode !== 'live' && <p>Choose an individual connected account in the sidebar.</p>}
        {(busy || disabled) && <p>Wait for the current operation to finish.</p>}
        {preview?.status === 'running' && <p>Analysis is already running. Wait for the proposal before learning again.</p>}
        {dirty && <p>Save identity or learning settings and save or discard any proposal edits before learning again.</p>}
        {!saved.enabled && <p>Learning is off. Enable and save it in Learning configuration below.</p>}
        {!state.settings.ai?.configured && <p>Configure and save an AI model in Model settings first. {onOpenSettings && <button className="button secondary" onClick={() => onOpenSettings('model')}>Open Model</button>}</p>}
        {!value.permitted && <p>Requires saved learning opt-in plus AI Permissions: AI on, Email Brain, Sent and email body access. {onOpenSettings && <button className="button secondary" onClick={() => onOpenSettings('permissions')}>Open AI Permissions</button>}</p>}
        {state.settings.policy.folders?.sent === false && <p>Sent access is off. Enable Sent in AI permissions before analyzing your writing style. Your confirmed identity can remain saved without Sent access.</p>}
        <p>Uses downloaded Sent mail. Import Sent mail in Mail settings if you need samples. {onOpenSettings && <button className="button secondary" onClick={() => onOpenSettings('mail')}>Open Mail</button>}</p>
      </div>
      {error && <p role="alert" className="settings-error">{error}</p>}
      <p className="settings-help">Uses saved learning settings. Review samples and the token estimate before AI analysis generates a proposed writing style. Save Approved Style activates it for writing and replies under Email Brain permission; it does not overwrite Email Brain contacts, notes, or voice.</p>
      <details className="settings-disclosure">
        <summary>Learning configuration · {saved.enabled ? (saved.weekly ? 'Weekly analysis enabled' : 'Manual analysis') : 'Off'}{settingsDirty ? ' · Unsaved changes' : ''}</summary>
        <div className="settings-fields">
          <p className="settings-help">Optional. Only your own Sent text is analyzed; contact and project memory stay separate. Importing mail does not use AI tokens.</p>
          <label className="settings-permission"><input type="checkbox" checked={options.enabled} onChange={e => setOptions({ ...options, enabled: e.target.checked, weekly: e.target.checked && options.weekly })} /><span>Enable writing-style learning for this account</span></label>
          <label className="settings-permission"><input type="checkbox" checked={options.weekly} disabled={!options.enabled} onChange={e => setOptions({ ...options, weekly: e.target.checked })} /><span>Analyze newly sent mail weekly within this budget. Each update still needs review and Save. Uses cached Sent mail while Morrow is open; enable mail refresh to capture mail sent elsewhere. Paused while a preview awaits review.</span></label>
          <label className="settings-field">Sent history<select value={options.months} onChange={e => setOptions({ ...options, months: Number(e.target.value) })}>{[1, 3, 6, 12].map(n => <option key={n} value={n}>Last {n} month{n > 1 ? 's' : ''}</option>)}</select></label>
          <label className="settings-field">Maximum samples<input type="number" min="1" max="50" value={options.maxSamples} onChange={e => setOptions({ ...options, maxSamples: Number(e.target.value) })} /><span className="settings-help">Also limited by AI Permissions → Maximum messages (currently {state.settings.policy.maxMessages}).</span></label>
          <label className="settings-field">Token budget per analysis<input type="number" min="4000" max="64000" step="1000" value={options.tokenBudget} onChange={e => setOptions({ ...options, tokenBudget: Number(e.target.value) })} /><span className="settings-help">Conservative UTF-8 estimate including response allowance; your custom model’s billing may differ. No currency estimate.</span></label>
          <div className="settings-actions"><button className="button secondary" onClick={() => action('settings', options)} disabled={preview?.status === 'running'}>Save learning settings</button></div>
        </div>
      </details>
      <details className="settings-disclosure">
        <summary>Your identity for this account · {savedIdentity.confirmed ? 'Confirmed' : 'Not confirmed'}{identityDirty ? ' · Unsaved changes' : ''}</summary>
        <div className="settings-fields">
          <p className="settings-help">Confirm the names people use when addressing you, including in group mail. AI can use only your saved, confirmed identity under its existing permissions. Names inferred from signatures or messages are not automatically verified. This does not change your From address or Email Brain notes.</p>
          <label className="settings-field">Your display name<input maxLength={100} autoComplete="off" value={identity.displayName} onChange={event => setIdentity({ ...identity, displayName: event.target.value, confirmed: false })} /></label>
          <label className="settings-field">Other names or nicknames — one per line<textarea rows={3} maxLength={1100} value={aliases} onChange={event => { setAliases(event.target.value); setIdentity({ ...identity, confirmed: false }); }} /><span className="settings-help">Up to 10 aliases, 100 characters each. Include only names that refer to you.</span></label>
          <label className="settings-permission"><input type="checkbox" checked={identity.confirmed} disabled={!identity.displayName.trim()} onChange={event => setIdentity({ ...identity, confirmed: event.target.checked })} /><span>I confirm this name and these aliases identify me for this account</span></label>
          <div className="settings-actions"><button className="button secondary" disabled={!identityDirty} onClick={() => action('settings', { identity: identityValue })}>Save identity · no AI call</button><span>{savedIdentity.confirmed ? 'Saved identity confirmed' : 'No confirmed identity is active'}</span></div>
          <p className="settings-help">Identity confirmation does not need Sent access or enable learning. Editing a name requires confirmation again; save with confirmation unchecked to stop using it.</p>
        </div>
      </details>
      {value.profile && <div className="settings-test-result"><strong>Saved style · {value.profile.active ? 'active for writing and replies' : 'inactive under current permissions or source scope'}</strong><p style={{ whiteSpace: 'pre-wrap' }}>{value.profile.voice}</p></div>}
      <button className="button secondary" onClick={() => { if (window.confirm('Delete this account’s learned style and sample preview, and turn off learning? Your confirmed identity is retained.')) action('profile', {}, 'DELETE'); }}>Delete learned style & stop learning</button>
    </fieldset>
    {busy && <p role="status">Working…</p>}
  </section>;
}
