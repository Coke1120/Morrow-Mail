import { useEffect, useRef, useState } from 'react';

const localDate = value => {
  const date = new Date(value);
  return Number.isFinite(+date) ? new Date(+date - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
};
const utcDate = value => value ? new Date(value).toISOString() : '';
const noop = () => {};

export default function OutOfOffice({ state, onDirtyChange = noop, onBusyChange = noop, disabled = false }) {
  const owner = state.account.id, live = state.account.mode === 'live';
  const [value, setValue] = useState(null), [options, setOptions] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const currentOwner = useRef(owner), inFlight = useRef(false), mounted = useRef(true);
  currentOwner.current = owner;
  const dirty = options !== null && JSON.stringify(options) !== JSON.stringify(value?.settings);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; onDirtyChange(false); onBusyChange(false); }; }, [onDirtyChange, onBusyChange]);
  useEffect(() => {
    const controller = new AbortController();
    setValue(null); setOptions(null); setError('');
    if (!live) { setBusy(false); return () => controller.abort(); }
    setBusy(true);
    request(owner, 'GET', undefined, controller.signal).then(result => {
      if (!controller.signal.aborted && currentOwner.current === owner) { setValue(result); setOptions(result.settings || null); }
    }).catch(cause => { if (!controller.signal.aborted && currentOwner.current === owner) setError(cause.message); })
      .finally(() => { if (!controller.signal.aborted && currentOwner.current === owner) setBusy(false); });
    return () => controller.abort();
  }, [owner, live]);
  async function request(account, method, body, signal) {
    const response = await fetch('/api/out-of-office', { method, signal, headers: { 'Content-Type': 'application/json', 'X-Genmail-Account': account }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not read automatic reply settings.');
    return result;
  }
  async function action(kind) {
    if (inFlight.current || busy || disabled || !live) return;
    const label = kind === 'disable' ? 'Disable' : options?.mode === 'disabled' ? 'Save disabled settings' : 'Save and enable';
    if (kind !== 'refresh' && !value?.canWrite) return;
    if (kind === 'refresh' ? dirty && !window.confirm('Discard unsaved automatic reply edits and refresh from the provider?')
      : !window.confirm(`${label} automatic replies for ${owner}?\n\n${kind === 'disable' ? `The provider will stop sending automatic replies. Existing templates are retained.${dirty ? ' Unsaved edits in this form will be discarded.' : ''}` : `The provider will store these plain-text replies. Mode: ${options.mode}. Audience: ${options.audience}${options.restrictToDomain ? ' · Google Workspace domain only' : ''}. Saving replaces any existing rich formatting.`}\n\nEnabled replies continue while Morrow is closed. No mail is sent by this button.`)) return;
    if (currentOwner.current !== owner) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      const result = await request(owner, kind === 'refresh' ? 'GET' : 'PUT', kind === 'refresh' ? undefined : { ...options, action: kind === 'disable' ? 'disable' : 'save', confirmed: true, revision: value.revision });
      if (mounted.current && currentOwner.current === owner) { setValue(result); setOptions(result.settings || null); }
    } catch (cause) { if (mounted.current && currentOwner.current === owner) setError(cause.message); }
    finally { inFlight.current = false; if (mounted.current && currentOwner.current === owner) setBusy(false); }
  }
  async function reconnect() {
    if (inFlight.current || busy || disabled || !live || !value?.supported || !window.confirm(`Allow Out of Office settings access for ${owner}?\n\nThe browser will request ${value.requiredScope}. This permission lets Morrow read and change your provider’s automatic reply settings. Enabling replies still requires a separate Save confirmation.`)) return;
    if (currentOwner.current !== owner) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      const response = await fetch(`/api/oauth/${value.provider}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Genmail-Account': owner }, body: JSON.stringify({ outOfOffice: true, forAccount: owner }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not start settings authorization.');
      if (!mounted.current || currentOwner.current !== owner) return;
      const url = new URL(result.url);
      if (url.protocol !== 'http:' || url.hostname !== 'localhost' || url.pathname !== `/api/oauth/${value.provider}/authorize` || !url.searchParams.get('state')) throw new Error('The service returned an invalid sign-in URL.');
      if (window.morrowDesktop) await window.morrowDesktop.openSignIn(result.url);
      else window.location.assign(url.href);
    } catch (cause) { if (mounted.current && currentOwner.current === owner) setError(cause.message); }
    finally { inFlight.current = false; if (mounted.current && currentOwner.current === owner) setBusy(false); }
  }
  const change = (key, next) => setOptions(previous => ({ ...previous, [key]: next }));
  const google = value?.provider === 'google';
  return <section className="settings-fields">
    <h2 className="settings-section-title">Out of Office</h2>
    <p className="settings-intro">Server-managed automatic replies continue while Morrow is closed. Gmail or Outlook controls delivery and how often each sender receives a reply.</p>
    <strong>{live ? owner : 'Choose an individual connected mailbox.'}</strong>
    {live && <button className="button secondary" disabled={busy || disabled} onClick={() => action('refresh')}>Refresh provider settings</button>}
    {value && !value.supported && <p className="settings-help">IMAP does not support this feature. Configure automatic replies in your provider’s webmail settings. Morrow will not send local automatic replies.</p>}
    {value?.requiresReconnect && <div className="settings-test-result"><p>Reconnect this mailbox and explicitly allow Out of Office settings permission: <code>{value.requiredScope}</code>. Reading and sending mail do not grant permission to change automatic replies. After browser sign-in, return here and refresh provider settings.</p><button className="button secondary" disabled={busy || disabled} onClick={reconnect}>Allow Out of Office settings…</button></div>}
    {value?.providerUrl && <a href={value.providerUrl} target="_blank" rel="noreferrer">Open provider settings</a>}
    {options && <fieldset className="settings-fields" disabled={busy || disabled || !value.canWrite}>
      <label className="settings-field">Automatic replies<select value={options.mode} onChange={event => change('mode', event.target.value)}><option value="disabled">Disabled</option><option value="always">Always enabled</option><option value="scheduled">Scheduled</option></select></label>
      {options.mode === 'scheduled' && <>
        <p className="settings-help">Dates use your device’s local timezone. {google ? 'At least one date is required; leave one blank for an open-ended schedule.' : 'Both dates are required.'}</p>
        <label className="settings-field">Start<input type="datetime-local" value={localDate(options.start)} onChange={event => { try { change('start', utcDate(event.target.value)); } catch { setError('Choose a valid start time.'); } }} /></label>
        <label className="settings-field">End<input type="datetime-local" value={localDate(options.end)} onChange={event => { try { change('end', utcDate(event.target.value)); } catch { setError('Choose a valid end time.'); } }} /></label>
      </>}
      {value.scheduleWarning && <p className="settings-help">{value.scheduleWarning}</p>}
      {google && <label className="settings-field">Subject prefix<input maxLength="200" value={options.subject} onChange={event => change('subject', event.target.value)} /></label>}
      <label className="settings-field">{google ? 'Reply message' : 'Reply within your organization'}<textarea rows="6" maxLength="10000" value={options.message} onChange={event => change('message', event.target.value)} /></label>
      <label className="settings-field">{google ? 'Reply audience' : 'Outside your organization'}<select value={options.audience} onChange={event => change('audience', event.target.value)}>{!google && <option value="none">No external replies</option>}<option value="contacts">Contacts only</option><option value="all">All senders</option></select></label>
      {!google && <label className="settings-field">External reply message<textarea rows="6" maxLength="10000" value={options.externalMessage} onChange={event => change('externalMessage', event.target.value)} /></label>}
      {google && <label className="settings-permission"><input type="checkbox" checked={options.restrictToDomain} onChange={event => change('restrictToDomain', event.target.checked)} />Only my Google Workspace domain (Workspace accounts only)</label>}
      <p className="settings-help">Plain text only. Existing rich replies are shown as text; Save replaces their formatting. Outlook keeps separate internal and external messages. Disable preserves the provider’s existing templates.</p>
      <div className="settings-actions"><button className="button primary" onClick={() => action('save')}>{options.mode === 'disabled' ? 'Save disabled settings…' : 'Save and enable…'}</button><button className="button secondary" disabled={value.settings.mode === 'disabled'} onClick={() => action('disable')}>Disable automatic replies…</button></div>
    </fieldset>}
    {busy && <p role="status" aria-live="polite">Contacting the mail provider…</p>}
    {error && <p className="settings-error" role="alert">{error}</p>}
  </section>;
}
