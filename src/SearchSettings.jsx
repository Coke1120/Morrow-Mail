import { useEffect, useRef, useState } from 'react';

async function request(path, body) {
  const response = await fetch('/api/search/' + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json(); if (!response.ok) throw Error(value.error || 'Search settings request failed.'); return value;
}
export function editableSearchSettings(value, presentation = 'search') {
  const keys = presentation === 'model' ? ['protocol', 'baseUrl', 'model'] : ['enabled', 'accounts', 'months', 'tokenBudget', 'folders', 'content'];
  return { ...Object.fromEntries(keys.map(key => [key, value.settings[key]])), ...(presentation === 'model' ? { apiKey: '', clearApiKey: false } : {}) };
}
export default function SearchSettings({ state, onDirtyChange, onBusyChange, onConfigureModel, onConfigurePermissions, disabled, presentation = 'search', active = true }) {
  const [value, setValue] = useState(null), [options, setOptions] = useState(null), [baseline, setBaseline] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [testResult, setTestResult] = useState('');
  const requestLock = useRef(false);
  const revision = useRef(0);
  const dirty = !!options && JSON.stringify(options) !== baseline, indexing = value?.job?.status === 'running';
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  // indexVersion is supplied by the Rust service; Node has no batch-control routes.
  const batchControls = Number.isInteger(value?.indexVersion), job = value?.job;
  const resumable = batchControls && ['paused', 'interrupted', 'failed'].includes(job?.status);
  const budgetExhausted = resumable && job.spentTokens >= job.budget;
  const prerequisites = [];
  if (options && presentation === 'search') {
    if (dirty) prerequisites.push('Save your changes before indexing.');
    if (!options.enabled) prerequisites.push('Enable Smart Search and save the search settings.');
    if (!value.settings.model.trim()) prerequisites.push('Save an embedding model in Model → Search Embedding.');
    if (!value.permitted) prerequisites.push('Enable AI access in AI Permissions and save permissions.');
    if (!options.accounts.some(id => state.accounts.some(account => account.id === id))) prerequisites.push('Choose at least one connected account in Indexing scope. Add an account in Mail if needed.');
    for (const group of ['folders', 'content']) {
      if (!Object.values(options[group]).some(Boolean)) prerequisites.push(`Choose at least one ${group === 'folders' ? 'folder' : 'content field'} in Indexing scope.`);
      else if (!Object.entries(options[group]).some(([key, checked]) => checked && state.settings.policy?.[group]?.[key] !== false)) prerequisites.push(`Allow at least one selected ${group === 'folders' ? 'folder' : 'content field'} in AI Permissions and save permissions.`);
    }
  }
  useEffect(() => {
    if (!active) return;
    let current = true;
    const version = revision.current;
    request('settings').then(next => {
      if (!current || version !== revision.current) return;
      setValue(previous => next.job?.id && previous?.job?.id === next.job.id ? { ...next, samples: previous.samples } : next);
      const fields = editableSearchSettings(next, presentation);
      if (!dirtyRef.current) { setOptions(fields); setBaseline(JSON.stringify(fields)); }
      setError('');
    }).catch(error => { if (current && version === revision.current) setError(error.message); });
    return () => { current = false; };
  }, [active, presentation]);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { setTestResult(''); }, [JSON.stringify(options)]);
  useEffect(() => () => { onDirtyChange(false); onBusyChange(false); }, [onDirtyChange, onBusyChange]);
  useEffect(() => { if (!indexing || !active) return; let current = true; const timer = setInterval(() => { if (requestLock.current) return; const version = revision.current; request('settings').then(next => { if (current && version === revision.current) { setValue(next); setError(''); } }).catch(error => { if (current && version === revision.current) setError(error.message); }); }, 1500); return () => { current = false; clearInterval(timer); }; }, [indexing, active]);
  async function action(path, body = {}) {
    if (requestLock.current || disabled || (indexing && !['index/pause', 'index/cancel', 'index/clear'].includes(path))) return;
    if (['index/now', 'index/resume'].includes(path) && (presentation !== 'search' || prerequisites.length || (path === 'index/now' && resumable))) return;
    if (['index/pause', 'index/resume', 'index/cancel'].includes(path)) {
      if (!batchControls || !job?.id || (path === 'index/resume' && (!resumable || budgetExhausted))) return;
      body = { previewId: job.id };
    }
    // The service owns a running batch; only this request/confirmation blocks navigation.
    requestLock.current = true; revision.current++; setBusy(true); onBusyChange(true); setError(''); setTestResult('');
    try {
      if (path === 'index/resume' && !window.confirm(`Resume this reviewed batch?\nModel: ${value.settings.model}\nEndpoint: ${value.settings.baseUrl}\nAccounts: ${value.settings.accounts.join(', ')}\n${job.completed} / ${job.sampleCount} messages completed.\nEstimated tokens charged to this batch budget: ${job.spentTokens} / ${job.budget}.\nOnly the remaining approved batch will run. An interrupted request may already have used provider tokens; resuming may charge again.`)) return;
      const next = await request(path === 'index/now' ? 'index/preview' : path, body);
      if (path === 'test') setTestResult(`Connection successful · ${next.dimensions} dimensions. Settings were not changed.`);
      else {
        setValue(next);
        if (path === 'settings') { const fields = editableSearchSettings(next, presentation); setOptions(fields); setBaseline(JSON.stringify(fields)); }
        if (path === 'index/now') {
          const { settings, job, samples = [] } = next;
          const fields = group => Object.entries(settings[group]).filter(([, allowed]) => allowed).map(([key]) => key).join(', ');
          const excerpts = samples.map(sample => `${sample.account}: ${sample.text.slice(0, 200)}`).join('\n\n');
          if (window.confirm(`Start this indexing batch?\nModel: ${settings.model}\nEndpoint: ${settings.baseUrl}\nAccounts: ${settings.accounts.join(', ')}\nFolders: ${fields('folders')} · Fields: ${fields('content')} · Last ${settings.months} months\n${job.sampleCount} messages · ${job.chunks} chunks · estimated tokens ≤ ${job.estimatedTokens}\nBudget: ${settings.tokenBudget} tokens. Remote models may charge.\n\nShort excerpts (cancel to review more on this page):\n${excerpts}`)) setValue(await request('index/run', { previewId: job.id }));
        }
      }
    } catch (cause) { setError(cause.message); } finally { requestLock.current = false; setBusy(false); onBusyChange(false); }
  }
  if (!options) return <p role="status">{error || (presentation === 'model' ? 'Loading embedding settings…' : 'Loading search settings…')}</p>;
  const set = (key, value) => setOptions({ ...options, [key]: value });
  return <section className="settings-fields">
    <h2 className="settings-section-title">{presentation === 'model' ? 'Embedding model' : 'Search & semantic indexing'}</h2>
    <p className="settings-intro">{presentation === 'model' ? 'Smart search (智慧搜尋) uses this separate embedding model. Choose indexing scope and review batches in Search.' : 'Keyword search is local and always available. Configure the embedding connection in Model. Smart search (智慧搜尋) is optional; selected mail text is sent only after you review and start an indexing batch.'}</p>
    {testResult && <p role="status" className="settings-test-result">{testResult}</p>}
    {error && <p role="alert" className="search-error">{error}</p>}
    {presentation === 'search' ? <div className="settings-card">
      <strong>Saved embedding connection · {value.settings.model || 'No embedding model saved'}</strong>
      <p>{value.settings.baseUrl}</p>
      <p>{value.local ? 'Local embedding endpoint' : 'Remote embedding endpoint — approved mail text leaves this device'}</p>
      {presentation === 'search' && <><div className="settings-actions"><button className="button secondary" disabled={busy || indexing || disabled || !value.settings.model.trim()} onClick={() => action('test')}>Test saved embedding connection</button>{onConfigureModel && <button className="button secondary" disabled={busy || disabled} onClick={onConfigureModel}>Edit in Model…</button>}</div>
      <p className="settings-help">Tests the saved connection with a fixed sentence, never your mail. Does not save settings or change the index; the provider may charge for this request.</p></>}
    </div> : <p className="settings-help">Saved connection: {value.local ? 'local endpoint' : 'remote endpoint'}</p>}
    <fieldset className="settings-fields" disabled={busy || indexing || disabled}>
      {presentation === 'model' ? <>
        <label className="settings-field">Embedding protocol<select value={options.protocol} onChange={e => set('protocol', e.target.value)}><option value="openai">OpenAI-compatible (/embeddings)</option><option value="ollama">Ollama native (/api/embed)</option></select></label>
        <label className="settings-field">Embedding base URL<input value={options.baseUrl} onChange={e => set('baseUrl', e.target.value)} /><span className="settings-help">Local example: http://127.0.0.1:11434/v1 for OpenAI-compatible, or http://127.0.0.1:11434 for Ollama native. Remote endpoints require HTTPS.</span></label>
        <label className="settings-field">Embedding model ID<input value={options.model} onChange={e => set('model', e.target.value)} /><span className="settings-help">Choose an embedding model; a chat model alone is not enough. Changing the model or scope invalidates existing vectors.</span></label>
        <label className="settings-field">Embedding API key<input type="password" autoComplete="off" value={options.apiKey} onChange={e => set('apiKey', e.target.value)} /><span className="settings-help">{value.settings.hasApiKey ? 'Leave blank to keep the saved key at the same base URL. Changing the base URL requires entering the key again.' : 'Optional for local models.'}</span></label>
        {value.settings.hasApiKey && <label className="settings-permission"><input type="checkbox" checked={options.clearApiKey} onChange={e => set('clearApiKey', e.target.checked)} /><span>Remove saved key</span></label>}
      </> : <>
        <label className="settings-permission"><input type="checkbox" checked={options.enabled} onChange={e => set('enabled', e.target.checked)} /><span>Enable smart search</span></label>
        <details className="settings-disclosure"><summary>Indexing scope · {options.accounts.length} account(s) · Last {options.months} month(s)</summary>
        <h3>Accounts to index</h3>{state.accounts.map(account => <label className="settings-permission" key={account.id}><input type="checkbox" checked={options.accounts.includes(account.id)} onChange={e => set('accounts', e.target.checked ? [...options.accounts, account.id] : options.accounts.filter(id => id !== account.id))} /><span>{account.email}</span></label>)}
        {['folders', 'content'].map(group => <div key={group}><h3>{group === 'folders' ? 'Folders' : 'Allowed content'}</h3>{Object.entries(options[group]).map(([key, checked]) => <label className="settings-permission" key={key}><input type="checkbox" checked={checked} onChange={e => set(group, { ...options[group], [key]: e.target.checked })} /><span>{key === 'sender' ? 'Sender and recipients (including Cc/Bcc)' : key}</span></label>)}</div>)}
        <p className="settings-help">Global AI permissions also apply. Unchecked fields and folders are excluded before any embedding request. Separate accounts are indexed in separate requests.</p>
        <label className="settings-field">Index history<select value={options.months} onChange={e => set('months', Number(e.target.value))}>{[1, 3, 6, 12].map(n => <option key={n} value={n}>Last {n} month(s)</option>)}</select></label>
        <label className="settings-field">Estimated token budget per batch<input type="number" min="4000" max="64000" step="1000" value={options.tokenBudget} onChange={e => set('tokenBudget', Number(e.target.value))} /><span className="settings-help">Conservative UTF-8 estimate, not a billing guarantee. Each reviewed batch also respects the global message limit and at most 50 text chunks. Only new or modified permitted text is indexed.</span></label>
        </details>
      </>}
      <div className="settings-actions">{dirty && <><button className="button primary" onClick={() => action('settings', options)}>{presentation === 'model' ? 'Save embedding model' : 'Save search settings'}</button><button className="button secondary" onClick={() => { const fields = editableSearchSettings(value, presentation); setOptions(fields); setBaseline(JSON.stringify(fields)); }}>Discard changes</button></>}{presentation === 'model' && <button className="button secondary" disabled={!options.model.trim()} onClick={() => action('test', options)}>Test embedding connection</button>}</div>
      {presentation === 'model' && <p className="settings-help">Test connection sends only a fixed test sentence, never your mail. It uses the fields above without saving them and may use provider tokens.</p>}
      {presentation === 'model' && indexing && <p role="status">An indexing batch is running. Wait for it to finish, or manage the batch in Search, before editing the embedding connection.</p>}
    </fieldset>
    {presentation === 'search' && <>
      <div className="settings-card">
        <strong>Check scope → Review &amp; Index</strong>
        {prerequisites.length > 0 && <ul>{prerequisites.map(reason => <li key={reason}>{reason}</li>)}</ul>}
        {onConfigurePermissions && <button className="button secondary" disabled={busy || disabled} onClick={onConfigurePermissions}>Open AI Permissions…</button>}
        {resumable && <p>Resume or cancel the current batch before reviewing another.</p>}
        {!dirty && !prerequisites.length && !indexing && !resumable && value.pending === 0 && <p>No new permitted downloaded mail needs indexing. Check Indexing scope and AI Permissions, or download mail in Mail.</p>}
        <div className="settings-actions"><button className="button primary" disabled={busy || disabled || indexing || resumable || prerequisites.length > 0 || value.pending === 0} onClick={() => action('index/now')}>Review &amp; Index…</button></div>
        <p className="settings-help">Review the saved accounts, folders, content and batch budget first. No AI call is made until you confirm the reviewed batch. Model or scope changes invalidate existing vectors.</p>
      </div>
      <div className="settings-test-result" role="status"><strong>{value.indexed} / {value.eligible} eligible messages indexed · {value.pending} pending</strong><p>{value.local ? 'Local embedding endpoint' : 'Remote embedding endpoint — approved mail text leaves this device'}. The index covers downloaded mail only. New mail requires another reviewed batch; there is no automatic paid indexing.</p></div>
      {indexing && <p role="status" className="settings-help">Indexing continues in the background while Morrow is open. You can leave Search, Model or Settings; check Activity or return here for progress.</p>}
      {value.job && <div className="settings-test-result semantic-samples"><strong>{value.job.status} · {value.job.completed} / {value.job.sampleCount} messages</strong><p>{value.job.chunks} chunks · estimated tokens ≤ {value.job.estimatedTokens} · {value.job.oversized} oversized messages excluded from this batch.</p>{value.job.error && <p role="alert">{value.job.error}</p>}
        {value.samples && <details><summary>Review excerpts (first three messages)</summary>{value.samples.map((sample, i) => <div key={i}><strong>{sample.account}</strong><pre>{sample.text}</pre></div>)}</details>}
        {batchControls && <>
          <p className="settings-help">Pause keeps batch progress; cancel discards unfinished work. Completed valid vectors remain. In-flight requests may already have used provider tokens.</p>
          {resumable && <p>Estimated tokens charged to batch budget: {job.spentTokens} / {job.budget}.{budgetExhausted && ' Budget exhausted. Cancel this batch, then review another to authorize more tokens.'}</p>}
          <div className="settings-actions">
            {indexing && <button className="button secondary" disabled={busy || disabled} onClick={() => action('index/pause')}>Pause batch</button>}
            {resumable && <button className="button secondary" disabled={busy || disabled || prerequisites.length > 0 || budgetExhausted} onClick={() => action('index/resume')}>Resume batch…</button>}
            {['prepared', 'running', 'paused', 'interrupted', 'failed'].includes(job.status) && <button className="button secondary" disabled={busy || disabled} onClick={() => { if (window.confirm('Cancel this batch? Unfinished work is discarded; completed valid vectors and your mail are kept.')) action('index/cancel'); }}>Cancel batch…</button>}
          </div>
        </>}
        {!batchControls && <p className="settings-help">This compatibility service does not support pause, resume or cancel without clearing vectors. Failed or interrupted batches need a new review.</p>}
      </div>}
      <details className="settings-disclosure"><summary>Clear index…</summary><p>Deletes all semantic vectors across indexed accounts and cancels the current batch. Your mail and keyword index stay available. Rebuilding requires another reviewed batch and may use provider tokens.</p><button className="button secondary" disabled={busy || disabled} onClick={() => { if (window.confirm('Delete all semantic vectors across indexed accounts and cancel indexing? Your mail and keyword index stay available. Rebuilding may use provider tokens.')) action('index/clear'); }}>Clear semantic index…</button></details>
    </>}
  </section>;
}
