import StyleLearning from './StyleLearning';
import SearchSettings from './SearchSettings';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, CalendarDays, ExternalLink, Info, LoaderCircle, Mail, Settings2, ShieldCheck, Sparkles } from 'lucide-react';
import { AI_BEHAVIORS, DEFAULT_POLICY, DEFAULT_PREFERENCES } from '../shared/features';
import Modal from './Modal';
import FooterPreview from './FooterPreview';
import './settings.css';
import CalendarSettings from './CalendarSettings';

const TABS = [['general', Settings2, 'General'], ['mail', Mail, 'Mail'], ['learning', Sparkles, 'Learning'], ['search', Sparkles, 'Search'], ['calendar', CalendarDays, 'Calendar'], ['model', Sparkles, 'Model'], ['policy', ShieldCheck, 'AI permissions'], ['about', Info, 'About']];
const CONTENT_LABELS = {
  subject: ['Email subjects', 'Subject lines used for context and search.'],
  body: ['Email & draft text', 'The written content of permitted messages and drafts.'],
  sender: ['Sender & recipient', 'Names and email addresses in permitted messages.'],
  contacts: ['Contacts', 'Contact notes in the local Email Brain; no address book access.'],
  calendar: ['Calendar simulations', 'Allows local AI Studio event simulations. Connected calendars are manual and are never sent to AI.'],
  attachments: ['Attachments', 'Sample attachment fixtures only; no real files are fetched.'],
};

function mailValues(mail) {
  return { email: mail.email || '', password: '', imapHost: mail.imapHost || 'imap.gmail.com', imapPort: mail.imapPort || 993, smtpHost: mail.smtpHost || 'smtp.gmail.com', smtpPort: mail.smtpPort || 465 };
}

export function mailImportOptions(options, provider) {
  return { ...options, allMail: ['google', 'microsoft', 'imap'].includes(provider) && options.allMail };
}

const GENERAL_KEYS = ['displayName', 'signature', 'signatureFormat', 'theme', 'density', 'replyTone', 'language', 'translationLanguage', 'syncInterval', 'markReadOnOpen'];
export function preferencePatch(current, saved) {
  const patch = Object.fromEntries(GENERAL_KEYS.filter(key => current[key] !== saved[key]).map(key => [key, current[key]]));
  if ('signature' in patch || 'signatureFormat' in patch) { patch.signature = current.signature; patch.signatureFormat = current.signatureFormat; }
  return patch;
}
export function acceptPreferences(current, saved, sent, received) {
  const value = { ...current }, baseline = { ...saved };
  const sameFooter = current.signature === sent.signature && current.signatureFormat === sent.signatureFormat;
  for (const key of Object.keys(sent)) {
    baseline[key] = received[key];
    if (current[key] === sent[key] && (!['signature', 'signatureFormat'].includes(key) || sameFooter)) value[key] = received[key];
  }
  return { value, baseline };
}
export function importStatusLabel(job) {
  if (!job) return 'History import has not started.';
  if (job.status === 'running' && job.phase === 'retrying') return 'Temporary connection problem — waiting to retry';
  if (job.status === 'running' && job.phase === 'queued') return 'History import queued — waiting for the next page';
  return ({ running: 'History import in progress', paused: 'History import paused', failed: 'History import stopped after an error', interrupted: 'History import interrupted', stopped: 'History import stopped', complete: 'Chosen history range completed', completed: 'Chosen history range completed' })[job.status] || 'History import status unknown';
}
export function importControl(job) {
  if (job?.status === 'running') return 'pause';
  if (['reconnect', 'restart'].includes(job?.recoveryAction)) return null;
  return ['paused', 'failed', 'interrupted', 'stopped'].includes(job?.status) ? 'resume' : null;
}

function modelValues(ai) {
  return { baseUrl: ai.baseUrl || 'http://127.0.0.1:11434/v1', model: ai.model || '', apiKey: '', clearApiKey: false, temperature: ai.temperature ?? 0.7, maxTokens: ai.maxTokens ?? 1024 };
}

function policyValues(policy = {}) {
  return { ...DEFAULT_POLICY, ...policy, summarySchedule: { ...DEFAULT_POLICY.summarySchedule, ...policy.summarySchedule }, triggers: { ...DEFAULT_POLICY.triggers, ...policy.triggers }, behaviors: { ...DEFAULT_POLICY.behaviors, ...policy.behaviors }, folders: { ...DEFAULT_POLICY.folders, ...policy.folders }, content: { ...DEFAULT_POLICY.content, ...policy.content } };
}

function Permission({ checked, onChange, title, description, simulated = false }) {
  return <label className="settings-permission">
    <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    <span><strong>{title}{simulated && <small>Simulated</small>}</strong>{description && <span>{description}</span>}</span>
  </label>;
}

export default function Settings({ state, onClose, onUpdate, notify, page = false, initialTab = 'general', onDirtyChange, onBusyChange }) {
  const savedMail = state.settings.mail;
  const savedAi = state.settings.ai;
  const imapConfigured = savedMail.configured && (!savedMail.provider || savedMail.provider === 'imap');
  const [tab, setTab] = useState(TABS.some(([id]) => id === initialTab) ? initialTab : 'general');
  const [provider, setProvider] = useState(savedMail.configured ? savedMail.provider || 'imap' : 'google');
  const [oauth, setOauth] = useState({ google: { clientId: '', clientSecret: '' }, microsoft: { clientId: '' } });
  const [customClients, setCustomClients] = useState({});
  const hasDefaultClient = !!state.settings.oauthClients?.[provider]?.configured;
  const useDefaultClient = hasDefaultClient && !customClients[provider];
  const [busy, setBusy] = useState('');
  const [preferencesSaving, setPreferencesSaving] = useState(false);
  const [preferencesError, setPreferencesError] = useState('');
  const [mailSnapshot, setMailSnapshot] = useState(null);
  const [importRefreshError, setImportRefreshError] = useState('');
  const [importOptions, setImportOptions] = useState({ months: 3, inbox: true, sent: true, allMail: true });
  const canImport = id => !!(mailImportOptions(importOptions, id).allMail || importOptions.inbox || importOptions.sent);
  const [searchDirty, setSearchDirty] = useState(false);
  const [searchRequestBusy, setSearchRequestBusy] = useState(false);
  const [embeddingDirty, setEmbeddingDirty] = useState(false);
  const [embeddingRequestBusy, setEmbeddingRequestBusy] = useState(false);
  const [learningDirty, setLearningDirty] = useState(false);
  const [learningBusy, setLearningBusy] = useState(false);
  const [calendarDirty, setCalendarDirty] = useState(false);
  const [calendarBusy, setCalendarBusy] = useState(false);
  const otherOperationBusy = !!busy || calendarBusy || learningBusy || searchRequestBusy || embeddingRequestBusy;
  const operationBusy = otherOperationBusy || preferencesSaving;
  const [error, setError] = useState('');
  const [mail, setMail] = useState(() => mailValues({}));
  const [ai, setAi] = useState(() => modelValues(savedAi));
  const [preferences, setPreferences] = useState(() => ({ ...DEFAULT_PREFERENCES, ...state.settings.preferences }));
  const [policy, setPolicy] = useState(() => policyValues(state.settings.policy));
  const [testResult, setTestResult] = useState('');
  const [footerPreview, setFooterPreview] = useState(null);
  const [updateResult, setUpdateResult] = useState(null);
  const [includePrereleases, setIncludePrereleases] = useState(__APP_VERSION__.includes('-'));
  const [downloadState, setDownloadState] = useState({ supported: false, phase: 'idle' });
  useEffect(() => setFooterPreview(null), [preferences.signature, preferences.signatureFormat]);
  const saved = useRef({ mail, model: ai, general: preferences, policy });
  const preferenceFlight = useRef(false);
  const mounted = useRef(false);
  const latest = useRef({});
  latest.current = { preferences, state, onUpdate, otherOperationBusy };
  const displayedAccounts = mailSnapshot || state.accounts || [];
  const allowUnload = useRef(false);
  const dirty = Object.fromEntries(Object.entries({ mail, model: ai, general: preferences, policy }).map(([key, value]) => [key, JSON.stringify(value) !== JSON.stringify(saved.current[key])]));
  dirty.mail ||= Object.values(oauth).some(credentials => Object.values(credentials).some(Boolean));
  dirty.calendar = calendarDirty;
  dirty.learning = learningDirty;
  dirty.search = searchDirty;
  dirty.model ||= embeddingDirty;
  const isDirty = Object.values(dirty).some(Boolean);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!dirty.general || preferencesSaving || preferencesError || otherOperationBusy) return;
    const timer = window.setTimeout(() => { void savePreferences(); }, 600);
    return () => window.clearTimeout(timer);
  }, [preferences, preferencesSaving, preferencesError, otherOperationBusy]);
  useEffect(() => { setMailSnapshot(null); }, [state.accounts]);
  useEffect(() => {
    if (tab !== 'mail' || operationBusy) return;
    const controller = new AbortController(); let timer;
    const poll = async () => {
      if (!document.hidden) {
        try {
          const response = await fetch('/api/state', { signal: controller.signal, headers: { 'X-Morrow-View': 'paged', 'X-Genmail-Account': state.account.id } });
          const result = await response.json();
          if (!response.ok || !Array.isArray(result.accounts)) throw new Error('Could not refresh import status.');
          if (!controller.signal.aborted) { setMailSnapshot(result.accounts); setImportRefreshError(''); }
        } catch { if (!controller.signal.aborted) setImportRefreshError('Import status could not be refreshed. Showing last known status.'); }
      }
      if (!controller.signal.aborted) timer = window.setTimeout(poll, 3000);
    };
    poll();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [tab, state.accounts, state.account.id, operationBusy]);

  function editPreferences(value) { setPreferences(value); setPreferencesError(''); }
  async function savePreferences() {
    if (preferenceFlight.current || latest.current.otherOperationBusy) return false;
    const sent = preferencePatch(latest.current.preferences, saved.current.general);
    if (!Object.keys(sent).length) return true;
    preferenceFlight.current = true; setPreferencesSaving(true); setPreferencesError('');
    try {
      const response = await fetch('/api/settings/preferences', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Morrow-View': 'paged', 'X-Genmail-Account': latest.current.state.account.id }, body: JSON.stringify(sent) });
      const result = await response.json();
      if (!response.ok || !result.settings?.preferences) throw new Error(result.error || 'Preferences could not be saved.');
      if (!mounted.current) return false;
      const accepted = acceptPreferences(latest.current.preferences, saved.current.general, sent, result.settings.preferences);
      saved.current.general = accepted.baseline;
      latest.current.preferences = accepted.value;
      setPreferences(accepted.value);
      const current = latest.current.state;
      const acknowledged = Object.fromEntries(Object.keys(sent).map(key => [key, result.settings.preferences[key]]));
      latest.current.onUpdate({ ...current, settings: { ...current.settings, preferences: { ...current.settings.preferences, ...acknowledged }, ...('signature' in sent ? { footer: result.settings.footer } : {}) } });
      return true;
    } catch (cause) {
      if (mounted.current) setPreferencesError(`${cause.message || 'Preferences could not be saved.'} Your changes are still here. Edit them or retry.`);
      return false;
    } finally {
      preferenceFlight.current = false;
      if (mounted.current) setPreferencesSaving(false);
    }
  }

  useEffect(() => { onDirtyChange?.(isDirty); }, [isDirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(operationBusy); }, [operationBusy, onBusyChange]);
  useEffect(() => {
    const warn = (event) => { if ((isDirty || operationBusy) && !allowUnload.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [isDirty, operationBusy]);
  useEffect(() => { setTestResult(''); }, [ai]);
  useEffect(() => {
    if (tab !== 'about' || !window.morrowDesktop) return;
    const controller = new AbortController(); let timer;
    const poll = async () => {
      try { const response = await fetch('/api/updates/status', { signal: controller.signal }); if (response.ok && !controller.signal.aborted) setDownloadState(await response.json()); } catch {}
      if (!controller.signal.aborted) timer = setTimeout(poll, 1500);
    };
    poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [tab]);
  useEffect(() => {
    if (!window.morrowDesktop || tab !== 'mail' || isDirty || operationBusy) return;
    let controller;
    const refresh = () => {
      controller?.abort(); controller = new AbortController();
      const signal = controller.signal;
      refreshMailConnections(signal).catch(() => { if (!signal.aborted) setError('Could not refresh connections. Please try again.'); });
    };
    window.addEventListener('focus', refresh);
    return () => { controller?.abort(); window.removeEventListener('focus', refresh); };
  }, [tab, isDirty, operationBusy, onUpdate]);

  async function refreshMailConnections(signal) {
    const response = await fetch('/api/state', { signal, headers: { 'X-Morrow-View': 'paged' } });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    if (!signal?.aborted) onUpdate(result);
  }
  async function updateDownload(action) {
    setBusy('updates'); setError('');
    try {
      const response = await fetch(`/api/updates/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Morrow-View': 'paged' }, body: JSON.stringify({ includePrereleases }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not update the app.');
      setDownloadState(result);
    } catch (error) { setError(error.message); }
    finally { setBusy(''); }
  }

  async function closeSettings() {
    if (operationBusy || !await savePreferences()) return;
    if (Object.keys(preferencePatch(latest.current.preferences, saved.current.general)).length) return;
    if (Object.entries(dirty).some(([key, value]) => key !== 'general' && value) && !window.confirm('Discard your unsaved settings and return to your inbox?')) return;
    onClose();
  }

  async function checkUpdates() {
    if (operationBusy) return;
    setBusy('updates'); setError(''); setUpdateResult(null);
    try {
      const response = await fetch(`/api/updates?includePrereleases=${includePrereleases}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not check for updates.');
      setUpdateResult(result);
    } catch (cause) { setError(cause.message); }
    finally { setBusy(''); }
  }

  async function save(path, body, label, message, accountId = state.account.id) {
    if (operationBusy || preferenceFlight.current) return;
    if (['select', 'disconnect'].includes(label) && learningDirty && !window.confirm('Discard unsaved learning settings or style edits before changing account?')) return;
    if (label === 'oauth' && (dirty.general || dirty.model || dirty.policy || JSON.stringify(mail) !== JSON.stringify(saved.current.mail)) && !window.confirm('Continue to sign-in and discard your other unsaved settings?')) return;
    setBusy(label);
    setError('');
    if (label === 'test') setTestResult('');
    try {
      const response = await fetch(`/api/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Morrow-View': 'paged', 'X-Genmail-Account': accountId }, body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to save. Please try again.');
      if (label === 'oauth') {
        if (!result.url) throw new Error('No sign-in URL returned. Please try again.');
        if (window.morrowDesktop) {
          await window.morrowDesktop.openSignIn(result.url);
          setOauth({ google: { clientId: '', clientSecret: '' }, microsoft: { clientId: '' } });
          notify('Browser opened. Complete sign-in, then return to Morrow to refresh your connections.');
          return;
        }
        allowUnload.current = true;
        window.location.assign(result.url);
        return;
      }
      if (label === 'footer') { setFooterPreview(result.footer); return; }
      if (label === 'test') {
        setTestResult(result.text || 'Your model is responding.');
        return;
      }
      if (label === 'mail' || label === 'disconnect') {
        const nextMail = mailValues(result.settings.mail);
        saved.current.mail = nextMail;
        setMail(nextMail);
        setOauth({ google: { clientId: '', clientSecret: '' }, microsoft: { clientId: '' } });
      }
      if (label === 'ai') { const nextAi = modelValues(result.settings.ai); saved.current.model = nextAi; setAi(nextAi); }
      if (label === 'policy') { const nextPolicy = policyValues(result.settings.policy); saved.current.policy = nextPolicy; setPolicy(nextPolicy); }
      onUpdate(result);
      notify(message);
    } catch (err) {
      allowUnload.current = false;
      setError(err.message || 'Unable to connect. Please try again.');
    } finally {
      setBusy('');
    }
  }

  function changeTab(nextTab) {
    if (operationBusy) return;
    setTab(nextTab);
    setError('');
  }

  function tabKeys(event) {
    if (operationBusy || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = TABS.findIndex(([id]) => id === tab);
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
    const nextTab = TABS[nextIndex][0];
    changeTab(nextTab);
    document.getElementById(`settings-tab-${nextTab}`)?.focus();
  }

  const content = <>
      <div className="settings-mode">
        <span className={`settings-status-dot ${state.account.mode === 'live' ? 'is-live' : ''}`} />
        <div>
          <strong>{state.account.mode === 'demo' ? 'Connect your mailbox' : 'Your mailbox is connected'}</strong>
          <span>{state.account.mode === 'demo' ? 'Add a Gmail, Outlook, or IMAP account to get started.' : state.account.email}</span>
        </div>

      </div>

      {window.morrowDesktop && tab === 'mail' && <button className="button secondary" disabled={operationBusy} onClick={async () => {
        try { await refreshMailConnections(); notify('Mailbox connections refreshed.'); }
        catch { setError('Could not refresh connections. Please try again.'); }
      }}>Refresh connections</button>}

      <div className="settings-tabs" role="tablist" aria-label="Workspace settings" onKeyDown={tabKeys}>
        {TABS.map(([id, Icon, label]) => (
          <button key={id} id={`settings-tab-${id}`} role="tab" type="button"
            aria-controls={`settings-panel-${id}`} aria-selected={tab === id} tabIndex={tab === id ? 0 : -1}
            disabled={operationBusy} onClick={() => changeTab(id)}>
            <Icon size={16} />{label}
            {dirty[id] && <span className="settings-dirty-dot" aria-label="Unsaved changes" />}
          </button>
        ))}
      </div>

      {error && <p className="settings-error" role="alert">{error}</p>}

      <section id="settings-panel-general" role="tabpanel" aria-labelledby="settings-tab-general" hidden={tab !== 'general'}>
        <form onSubmit={event => { event.preventDefault(); void savePreferences(); }}>
          <fieldset className="settings-fields" disabled={otherOperationBusy}>
            <legend className="settings-section-title">Make room for your rhythm.</legend>
            <p className="settings-intro">A few details that make Morrow feel like yours.</p>
            <label className="settings-field">Display name
              <input maxLength={100} autoComplete="name" value={preferences.displayName} placeholder={state.account.name || 'Your name'} onChange={(event) => editPreferences({ ...preferences, displayName: event.target.value })} />
            </label>
            <label className="settings-field">Footer format<select value={preferences.signatureFormat} onChange={event => editPreferences({ ...preferences, signatureFormat: event.target.value })}><option value="plain">Plain text</option><option value="html">HTML</option></select></label>
            <label className="settings-field">{preferences.signatureFormat === 'html' ? 'HTML signature source' : 'Email signature'}
              <textarea rows={4} maxLength={12000} value={preferences.signature} placeholder="Your sign-off, just the way you like it." onChange={(event) => editPreferences({ ...preferences, signature: event.target.value })} />
              <span className="settings-help">Added to new messages and replies across your accounts. Saved drafts keep their footer. HTML supports text styles, tables and links; images and active content are removed.</span>
            </label>
            <button type="button" className="button secondary" disabled={preferencesSaving} onClick={() => save('signature/preview', { signature: preferences.signature, signatureFormat: preferences.signatureFormat }, 'footer')}>Preview footer</button>
            {footerPreview && <FooterPreview footer={footerPreview} />}
            <div className="settings-columns">
              <label className="settings-field">Theme
                <select value={preferences.theme} onChange={(event) => editPreferences({ ...preferences, theme: event.target.value })}>
                  <option value="system">Match device</option><option value="light">Light</option><option value="dark">Dark</option>
                </select>
              </label>
              <label className="settings-field">Inbox density
                <select value={preferences.density} onChange={(event) => editPreferences({ ...preferences, density: event.target.value })}>
                  <option value="comfortable">Comfortable</option><option value="compact">Compact</option><option value="spacious">Spacious</option>
                </select>
              </label>
              <label className="settings-field">Default reply tone
                <select value={preferences.replyTone} onChange={(event) => editPreferences({ ...preferences, replyTone: event.target.value })}>
                  <option value="friendly">Friendly</option><option value="professional">Professional</option><option value="concise">Concise</option><option value="warm">Warm</option>
                </select>
              </label>
              <label className="settings-field">Preferred AI response language
                <input required maxLength={60} value={preferences.language} onChange={(event) => editPreferences({ ...preferences, language: event.target.value })} />
              </label>
            </div>
            <label className="settings-field">Target translation language
              <input maxLength={60} value={preferences.translationLanguage} placeholder="Blank uses preferred language" onChange={event => editPreferences({ ...preferences, translationLanguage: event.target.value })} />
              <span className="settings-help">These control AI output, not the app’s interface language.</span>
            </label>
            <label className="settings-field">Refresh connected mailboxes
              <select value={preferences.syncInterval} onChange={(event) => editPreferences({ ...preferences, syncInterval: Number(event.target.value) })}>
                <option value={0}>Manually</option><option value={1}>Every minute</option><option value={5}>Every 5 minutes</option><option value={15}>Every 15 minutes</option><option value={30}>Every 30 minutes</option>
              </select>
              <span className="settings-help">Runs while Morrow is open. New mail triggers AI only if enabled in AI permissions.</span>
            </label>
            <Permission checked={preferences.markReadOnOpen} onChange={(checked) => editPreferences({ ...preferences, markReadOnOpen: checked })} title="Mark emails as read when opened" description="Updates read status locally in Morrow." />
            <div className="settings-actions">
              <span role="status">{preferencesSaving ? 'Saving preferences…' : preferencesError ? 'Changes not saved' : dirty.general ? 'Waiting to save…' : 'Preferences saved automatically'}</span>
              {preferencesError && <button className="button secondary" type="submit" disabled={preferencesSaving}>Retry saving</button>}
            </div>
            {preferencesError && <p className="settings-error" role="alert">{preferencesError}</p>}
          </fieldset>
        </form>
      </section>

      <div id="settings-panel-search" role="tabpanel" aria-labelledby="settings-tab-search" hidden={tab !== 'search'}><SearchSettings state={state} active={tab === 'search'} onDirtyChange={setSearchDirty} onBusyChange={setSearchRequestBusy} onConfigureModel={() => changeTab('model')} disabled={!!busy || preferencesSaving || calendarBusy || learningBusy || embeddingRequestBusy} /></div>
      <div id="settings-panel-learning" role="tabpanel" aria-labelledby="settings-tab-learning" hidden={tab !== 'learning'}><StyleLearning key={state.account.id} state={state} onUpdate={onUpdate} onDirtyChange={setLearningDirty} onBusyChange={setLearningBusy} disabled={!!busy || preferencesSaving || calendarBusy} /></div>
      <section id="settings-panel-mail" role="tabpanel" aria-labelledby="settings-tab-mail" hidden={tab !== 'mail'}>
        <fieldset className="settings-fields" disabled={operationBusy}>
          <h2>Import history</h2><p className="settings-help">Sync checks recent mail in bounded batches. These options fill the chosen date window when connecting or starting an import below, without AI calls. Cached mail is retained when you choose a shorter range.</p>
          <label className="settings-field">History range<select value={importOptions.months} onChange={e => setImportOptions({ ...importOptions, months: Number(e.target.value) })}><option value={0}>All available history</option>{[1, 3, 6, 12].map(n => <option key={n} value={n}>Last {n} month{n > 1 ? 's' : ''}</option>)}</select></label>
          <label className="settings-permission"><input type="checkbox" checked={importOptions.allMail} onChange={event => setImportOptions({ ...importOptions, allMail: event.target.checked })} /><span>All mail (normal folders)</span></label>
          {!importOptions.allMail && <>
            <p className="settings-help">With All mail off:</p>
            {['inbox', 'sent'].map(folder => <label className="settings-permission" key={folder}><input type="checkbox" checked={importOptions[folder]} onChange={e => setImportOptions({ ...importOptions, [folder]: e.target.checked })} /><span>{folder === 'inbox' ? 'Inbox' : 'Sent — for optional writing-style learning'}</span></label>)}
          </>}
          <p className="settings-help">Choose All mail for Gmail, Outlook or IMAP, or at least one folder. Gmail / Outlook exclude Spam/Junk and Trash/Deleted Items. IMAP relies on the server’s special-use flags to exclude Junk and Trash; folders without those flags may be imported. IMAP also skips virtual All / Flagged views and folders that cannot be selected. Configure style learning separately in Learning.</p>
          <button className="button secondary" onClick={async () => { setBusy('refresh'); try { const response = await fetch('/api/state', { headers: { 'X-Genmail-Account': state.account.id, 'X-Morrow-View': 'paged' } }); const next = await response.json(); if (!response.ok || !Array.isArray(next.accounts)) throw new Error(); setMailSnapshot(next.accounts); setImportRefreshError(''); } catch { setImportRefreshError('Import status could not be refreshed. Showing last known status.'); } finally { setBusy(''); } }}>Refresh progress</button>
          {importRefreshError && <p role="alert" className="settings-error">{importRefreshError}</p>}
        </fieldset>
        {displayedAccounts.map(account => <div className="settings-connected" key={account.id}>
          <div><strong>{account.email}</strong><p>{account.provider.toUpperCase()} · Disconnect removes only this account’s credentials. Cached mail and drafts stay on this computer.</p><p role="status">{importStatusLabel(account.import)}{account.import && <> · {account.import.imported} new messages · {account.import.options.months === 0 ? 'All available history' : `${account.import.options.months} months`}{account.import.currentFolder && ` · ${account.import.currentFolder === 'all' ? 'All normal folders' : account.import.currentFolder}`}{account.import.pages != null && ` · ${account.import.pages} pages`}{account.import.processed != null && ` · ${account.import.processed} checked`}{account.import.error && ` · ${account.import.error}`}</>}</p>
          {account.import?.phase === 'retrying' && account.import.nextRetryAt && <p>Next retry: {new Date(account.import.nextRetryAt).toLocaleString()}. You can pause this import.</p>}
          {account.import?.recoveryAction === 'reconnect' && <p>Reconnect this account using the sign-in form below, then start a new import.</p>}
          {account.import?.recoveryAction === 'restart' && <p>Start a new import below to replace the unusable checkpoint. Downloaded mail is retained.</p>}
          <div className="settings-actions"><button className="button secondary" disabled={operationBusy || !canImport(account.provider)} onClick={() => save('imports/start', mailImportOptions(importOptions, account.provider), 'import', 'Import started.', account.id)}>{mailImportOptions(importOptions, account.provider).allMail ? 'Start all mail import' : 'Start chosen import'}</button>
          {importControl(account.import) && <button className="button secondary" disabled={operationBusy} onClick={() => save(`imports/${importControl(account.import)}`, {}, 'import', 'Import updated.', account.id)}>{importControl(account.import) === 'pause' ? 'Pause' : 'Resume from checkpoint'}</button>}</div></div>
          <button type="button" className="button secondary" disabled={operationBusy} onClick={() => save('account/select', { accountId: account.id }, 'select', 'Mailbox selected.')}>Use mailbox</button>
          {account.provider === 'imap' && <button type="button" className="button secondary" disabled={operationBusy} onClick={() => { if (dirty.mail && !window.confirm('Discard unsaved mail settings?')) return; const value = mailValues(account.settings); saved.current.mail = value; setMail(value); setProvider('imap'); }}>Edit</button>}
          <button type="button" className="button secondary" disabled={operationBusy} onClick={() => {
            if (window.confirm(`Disconnect ${account.email}? Cached mail and drafts will be retained.`)) save('account/disconnect', {}, 'disconnect', 'Mailbox disconnected. Cached mail is retained.', account.id);
          }}>Disconnect</button>
        </div>)}
        <button type="button" className="button secondary" disabled={operationBusy} onClick={() => { if (dirty.mail && !window.confirm('Discard unsaved mail settings?')) return; const value = mailValues({}); saved.current.mail = value; setMail(value); setOauth({ google: { clientId: '', clientSecret: '' }, microsoft: { clientId: '' } }); }}>Add another account</button>
        <p className="settings-intro">Keep multiple Gmail, Outlook, and IMAP accounts connected. Choose separate or combined mail in the sidebar. Reconnecting an email address updates that account.</p>
        <div className="settings-providers" role="group" aria-label="Mail provider">
          {[['google', 'Gmail'], ['microsoft', 'Outlook / Microsoft 365'], ['imap', 'Custom IMAP']].map(([id, label]) => (
            <button type="button" key={id} aria-pressed={provider === id} disabled={operationBusy}
              onClick={() => { setProvider(id); setError(''); }}>
              {label}{savedMail.configured && savedMail.provider === id && <Check size={13} aria-label="Connected" />}
            </button>
          ))}
        </div>
        {provider !== 'imap' ? <form onSubmit={(event) => {
          event.preventDefault();
          save(`oauth/${provider}/start`, { ...(useDefaultClient ? { useDefaultClient: true, organize: !!oauth[provider].organize } : oauth[provider]), importOptions: mailImportOptions(importOptions, provider) }, 'oauth');
        }}>
          <fieldset className="settings-fields" disabled={operationBusy}>
            <legend className="settings-section-title">Connect {provider === 'google' ? 'your Gmail' : 'your Microsoft mailbox'}.</legend>
            <p className="settings-intro">Use the sign-in button below to open {provider === 'google' ? 'Google' : 'Microsoft'} in your browser. Keep Morrow open while you approve access, then return to the app. Morrow imports your chosen history in the background.</p>
            {useDefaultClient ? <p className="settings-help">{provider === 'google' ? 'Google sign-in is ready. No client ID or secret is needed. If Google limits access to test users, the publisher must add your account or complete app verification.' : 'Microsoft sign-in is ready. No client ID or secret is needed. Your organization may require administrator approval.'}</p> : <div className="settings-oauth-setup">
              <strong>Register your own OAuth app first</strong>
              <p>{provider === 'google'
                ? 'Create a Desktop app OAuth client in Google Cloud, then enter its client ID and client secret below.'
                : 'Create a desktop app registration in Microsoft Entra, then enter its application (client) ID below. No client secret is needed.'} See README.md in the project folder for setup instructions.</p>
            </div>}
            {!useDefaultClient && <label className="settings-field">Client ID
              <input required value={oauth[provider].clientId} autoComplete="off" autoCapitalize="none" spellCheck={false}
                placeholder={provider === 'google' ? 'Your Google OAuth client ID' : 'Your Microsoft application (client) ID'}
                onChange={(event) => setOauth({ ...oauth, [provider]: { ...oauth[provider], clientId: event.target.value } })} />
            </label>}
            {provider === 'google' && !useDefaultClient && <label className="settings-field">Client secret
              <input type="password" required autoComplete="new-password" value={oauth.google.clientSecret} placeholder="Your Google desktop app client secret"
                onChange={(event) => setOauth({ ...oauth, google: { ...oauth.google, clientSecret: event.target.value } })} />
            </label>}
            <label className="settings-permission"><input type="checkbox" checked={!!oauth[provider].organize} onChange={event => setOauth({ ...oauth, [provider]: { ...oauth[provider], organize: event.target.checked } })} /><span>Allow moving mail and managing labels (Gmail modify / Outlook Mail.ReadWrite). Reconnect existing accounts to enable.</span></label>
            <p className="settings-help settings-scope">Read, star, archive, and trash shortcuts stay local. Move / Labels applies reviewed provider changes. Sending requires an explicit send or schedule review. Formatted mail uses a protected reader; attachments and CID images are not supported.</p>
            <div className="settings-actions">
              <span><ShieldCheck size={15} /> Credentials encrypted on disk</span>
              <button className="button primary" type="submit" disabled={!canImport(provider)}>
                {busy === 'oauth' ? <LoaderCircle size={16} className="settings-spinner" /> : <ExternalLink size={16} />}
                {busy === 'oauth' ? 'Opening sign-in…' : `Sign in with ${provider === 'google' ? 'Google' : 'Microsoft'} in browser`}
              </button>
            </div>
            <details className="settings-oauth-setup"><summary>Advanced: callback URL for app registration</summary>
              {hasDefaultClient && <label className="settings-permission"><input type="checkbox" checked={!!customClients[provider]} onChange={event => setCustomClients(value => ({ ...value, [provider]: event.target.checked }))} /><span>Use my own {provider === 'google' ? 'Google' : 'Microsoft'} OAuth client</span></label>}
              <p>Do not open this URL to sign in. Your browser returns here automatically after authorization.</p>
              <code>{window.morrowDesktop ? `http://localhost:${window.location.port}` : 'http://localhost:3001'}/api/oauth/{provider}/callback</code>
            </details>
          </fieldset>
        </form> : <form onSubmit={(event) => {
          event.preventDefault();
          save('settings/mail', { ...mail, importOptions: mailImportOptions(importOptions, 'imap'), password: mail.password || undefined, imapPort: Number(mail.imapPort), smtpPort: Number(mail.smtpPort) }, 'mail', 'Mailbox connected. Historical import will continue while Morrow is open.');
        }}>
          <fieldset className="settings-fields" disabled={operationBusy}>
            <legend className="settings-section-title">Bring your inbox along.</legend>
            <p className="settings-intro">Connect with IMAP and SMTP. Your chosen history will import while Morrow is open.</p>
            <label className="settings-field">Email address
              <input type="email" autoComplete="email" required placeholder="you@example.com" value={mail.email}
                onChange={(event) => setMail({ ...mail, email: event.target.value })} />
            </label>
            <label className="settings-field">App password
              <input type="password" autoComplete="new-password" required={!imapConfigured || mail.email !== savedMail.email}
                placeholder={imapConfigured ? 'Leave blank to keep your saved password' : 'Your email provider’s app password'}
                value={mail.password} aria-describedby="settings-password-help"
                onChange={(event) => setMail({ ...mail, password: event.target.value })} />
              <span className="settings-help" id="settings-password-help">Use an app password from your provider. Enable IMAP in your mailbox settings if needed.</span>
            </label>
            <div className="settings-server-row">
              <label className="settings-field">IMAP server
                <input required value={mail.imapHost} autoCapitalize="none" spellCheck={false}
                  onChange={(event) => setMail({ ...mail, imapHost: event.target.value })} />
              </label>
              <label className="settings-field">TLS port
                <input type="number" min="1" max="65535" required value={mail.imapPort}
                  onChange={(event) => setMail({ ...mail, imapPort: event.target.value })} />
              </label>
            </div>
            <div className="settings-server-row">
              <label className="settings-field">SMTP server
                <input required value={mail.smtpHost} autoCapitalize="none" spellCheck={false}
                  onChange={(event) => setMail({ ...mail, smtpHost: event.target.value })} />
              </label>
              <label className="settings-field">Secure port
                <select value={mail.smtpPort} onChange={(event) => setMail({ ...mail, smtpPort: event.target.value })}>
                  <option value="465">465 · TLS</option><option value="587">587 · STARTTLS</option>
                </select>
              </label>
            </div>
            <p className="settings-help settings-scope">Read, star, archive, and trash shortcuts stay local. Move / Labels applies reviewed provider changes. SMTP sending requires an explicit send or schedule review. Formatted mail uses a protected reader; attachments and CID images are not supported.</p>
            <div className="settings-actions">
              <span><ShieldCheck size={15} /> Credentials encrypted on disk</span>
              <button className="button primary" type="submit" disabled={!canImport('imap')}>
                {busy === 'mail' ? <LoaderCircle size={16} className="settings-spinner" /> : <ArrowRight size={16} />}
                {busy === 'mail' ? 'Connecting…' : imapConfigured ? 'Update & sync' : 'Connect & sync'}
              </button>
            </div>
          </fieldset>
        </form>}
      </section>

      <section id="settings-panel-model" role="tabpanel" aria-labelledby="settings-tab-model" hidden={tab !== 'model'}>
        <form onSubmit={(event) => {
          event.preventDefault();
          const testing = event.nativeEvent.submitter?.value === 'test';
          save(testing ? 'settings/ai/test' : 'settings/ai', { ...ai, apiKey: ai.apiKey || undefined, temperature: Number(ai.temperature), maxTokens: Number(ai.maxTokens) }, testing ? 'test' : 'ai', 'Model settings saved.');
        }}>
          <fieldset className="settings-fields" disabled={operationBusy}>
            <legend className="settings-section-title">Your inbox. Your model.</legend>
            <p className="settings-intro">Use Ollama locally or connect any OpenAI-compatible endpoint.</p>
            <label className="settings-field">API base URL
              <input type="url" required value={ai.baseUrl} autoCapitalize="none" spellCheck={false} placeholder="http://127.0.0.1:11434/v1"
                aria-describedby="settings-url-help" onChange={(event) => setAi({ ...ai, baseUrl: event.target.value })} />
              <span className="settings-help" id="settings-url-help">Include /v1 if your provider requires it. The default connects to Ollama on this computer.</span>
            </label>
            <label className="settings-field">Model ID
              <input required value={ai.model} placeholder="qwen3:8b" autoCapitalize="none" spellCheck={false}
                onChange={(event) => setAi({ ...ai, model: event.target.value })} />
            </label>
            <label className="settings-field">API key <span className="settings-optional">Optional for local models</span>
              <input type="password" autoComplete="new-password" value={ai.apiKey} disabled={ai.clearApiKey}
                placeholder={savedAi.hasApiKey ? 'Leave blank to keep your saved key' : 'Enter a key if your provider requires one'}
                onChange={(event) => setAi({ ...ai, apiKey: event.target.value })} />
            </label>
            {savedAi.hasApiKey && <label className="settings-checkbox">
              <input type="checkbox" checked={ai.clearApiKey} onChange={(event) => setAi({ ...ai, clearApiKey: event.target.checked, apiKey: '' })} />
              Remove saved API key
            </label>}
            <div className="settings-columns">
              <label className="settings-field">Temperature
                <input type="number" min="0" max="2" step="0.1" required value={ai.temperature} onChange={(event) => setAi({ ...ai, temperature: event.target.value })} />
                <span className="settings-help">0 is more predictable; 2 is more varied.</span>
              </label>
              <label className="settings-field">Maximum response tokens
                <input type="number" min="128" max="4096" step="1" required value={ai.maxTokens} onChange={(event) => setAi({ ...ai, maxTokens: event.target.value })} />
                <span className="settings-help">Limits each model response, from 128 to 4,096.</span>
              </label>
            </div>
            <div className="settings-privacy">
              <ShieldCheck size={19} />
              <div><strong>You choose what your AI sees.</strong>
                <p>Permitted context goes to your model when you ask for help or enable an automatic trigger. AI drafts stay yours to review and send.</p>
              </div>
            </div>
            <p className="settings-help">Test connection sends a fixed test prompt, without any email content. It does not save your settings.</p>
            {testResult && <div className="settings-test-result" role="status"><strong>Connection successful</strong><p>{testResult}</p></div>}
            <div className="settings-actions">
              <span>{dirty.model ? 'You have unsaved changes' : savedAi.configured ? <><Check size={15} /> Model is configured</> : 'Bring your own model'}</span>
              <div className="settings-button-row">
                <button className="button secondary" type="submit" value="test">{busy === 'test' ? <LoaderCircle size={16} className="settings-spinner" /> : null}{busy === 'test' ? 'Testing…' : 'Test connection'}</button>
                <button className="button primary" type="submit" value="save">
                  {busy === 'ai' ? <LoaderCircle size={16} className="settings-spinner" /> : <Check size={16} />}
                  {busy === 'ai' ? 'Saving…' : 'Save model'}
                </button>
              </div>
            </div>
          </fieldset>
        </form>
        <SearchSettings presentation="model" active={tab === 'model'} state={state} onDirtyChange={setEmbeddingDirty} onBusyChange={setEmbeddingRequestBusy} disabled={!!busy || preferencesSaving || calendarBusy || learningBusy || searchRequestBusy} />
      </section>
      <section id="settings-panel-policy" role="tabpanel" aria-labelledby="settings-tab-policy" hidden={tab !== 'policy'}>
        <form onSubmit={(event) => { event.preventDefault(); save('settings/policy', { ...policy, maxMessages: Number(policy.maxMessages) }, 'policy', 'AI permissions saved.'); }}>
          <fieldset className="settings-fields" disabled={operationBusy}>
            <legend className="settings-section-title">Your assistant. Your boundaries.</legend>
            <p className="settings-intro">Every AI action follows these saved permissions, including demos and local simulations. Unchecked behaviors are blocked by the server before execution.</p>
            <div className="settings-master-permission">
              <Permission checked={policy.enabled} onChange={(checked) => setPolicy({ ...policy, enabled: checked })} title="Enable AI assistance" description="Turn off to block all AI and simulated workflows. Manual reading, composing, and sending still work." />
            </div>
            <h3 className="settings-group-title">When assistance starts</h3>
            <p className="settings-help">All triggers default to off. Checked filters must all match, for each account separately. Drafts and Trash are excluded. Your model may charge per request. Suggestions never send, create events or replace drafts automatically.</p>
            <div className="settings-permissions-grid">
              {Object.entries({ onOpen: 'Summarize when I open a message', onReply: 'Suggest text when I start a reply', onArrival: 'Summarize newly synced messages', scheduledSummary: 'Generate scheduled inbox summaries', inboxOnly: 'Only messages in Inbox', starredOnly: 'Only starred messages' }).map(([key, title]) => <Permission key={key} checked={policy.triggers[key]} onChange={checked => setPolicy({ ...policy, triggers: { ...policy.triggers, [key]: checked } })} title={title} />)}
            </div>
            <p className="settings-help">New-mail summaries start after sync discovers a new message; initial imports are excluded. Enable automatic sync in General for regular checks. This is polling, not instant provider push.</p>
            <h3 className="settings-group-title">Summary schedule · P0–P4</h3>
            <label className="settings-field">Repeat<select value={policy.summarySchedule.cadence} onChange={event => setPolicy({ ...policy, summarySchedule: { ...policy.summarySchedule, cadence: event.target.value } })}><option value="daily">Daily at a set time</option><option value="interval">Every few hours</option></select></label>
            {policy.summarySchedule.cadence === 'daily' ? <div className="settings-columns">
              <label className="settings-field">Time<input type="time" required value={policy.summarySchedule.time} onChange={event => setPolicy({ ...policy, summarySchedule: { ...policy.summarySchedule, time: event.target.value } })} /></label>
              <label className="settings-field">Time zone<input required maxLength={100} placeholder="Asia/Hong_Kong" value={policy.summarySchedule.timeZone} onChange={event => setPolicy({ ...policy, summarySchedule: { ...policy.summarySchedule, timeZone: event.target.value } })} /></label>
            </div> : <label className="settings-field">Every N hours<input type="number" min="1" max="168" step="1" required value={policy.summarySchedule.everyHours} onChange={event => setPolicy({ ...policy, summarySchedule: { ...policy.summarySchedule, everyHours: Number(event.target.value) } })} /></label>}
            <p className="settings-help">Runs while Morrow is open, using up to your maximum permitted messages from cached mail. Find results in AI Studio → Summaries. Missed daily runs catch up once when reopened; interval timing starts when enabled. Failed or interrupted jobs are not retried automatically.</p>
            <p className="settings-help">P0 emergency · P1 due today · P2 action/follow-up · P3 information · P4 bulk/promotional. AI priorities need your review. Email Brain and writing style still require explicit review and saving.</p>
            <h3 className="settings-group-title">What your assistant can do</h3>
            <div className="settings-permissions-grid">
              {AI_BEHAVIORS.map((feature) => <Permission key={feature.id} checked={policy.behaviors[feature.id]} onChange={(checked) => setPolicy({ ...policy, behaviors: { ...policy.behaviors, [feature.id]: checked } })} title={feature.label} description={feature.description} simulated={!!feature.mock} />)}
            </div>
            <h3 className="settings-group-title">Which folders it can use</h3>
            <p className="settings-help">Choose each folder independently. Messages outside these folders cannot become AI context.</p>
            <div className="settings-folder-permissions">
              {Object.keys(DEFAULT_POLICY.folders).map((folder) => <Permission key={folder} checked={policy.folders[folder]} onChange={(checked) => setPolicy({ ...policy, folders: { ...policy.folders, [folder]: checked } })} title={folder[0].toUpperCase() + folder.slice(1)} />)}
            </div>
            <h3 className="settings-group-title">Which information it can see</h3>
            <div className="settings-permissions-grid">
              {Object.keys(DEFAULT_POLICY.content).map((scope) => <Permission key={scope} checked={policy.content[scope]} onChange={(checked) => setPolicy({ ...policy, content: { ...policy.content, [scope]: checked } })} title={CONTENT_LABELS[scope][0]} description={CONTENT_LABELS[scope][1]} />)}
            </div>
            <label className="settings-field settings-limit">Maximum messages per request
              <input type="number" min="1" max="50" required value={policy.maxMessages} onChange={(event) => setPolicy({ ...policy, maxMessages: event.target.value })} />
              <span className="settings-help">Between 1 and 50 permitted messages. Smaller limits share less context.</span>
            </label>
            <div className="settings-privacy"><ShieldCheck size={19} /><div><strong>Permission is never permission to send.</strong><p>Review AI drafts before sending. Simulated workflows only change local Morrow data after you review and apply their preview. Calendar and attachment demos have no external access.</p></div></div>
            <div className="settings-actions">
              <span>{dirty.policy ? 'Unsaved permissions are not active yet' : 'These permissions are active'}</span>
              <button className="button primary" type="submit">{busy === 'policy' ? <LoaderCircle size={16} className="settings-spinner" /> : <Check size={16} />} Save permissions</button>
            </div>
          </fieldset>
        </form>
      </section>

      <section id="settings-panel-calendar" role="tabpanel" aria-labelledby="settings-tab-calendar" hidden={tab !== 'calendar'}>
        <fieldset className="settings-fields" disabled={preferencesSaving}>
        <CalendarSettings onNotify={notify} onDirtyChange={setCalendarDirty} onBusyChange={value => { setCalendarBusy(value); if (!value) allowUnload.current = false; }} onBeforeConnect={() => {
          if (preferenceFlight.current) return false;
          if (Object.entries(dirty).some(([key, value]) => key !== 'calendar' && value) && !window.confirm('Continue to calendar sign-in and discard your other unsaved settings?')) return false;
          allowUnload.current = true;
          return true;
        }} />
        </fieldset>
      </section>

      <section id="settings-panel-about" role="tabpanel" aria-labelledby="settings-tab-about" hidden={tab !== 'about'}>
        <div className="settings-about-brand"><img src="/brand/morrow-icon.svg" alt="" width="72" height="72" /><div><h2>Morrow Mail</h2><p>Version {__APP_VERSION__} · A little more room to think.</p></div></div>
        <fieldset className="settings-fields" disabled={operationBusy}>
          <legend>App updates</legend>
          <Permission title="Include alpha and beta releases" checked={includePrereleases} onChange={value => { setIncludePrereleases(value); setUpdateResult(null); }} />
          <p className="settings-help">Checks public GitHub releases without sharing mail or credentials. {window.morrowDesktop ? 'Downloaded updates are verified before you choose Install & Restart.' : 'Use the release downloads to update a browser development installation.'}</p>
          <button type="button" className="button secondary" onClick={checkUpdates}>{busy === 'updates' ? 'Checking…' : 'Check for updates'}</button>
          {updateResult && <div role="status" className="settings-test-result"><strong>{updateResult.updateAvailable ? `Update available: ${updateResult.latestVersion}` : 'You’re up to date for this channel.'}</strong><p>Installed: {updateResult.currentVersion} · Latest: {updateResult.latestVersion}<br />Checked: {new Date(updateResult.checkedAt).toLocaleString()}</p><a href={updateResult.url} target="_blank" rel="noreferrer">View release & downloads</a></div>}
          {updateResult?.updateAvailable && downloadState.supported && ['idle', 'error'].includes(downloadState.phase) && <button type="button" className="button primary" onClick={() => updateDownload('download')}>Download update</button>}
          {['checking', 'downloading', 'verifying'].includes(downloadState.phase) && <div role="status"><progress max={downloadState.total || 1} value={downloadState.received || 0} aria-label="Update download progress" /><p>{downloadState.phase === 'downloading' ? 'Downloading update…' : 'Verifying update…'}</p><button type="button" className="button secondary" onClick={() => updateDownload('cancel')}>Cancel download</button></div>}
          {downloadState.phase === 'ready' && <div role="status"><p>Version {downloadState.version} is ready to install.</p><button type="button" className="button primary" disabled={isDirty || operationBusy} onClick={async () => { try { await window.morrowDesktop.installUpdate(); } catch (error) { setError(error.message || 'Could not restart for the update.'); } }}>Install & Restart</button>{isDirty && <p>Save or discard unsaved changes before restarting.</p>}</div>}
          {downloadState.error && <p role="alert" className="settings-error">{downloadState.error}</p>}
          {downloadState.previous && <p role="status">{downloadState.previous}</p>}
        </fieldset>
        <p><a href="https://github.com/Coke1120/Morrow-Mail" target="_blank" rel="noreferrer">GitHub</a> · <a href="https://github.com/sponsors/Coke1120" target="_blank" rel="noreferrer">GitHub Sponsors</a> · <a href="https://buymeacoffee.com/Coke1120" target="_blank" rel="noreferrer">Buy Me a Coffee</a></p>
        <p className="settings-about-intro">An independent, open-source email workspace inspired by GenMail. Original design and code, MIT licensed, and built to keep your workspace on your computer.</p>
        <dl className="settings-about-status">
          <div><dt>Mailbox</dt><dd>{state.account.mode === 'demo' ? 'No mailbox selected' : `${({ google: 'Gmail API', microsoft: 'Microsoft Graph', imap: 'IMAP / SMTP' })[state.account.provider || savedMail.provider] || 'Live provider'} · ${state.account.email}`}</dd></div>
          <div><dt>Model</dt><dd>{savedAi.configured ? `${savedAi.model} · ${savedAi.baseUrl}` : 'Not configured'}</dd></div>
          <div><dt>AI assistance</dt><dd>{state.settings.policy?.enabled === false ? 'Disabled in your saved permissions' : 'Manual actions and opt-in triggers, using saved permissions'}</dd></div>
          <div><dt>Simulated features</dt><dd>AI Studio scheduling, attachment discovery, research, unsubscribe, Email Brain, and other marked workflows use local previews. The separate Calendar page connects to real Google and Outlook calendars.</dd></div>
          <div><dt>Your data</dt><dd>Mail and workspace data stay in your local database. Credentials are encrypted on disk. Explicit sending contacts your mail provider; AI actions share only permitted context with your chosen model.</dd></div>
          <div><dt>Documentation</dt><dd>README.md in the project folder includes setup, provider instructions, and feature coverage.</dd></div>
        </dl>
      </section>
    </>;

  return page ? <section className="settings-page" aria-labelledby="settings-page-title">
    <div className="settings-page-inner">
      <header className="settings-page-heading"><div><span className="eyebrow">MAKE YOURSELF AT HOME</span><h1 id="settings-page-title">Your workspace</h1><p>A calmer inbox starts with a workspace that fits you.</p></div><button type="button" className="button secondary" disabled={operationBusy} onClick={closeSettings}><ArrowLeft size={16} />Back to inbox</button></header>
      {content}
    </div>
  </section> : <Modal title="Your workspace" description="Make Morrow yours." onClose={closeSettings} closeDisabled={operationBusy} className="settings-modal">{content}</Modal>;
}
