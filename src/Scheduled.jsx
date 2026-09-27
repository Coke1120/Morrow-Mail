import { useEffect, useRef, useState } from 'react';
import { CalendarDays, RefreshCw } from 'lucide-react';
import { api } from './api';
import FooterPreview from './FooterPreview';

export function scheduledTime(value, now = Date.now()) {
  const time = new Date(value).getTime();
  if (!value || !Number.isFinite(time) || time <= now) throw new Error('Choose a future date and time.');
  return new Date(time).toISOString();
}

export function scheduledReview(draft, owner, value) {
  if (!owner || ['all', 'demo'].includes(owner)) throw new Error('Choose the connected mailbox that owns this draft.');
  return { owner, payload: structuredClone({ requestId: crypto.randomUUID(), sendAt: scheduledTime(value), to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject, body: draft.body, footer: draft.footer, ...(draft.replyToId ? { replyToId: draft.replyToId } : {}), ...(draft.id ? { draftId: draft.id } : {}) }) };
}

export function ScheduledReview({ review, busy, locked, uncertain, onConfirm, onEdit }) {
  return <section className="compose-ai-panel" aria-label="Scheduled send review"><strong>Review scheduled sending</strong>
    <pre>{`From: ${review.owner}\nTo: ${review.payload.to}\nCc: ${review.payload.cc}\nBcc: ${review.payload.bcc}\nSend: ${new Date(review.payload.sendAt).toLocaleString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone})\nSubject: ${review.payload.subject || '(No subject)'}\n\n${review.payload.body}`}</pre>
    <FooterPreview footer={review.payload.footer} />
    <p>Morrow must be open. A delay of up to 15 minutes is allowed; after that the message is marked missed and requires review. This saves the reviewed content and time. Cancel the schedule before changing them.</p>
    <button type="button" className="button primary" disabled={busy || locked} onClick={onConfirm}>{busy ? 'Scheduling…' : uncertain ? 'Retry this schedule request' : 'Confirm schedule'}</button>
    {!uncertain && <button type="button" className="button secondary" disabled={busy} onClick={onEdit}>Edit schedule</button>}
  </section>;
}

export const cancellableSchedule = job => ['scheduled', 'missed', 'blocked'].includes(job.status);
const statusNames = { scheduled: 'Scheduled', sending: 'Sending', sent: 'Sent', cancelled: 'Cancelled', missed: 'Missed — review required', blocked: 'Blocked — review required', uncertain: 'Delivery unconfirmed — check Sent before retrying' };

export function ScheduledRows({ jobs, busy, onCancel, onReview }) {
  return <div className="scheduled-list">{jobs.map(job => { const message = job.payload || job; return <article className="scheduled-message" key={job.id}>
    <div><h2>{message.subject || '(No subject)'}</h2><p className="mailbox-label">{job.accountId}</p>
      <p><time dateTime={job.sendAt}>{new Date(job.sendAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</time> · {statusNames[job.status] || job.status}</p>
      <dl><dt>To</dt><dd>{message.to || '—'}</dd>{message.cc && <><dt>Cc</dt><dd>{message.cc}</dd></>}{message.bcc && <><dt>Bcc</dt><dd>{message.bcc}</dd></>}</dl>
      {job.error && <p role="alert">{job.error}</p>}
    </div>
    <div className="scheduled-actions">
      {cancellableSchedule(job) && <button className="button secondary" disabled={busy} onClick={() => onCancel(job)}>Cancel schedule</button>}
      {(job.status === 'uncertain' || job.requiresSendReview) && <button className="button secondary" disabled={busy || !job.draftId} onClick={() => onReview(job)}>Review unconfirmed draft</button>}
    </div>
  </article>; })}</div>;
}

export default function Scheduled({ state, onUpdate, notify, onBusyChange, onReview }) {
  const [owner, setOwner] = useState(state.account.id === 'all' ? state.accounts[0]?.id || '' : state.account.id);
  const [value, setValue] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  const flight = useRef(false), mounted = useRef(false);
  const connected = state.accounts.some(account => account.id === owner);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => {
    const controller = new AbortController();
    setValue(null); setError('');
    if (!connected) return () => controller.abort();
    setLoading(true);
    api('/scheduled', { account: owner, signal: controller.signal }).then(result => {
      if (!Array.isArray(result.scheduled) || result.scheduled.some(job => job.accountId !== owner)) throw new Error('Scheduled messages could not be loaded for this mailbox.');
      if (!controller.signal.aborted) setValue(result);
    }).catch(cause => { if (!controller.signal.aborted) setError(cause.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [owner, connected, state.revision, revision]);

  async function act(job, cancel) {
    if (flight.current || job.accountId !== owner || !connected) return;
    if (cancel && (!cancellableSchedule(job) || !window.confirm(`Cancel scheduled sending of “${job.payload?.subject || job.subject || '(No subject)'}” from ${owner}? The draft will be retained.`))) return;
    flight.current = true; setBusy(true); setError('');
    try {
      if (cancel) {
        const result = await api(`/scheduled/${encodeURIComponent(job.id)}/cancel`, { account: job.accountId, method: 'POST', body: '{}' });
        if (result.job?.status !== 'cancelled' || result.job.id !== job.id || result.job.accountId !== job.accountId) throw new Error('Cancellation could not be confirmed. Refresh Scheduled before retrying.');
        if (mounted.current) { setRevision(previous => previous + 1); onUpdate(); notify('Schedule cancelled. The draft is retained.'); }
      } else {
        const { message } = await api(`/messages/${encodeURIComponent(job.draftId)}`, { account: job.accountId });
        if (message?.accountId !== owner || message.id !== job.draftId || message.deliveryStatus !== 'unconfirmed') throw new Error('Refresh the scheduled list before reviewing this delivery.');
        if (mounted.current) onReview(message);
      }
    } catch (cause) { if (mounted.current) setError(cause.message); }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  }

  return <section className="scheduled-page" aria-label="Scheduled mail">
    <div className="page-heading"><div><h1>Scheduled<span className="heading-period">.</span></h1><p>Review mail waiting to be sent from this device.</p></div></div>
    <div className="scheduled-controls"><label>Mailbox<select value={owner} disabled={busy} onChange={event => setOwner(event.target.value)}>{state.accounts.map(account => <option key={account.id} value={account.id}>{account.email}</option>)}</select></label><button className="button secondary" disabled={busy || loading || !connected} onClick={() => setRevision(previous => previous + 1)}><RefreshCw size={15} />Refresh</button></div>
    <p className="scheduled-notice"><CalendarDays size={16} />Morrow must be open to send. Mail can be sent up to {value?.lateGraceMinutes ?? 15} minutes late; after that it is marked missed and requires review. Drafts awaiting or currently sending are locked. Cancel an awaiting schedule to edit its draft; sending and unconfirmed deliveries cannot be cancelled.</p>
    {error && <p role="alert" className="inline-error">{error}</p>}
    {!connected ? <p>Choose a connected mailbox to view scheduled mail.</p> : loading ? <p role="status">Loading scheduled mail…</p> : value && !value.scheduled.length ? <p>No scheduled messages in this mailbox.</p> : value && <ScheduledRows jobs={value.scheduled} busy={busy} onCancel={job => act(job, true)} onReview={job => act(job, false)} />}
  </section>;
}
