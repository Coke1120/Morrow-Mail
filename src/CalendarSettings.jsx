import { useEffect, useRef, useState } from 'react';
import { CalendarDays, Check, ExternalLink, LoaderCircle, Unplug } from 'lucide-react';
import './calendar.css';

const PROVIDERS = { google: 'Google Calendar', microsoft: 'Outlook Calendar' };
const emptyForms = () => ({ google: { clientId: '', clientSecret: '' }, microsoft: { clientId: '', clientSecret: '' } });

export default function CalendarSettings({ onNotify, onDirtyChange, onBusyChange, onBeforeConnect }) {
  const [connections, setConnections] = useState([]);
  const [forms, setForms] = useState(emptyForms);
  const [customClients, setCustomClients] = useState({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const saved = useRef(emptyForms());
  const pending = useRef(null);
  const allowUnload = useRef(false);
  const dirty = Object.keys(PROVIDERS).some(provider => forms[provider].clientSecret || forms[provider].clientId !== saved.current[provider].clientId);

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(!!busy); }, [busy, onBusyChange]);
  useEffect(() => {
    const warn = event => { if ((dirty || busy) && !allowUnload.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, busy]);
  useEffect(() => () => { pending.current?.abort(); }, []);
  useEffect(() => {
    if (!window.morrowDesktop || dirty || busy || loading) return;
    const refresh = () => setRevision(value => value + 1);
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [dirty, busy, loading]);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    fetch('/api/calendars', { signal: controller.signal }).then(async response => {
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Unable to load calendar connections.');
      if (controller.signal.aborted) return;
      setConnections(result.connections || []);
      const next = emptyForms();
      for (const connection of result.connections || []) if (next[connection.provider]) next[connection.provider].clientId = connection.clientId || '';
      saved.current = next; setForms(next);
    }).catch(cause => { if (!controller.signal.aborted) setError(cause.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);

  async function connect(event, provider) {
    event.preventDefault();
    if (pending.current) return;
    const other = provider === 'google' ? 'microsoft' : 'google';
    if ((forms[other].clientSecret || forms[other].clientId !== saved.current[other].clientId) && !window.confirm(`Continue to sign-in and discard the unsaved ${PROVIDERS[other]} credentials?`)) return;
    if (onBeforeConnect && !onBeforeConnect()) return;
    const controller = new AbortController(); pending.current = controller;
    setBusy(`connect-${provider}`); setError('');
    try {
      const useDefault = !customClients[provider] && connections.some(item => item.provider === provider && item.hasDefaultClient);
      const response = await fetch(`/api/calendars/${provider}/connect`, { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(useDefault ? { useDefaultClient: true } : { clientId: forms[provider].clientId.trim(), clientSecret: forms[provider].clientSecret.trim() }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Unable to start calendar sign-in.');
      if (controller.signal.aborted) return;
      const url = new URL(result.url, window.location.origin);
      const connection = connections.find(item => item.provider === provider);
      const origin = new URL(connection?.redirectUri || `http://localhost:3001/api/calendar-oauth/${provider}/callback`).origin;
      if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.origin !== origin || url.pathname !== `/api/calendar-oauth/${provider}/authorize` || !url.searchParams.get('state') || url.username || url.password || url.hash) throw new Error('The calendar sign-in URL is invalid.');
      setForms(value => ({ ...value, [provider]: { ...value[provider], clientSecret: '' } }));
      if (window.morrowDesktop) {
        await window.morrowDesktop.openSignIn(url.href);
        const used = { clientId: forms[provider].clientId.trim(), clientSecret: '' };
        saved.current = { ...saved.current, [provider]: used };
        setForms(value => ({ ...value, [provider]: used }));
        onNotify?.('Browser opened. Complete sign-in, then return to Morrow to refresh your connections.');
        return;
      }
      allowUnload.current = true;
      window.location.assign(url.href);
    } catch (cause) { if (!controller.signal.aborted) { allowUnload.current = false; setError(cause.message); } }
    finally { if (pending.current === controller) { pending.current = null; if (!controller.signal.aborted && !allowUnload.current) setBusy(''); } }
  }

  async function disconnect(connection) {
    if (pending.current || !window.confirm(`Disconnect ${connection.email} from ${PROVIDERS[connection.provider]}? Your provider's events will remain unchanged.`)) return;
    const controller = new AbortController(); pending.current = controller;
    setBusy(`disconnect-${connection.provider}`); setError('');
    try {
      const response = await fetch(`/api/calendars/${connection.provider}/disconnect`, { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectionEmail: connection.email }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Unable to disconnect the calendar.');
      if (controller.signal.aborted) return;
      setConnections(value => value.map(item => item.provider === connection.provider ? { ...item, connected: false, email: '', clientId: '', hasClientSecret: false } : item));
      saved.current = { ...saved.current, [connection.provider]: { clientId: '', clientSecret: '' } };
      setForms(value => ({ ...value, [connection.provider]: { clientId: '', clientSecret: '' } }));
      onNotify?.(`${PROVIDERS[connection.provider]} disconnected.`);
    } catch (cause) { if (!controller.signal.aborted) setError(cause.message); }
    finally { if (pending.current === controller) { pending.current = null; if (!controller.signal.aborted) setBusy(''); } }
  }

  return <div className="calendar-settings">
    <h2 className="settings-section-title">A calendar for every part of your day.</h2>
    <p className="settings-intro">Connect one Google and one Outlook calendar account at the same time. Each can show multiple calendars. Calendar connections are separate from email.</p>
    {window.morrowDesktop && <button className="button secondary" disabled={loading || !!busy} onClick={() => { if (!dirty || window.confirm('Refresh connections and discard unsaved calendar credentials?')) setRevision(value => value + 1); }}>Refresh connections</button>}
    <div className="settings-privacy"><CalendarDays size={19} /><div><strong>Your calendar is live.</strong><p>View calendar events and explicitly create events after reviewing them. Calendar data is not sent to your AI model. AI Studio’s calendar exercises remain local simulations.</p></div></div>
    {error && <div className="settings-error" role="alert"><p>{error}</p>{!connections.length && <button type="button" className="button secondary" disabled={loading || !!busy} onClick={() => setRevision(value => value + 1)}>Retry connections</button>}</div>}
    {loading ? <p className="calendar-status" role="status"><LoaderCircle className="calendar-spinner" size={16} />Loading connections…</p> : Object.entries(PROVIDERS).map(([provider, name]) => {
      const connection = connections.find(item => item.provider === provider);
      const form = forms[provider];
      const useDefault = connection?.hasDefaultClient && !customClients[provider];
      const preservedSecret = !!connection?.hasClientSecret && connection.clientId === form.clientId.trim();
      const redirect = connection?.redirectUri || `http://localhost:3001/api/calendar-oauth/${provider}/callback`;
      return <section className="calendar-connection" key={provider} aria-labelledby={`calendar-connection-${provider}`}>
        <div className="calendar-connection-heading"><h3 id={`calendar-connection-${provider}`}>{name}</h3><span className={`calendar-connection-status ${connection?.connected ? 'connected' : ''}`}>{connection?.connected ? <><Check size={13} />Connected</> : 'Not connected'}</span></div>
        {connection?.connected && <div className="calendar-connection-account"><p>{connection.email}</p><button type="button" className="button secondary" disabled={!!busy} onClick={() => disconnect(connection)}>{busy === `disconnect-${provider}` ? <LoaderCircle size={14} className="calendar-spinner" /> : <Unplug size={14} />}Disconnect</button></div>}
        <details className="calendar-setup" open={!connection?.connected}><summary>{connection?.connected ? 'Reconnect or change account' : 'Sign in through your browser'}</summary>
          {useDefault ? <p className="settings-help">{provider === 'google' ? 'Google sign-in is ready. No client ID or secret is needed. If Google limits access to test users, the publisher must add your account or complete app verification.' : 'Microsoft sign-in is ready. No client ID or secret is needed. Your organization may require administrator approval.'}</p> : <div className="settings-oauth-setup">
            {provider === 'google' ? <><strong>Google Cloud setup</strong><p>Enable the Google Calendar API, configure your OAuth consent screen, and create a Desktop app OAuth client. Copy its client ID and client secret. Add your Google account as a test user if the app is in Testing.</p><p>Requested access: your account identity, calendar list, and calendar events.</p><a href="https://developers.google.com/workspace/calendar/api/quickstart/nodejs" target="_blank" rel="noopener noreferrer">Google Calendar setup guide <ExternalLink size={12} /></a></> : <><strong>Microsoft Entra setup</strong><p>Register an app supporting the accounts you want to connect (personal and organizational accounts are supported). Add a Mobile and desktop applications platform with the redirect below. Enable public client flows; a client secret is not required.</p><p>Delegated permissions: User.Read, Calendars.ReadWrite, and offline_access. Your organization may require administrator approval.</p><a href="https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-registration" target="_blank" rel="noopener noreferrer">Microsoft desktop app registration guide <ExternalLink size={12} /></a></>}
          </div>}
          <form onSubmit={event => connect(event, provider)}><fieldset className="settings-fields" disabled={!!busy}>
            {!useDefault && <>
              <label className="settings-field">{name} client ID<input autoComplete="off" required maxLength={500} spellCheck="false" value={form.clientId} onChange={event => setForms(value => ({ ...value, [provider]: { ...value[provider], clientId: event.target.value } }))} /></label>
              <label className="settings-field">{name} client secret{provider === 'microsoft' ? ' (optional)' : ''}<input type="password" autoComplete="new-password" required={provider === 'google' && !preservedSecret} maxLength={2000} value={form.clientSecret} placeholder={preservedSecret ? 'Leave blank to keep the saved secret' : provider === 'microsoft' ? 'Not needed for a public desktop client' : 'Client secret value'} onChange={event => setForms(value => ({ ...value, [provider]: { ...value[provider], clientSecret: event.target.value } }))} /><span className="settings-help">Stored encrypted on this device. {preservedSecret ? 'A blank value keeps the saved secret for this client ID.' : provider === 'microsoft' ? 'Leave blank for the recommended public desktop client.' : 'Use the secret from your Google Desktop app client.'}</span></label>
            </>}
            <button className="button primary" type="submit">{busy === `connect-${provider}` ? <LoaderCircle size={15} className="calendar-spinner" /> : <ExternalLink size={15} />}{busy === `connect-${provider}` ? 'Opening sign-in…' : `Sign in to ${name} in browser`}</button>
            <details><summary>Advanced: callback URL for app registration</summary>
              {connection?.hasDefaultClient && <label className="settings-permission"><input type="checkbox" checked={!!customClients[provider]} onChange={event => setCustomClients(value => ({ ...value, [provider]: event.target.checked }))} /><span>Use my own {provider === 'google' ? 'Google' : 'Microsoft'} OAuth client</span></label>}
              <code>{redirect}</code><p>Do not open this URL to sign in. Your browser returns here automatically after authorization.</p>
            </details>
          </fieldset></form>
        </details>
      </section>;
    })}
  </div>;
}
