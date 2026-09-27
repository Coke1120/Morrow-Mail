import { api } from './api';
import { useMailPage } from './mail-page';
import { replyDraft, forwardDraft, copyProviderDraft } from './message-draft';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, ArrowDownLeft, ArrowLeft, ArrowRight, Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, CalendarDays, CircleHelp, FilePenLine, Inbox, Leaf, LoaderCircle, Mail, MailOpen, Menu, Pencil, Plus, RefreshCw, ReplyAll, Search, Send, Settings as SettingsIcon, ShieldCheck, Sparkles, Star, Trash2, X } from 'lucide-react';
import Modal from './Modal';
import MailSearch, { SearchHighlight } from './MailSearch';
import { storage } from './storage';
import FooterPreview from './FooterPreview';
import MessageBody from './MessageBody';
import MessageAI from './MessageAI';
import Settings from './Settings';
import ActivityStatus from './ActivityStatus';
import Dashboard from './Dashboard';
import Studio from './Studio';
import Calendar from './Calendar';
import { AI_BEHAVIORS, DEFAULT_POLICY, DEFAULT_PREFERENCES } from '../shared/features';

const messageKey = message => message?.viewId || JSON.stringify([message?.accountId, message?.id]);
const folders = [
  { id: 'inbox', name: 'Inbox', icon: Inbox }, { id: 'starred', name: 'Starred', icon: Star },
  { id: 'sent', name: 'Sent', icon: Send }, { id: 'drafts', name: 'Drafts', icon: FilePenLine },
  { id: 'archive', name: 'Archive', icon: Archive }, { id: 'spam', name: 'Spam', icon: ShieldCheck }, { id: 'trash', name: 'Trash', icon: Trash2 },
];
const categories = [{ id: 'all', name: 'All mail' }, { id: 'primary', name: 'Primary' }, { id: 'updates', name: 'Updates' }, { id: 'newsletters', name: 'Newsletters' }];
const initials = name => (name || '?').split(/[\s@]+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase();
const avatarColor = name => ['sage', 'peach', 'lilac', 'blue', 'sand'][([...name].reduce((sum, char) => sum + char.charCodeAt(0), 0)) % 5];
const shortDate = date => {
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return '';
  return value.toDateString() === new Date().toDateString() ? value.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : value.toLocaleDateString([], { month: 'short', day: 'numeric' });
};
const fullDate = date => new Date(date).toLocaleString([], { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

function Avatar({ name, large = false }) { return <span className={`avatar ${avatarColor(name)} ${large ? 'large' : ''}`} aria-hidden="true">{initials(name)}</span>; }
function IconButton({ icon: Icon, label, children, ...props }) { return <button className="icon-button" title={label} aria-label={label} {...props}><Icon size={18} />{children}</button>; }

function AccountGroup({ account, active, children }) {
  const key = `morrow.account.collapsed.${account.id}`;
  const [open, setOpen] = useState(() => { try { return storage.getItem(key) !== 'true'; } catch { return true; } });
  return <details className={`account-group ${active ? 'current-account' : ''}`} open={open} onToggle={event => {
    const expanded = event.currentTarget.open;
    setOpen(expanded);
    try { storage.setItem(key, String(!expanded)); } catch { /* UI preferences may be unavailable in private browsing. */ }
  }}><summary title={account.email}><ChevronRight size={14} /><span><strong>{account.email}</strong><small>{account.provider === 'google' ? 'Google' : account.provider === 'microsoft' ? 'Outlook' : account.provider === 'imap' ? 'IMAP' : account.provider}</small></span>{account.unread > 0 && <span className="nav-count">{account.unread}</span>}</summary><div className="account-folders">{children}</div></details>;
}

export function ReaderHeader({ message }) {
  return <header className="reader-heading">
    <h2>{message.subject || '(No subject)'}</h2>
    <details className="reader-details"><summary>
      <Avatar name={message.fromName || message.fromEmail || '?'} />
      <span className="reader-sender" title={`${message.fromName || ''} <${message.fromEmail || ''}>`}><strong>{message.fromName || message.fromEmail || 'Unknown sender'}</strong><span>{message.fromEmail}</span></span>
      <time dateTime={message.date}>{new Date(message.date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</time>
      <span className="reader-details-label">Details<ChevronDown size={12} /></span>
    </summary><dl>
      <dt>From</dt><dd>{message.fromName} &lt;{message.fromEmail}&gt;</dd>
      <dt>To</dt><dd>{message.to || '—'}</dd>
      {message.cc && <><dt>Cc</dt><dd>{message.cc}</dd></>}{message.bcc && <><dt>Bcc</dt><dd>{message.bcc}</dd></>}
      <dt>Mailbox</dt><dd>{message.accountId}</dd><dt>Date</dt><dd>{fullDate(message.date)}</dd>
      <dt>Folder</dt><dd>{message.folder}{message.providerFolderName && ` · ${message.providerFolderName}`}</dd>
      {!!message.labels?.length && <><dt>Labels</dt><dd>{message.labels.join(', ')}</dd></>}
    </dl></details>
  </header>;
}

export function ReaderSummary({ title, text, metadata }) {
  return <details className="reader-summary"><summary><Sparkles size={14} /><strong>{title}</strong><span>{text}</span><ChevronDown size={12} /></summary><div><pre>{text}</pre>{metadata && <small>{metadata}</small>}</div></details>;
}

function AutomaticAssistance({ messageId, account, trigger, policy, modelKey, onUse, compact = false }) {
  const [result, setResult] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const request = useRef(0);
  useEffect(() => { request.current++; setResult(null); setError(''); setBusy(false); }, [JSON.stringify(policy), modelKey]);
  useEffect(() => {
    const action = trigger === 'onOpen' ? 'summary' : 'reply';
    if (!policy.enabled || !policy.triggers?.[trigger] || !policy.behaviors[action]) return;
    const current = ++request.current;
    setBusy(true);
    api('/ai', { account, method: 'POST', body: JSON.stringify({ action, messageId, trigger }) })
      .then(value => { if (current === request.current) setResult(value); })
      .catch(cause => { if (current === request.current) setError(cause.message); })
      .finally(() => { if (current === request.current) setBusy(false); });
    return () => { request.current++; };
    // Triggers run on opening this view, not on preference changes or re-renders.
  }, [messageId, account, trigger]);
  if (!busy && !result?.text && !error) return null;
  if (compact) return busy || error ? <p className="reader-ai-status" role={error ? 'alert' : 'status'}>{error ? `Automatic assistance: ${error}` : 'Preparing automatic summary…'}</p> : <ReaderSummary title={result.source === 'demo' ? 'Demo summary' : 'AI summary'} text={result.text} metadata="Automatic assistance · Review before using" />;
  return <section className="compose-ai-preview" aria-label="Automatic assistance" aria-live="polite">
    {busy && <p>Preparing automatic assistance…</p>}
    {error && <p>Automatic assistance: {error}</p>}
    {result?.text && <><strong>{result.source === 'demo' ? 'Automatic assistance · Illustrative demo' : 'Automatic assistance · Review before using'}</strong><pre>{result.text}</pre>{onUse && <button type="button" className="button secondary" onClick={() => onUse(result.text)}>Use suggested reply</button>}</>}
  </section>;
}

export function Compose({ initial, account: currentAccount, accounts, preferences, footer, policy, modelKey, onClose, onSaved, onSent, onSettings, notify }) {
  if (initial?.providerDraft) initial = copyProviderDraft(initial);
  const [owner, setOwner] = useState(initial?.id || initial?.replyToId || initial?.forwarding || initial?.sourceDraft ? initial.accountId || '' : initial?.accountId || (currentAccount.id === 'all' ? accounts[0]?.id || '' : currentAccount.id));
  const account = accounts.find(item => item.id === owner) || { id: owner, email: owner, mode: 'live' };
  const sendLock = useRef(false);
  const aiRequest = useRef(0);
  const [draft, setDraft] = useState({ requestId: initial?.deliveryRequestId || crypto.randomUUID(), id: initial?.id, to: initial?.to || '', cc: initial?.cc || '', bcc: initial?.bcc || '', subject: initial?.subject || '', body: initial?.body || '', footer: initial?.id ? initial.footer : footer, replyToId: initial?.replyToId });
  const [saved, setSaved] = useState(JSON.stringify({ to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject, body: draft.body, footer: draft.footer }));
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [needsReview, setNeedsReview] = useState(initial?.deliveryStatus === 'unconfirmed');
  const [deliveryReviewed, setDeliveryReviewed] = useState(false);
  const [reviewSend, setReviewSend] = useState(false);
  const [showAI, setShowAI] = useState(false);
  const [aiAction, setAiAction] = useState('write');
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiResult, setAiResult] = useState(null);
  const aiAllowed = policy.enabled && policy.behaviors[aiAction] && (aiAction === 'write' || (policy.folders.drafts && policy.content.body));
  const dirty = JSON.stringify({ to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject, body: draft.body, footer: draft.footer }) !== saved || (!draft.id && [draft.to, draft.cc, draft.bcc, draft.subject, draft.body].some(value => value.trim()));
  useEffect(() => {
    if (!dirty) return;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => () => { aiRequest.current += 1; }, []);
  useEffect(() => { aiRequest.current += 1; setAiBusy(false); setAiResult(null); }, [JSON.stringify(policy)]);

  function edit(field, value) { setReviewSend(false); aiRequest.current += 1; setAiBusy(false); setAiResult(null); setDraft(previous => ({ ...previous, [field]: value, requestId: crypto.randomUUID() })); }
  function close() { if (!busy && (!dirty || window.confirm('Discard your unsaved changes? Save draft to keep them.'))) onClose(); }
  async function generate() {
    if (aiBusy || busy || !aiAllowed) return;
    const request = ++aiRequest.current;
    setAiBusy(true); setAiResult(null); setError('');
    try {
      const result = await api('/ai', { account, method: 'POST', body: JSON.stringify({ action: aiAction, prompt: aiPrompt, ...(aiAction !== 'write' ? { draftText: draft.body } : {}) }) });
      if (request === aiRequest.current) setAiResult(result);
    } catch (cause) { if (request === aiRequest.current) setError(cause.message); }
    finally { if (request === aiRequest.current) setAiBusy(false); }
  }
  async function submit(send, confirmed = false) {
    if (sendLock.current || (send && needsReview && !deliveryReviewed)) return;
    if (!accounts.some(item => item.id === owner)) { setError('Reconnect the original mailbox before saving or sending this draft.'); return; }
    if (send && !confirmed) { setReviewSend(true); return; }
    sendLock.current = true; setReviewSend(false);
    setBusy(send ? 'send' : 'save'); setError('');
    let submitted = false;
    try {
      let draftId = draft.id;
      if (send && !needsReview) {
        const savedDraft = await api('/drafts', { account, method: 'POST', body: JSON.stringify(draft) });
        draftId = savedDraft.message.id; setDraft(previous => ({ ...previous, id: draftId })); onSaved(savedDraft.message);
      }
      submitted = send;
      const result = await api(send ? '/send' : '/drafts', { account, method: 'POST', body: JSON.stringify(send ? { ...draft, draftId, retryUnconfirmed: needsReview && deliveryReviewed } : draft) });
      if (send) { onSent(result.message, draft.id); notify(result.simulated ? 'Demo message sent. No email left your device.' : 'Your message has been sent.'); onClose(); }
      else { setDraft(previous => ({ ...previous, id: result.message.id })); setSaved(JSON.stringify({ to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject, body: draft.body, footer: draft.footer })); onSaved(result.message); notify('Draft saved on this device.'); }
    } catch (cause) {
      setError(cause.message);
      if (cause.requiresSendReview || (submitted && !cause.status)) {
        setNeedsReview(true); setDeliveryReviewed(false); setShowAI(false);
        setDraft(previous => ({ ...previous, ...(cause.messageRecord || {}), id: cause.draftId || previous.id, requestId: cause.deliveryRequestId || previous.requestId }));
        if (!cause.status) setError("Delivery could not be confirmed. Check Sent before retrying this same message; retrying may send a duplicate.");
        setSaved(JSON.stringify({ to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject, body: draft.body, footer: draft.footer }));
        if (cause.messageRecord) onSaved(cause.messageRecord);
      }
    }
    finally { sendLock.current = false; setBusy(''); }
  }
  useEffect(() => {
    const shortcut = event => {
      if (!(event.ctrlKey || event.metaKey) || busy || aiBusy) return;
      if (event.key.toLowerCase() === 's' && !event.shiftKey) { event.preventDefault(); submit(false); }
      if (event.key.toLowerCase() === 'd' && event.shiftKey) { event.preventDefault(); submit(true); }
    };
    document.addEventListener('keydown', shortcut); return () => document.removeEventListener('keydown', shortcut);
  });
  return <Modal title={draft.replyToId ? 'A thoughtful reply' : initial?.forwarding ? 'Forward message' : 'A fresh conversation'} description={account.mode === 'demo' ? 'Demo mode · Sending is simulated. No email leaves your device.' : `Sending from ${preferences.displayName || account.name || ''} <${account.email}>`} onClose={close} closeDisabled={!!busy} className="compose-modal">
    <form className="compose-form" onSubmit={event => { event.preventDefault(); submit(true); }}>
      <label className="compose-field"><span>From</span><select aria-label="Sending account" value={owner} disabled={!!busy || aiBusy || !!draft.id || !!draft.replyToId || initial?.forwarding || initial?.sourceDraft || needsReview} onChange={event => { setOwner(event.target.value); setAiResult(null); setDraft(previous => ({ ...previous, requestId: crypto.randomUUID() })); }}>{accounts.map(item => <option key={item.id} value={item.id}>{item.email}</option>)}</select></label>
      {(initial?.sourceDraft) && <small className="reply-owner">Editing a local copy without attachments. The original Gmail draft stays in Gmail; changes here are not uploaded to it.</small>}
      {initial?.forwarding && <small className="reply-owner">Forwarding the message text. Attachments are not included.</small>}
      {draft.replyToId && <small className="reply-owner"><ShieldCheck size={14} />Replying from the mailbox that received this conversation.</small>}
      {initial?.replyToId && !initial.id && !initial.body && !needsReview && <AutomaticAssistance messageId={initial.replyToId} account={owner} trigger="onReply" policy={policy} modelKey={modelKey} onUse={text => { if (!busy && (!draft.body || window.confirm('Replace your current draft text with this suggestion?'))) edit('body', text); }} />}
      {['to', 'cc', 'bcc'].map(field => <label className="compose-field" key={field}><span>{field === 'to' ? 'To' : field === 'cc' ? 'Cc' : 'Bcc'}</span><input aria-label={field.toUpperCase()} value={draft[field]} onChange={event => edit(field, event.target.value)} placeholder="Email addresses, separated by commas or semicolons" autoFocus={field === 'to'} disabled={!!busy || needsReview} /></label>)}
      <small>Up to 100 plain email addresses across To, Cc and Bcc. Bcc stays hidden from other recipients.</small>
      <label className="compose-field"><span>Subject</span><input value={draft.subject} onChange={event => edit('subject', event.target.value)} placeholder="What’s on your mind?" disabled={!!busy || needsReview} /></label>
      <div className="compose-ai-toggle"><button type="button" className="button ghost" onClick={() => setShowAI(!showAI)} aria-expanded={showAI} disabled={needsReview}><Sparkles size={15} />Writing assistant<ChevronDown size={13} /></button><span>{preferences.replyTone} · {preferences.language}</span></div>
      {showAI && !needsReview && <div className="compose-ai-panel"><div className="compose-ai-tools"><label>Action<select value={aiAction} disabled={aiBusy || !!busy} onChange={event => { setAiAction(event.target.value); setAiResult(null); }}><option value="write">Write from instructions</option><option value="rewrite">Rewrite this draft</option><option value="translate">Translate this draft</option></select></label><label>{aiAction === 'translate' ? 'Language / instructions' : 'Instructions'}<input value={aiPrompt} maxLength={2000} disabled={aiBusy || !!busy} onChange={event => { setAiPrompt(event.target.value); setAiResult(null); }} placeholder={aiAction === 'translate' ? `Translate into ${preferences.translationLanguage || preferences.language}` : aiAction === 'write' ? 'Thank Sam for the proposal and ask for a call Friday' : 'Make this clearer and more concise'} /></label><button type="button" className="button secondary" onClick={generate} disabled={!aiAllowed || aiBusy || !!busy || (aiAction === 'write' ? !aiPrompt.trim() : !draft.body.trim())}>{aiBusy ? <LoaderCircle size={15} className="spinning" /> : <Sparkles size={15} />}Preview</button></div>
        {!aiAllowed && <div className="policy-notice"><ShieldCheck size={14} /><span>This action is disabled by your AI permissions.</span><button type="button" onClick={() => { if (!dirty || window.confirm('Discard unsaved changes and open settings?')) { onClose(); onSettings(); } }}>Settings</button></div>}
        {aiResult && <div className="compose-ai-preview"><div><strong>Review before inserting</strong><span>{aiResult.source === 'demo' ? 'ILLUSTRATIVE DEMO' : 'AI GENERATED'}</span></div><pre>{aiResult.text}</pre><button type="button" className="button primary" onClick={() => edit('body', aiResult.text)}>Replace draft text<ArrowRight size={14} /></button></div>}
      </div>}
      <textarea className="compose-body" aria-label="Message body" placeholder="Make someone's inbox a little brighter…" value={draft.body} onChange={event => edit('body', event.target.value)} required disabled={!!busy || needsReview} />
      {(draft.footer?.text || draft.footer?.html) && <section className="draft-signature"><header><strong>Email footer</strong><button type="button" className="button ghost" disabled={!!busy || needsReview} onClick={() => edit('footer', { text: '', html: '' })}>Remove</button></header><FooterPreview footer={draft.footer} /></section>}
      {needsReview && <div className="inline-error" role="alert"><p>This delivery is unconfirmed. Check your provider’s Sent folder before retrying. The saved draft is preserved; another send may create a duplicate.</p><label><input type="checkbox" checked={deliveryReviewed} disabled={!!busy} onChange={event => setDeliveryReviewed(event.target.checked)} /> I checked Sent and want to retry this delivery.</label></div>}
      {error && <div className="inline-error" role="alert">{error}</div>}
      {reviewSend && <section className="compose-ai-panel" aria-label="Send review"><strong>Review recipients before sending</strong><pre>{`From: ${account.email}\nTo: ${draft.to}\nCc: ${draft.cc}\nBcc: ${draft.bcc}\nSubject: ${draft.subject || '(No subject)'}`}</pre><button type="button" className="button primary" disabled={!!busy} onClick={() => submit(true, true)}>Confirm send</button><button type="button" className="button secondary" onClick={() => setReviewSend(false)}>Cancel review</button></section>}
      <div className="compose-footer"><div className="compose-note"><ShieldCheck size={15} /><span>Review first. Send when ready.</span></div><div className="compose-actions"><button type="button" className="button secondary" onClick={() => submit(false)} disabled={!!busy || needsReview}>{busy === 'save' && <LoaderCircle size={16} className="spinning" />}Save draft</button><button type="submit" className="button primary" disabled={!!busy || (needsReview && !deliveryReviewed)}>{busy === 'send' ? <LoaderCircle size={16} className="spinning" /> : <Send size={16} />}{account.mode === 'demo' ? 'Send demo' : 'Send email'}</button></div></div>
    </form>
  </Modal>;
}

function OrganizeMail({ message, onClose, onUpdate }) {
  const [data, setData] = useState(null), [destination, setDestination] = useState(''), [mode, setMode] = useState('move');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [review, setReview] = useState(false);
  useEffect(() => { let active = true; api('/mail/folders', { account: message.accountId }).then(value => { if (active) setData(value); }).catch(cause => { if (active) setError(cause.message); }); return () => { active = false; }; }, [message.accountId]);
  const choices = (data?.folders || []).filter(folder => mode === 'move' || folder.kind === 'label');
  async function apply(confirmed = false) {
    if (busy || !destination) return;
    if (!confirmed) { setReview(true); return; }
    setBusy(true); setError('');
    try { await api(`/messages/${encodeURIComponent(message.id)}/organize`, { account: message.accountId, method: 'POST', body: JSON.stringify({ destinationId: destination, mode, confirmed: true }) }); onUpdate(); onClose(); }
    catch (cause) { setError(cause.message); } finally { setBusy(false); }
  }
  return <Modal title="Move / Labels / Spam on Provider" description={message.accountId} onClose={onClose} closeDisabled={busy}>
    <div className="settings-section"><p>{message.subject}</p>{!data && !error && <p>Loading folders…</p>}
      {data?.provider === 'google' && <label className="settings-field">Action<select value={mode} disabled={busy} onChange={event => { setMode(event.target.value); setDestination(''); setReview(false); }}><option value="move">Move out of Inbox</option><option value="addLabel">Add label</option><option value="removeLabel">Remove label</option></select></label>}
      {data && <label className="settings-field">Folder / label<select value={destination} disabled={busy} onChange={event => { setDestination(event.target.value); setReview(false); }}><option value="">Choose a destination</option>{choices.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>}
      <p>Changes apply within this mailbox on your provider. Gmail labels are shown on downloaded mail. Archive contains mail without Inbox, Sent, Draft, Spam or Trash labels. Gmail Move removes Inbox and retains other labels. Moving to Inbox also removes Spam.</p><p>Choose Spam / Junk to move this message on your provider. To report phishing or block future messages from this sender, use your provider’s website; Morrow does not submit those reports or change the provider’s blocked-sender list.</p>{data?.provider === "google" || data?.provider === "microsoft" ? <a href={data.provider === "google" ? "https://mail.google.com/" : "https://outlook.live.com/mail/"} target="_blank" rel="noopener noreferrer">Open provider to report or block</a> : null}
      {error && <p className="inline-error" role="alert">{error}</p>}<button className="button primary" disabled={busy || !destination} onClick={() => apply()}>{busy ? 'Applying…' : 'Review change'}</button>
      {review && <section aria-label="Provider change review"><p>{message.accountId} · {mode} · {choices.find(folder => folder.id === destination)?.name}</p><button className="button primary" disabled={busy} onClick={() => apply(true)}>Apply provider change</button></section>}
    </div>
  </Modal>;
}

export default function App() {
  const [state, setState] = useState(null);
  const [activity, setActivity] = useState(null), [activityError, setActivityError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [folder, setFolder] = useState('inbox');
  const [category, setCategory] = useState('all');
  const [query, setQuery] = useState('');
  const [searchResult, setSearchResult] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [detailRetry, setDetailRetry] = useState(0);
  const [detail, setDetail] = useState(null), [detailError, setDetailError] = useState(''), [draftToOpen, setDraftToOpen] = useState(null);
  const [mobileReading, setMobileReading] = useState(false);
  const [mailLayout, setMailLayout] = useState(() => { try { const saved = storage.getItem('morrow.mail.layout'); return ['right', 'bottom', 'focus'].includes(saved) ? saved : 'right'; } catch { return 'right'; } });
  const [isNarrow, setIsNarrow] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [page, setPage] = useState('mail');
  const [settingsTab, setSettingsTab] = useState('general');
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [calendarDirty, setCalendarDirty] = useState(false);
  const [calendarBusy, setCalendarBusy] = useState(false);
  const [studioDirty, setStudioDirty] = useState(false);
  const [studioBusy, setStudioBusy] = useState(false);
  const [studioSelectedId, setStudioSelectedId] = useState(null);
  const [studioInitialTab, setStudioInitialTab] = useState('tools');
  const settingsOpen = page === 'settings';
  const [compose, setCompose] = useState(null);
  const [organizing, setOrganizing] = useState(null);
  const [readerAI, setReaderAI] = useState(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [aiResult, setAiResult] = useState(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState('');
  const [aiPrompt, setAiPrompt] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [pendingIds, setPendingIds] = useState(new Set());
  const [toast, setToast] = useState(null);
  const accountVersion = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const syncLock = useRef(false);
  const preferences = { ...DEFAULT_PREFERENCES, ...state?.settings.preferences };
  const policy = state?.settings.policy || DEFAULT_POLICY;
  const aiRequest = useRef(0);
  const toastTimeout = useRef(null);
  const searchInput = useRef(null);

  const notify = useCallback((message, type = 'success') => { setToast({ message, type }); window.clearTimeout(toastTimeout.current); toastTimeout.current = window.setTimeout(() => setToast(null), 5000); }, []);
  const applyState = useCallback(next => {
    const previous = stateRef.current;
    const changedAccount = previous && (previous.account.mode !== next.account.mode || previous.account.email !== next.account.email);
    accountVersion.current += 1; aiRequest.current += 1;
    setState(next); setAiResult(null); setAiBusy(false); setAiError('');
    if (changedAccount) { setDetail(null); setDraftToOpen(null); setFolder('inbox'); setCategory('all'); setQuery(''); setSearchResult(null); setSelectedId(null); setStudioSelectedId(null); setMobileReading(false); setCompose(null); }
  }, []);
  useEffect(() => {
    if (!state) return;
    let active = true, timer;
    const controller = new AbortController();
    const poll = async () => {
      if (!document.hidden) {
        try { const next = await api('/activity', { signal: controller.signal }); if (active) { setActivity(next); setActivityError(''); } }
        catch { if (active) setActivityError('Activity could not be refreshed. Last known status may be out of date.'); }
      }
      if (active) timer = window.setTimeout(poll, 2000);
    };
    poll();
    return () => { active = false; window.clearTimeout(timer); controller.abort(); };
  }, [!!state]);
  const load = useCallback(async () => {
    setLoading(true); setLoadError('');
    try {
      let next = await api('/state');
      if (next.account.id === 'demo' && next.accounts.length) next = await api('/account/select', { method: 'POST', body: JSON.stringify({ accountId: next.accounts[0].id }) });
      applyState(next);
    } catch (cause) { setLoadError(cause.message); } finally { setLoading(false); }
  }, [applyState]);
  useEffect(() => {
    load();
    const params = new URLSearchParams(window.location.search);
    if (params.has('connected')) notify('Your mailbox is connected. Welcome to a calmer inbox.');
    if (params.has('connectionError')) notify(params.get('connectionError') || 'Mailbox connection failed. Please try again.', 'error');
    if (params.has('calendarConnected')) { notify('Your calendar is connected.'); setPage('calendar'); }
    if (params.has('calendarError')) { notify(params.get('calendarError') || 'Calendar connection failed.', 'error'); setPage('settings'); setSettingsTab('calendar'); }
    if (['connected', 'connectionError', 'calendarConnected', 'calendarError'].some(key => params.has(key))) { for (const key of ['connected', 'connectionError', 'calendarConnected', 'calendarError']) params.delete(key); window.history.replaceState({}, '', `${window.location.pathname}${params.size ? `?${params}` : ''}`); }
    return () => window.clearTimeout(toastTimeout.current);
  }, [load, notify]);
  useEffect(() => { aiRequest.current += 1; setAiBusy(false); setAiResult(null); }, [JSON.stringify(policy)]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => { document.documentElement.dataset.theme = preferences.theme === 'system' ? (media.matches ? 'dark' : 'light') : preferences.theme; };
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [preferences.theme]);
  useEffect(() => {
    if (!state || compose || organizing || settingsOpen || calendarBusy || calendarDirty || studioBusy || studioDirty || aiBusy || syncing || pendingIds.size) return;
    let active = true, pending = false;
    // The service owns provider polling; clients only refresh their visible account.
    const timer = window.setInterval(async () => {
      if (pending || document.hidden) return;
      pending = true;
      const version = accountVersion.current;
      try { const stamp = await api('/state/revision'); if (stamp.revision === stateRef.current.revision && stamp.accountId === stateRef.current.account.id) return; const next = await api('/state'); if (active && version === accountVersion.current) applyState(next); }
      catch { /* The manual refresh path exposes connection failures. */ }
      finally { pending = false; }
    }, 30000);
    return () => { active = false; window.clearInterval(timer); };
  }, [!!state, state?.account.id, compose, organizing, settingsOpen, calendarBusy, calendarDirty, studioBusy, studioDirty, aiBusy, syncing, pendingIds.size]);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const update = () => setIsNarrow(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    function shortcut(event) {
      if (readerAI) return;
      const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
      if ((event.ctrlKey || event.metaKey) && !compose && !settingsBusy && !calendarBusy && !studioBusy && !syncing) {
        const key = event.key.toLowerCase();
        if (key === 'n') { event.preventDefault(); if (!hasMailbox) setSettingsOpen(true, 'mail'); else if (navigate('mail')) setCompose({}); }
        if (key === 'f') { event.preventDefault(); if (navigate('mail')) searchInput.current?.focus(); }
        if (key === ',') { event.preventDefault(); setSettingsOpen(true); }
        if (key === 'r') { event.preventDefault(); if (event.shiftKey) { if (page === 'mail' && selected?.folder !== 'drafts') reply(); } else sync(); }
        if (['1', '2', '3'].includes(key)) { event.preventDefault(); if (key === '1') changeFolder('inbox'); else if (key === '2') openStudio(); else navigate('calendar'); }
      }
      if (event.key === '/' && !editing && page === 'mail' && !compose) { event.preventDefault(); searchInput.current?.focus(); }
      if (event.key === 'Escape') { setSidebarOpen(false); if (!settingsOpen && !compose) setAssistantOpen(false); }
    }
    document.addEventListener('keydown', shortcut); return () => document.removeEventListener('keydown', shortcut);
  });

  const hasMailbox = !!state?.accounts.length && state.account.id !== 'demo';
  const messages = hasMailbox ? state.messages : [];
  const mail = useMailPage(hasMailbox && page !== 'today' ? state.account.id : null, state?.revision, { folder, category, sort: preferences.sort });
  const filtered = hasMailbox ? searchResult?.messages ?? mail.messages : [];
  const selectedRow = filtered.find(message => messageKey(message) === selectedId) ||
    (detail && (!selectedId || messageKey(detail) === selectedId) && !searchResult && (state?.account.id === detail.accountId || state?.account.id === 'all' && state.accounts.some(a => a.id === detail.accountId)) && (folder === 'starred' ? detail.starred && !['trash', 'spam'].includes(detail.folder) : detail.folder === folder) && (category === 'all' || detail.category === category) ? detail : filtered[0]) || null;
  const detailLoaded = !!selectedRow && messageKey(detail) === messageKey(selectedRow);
  const selected = detailLoaded ? { ...selectedRow, ...detail } : selectedRow;
  const unread = (state?.accounts || []).filter(item => state.account.id === 'all' || item.id === state.account.id).reduce((sum, item) => sum + item.unread, 0);
  useEffect(() => {
    setDetailError('');
    if (page === 'today' || !selectedRow) return;
    const controller = new AbortController();
    api('/messages/' + encodeURIComponent(selectedRow.id), { account: selectedRow.accountId, signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) { setDetail(result.message); if (draftToOpen === messageKey(result.message)) { setCompose(result.message); setDraftToOpen(null); } } })
      .catch(cause => { if (!controller.signal.aborted) { setDetail(null); setDetailError(cause.message); setDraftToOpen(null); } });
    return () => controller.abort();
  }, [selectedRow?.viewId, state?.revision, draftToOpen, detailRetry, page]);
  const currentFolder = folders.find(item => item.id === folder);
  const selectedIndex = filtered.findIndex(message => messageKey(message) === messageKey(selected));
  const localUpdate = useCallback(() => {
    const version = accountVersion.current;
    api('/state', { account: stateRef.current.account }).then(next => { if (version === accountVersion.current) setState(next); }).catch(cause => notify(cause.message, 'error'));
  }, [notify]);

  const patch = useCallback(async (message, changes, silent = false) => {
    const version = accountVersion.current;
    setPendingIds(previous => new Set([...previous, messageKey(message)]));
    try {
      const result = await api(`/messages/${encodeURIComponent(message.id)}`, { account: message.accountId, method: 'PATCH', body: JSON.stringify(changes) });
      if (version !== accountVersion.current) return;
      setDetail(previous => messageKey(previous) === messageKey(result.message) ? result.message : previous);
      localUpdate();
      if (!silent && changes.folder) notify(changes.folder === 'archive' ? 'Moved to Archive on this device.' : changes.folder === 'trash' ? 'Moved to Trash on this device.' : 'Moved to Inbox on this device.');
    } catch (cause) { if (version === accountVersion.current) notify(cause.message, 'error'); }
    finally { setPendingIds(previous => { const next = new Set(previous); next.delete(messageKey(message)); return next; }); }
  }, [localUpdate, notify, state?.account.email, state?.account.mode]);

  useEffect(() => {
    if (page === 'mail' && preferences.markReadOnOpen && selected && !selected.read && selected.folder !== 'drafts' && (!isNarrow || mobileReading)) {
      patch(selected, { read: true }, true);
    }
    setAiResult(previous => previous?.messageId && previous.viewId !== messageKey(selected) ? null : previous);
    setAiError(''); aiRequest.current += 1; setAiBusy(false);
  }, [selected?.viewId, state?.account.email, mobileReading, isNarrow, page, preferences.markReadOnOpen]);

  function navigate(next) {
    if (page === 'settings' && next !== page) {
      if (settingsBusy) { notify('Wait for the current settings operation to finish.', 'error'); return false; }
      if (settingsDirty && !window.confirm('Discard your unsaved settings changes?')) return false;
      setSettingsDirty(false);
    }
    if (page === 'calendar' && next !== page) {
      if (calendarBusy) { notify('Wait for the calendar operation to finish.', 'error'); return false; }
      if (calendarDirty && !window.confirm('Discard your unsaved calendar event?')) return false;
      setCalendarDirty(false);
    }
    if (page === 'studio' && next !== page) {
      if (studioBusy) { notify('Wait for AI Studio to finish.', 'error'); return false; }
      if (studioDirty && !window.confirm('Discard unsaved AI Studio changes?')) return false;
      setStudioDirty(false);
    }
    setPage(next); setSidebarOpen(false); return true;
  }
  function setSettingsOpen(open, tab = 'general') { if (open) setSettingsTab(tab === 'permissions' ? 'policy' : tab); navigate(open ? 'settings' : 'mail'); }
  function openStudio(tab = 'tools') { if (navigate('studio')) { setStudioInitialTab(tab === 'summaries' ? 'summaries' : 'tools'); setStudioSelectedId(tab !== 'summaries' && selected ? messageKey(selected) : null); } }
  function allowed(action, message = null) { return (state?.account.id !== 'all' || !!message) && policy.enabled && policy.behaviors[action] && (!message || policy.folders[message.folder]) && (action === 'write' || (['subject', 'body', 'sender'].some(field => policy.content[field]) && (message || Object.values(policy.folders).some(Boolean)))); }
  function changeFolder(next) { if (!navigate('mail')) return; setDetail(null); setDraftToOpen(null); setFolder(next); setCategory('all'); setQuery(''); setSearchResult(null); setSelectedId(null); setMobileReading(false); setSidebarOpen(false); }
  function selectMessage(message) { setSelectedId(messageKey(message)); setMobileReading(true); if (message.folder === 'drafts') setDraftToOpen(messageKey(message)); }
  function reply(body = '', all = false) { if (selected && detailLoaded) setCompose(replyDraft(selected, { body, all })); }
  function forward() { if (selected && detailLoaded) setCompose(forwardDraft(selected)); }
  async function sync(automatic = false) {
    if (syncLock.current || !hasMailbox) return;
    syncLock.current = true;
    const version = accountVersion.current; setSyncing(true);
    try { const next = await api('/sync', { account: state.account, method: 'POST' }); if (version === accountVersion.current) { setState(next); if (next.syncErrors?.length) notify(`Could not sync: ${next.syncErrors.map(item => item.accountId).join(', ')}. Check Settings.`, 'error'); else if (!automatic) notify(state.account.mode === 'demo' ? 'Your demo inbox is up to date.' : 'Recent mail refreshed. See Activity and Mail settings for older-mail import progress.'); } } catch (cause) { notify(cause.message, 'error'); } finally { syncLock.current = false; setSyncing(false); }
  }
  async function askAI(action, prompt = '') {
    if (aiBusy || !allowed(action, action === 'ask' ? null : selected)) return;
    const request = ++aiRequest.current;
    const messageId = action === 'ask' ? undefined : selected?.id;
    if (action !== 'ask' && !messageId) return;
    setAssistantOpen(true); setAiBusy(true); setAiError(''); setAiResult(null);
    try {
      const result = await api('/ai', { account: action === 'ask' ? state.account : selected.accountId, method: 'POST', body: JSON.stringify({ action, messageId, prompt }) });
      if (request === aiRequest.current) setAiResult({ ...result, action, messageId, viewId: messageKey(selected), prompt });
    } catch (cause) { if (request === aiRequest.current) setAiError(cause.message); }
    finally { if (request === aiRequest.current) setAiBusy(false); }
  }
  function sent() { localUpdate(); }
  async function preference(key, value) {
    const version = accountVersion.current;
    try { const next = await api('/settings/preferences', { account: state.account, method: 'POST', body: JSON.stringify({ [key]: value }) }); if (version === accountVersion.current) setState(next); }
    catch (error) { notify(error.message, 'error'); }
  }
  async function selectAccount(accountId, nextFolder = 'inbox', nextPage = 'mail') {
    if (syncLock.current || syncing || settingsBusy || pendingIds.size || compose || !navigate(nextPage)) return;
    if (accountId === state.account.id) { if (nextPage === 'mail') changeFolder(nextFolder); return; }
    syncLock.current = true; setSyncing(true);
    try { applyState(await api('/account/select', { method: 'POST', body: JSON.stringify({ accountId }) })); setFolder(nextFolder); setSidebarOpen(false); }
    catch (cause) { notify(cause.message, 'error'); }
    finally { syncLock.current = false; setSyncing(false); }
  }


  if (loading || !state) return <div className="startup"><img className="startup-brand" src="/brand/morrow-icon.svg" alt="Morrow Mail" /><h1>morrow<span>.</span></h1>{loading ? <><LoaderCircle className="spinning" size={22} /><p>A little more headspace is on its way.</p></> : <><p role="alert">{loadError || 'We couldn’t load your workspace.'}</p><button className="button primary" onClick={load}><RefreshCw size={16} />Try again</button></>}<span className="startup-caption">YOUR INBOX. YOUR TERMS.</span></div>;

  return <div className={`app-shell ${sidebarOpen ? 'nav-open' : ''}`} data-density={preferences.density}>
    {sidebarOpen && <button className="nav-backdrop" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}
    <aside className="sidebar" aria-label="Mailbox navigation">
      <a href="#" className="brand" onClick={event => { event.preventDefault(); changeFolder('inbox'); }}><img className="brand-image" src="/brand/morrow-icon.svg" alt="" /><span>morrow<span className="brand-dot">.</span></span><span className="open-tag">OPEN</span></a>
      <button className="compose-button" disabled={settingsBusy || !hasMailbox} onClick={() => { setCompose({}); setSidebarOpen(false); }}><Pencil size={18} />Compose<span><Plus size={16} /></span></button>
      <div className="nav-label">WORKSPACE</div>
      <button className={`nav-item today-nav ${page === 'today' ? 'active' : ''}`} onClick={() => navigate('today')} aria-current={page === 'today' ? 'page' : undefined}><CalendarDays size={19} /><span>Today</span></button>
      <button className={`nav-item studio-nav ${page === 'studio' ? 'active' : ''}`} onClick={openStudio} aria-current={page === 'studio' ? 'page' : undefined}><Sparkles size={19} /><span>AI Studio</span><span className="tiny-tag">{AI_BEHAVIORS.length}</span></button>
      <button className={`nav-item ${page === 'calendar' ? 'active' : ''}`} onClick={() => navigate('calendar')} aria-current={page === 'calendar' ? 'page' : undefined}><CalendarDays size={19} /><span>Calendar</span></button>
      <button className={`nav-item assistant-nav ${assistantOpen ? 'selected' : ''}`} disabled={!hasMailbox} onClick={() => { if (navigate('mail')) setAssistantOpen(previous => !previous); }}><Sparkles size={19} /><span>AI assistant</span><span className="tiny-tag">AI</span></button>
      <div className="nav-label">ACCOUNTS</div>
      <nav aria-label="Account views" className="account-groups">
        {[...(state.accounts.length ? [{ id: 'all', email: 'All accounts', provider: 'Combined mail' }] : []), ...state.accounts].map(account => <AccountGroup key={account.id} account={account} active={state.account.id === account.id}>
          {folders.map(item => {
            const Icon = item.icon;
            const count = account.id === 'all' ? state.accounts.reduce((total, row) => total + (item.id === 'inbox' ? row.unread : row.counts?.[item.id] || 0), 0) : item.id === 'inbox' ? account.unread : account.counts?.[item.id] || 0;
            const active = state.account.id === account.id && page === 'mail' && folder === item.id;
            return <button key={item.id} className={`nav-item ${active ? 'active' : ''}`} disabled={syncing || settingsBusy || pendingIds.size > 0} onClick={() => selectAccount(account.id, item.id)} aria-current={active ? 'page' : undefined}><Icon size={16} /><span>{item.name}</span>{['inbox', 'drafts'].includes(item.id) && count > 0 && <span className="nav-count">{count}</span>}</button>;
          })}
        </AccountGroup>)}
      </nav>
      <button className="nav-item" onClick={() => setSettingsOpen(true, 'mail')}><Plus size={18} /><span>Add account</span></button>
      <div className="sidebar-divider" />
      <div className="sidebar-bottom"><div className="local-card"><div className="local-card-icon"><Leaf size={18} /></div><strong>A calmer kind of email.</strong><p>Open source. Local first.<br />Always on your terms.</p><div className="local-status"><span />Your workspace, your device</div></div>
        <button className="sidebar-settings" onClick={() => { setSettingsOpen(true); setSidebarOpen(false); }}><SettingsIcon size={18} /><span>Settings & connections</span></button>
        <button className="account-button" onClick={() => { setSettingsOpen(true); setSidebarOpen(false); }}><Avatar name={preferences.displayName || (hasMailbox ? state.account.name || state.account.email : 'Morrow Mail')} /><span className="account-text"><strong>{preferences.displayName || (hasMailbox ? state.account.name || state.account.email.split('@')[0] : 'Morrow Mail')}</strong><small>{!hasMailbox ? 'Add an account' : state.account.id === 'all' ? `${state.accounts.length} connected accounts` : state.account.email}</small></span><ChevronDown size={15} /></button>
      </div>
    </aside>

    <main className="workspace">
      <header className="topbar"><div className="breadcrumbs"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setSidebarOpen(true)}><Menu size={20} /></button><span className="breadcrumb-home">Workspace</span><ChevronRight size={13} /><strong>{page === 'today' ? 'Today' : page === 'settings' ? 'Settings' : page === 'studio' ? 'AI Studio' : page === 'calendar' ? 'Calendar' : currentFolder.name}</strong></div><div className="topbar-right"><span className={`mode-badge ${state.account.mode}`}><span />{page === 'calendar' ? 'Live calendars' : !hasMailbox ? 'No mailbox selected' : 'Connected'}</span><button className="topbar-sync" aria-label="Sync mail" onClick={() => sync()} disabled={!hasMailbox || syncing || settingsBusy || pendingIds.size > 0}><RefreshCw size={14} className={syncing ? 'spinning' : ''} /><span>{syncing ? 'Syncing…' : 'Sync mail'}</span></button><span className="topbar-separator" /><IconButton icon={SettingsIcon} label="Settings and connections" onClick={() => setSettingsOpen(true)} /></div></header>
      <div style={{ padding: '0 20px', borderBottom: '1px solid var(--border)' }}><ActivityStatus value={activity} error={activityError} onOpenSettings={() => setSettingsOpen(true, 'mail')} /></div>
      {page === 'settings' ? <Settings page initialTab={settingsTab} state={state} onClose={() => { setSettingsDirty(false); setPage('mail'); setFolder('inbox'); setCategory('all'); setQuery(''); setSearchResult(null); setSelectedId(null); setMobileReading(false); }} onUpdate={applyState} notify={notify} onDirtyChange={setSettingsDirty} onBusyChange={setSettingsBusy} /> : page === 'calendar' ? <Calendar onNotify={notify} onOpenSettings={() => setSettingsOpen(true, 'calendar')} onDirtyChange={setCalendarDirty} onBusyChange={setCalendarBusy} /> : page === 'today' ? <Dashboard state={state} busy={syncing || pendingIds.size > 0} onSelectAccount={accountId => selectAccount(accountId, 'inbox', 'today')} onSettings={tab => setSettingsOpen(true, tab)} onStudio={() => openStudio('summaries')} onInbox={unreadOnly => { changeFolder('inbox'); if (unreadOnly) { setQuery('is:unread'); setSearchResult({ messages: [], waiting: true }); } }} /> : !hasMailbox ? <div className="reader-empty"><Mail size={42} /><h2>{state.accounts.length ? 'Choose a mailbox' : 'Add your first account'}</h2><p>Connect Gmail, Outlook, or an IMAP account to start reading your mail.</p><button className="button primary" onClick={() => setSettingsOpen(true, 'mail')}><Plus size={16} />Add account</button></div> : page === 'studio' ? state.account.id === 'all' ? <div className="page-heading"><div><h1>Choose an account.</h1><p>Select a mailbox in the sidebar to use its AI Studio. Each account has its own context, skills, and activity.</p></div></div> : <Studio key={state.account.id} initialTab={studioInitialTab} onDirtyChange={setStudioDirty} onBusyChange={setStudioBusy} state={state} selectedMessage={selected && messageKey(selected) === studioSelectedId ? selected : messages.find(message => messageKey(message) === studioSelectedId) || null} onUpdate={applyState} onCompose={setCompose} onSettings={tab => setSettingsOpen(true, tab)} notify={notify} /> : <>
      <div className="page-heading"><div><div className="eyebrow"><span />A LITTLE MORE HEADSPACE</div><h1>{currentFolder.name}<span className="heading-period">.</span></h1><p>{folder === 'inbox' ? unread ? `You have ${unread} unread ${unread === 1 ? 'message' : 'messages'}. Let’s make room for what matters.` : 'You’re all caught up. Make room for what matters.' : folder === 'starred' ? 'The conversations you want to keep close.' : folder === 'drafts' ? 'Good things start with a few words.' : folder === 'sent' ? 'Thoughts shared. Conversations started.' : folder === 'archive' ? 'Out of the way. Always here when you need them.' : 'A little room to let things go.'}</p></div><button className={`button assistant-toggle ${assistantOpen ? 'is-active' : ''}`} aria-label="Ask your inbox" onClick={() => setAssistantOpen(previous => !previous)} aria-expanded={assistantOpen}><Sparkles size={17} /><span>Ask your inbox</span><span className="keyboard-hint">AI</span></button></div>
      <div className={`mail-workspace layout-${mailLayout} ${mobileReading ? 'show-reader' : ''} ${assistantOpen ? 'with-assistant' : ''}`}>
        <section className="message-pane" aria-label="Messages">
          <MailSearch key={state.account.id + ':' + folder} api={api} account={state.account.id} folder={folder} query={query} setQuery={setQuery} inputRef={searchInput} revision={state.revision} onResult={setSearchResult} onSettings={() => setSettingsOpen(true, 'search')} />
          <div hidden={!!searchResult} className="category-tabs" role="group" aria-label="Message category">{categories.map(item => <button key={item.id} className={category === item.id ? 'active' : ''} aria-pressed={category === item.id} onClick={() => { setCategory(item.id); setSelectedId(null); setDetail(null); }}>{item.name}</button>)}</div>
          <div className="mail-layout-control"><label>Reading layout <select value={mailLayout} onChange={event => { setMailLayout(event.target.value); try { storage.setItem("morrow.mail.layout", event.target.value); } catch { /* This session still uses the chosen layout. */ } }}><option value="right">Reader on right</option><option value="bottom">Reader below</option><option value="focus">Focused reading</option></select></label></div>
          <div className="list-meta"><span>{filtered.length} {filtered.length === 1 ? 'conversation' : 'conversations'}</span><select disabled={!!searchResult} aria-label="Sort messages" value={preferences.sort} onChange={event => { setSelectedId(null); setDetail(null); preference('sort', event.target.value); }}>{[['newest', 'Newest first'], ['oldest', 'Oldest first'], ['sender', 'Sender A–Z'], ['subject', 'Subject A–Z'], ['unread', 'Unread first'], ['starred', 'Starred first']].map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select><select aria-label="Inbox density" value={preferences.density} onChange={event => preference('density', event.target.value)}>{['compact', 'comfortable', 'spacious'].map(value => <option key={value}>{value}</option>)}</select></div>
          <div className="message-list" aria-busy={!searchResult && mail.loading}>
            {!searchResult && mail.error && <p role="alert">{mail.error}</p>}
            {filtered.length ? filtered.map(message => <article key={messageKey(message)} className={`message-row ${messageKey(selected) === messageKey(message) ? 'selected' : ''} ${!message.read ? 'unread' : ''}`}>
              <button className="message-select" onClick={() => selectMessage(message)} aria-label={`${message.read ? '' : 'Unread: '}${message.fromName}, ${message.subject}`} aria-current={messageKey(selected) === messageKey(message) ? 'true' : undefined}>
                <div className="message-row-top"><Avatar name={message.fromName} /><span className="message-sender">{message.folder === 'sent' || message.folder === 'drafts' ? `To: ${message.to || 'New recipient'}` : message.fromName}</span><time dateTime={message.date}>{shortDate(message.date)}</time><span className="unread-indicator">{!message.read && <span className="unread-dot" aria-label="Unread" />}</span></div>
                <div className="message-row-content">{(state.account.id === 'all' || searchResult) && <small className="mailbox-label">{message.accountId}</small>}<h3><SearchHighlight segments={message.searchSubject} fallback={message.subject || '(No subject)'} /></h3><p><SearchHighlight segments={message.searchSnippet} fallback={message.preview || message.body || 'An empty page, ready for your words.'} /></p>{message.searchMatch && <small className="search-match">{message.folder} · {message.searchMatch}</small>}<div className="message-row-bottom"><span className={`category-label ${message.category}`}><span />{message.category === 'primary' ? 'Primary' : message.category === 'updates' ? 'Updates' : 'Newsletter'}</span></div></div>
              </button>
              <button className={`message-star ${message.starred ? 'starred' : ''}`} aria-label={message.starred ? 'Remove star' : 'Star message'} title={message.starred ? 'Remove star' : 'Star message'} onClick={() => patch(message, { starred: !message.starred }, true)} disabled={pendingIds.has(messageKey(message)) || syncing}><Star size={15} fill={message.starred ? 'currentColor' : 'none'} /></button>
            </article>) : <div className="list-empty"><Search size={27} strokeWidth={1.4} /><h3>{query ? 'No matches, just yet.' : 'A little breathing room.'}</h3><p>{query ? 'Try a different name or keyword.' : category !== 'all' ? 'No messages in this category.' : `Your ${currentFolder.name.toLowerCase()} is empty.`}</p>{(query || category !== 'all') && <button className="button secondary" onClick={() => { setQuery(''); setCategory('all'); }}>Clear filters</button>}</div>}
          </div><div className="list-footer">{!searchResult && <><button disabled={!mail.previous || mail.loading} onClick={() => { setSelectedId(null); setDetail(null); mail.previous(); }}>Previous</button><span aria-live="polite">{mail.loading ? 'Loading…' : `Page ${mail.page} · ${mail.total} messages`}</span><button disabled={!mail.next || mail.loading} onClick={() => { setSelectedId(null); setDetail(null); mail.next(); }}>Next</button></>}</div>
        </section>
        <section className="reader-pane" aria-label="Message detail">
          {selected ? <>
            <div className="reader-toolbar"><div>{/^(google|microsoft|imap):/.test(selected.remoteId || selected.id) && <button className="button ghost" disabled={syncing || pendingIds.has(messageKey(selected))} onClick={() => setOrganizing(selected)}>Move / Labels / Spam</button>}<button className={`icon-button reader-back ${mailLayout === "focus" ? "focus-back" : ""}`} aria-label="Back to messages" onClick={() => setMobileReading(false)}><ArrowLeft size={18} /></button><IconButton icon={selected.folder === 'archive' || selected.folder === 'trash' ? Inbox : Archive} label={selected.folder === 'archive' || selected.folder === 'trash' ? 'Move to inbox locally' : 'Archive locally'} onClick={() => patch(selected, { folder: selected.folder === 'archive' || selected.folder === 'trash' ? 'inbox' : 'archive' })} disabled={pendingIds.has(messageKey(selected)) || syncing || selected.folder === 'drafts' || selected.folder === 'sent'} /><IconButton icon={Trash2} label="Move to trash locally" onClick={() => patch(selected, { folder: 'trash' })} disabled={pendingIds.has(messageKey(selected)) || syncing || selected.folder === 'trash'} /><span className="toolbar-divider" /><IconButton icon={selected.read ? Mail : MailOpen} label={selected.read ? 'Mark unread locally' : 'Mark read locally'} onClick={() => patch(selected, { read: !selected.read }, true)} disabled={pendingIds.has(messageKey(selected)) || syncing} /><button className={`icon-button ${selected.starred ? 'starred' : ''}`} title={selected.starred ? 'Remove star' : 'Star message'} aria-label={selected.starred ? 'Remove star' : 'Star message'} onClick={() => patch(selected, { starred: !selected.starred }, true)} disabled={pendingIds.has(messageKey(selected)) || syncing}><Star size={18} fill={selected.starred ? 'currentColor' : 'none'} /></button></div><div className="reader-pagination"><span>{selectedIndex + 1} of {filtered.length}</span><IconButton icon={ChevronLeft} label="Previous message" disabled={selectedIndex <= 0} onClick={() => setSelectedId(messageKey(filtered[selectedIndex - 1]))} /><IconButton icon={ChevronRight} label="Next message" disabled={selectedIndex >= filtered.length - 1} onClick={() => setSelectedId(messageKey(filtered[selectedIndex + 1]))} /></div></div>
            <div className="reader-content" key={messageKey(selected)}><ReaderHeader message={selected} />
              {selected.aiSummary ? <ReaderSummary title={`${selected.aiSummary.source === 'demo' ? 'Demo summary' : 'AI summary'}${selected.aiSummary.items?.[0]?.priority ? ` · ${selected.aiSummary.items[0].priority}` : ''}`} text={selected.aiSummary.items?.[0]?.summary} metadata={`${fullDate(selected.aiSummary.completedAt)} · Review AI priorities.`} /> : detailLoaded && selectedId === messageKey(selected) && (!isNarrow || mobileReading) && <AutomaticAssistance compact messageId={selected.id} account={selected.accountId} trigger="onOpen" policy={policy} modelKey={JSON.stringify([state.settings.ai, state.settings.preferences])} />}
              <div className="message-content">{detailError ? <span role="alert">{detailError} <button onClick={() => setDetailRetry(value => value + 1)}>Retry loading message</button></span> : !detailLoaded ? <span role="status">Loading message…</span> : <MessageBody key={messageKey(selected)} message={selected} />}</div>
              <FooterPreview footer={selected.footer} />
              <div className="message-end"><span /><Leaf size={14} /><span /></div>
              <div className="reply-actions">{selected.folder === 'drafts' ? <button className="button primary" disabled={!detailLoaded} onClick={() => setCompose({ ...selected })}><Pencil size={16} />{selected.providerDraft ? 'Copy to local draft' : 'Continue writing'}</button> : <><button className="button primary" disabled={!detailLoaded} onClick={() => reply()}><ArrowDownLeft size={17} />Reply</button><button className="button secondary" disabled={!detailLoaded} onClick={() => reply('', true)}><ReplyAll size={17} />Reply all</button><button className="button secondary" disabled={!detailLoaded} onClick={forward}><ArrowRight size={17} />Forward</button></>}</div>
              <div className="reader-ai-actions" role="group" aria-label="AI for this message">
                <Sparkles size={15} aria-hidden="true" />
                {[['summary', 'Summarize', false], ...(selected.folder !== 'drafts' ? [['reply', 'Suggest reply', false], ['reply', 'Suggest with History', true]] : []), ['translate', 'Translate', false]].map(([action, label, includeHistory]) => <button key={label} type="button" className="button ghost" disabled={!detailLoaded || aiBusy || !allowed(action, selected) || (includeHistory && (!policy.content.sender || !selected.fromEmail))} title={includeHistory ? 'Use permitted downloaded mail from this sender; review scope before generating.' : undefined} onClick={() => setReaderAI({ action, includeHistory })}>{label}</button>)}
              </div>
              <p className="message-privacy"><ShieldCheck size={13} />Your words. Your final say. Nothing sends automatically.</p>
            </div>
          </> : <div className="reader-empty"><div className="empty-art"><Mail size={42} strokeWidth={1} /><span><Leaf size={16} /></span></div><span className="eyebrow">ROOM TO BREATHE</span><h2>Less noise.<br />More possibility.</h2><p>{query ? 'Your next conversation is just a search away.' : 'Choose a conversation, or start a new one.'}</p><button className="button secondary" onClick={() => setCompose({})}><Plus size={16} />Write something good</button></div>}
        </section>
        {assistantOpen && <aside className="assistant-pane" aria-label="AI assistant"><div className="assistant-header"><div><span className="assistant-logo"><Sparkles size={19} /></span><strong>A little assistance</strong></div><IconButton icon={X} label="Close AI assistant" onClick={() => setAssistantOpen(false)} /></div><div className="assistant-scroll"><div className="assistant-intro"><span className="eyebrow">YOUR INBOX, IN FOCUS</span><h2>Let’s lighten<br />the load.</h2><p>Find the important bits.<br />Find the words. Find your flow.</p><span className={`ai-mode ${state.settings.ai.configured ? 'configured' : ''}`}><span />{state.settings.ai.configured ? state.settings.ai.model : state.account.mode === 'demo' ? 'Demo AI · illustrative responses' : 'Choose an AI model in Settings'}</span></div>
          <div className="assistant-suggestions"><button disabled={!selected || aiBusy || !allowed('summary', selected)} onClick={() => askAI('summary')}><Mail size={16} /><span>Summarize this message</span><ArrowRight size={14} /></button><button disabled={!selected || aiBusy || !allowed('reply', selected)} onClick={() => askAI('reply')}><Pencil size={16} /><span>Help me write a reply</span><ArrowRight size={14} /></button><button disabled={aiBusy || !allowed('ask')} onClick={() => { const prompt = 'What needs my attention in my inbox?'; setAiPrompt(prompt); askAI('ask', prompt); }}><CheckCheck size={16} /><span>What needs my attention?</span><ArrowRight size={14} /></button></div>
          {(!allowed('ask') || (selected && (!allowed('summary', selected) || !allowed('reply', selected)))) && <div className="policy-notice"><ShieldCheck size={15} /><span>Some AI actions are disabled by your permissions.</span><button onClick={() => setSettingsOpen(true, 'policy')}>Manage</button></div>}
          <button className="assistant-studio-link" onClick={openStudio}>Explore all {AI_BEHAVIORS.length} tools in AI Studio<ArrowRight size={14} /></button>
          {aiBusy && <div className="ai-loading" role="status"><Sparkles size={18} className="pulse" /><span>Making a little room for clarity…</span></div>}
          {aiError && <div className="ai-error" role="alert"><p>{aiError}</p><button className="button secondary" onClick={() => setSettingsOpen(true, 'model')}>AI settings<ArrowRight size={14} /></button></div>}
          {aiResult && <div className="ai-response"><div className="ai-response-title"><Sparkles size={15} /><strong>{aiResult.action === 'reply' ? 'A starting point' : aiResult.action === 'summary' ? 'The important bits' : 'From your inbox'}</strong><span>{aiResult.source === 'demo' ? 'DEMO' : 'AI'}</span></div>{aiResult.prompt && <p className="ai-question">{aiResult.prompt}</p>}<div className="ai-response-text">{aiResult.text}</div>{aiResult.source === 'demo' && <p className="ai-demo-note">Illustrative demo output. Connect a model for real AI responses.</p>}{aiResult.action === 'reply' && aiResult.viewId === messageKey(selected) && <button className="button primary use-draft" onClick={() => reply(aiResult.text)}>Use in a draft<ArrowRight size={15} /></button>}</div>}
        </div><div className="assistant-bottom"><form className="assistant-input" onSubmit={event => { event.preventDefault(); if (aiPrompt.trim()) askAI('ask', aiPrompt.trim()); }}><textarea maxLength={2000} aria-label="Ask about your inbox" placeholder="Ask about your inbox…" rows={2} value={aiPrompt} onChange={event => setAiPrompt(event.target.value)} disabled={aiBusy} /><div><span><Sparkles size={12} />Made for a lighter day</span><button type="submit" aria-label="Ask AI" disabled={aiBusy || !aiPrompt.trim() || !allowed('ask')}><ArrowRight size={17} /></button></div></form><p><ShieldCheck size={11} />AI follows your saved permissions and triggers. Review its answers.</p></div></aside>}
      </div>
      </>}
      <footer className="workspace-footer"><span><span className="footer-dot" />A home for your email. A little space for you.</span><span>Open source, by nature.<Leaf size={12} /></span></footer>
    </main>
    {organizing && <OrganizeMail message={organizing} onClose={() => setOrganizing(null)} onUpdate={localUpdate} />}
    {readerAI && <MessageAI {...readerAI} state={state} message={selected} loaded={page === 'mail' && detailLoaded} onClose={() => setReaderAI(null)} onUse={setCompose} />}
    {compose && <Compose initial={compose} account={state.account} accounts={state.accounts} preferences={preferences} footer={state.settings.footer} policy={policy} modelKey={JSON.stringify(state.settings.ai)} onSettings={() => setSettingsOpen(true, 'policy')} onClose={() => setCompose(null)} onSaved={localUpdate} onSent={sent} notify={notify} />}
    {toast && <div className={`toast ${toast.type}`} role={toast.type === 'error' ? 'alert' : 'status'}>{toast.type === 'error' ? <CircleHelp size={18} /> : <Check size={18} />}<span>{toast.message}</span><button aria-label="Dismiss notification" onClick={() => setToast(null)}><X size={15} /></button></div>}
  </div>;
}
