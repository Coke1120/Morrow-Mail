import { ArrowRight, CalendarDays, Inbox, Settings, Sparkles } from 'lucide-react';

function reportDate(report) {
  const value = report.status === 'completed' ? report.completedAt || report.createdAt : report.createdAt;
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

export function todayReports(reports, now = new Date()) {
  return (Array.isArray(reports) ? reports : []).filter(report => {
    const date = report && reportDate(report);
    return date && date.toDateString() === now.toDateString();
  }).sort((a, b) => reportDate(b) - reportDate(a)).slice(0, 20);
}

const statusLabels = { completed: 'Completed', queued: 'Queued', running: 'Running', failed: 'Failed', interrupted: 'Interrupted', skipped: 'Skipped' };

export default function Dashboard({ state, busy = false, onSelectAccount, onSettings, onStudio, onInbox, now = new Date() }) {
  const accounts = state.accounts.filter(account => account.id !== 'demo');
  const combined = state.account.id === 'all';
  const owner = accounts.find(account => account.id === state.account.id);
  const scope = combined ? accounts : owner ? [owner] : [];
  const reports = owner ? todayReports(state.workspace?.summaries, now) : [];
  const totals = ['unread', 'inbox', 'drafts'].map(key => {
    const values = scope.map(account => key === 'unread' ? account.unread : account.counts?.[key]);
    return values.every(value => Number.isSafeInteger(value) && value >= 0) ? values.reduce((sum, value) => sum + value, 0) : null;
  });
  const dateLabel = now.toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return <section className="dashboard-page" aria-label="Today dashboard" aria-busy={busy}>
    <header className="dashboard-heading"><div><h1><CalendarDays size={25} />Today</h1><p>{dateLabel} · Local time{zone ? ` (${zone})` : ''}</p><p className="dashboard-owner">{combined ? 'All connected mailboxes' : owner?.email || owner?.id || 'Your workspace'}</p></div>{!!scope.length && <div className="dashboard-mail-actions"><button className="button secondary" disabled={busy} onClick={() => onInbox(true)}>Unread Inbox</button><button className="button secondary" disabled={busy} onClick={() => onInbox(false)}><Inbox size={16} />Open Inbox</button></div>}</header>
    {!accounts.length ? <div className="dashboard-empty"><h2>Add your first account</h2><p>Your downloaded mailbox overview and saved AI summaries will appear here.</p><button className="button primary" onClick={() => onSettings('mail')}>Add account</button></div> : <>
      {(combined || !owner || accounts.length > 1) && <nav className="dashboard-accounts" aria-label="Today mailbox">
        <button className="button secondary" aria-pressed={combined} disabled={busy} onClick={() => onSelectAccount('all')}>All accounts</button>
        {accounts.map(account => <button key={account.id} className="button secondary" aria-label={`Show Today for ${account.email || account.id}`} aria-pressed={owner?.id === account.id} disabled={busy} onClick={() => onSelectAccount(account.id)}>{account.email || account.id}</button>)}
      </nav>}
      {!!scope.length && <section aria-label="Downloaded mail overview">
        <dl className="dashboard-totals">{['Unread Inbox', 'Inbox', 'Drafts'].map((label, index) => <div key={label}><dt>{label}</dt><dd>{totals[index] === null ? '—' : totals[index].toLocaleString()}</dd></div>)}</dl>
        <p className="dashboard-note">Downloaded mail totals, not messages received today. Import coverage depends on your saved history range.</p>
      </section>}
      <section className="dashboard-summaries" aria-labelledby="today-summaries-title">
        <div className="dashboard-section-heading"><h2 id="today-summaries-title"><Sparkles size={18} />Today’s summaries</h2><button className="button ghost" disabled={busy} onClick={() => onSettings('policy')}><Settings size={15} />AI permissions</button></div>
        {combined || !owner ? <div className="dashboard-empty"><p>Choose a connected mailbox above to see its summaries. AI summaries stay separate for each account.</p></div> : <>
          <p className="dashboard-note">From the latest 20 available reports. Completed summaries use their completion date, or creation date for older records without one; other jobs use their creation date, in your local time. Viewing this page does not generate AI work.</p>
          {!reports.length ? <div className="dashboard-empty"><h3>No summaries for today</h3><p>Enable arrival or scheduled summaries in AI permissions, or check Summaries in AI Studio for recent history. Results may also be hidden when their source or permissions change.</p></div> : <div className="dashboard-report-list">{reports.map(report => {
            const date = reportDate(report);
            return <article className="dashboard-report" key={report.id}>
              <header><h3>{report.kind === 'arrival' ? 'New-mail summary' : 'Scheduled summary'}</h3><span className="dashboard-report-status">{statusLabels[report.status] || 'Status unavailable'}</span></header>
              <p className="dashboard-note"><time dateTime={date.toISOString()}>{date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</time>{Array.isArray(report.messageIds) && ` · ${report.messageIds.length} ${report.messageIds.length === 1 ? 'message' : 'messages'}`}{report.source === 'demo' && ' · Illustrative demo'}</p>
              {report.status === 'completed' && <div className="dashboard-report-text">{report.text || 'No summary text available.'}</div>}
              {report.status === 'queued' && <p role="status">Waiting for background processing.</p>}
              {report.status === 'running' && <p role="status">AI is preparing this summary.</p>}
              {report.error && <p className="inline-error">{report.error}</p>}
              {!report.error && ['failed', 'interrupted', 'skipped'].includes(report.status) && <p>Summary not completed. Check your model settings and AI permissions; this page does not retry jobs.</p>}
            </article>;
          })}</div>}
          <div className="dashboard-history"><span>Review recent reports in AI Studio → Summaries.</span><button className="button secondary" disabled={busy} onClick={onStudio}>Summary history<ArrowRight size={15} /></button></div>
        </>}
      </section>
    </>}
  </section>;
}
