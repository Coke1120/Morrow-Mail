import { useEffect, useRef, useState } from 'react';

async function request(path, body) {
  const response = await fetch('/api/search/' + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json(); if (!response.ok) throw Error(value.error || 'Search settings request failed.'); return value;
}
export function editableSearchSettings(value, presentation = 'search') {
  const keys = presentation === 'model' ? ['protocol', 'baseUrl', 'model'] : ['enabled', 'accounts', 'months', 'tokenBudget', 'folders', 'content'];
  return { ...Object.fromEntries(keys.map(key => [key, value.settings[key]])), ...(presentation === 'model' ? { apiKey: '', clearApiKey: false } : {}) };
}
export default function SearchSettings({ state, onDirtyChange, onBusyChange, onConfigureModel, disabled, presentation = 'search', active = true }) {
  const [value, setValue] = useState(null), [options, setOptions] = useState(null), [baseline, setBaseline] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [testResult, setTestResult] = useState('');
  const requestLock = useRef(false);
  const dirty = !!options && JSON.stringify(options) !== baseline, indexing = value?.job?.status === 'running';
  useEffect(() => {
    if (!active && options) return;
    let current = true;
    request('settings').then(next => {
      if (!current) return;
      setValue(previous => next.job?.id && previous?.job?.id === next.job.id ? { ...next, samples: previous.samples } : next);
      const fields = editableSearchSettings(next, presentation);
      setOptions(previous => previous ?? fields); setBaseline(previous => previous || JSON.stringify(fields)); setError('');
    }).catch(error => { if (current) setError(error.message); });
    return () => { current = false; };
  }, [active, presentation]);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { setTestResult(''); }, [JSON.stringify(options)]);
  useEffect(() => () => { onDirtyChange(false); onBusyChange(false); }, [onDirtyChange, onBusyChange]);
  useEffect(() => { if (!indexing || !active) return; let current = true; const timer = setInterval(() => { request('settings').then(next => { if (current) { setValue(next); setError(''); } }).catch(error => { if (current) setError(error.message); }); }, 1500); return () => { current = false; clearInterval(timer); }; }, [indexing, active]);
  async function action(path, body = {}) {
    if (requestLock.current || disabled || (indexing && path !== 'index/clear')) return;
    // The service owns a running batch; only this request/confirmation blocks navigation.
    requestLock.current = true; setBusy(true); onBusyChange(true); setError(''); setTestResult('');
    try {
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
    {presentation === 'search' && <div className="settings-test-result">
      <strong>Embedding connection · {value.settings.model || 'No embedding model saved'}</strong>
      <p>{value.settings.baseUrl}</p>
      <div className="settings-actions"><button className="button secondary" disabled={busy || indexing || disabled || !value.settings.model.trim()} onClick={() => action('test')}>Test connection</button>{onConfigureModel && <button className="button secondary" disabled={busy || disabled} onClick={onConfigureModel}>Edit in Model…</button>}</div>
      <p className="settings-help">Tests the saved connection with a fixed sentence, never your mail. Does not save settings or change the index; the provider may charge for this request.</p>
    </div>}
    <fieldset className="settings-fields" disabled={busy || indexing || disabled}>
      {presentation === 'model' ? <>
        <label className="settings-field">Embedding protocol<select value={options.protocol} onChange={e => set('protocol', e.target.value)}><option value="openai">OpenAI-compatible (/embeddings)</option><option value="ollama">Ollama native (/api/embed)</option></select></label>
        <label className="settings-field">Embedding base URL<input value={options.baseUrl} onChange={e => set('baseUrl', e.target.value)} /><span className="settings-help">Local example: http://127.0.0.1:11434/v1 for OpenAI-compatible, or http://127.0.0.1:11434 for Ollama native. Remote endpoints require HTTPS.</span></label>
        <label className="settings-field">Embedding model ID<input value={options.model} onChange={e => set('model', e.target.value)} /><span className="settings-help">Choose an embedding model; a chat model alone is not enough. Changing the model or scope invalidates existing vectors.</span></label>
        <label className="settings-field">Embedding API key<input type="password" autoComplete="off" value={options.apiKey} onChange={e => set('apiKey', e.target.value)} /><span className="settings-help">{value.settings.hasApiKey ? 'Leave blank to keep the saved key at the same base URL.' : 'Optional for local models.'}</span></label>
        <label className="settings-permission"><input type="checkbox" checked={options.clearApiKey} onChange={e => set('clearApiKey', e.target.checked)} /><span>Remove saved key</span></label>
      </> : <>
        <label className="settings-permission"><input type="checkbox" checked={options.enabled} onChange={e => set('enabled', e.target.checked)} /><span>Enable smart search</span></label>
        <h3>Accounts to index</h3>{state.accounts.map(account => <label className="settings-permission" key={account.id}><input type="checkbox" checked={options.accounts.includes(account.id)} onChange={e => set('accounts', e.target.checked ? [...options.accounts, account.id] : options.accounts.filter(id => id !== account.id))} /><span>{account.email}</span></label>)}
        {['folders', 'content'].map(group => <div key={group}><h3>{group === 'folders' ? 'Folders' : 'Allowed content'}</h3>{Object.entries(options[group]).map(([key, checked]) => <label className="settings-permission" key={key}><input type="checkbox" checked={checked} onChange={e => set(group, { ...options[group], [key]: e.target.checked })} /><span>{key === 'sender' ? 'Sender and recipients (including Cc/Bcc)' : key}</span></label>)}</div>)}
        <p className="settings-help">Global AI permissions also apply. Unchecked fields and folders are excluded before any embedding request. Separate accounts are indexed in separate requests.</p>
        <label className="settings-field">Index history<select value={options.months} onChange={e => set('months', Number(e.target.value))}>{[1, 3, 6, 12].map(n => <option key={n} value={n}>Last {n} month(s)</option>)}</select></label>
        <label className="settings-field">Estimated token budget per batch<input type="number" min="4000" max="64000" step="1000" value={options.tokenBudget} onChange={e => set('tokenBudget', Number(e.target.value))} /><span className="settings-help">Conservative UTF-8 estimate, not a billing guarantee. Each reviewed batch also respects the global message limit and at most 50 text chunks. Only new or modified permitted text is indexed.</span></label>
      </>}
      <div className="settings-actions"><button className="button primary" onClick={() => action('settings', options)}>{presentation === 'model' ? 'Save embedding model' : 'Save search settings'}</button>{presentation === 'model' && <button className="button secondary" disabled={!options.model.trim()} onClick={() => action('test', options)}>Test connection</button>}<button className="button secondary" disabled={dirty || !value.settings.enabled || !value.permitted} onClick={() => action('index/now')}>Index now…</button>{presentation === 'search' && <button className="button secondary" disabled={dirty || !options.enabled || !value.permitted} onClick={() => action('index/preview')}>Preview next batch · no AI call</button>}</div>
      {presentation === 'model' && <p className="settings-help">Test connection sends only a fixed test sentence, never your mail. It uses the fields above without saving them and may use provider tokens.</p>}
      <p className="settings-help">{dirty ? 'Save your changes before indexing.' : 'Index now reviews one batch within the saved Search scope and token budget, then asks you to confirm before sending mail text to the embedding model. Enable Smart Search and choose accounts in Search first.'}</p>
    </fieldset>
    <>
      <div className="settings-test-result" role="status"><strong>{value.indexed} / {value.eligible} eligible messages indexed · {value.pending} pending</strong><p>{value.local ? 'Local embedding endpoint' : 'Remote embedding endpoint — approved mail text leaves this device'}. The index covers downloaded mail only. New mail requires another reviewed batch; there is no automatic paid indexing.</p></div>
      {indexing && <p role="status" className="settings-help">Indexing continues in the background while Morrow is open. You can leave Search, Model or Settings; check Activity or return here for progress.</p>}
      {value.job && <div className="settings-test-result semantic-samples"><strong>{value.job.status} · {value.job.completed} / {value.job.sampleCount} messages</strong><p>{value.job.chunks} chunks · estimated tokens ≤ {value.job.estimatedTokens} · {value.job.oversized} oversized messages excluded from this batch.</p>{value.job.error && <p role="alert">{value.job.error}</p>}
        {value.samples && <details><summary>Review excerpts (first three messages)</summary>{value.samples.map((sample, i) => <div key={i}><strong>{sample.account}</strong><pre>{sample.text}</pre></div>)}</details>}
        {value.job.status === 'prepared' && <button className="button primary" disabled={dirty || busy || disabled} onClick={() => action('index/run', { previewId: value.job.id })}>Index reviewed batch · uses embeddings</button>}
      </div>}
      <button className="button secondary" disabled={busy || disabled} onClick={() => { if (window.confirm('Delete semantic vectors and cancel indexing? Your mail and keyword index stay available.')) action('index/clear'); }}>Clear semantic index / cancel batch</button>
    </>
  </section>;
}
