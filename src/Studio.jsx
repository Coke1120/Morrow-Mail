import { useMailPage } from './mail-page';
import { prepareDraft } from './message-draft';
import { messageAIContext } from './MessageAI';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Bell, BookOpen, Brain, CalendarDays, Check, CheckCheck, ChevronRight, FilePenLine, FolderCheck, Languages, ListFilter, LoaderCircle, Mail, MessageSquare, NotebookPen, Paperclip, Pencil, Plus, Save, Search, ShieldCheck, Sparkles, Star, Tag, Trash2, UserRound, WandSparkles, X } from 'lucide-react';
import { AI_BEHAVIORS, DEFAULT_POLICY } from '../shared/features';
import './studio.css';

const icons = { summary: ListFilter, reply: MessageSquare, ask: Search, write: Pencil, rewrite: WandSparkles, translate: Languages, briefing: BookOpen, triage: Star, labels: Tag, memory: Brain, research: UserRound, meeting: NotebookPen, skill: Sparkles, followup: Bell, schedule: CalendarDays, cleanup: FolderCheck, unsubscribe: Mail, attachments: Paperclip, batchReplies: FilePenLine };
const groups = { All: null, Writing: ['summary', 'reply', 'write', 'rewrite', 'translate', 'batchReplies'], Organizing: ['ask', 'briefing', 'triage', 'labels', 'cleanup', 'unsubscribe', 'attachments'], Planning: ['memory', 'research', 'meeting', 'skill', 'followup', 'schedule'] };
const mockNotes = {
  triage: 'Local simulation: previews stars for matching messages. No external mailbox changes.',
  labels: 'Local simulation: labels are saved in Morrow only.',
  memory: 'Local simulation: review suggested voice and contact notes before saving to Email Brain.',
  research: 'Sample research brief from permitted email context. No web lookup or verified company research.',
  meeting: 'Local simulation: previews an agenda and saves an activity record. No real calendar is accessed.',
  followup: 'Local reminder only. No email is sent and no background notification is scheduled.',
  schedule: 'Local calendar simulation. No real calendar event, invitation, or availability check.',
  cleanup: 'Local simulation: matching messages move to Morrow’s Archive only.',
  unsubscribe: 'Local simulation: records your intent. No unsubscribe link is opened or request sent.',
  attachments: 'Sample attachment fixtures only. No real attachments are fetched, read, or compared.',
  batchReplies: 'Local simulation: creates separate editable drafts. Every send requires your review.',
};
const emptySkill = () => ({ name: '', instructions: '', enabled: true, folders: { inbox: true, sent: false, drafts: false, archive: false, trash: false } });
const dateLabel = value => value && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'No date';
const tomorrow = () => { const date = new Date(); date.setDate(date.getDate() + 1); date.setHours(9, 0, 0, 0); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T09:00`; };

export default function Studio({ state, selectedMessage, onUpdate, onCompose, composeOpen = false, onSettings, notify, onDirtyChange, onBusyChange, initialTab = 'tools' }) {
  const savedPolicy = state.settings?.policy || {};
  const policy = { ...DEFAULT_POLICY, ...savedPolicy, behaviors: { ...DEFAULT_POLICY.behaviors, ...savedPolicy.behaviors }, folders: { ...DEFAULT_POLICY.folders, ...savedPolicy.folders }, content: { ...DEFAULT_POLICY.content, ...savedPolicy.content } };
  const workspace = state.workspace || {};
  const skills = workspace.skills || [];
  const brain = workspace.brain;
  const accountKey = state.account.id;
  const contextKey = JSON.stringify([accountKey, policy, state.accounts.find(item => item.id === accountKey)?.settings, state.settings.ai, state.settings.preferences, brain]);
  const currentContext = useRef(contextKey);
  currentContext.current = contextKey;
  const pending = useRef(null);
  const actionPanel = useRef(null);
  const [tab, setTab] = useState(initialTab === 'summaries' ? 'summaries' : 'tools');
  const [group, setGroup] = useState('All');
  const [action, setAction] = useState('briefing');
  const [messageId, setMessageId] = useState(selectedMessage?.id || '');
  const [prompt, setPrompt] = useState('');
  const [draftText, setDraftText] = useState('');
  const [translateSource, setTranslateSource] = useState('message');
  const [when, setWhen] = useState(tomorrow);
  const [skillId, setSkillId] = useState(skills[0]?.id || '');
  const [skillForm, setSkillForm] = useState(emptySkill);
  const [voice, setVoice] = useState(brain?.voice || '');
  const [notes, setNotes] = useState(brain?.notes || '');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [output, setOutput] = useState(null);
  const [preview, setPreview] = useState(null);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const mail = useMailPage(accountKey, state.revision);
  const contextRows = selectedMessage?.accountId === accountKey && !mail.messages.some(m => m.id === selectedMessage.id) ? [selectedMessage, ...mail.messages] : mail.messages;
  const permitted = contextRows.filter(message => policy.folders[message.folder]);
  const counts = accountKey === 'demo' ? state.demoStats?.counts || {} : state.accounts.find(item => item.id === accountKey)?.counts || {};
  const permittedCount = Object.entries(counts).filter(([folder]) => folder !== 'starred' && policy.folders[folder]).reduce((sum, [, count]) => sum + count, 0);
  const chosen = permitted.find(message => message.id === messageId) || permitted.find(message => message.id === selectedMessage?.id) || permitted[0];
  const draftContextKey = JSON.stringify([contextKey, tab, action, output, messageAIContext(state, chosen, 'reply').key, composeOpen]);
  const draftContext = useRef(draftContextKey);
  draftContext.current = draftContextKey;
  const feature = AI_BEHAVIORS.find(item => item.id === action);
  const usesDraft = action === 'rewrite' || (action === 'translate' && translateSource === 'draft');
  const usesSelected = feature.context === 'selected' && !usesDraft;
  const chosenSkill = skills.find(skill => skill.id === skillId) || skills[0];
  const skillCount = Object.entries(counts).filter(([folder]) => folder !== 'starred' && policy.folders[folder] && (!chosenSkill?.folders || chosenSkill.folders[folder])).reduce((sum, [, count]) => sum + count, 0);

  useEffect(() => {
    pending.current?.controller.abort(); pending.current = null;
    setBusy(''); setError(''); setOutput(null); setPreview(null);
    setPrompt(''); setDraftText(''); setMessageId(selectedMessage?.id || '');
    setSkillForm(emptySkill());
  }, [contextKey]);
  useEffect(() => () => { pending.current?.controller.abort(); pending.current = null; }, []);
  useEffect(() => {
    if (pending.current?.draft && pending.current.context !== draftContextKey) { pending.current.controller.abort(); pending.current = null; setBusy(''); }
  }, [draftContextKey]);
  useEffect(() => { setVoice(brain?.voice || ''); setNotes(brain?.notes || ''); }, [accountKey, brain?.voice, brain?.notes]);

  const originalSkill = skillForm.id ? skills.find(skill => skill.id === skillForm.id) : emptySkill();
  const dirty = voice !== (brain?.voice || '') || notes !== (brain?.notes || '') || JSON.stringify(skillForm) !== JSON.stringify(originalSkill);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(!!busy); }, [busy, onBusyChange]);
  useEffect(() => () => { onDirtyChange?.(false); onBusyChange?.(false); }, [onDirtyChange, onBusyChange]);

  function blocked(item, drafting = false, choosing = false) {
    if (!policy.enabled) return 'AI is turned off in permissions.';
    if (!policy.behaviors[item.id]) return 'This behavior is turned off in permissions.';
    if (['memory', 'research'].includes(item.id) && !policy.content.contacts) return 'Allow contact context in AI permissions.';
    if (['meeting', 'schedule'].includes(item.id) && !policy.content.calendar) return 'Allow local calendar context in AI permissions.';
    if (item.id === 'attachments' && !policy.content.attachments) return 'Allow sample attachment context in AI permissions.';
    if (item.id === 'batchReplies' && (!policy.content.sender || !policy.content.body)) return 'Batch replies require sender and message body permissions.';
    if ((item.id === 'rewrite' || drafting) && (!policy.folders.drafts || !policy.content.body)) return 'Draft actions require Drafts and message body permissions.';
    if (item.context !== 'none' && item.context !== 'draft' && !drafting && !['subject', 'body', 'sender'].some(key => policy.content[key])) return 'Allow subject, body, or sender context in AI permissions.';
    if (item.context !== 'none' && item.context !== 'draft' && !drafting && !permittedCount && !(choosing && item.id === 'translate' && policy.folders.drafts && policy.content.body)) return 'No messages are in your permitted folders.';
    return '';
  }
  const skillReason = action === 'skill' && chosenSkill ? chosenSkill.enabled === false ? 'This skill is disabled. Enable it in My skills.' : !skillCount ? 'This skill has no messages in its allowed folders. Edit its scope in My skills or change AI permissions.' : '' : '';
  const blockReason = blocked(feature, usesDraft) || skillReason;
  const modelMissing = !feature.mock && state.account.mode !== 'demo' && !state.settings.ai?.configured;
  const invalid = (usesSelected && !chosen) || (usesDraft && !draftText.trim()) || (['ask', 'write'].includes(action) && !prompt.trim()) || (action === 'skill' && !chosenSkill);
  const messageLabel = message => `${policy.content.subject ? message.subject || '(No subject)' : 'Subject hidden'}${policy.content.sender ? ` · ${message.fromName || message.fromEmail || 'Unknown sender'}` : ''}`;

  async function request(path, body, label, success, method = 'POST') {
    if (pending.current) return;
    const requestContext = contextKey;
    const token = { controller: new AbortController() };
    pending.current = token; setBusy(label); setError('');
    try {
      const response = await fetch(`/api${path}`, { method, signal: token.controller.signal, headers: { 'Content-Type': 'application/json', 'X-Morrow-View': 'paged', 'X-Genmail-Account': accountKey }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `Request failed (${response.status}). Please try again.`);
      if (currentContext.current === requestContext && pending.current === token) success(result);
    } catch (cause) {
      if (cause.name !== 'AbortError' && currentContext.current === requestContext && pending.current === token) setError(cause.message);
    } finally {
      if (pending.current === token) { pending.current = null; setBusy(''); }
    }
  }

  function selectAction(id) {
    setAction(id); setPreview(null); setOutput(null); setError(''); setTab('tools');
    requestAnimationFrame(() => actionPanel.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' }));
  }
  function run(event) {
    event.preventDefault();
    if (busy || blockReason || modelMissing || invalid) return;
    setPreview(null); setOutput(null);
    if (feature.mock) {
      const body = { action, ...(usesSelected ? { messageId: chosen.id } : {}) };
      if (['followup', 'schedule'].includes(action)) {
        const date = new Date(when);
        if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) { setError('Choose a future date and time.'); return; }
        body.when = date.toISOString();
      }
      request('/workflows/preview', body, 'preview', result => setPreview(result.preview));
    } else {
      const body = { action, prompt: prompt.trim(), ...(usesSelected ? { messageId: chosen.id } : {}), ...(usesDraft ? { draftText } : {}), ...(action === 'skill' ? { skillId: chosenSkill.id } : {}) };
      request('/ai', body, 'generate', result => setOutput({ ...result, action, message: usesSelected ? chosen : null }));
    }
  }
  function applyPreview() {
    request('/workflows/apply', { previewId: preview.id }, 'apply', next => { onUpdate(next); setPreview(null); notify('Simulation applied to your local workspace.'); });
  }
  async function useDraft() {
    if (!output || pending.current || composeOpen) return;
    const message = output.message;
    if (output.action !== 'reply') {
      onCompose({ accountId: message?.accountId || accountKey, body: output.text, to: message && policy.content.sender ? (message.folder === 'sent' ? message.to : message.fromEmail) : '', subject: message && policy.content.subject ? message.subject : '' });
      return;
    }
    if (!message || message.accountId !== accountKey || messageAIContext(state, message, 'reply').key !== messageAIContext(state, chosen, 'reply').key) { setError('The source message changed. Generate a new reply before opening a draft.'); return; }
    const token = { controller: new AbortController(), draft: true, context: draftContextKey };
    pending.current = token; setBusy('draft'); setError('');
    const valid = () => pending.current === token && !token.controller.signal.aborted && draftContext.current === token.context;
    try {
      const draft = await prepareDraft(message, 'reply', { body: output.text, signal: token.controller.signal });
      if (valid()) onCompose(draft);
    } catch (cause) { if (valid()) setError(cause.message); }
    finally { if (pending.current === token) { pending.current = null; setBusy(''); } }
  }
  function saveSkill(event) {
    event.preventDefault();
    request('/skills', skillForm, 'skill-save', next => { onUpdate(next); setSkillForm(emptySkill()); notify('Email skill saved.'); });
  }
  function updateRecord(collection, record, changes) {
    request(`/workspace/${collection}/${encodeURIComponent(record.id)}`, changes, record.id, next => { onUpdate(next); notify('Local record updated.'); }, 'PATCH');
  }
  function showSettings() { onSettings('permissions'); }

  return <section className="studio-page" aria-label="AI Studio">
    <header className="studio-heading"><div><span className="eyebrow">A LITTLE ASSISTANCE. A LOT OF POSSIBILITIES.</span><h1>AI Studio<span>.</span></h1><p>Your words, a clearer inbox, and room for what matters.</p></div><button className="button secondary" onClick={showSettings}><ShieldCheck size={16} />AI permissions</button></header>
    <div className="studio-intro"><span className="studio-emblem"><Sparkles size={22} /></span><div><strong>Thoughtful tools. You’re in control.</strong><p>AI runs when you ask or enable a trigger. Review every result; nothing sends automatically.</p></div><span className="studio-badge">{state.settings.ai?.configured ? state.settings.ai.model : state.account.mode === 'demo' ? 'Demo responses' : 'Choose an AI model'}</span></div>
    <nav className="studio-tabs" aria-label="Studio sections">{[['tools', WandSparkles, 'All tools'], ['summaries', BookOpen, 'Summaries'], ['brain', Brain, 'Email Brain'], ['skills', Sparkles, 'My skills'], ['activity', CheckCheck, 'Local activity']].map(([id, Icon, title]) => <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => { setTab(id); setError(''); }}><Icon size={16} />{title}{id === 'activity' && !!workspace.reminders?.filter(record => !record.done).length && <span>{workspace.reminders.filter(record => !record.done).length}</span>}</button>)}</nav>
    {error && <div className="studio-error" role="alert">{error}<button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={15} /></button></div>}
    {!policy.enabled && <div className="studio-notice"><ShieldCheck size={16} /><p>AI is paused. Your manual email tools still work.</p><button onClick={showSettings}>Manage permissions<ArrowRight size={14} /></button></div>}

    {tab === 'summaries' && <section className="studio-action-panel" aria-label="Scheduled and new-mail summaries">
      <div className="studio-section-heading"><div><h2>Scheduled &amp; new-mail summaries</h2><p>Latest 20 jobs for this account. P0 emergency · P1 due today · P2 action · P3 information · P4 bulk. Review AI priorities.</p></div><button className="button secondary" disabled={!!busy} onClick={() => request('/state', undefined, 'refresh', onUpdate, 'GET')}>Refresh</button></div>
      <p>Configure triggers in Settings → AI permissions. Summaries use cached mail and saved permissions. Results are hidden if the model, language, permissions, connection or source scope changes.</p>
      {workspace.summaryOverflow > 0 && <p role="status">{workspace.summaryOverflow} jobs exceeded the queue limit. Use a manual summary for those messages.</p>}
      {(state.syncErrors || []).map(item => <p role="status" key={item.accountId}>{item.accountId}: {item.error}</p>)}
      {!workspace.summaries?.length && <p>No summaries yet. Enable a trigger and wait for a scheduled time or newly synced mail.</p>}
      {(workspace.summaries || []).map(report => <article key={report.id} className="studio-result"><h3>{report.kind === 'arrival' ? 'New mail' : 'Scheduled summary'} · {report.status}</h3><small>{dateLabel(report.createdAt)} · {report.messageIds.length} messages{report.source === 'demo' ? ' · Illustrative demo' : ''}</small>{report.text && <div className="studio-result-text">{report.text}</div>}{report.error && <p role="status">{report.error}</p>}</article>)}
    </section>}

    {tab === 'tools' && <>
      <div className="studio-tools-bar"><div className="studio-filters" role="group" aria-label="Filter tools">{Object.keys(groups).map(name => <button key={name} onClick={() => setGroup(name)} aria-pressed={group === name}>{name}</button>)}</div><span>{AI_BEHAVIORS.length} ways to lighten the load</span></div>
      <div className="studio-feature-grid">{AI_BEHAVIORS.filter(item => !groups[group] || groups[group].includes(item.id)).map(item => { const Icon = icons[item.id]; const reason = blocked(item, false, true); return <button type="button" className={`studio-feature ${action === item.id ? 'is-selected' : ''}`} key={item.id} onClick={() => selectAction(item.id)} disabled={!!reason || !!busy} aria-pressed={action === item.id} title={reason || item.description}><span className="studio-feature-top"><span className="studio-feature-icon"><Icon size={18} /></span><span className={`studio-badge ${item.mock ? 'simulation' : ''}`}>{reason ? 'Restricted' : item.mock ? 'Simulation' : 'AI'}</span></span><strong>{item.label}</strong><p>{item.description}</p><span className="studio-feature-open">{reason ? 'Change permissions to use' : 'Open tool'}<ChevronRight size={13} /></span></button>; })}</div>
      <div className="studio-scope"><ShieldCheck size={14} /><span>AI can use up to {policy.maxMessages} messages from {Object.entries(policy.folders).filter(([, allowed]) => allowed).map(([folder]) => folder).join(', ') || 'no folders'}. Restricted tools follow your permissions.</span><button onClick={showSettings}>Change</button></div>
      <section ref={actionPanel} className="studio-action-panel" aria-labelledby="studio-action-title">
        <div className="studio-section-heading"><div><span className="eyebrow">{feature.mock ? 'PREVIEW FIRST. APPLY LOCALLY.' : 'A STARTING POINT, SHAPED BY YOU.'}</span><h2 id="studio-action-title">{feature.label}</h2><p>{feature.description}</p></div><span className={`studio-badge ${feature.mock ? 'simulation' : ''}`}>{feature.mock ? 'Local simulation' : 'On-demand AI'}</span></div>
        <form onSubmit={run} className="studio-action-form">
          {action === 'translate' && <label className="studio-field">Translate from<select value={translateSource} onChange={event => { setTranslateSource(event.target.value); setOutput(null); }} disabled={!!busy}><option value="message">An email</option><option value="draft">Text I’m writing</option></select></label>}
          {usesSelected && <label className="studio-field">Email context<select value={chosen?.id || ''} onChange={event => { setMessageId(event.target.value); setOutput(null); setPreview(null); }} disabled={!!busy || !!blockReason} required>{!permitted.length && <option value="">No permitted messages</option>}{permitted.map(message => <option key={message.id} value={message.id}>{messageLabel(message)}</option>)}</select><small>Only messages in your permitted folders are available.</small><span className="search-actions"><button type="button" disabled={!!busy || mail.loading || !mail.previous} onClick={mail.previous}>Previous messages</button><span>Page {mail.page}</span><button type="button" disabled={!!busy || mail.loading || !mail.next} onClick={mail.next}>Next messages</button></span>{mail.error && <small role="alert">{mail.error}</small>}</label>}
          {feature.context === 'mailbox' && <p className="studio-context"><Mail size={15} />Uses up to {Math.min(action === 'skill' ? skillCount : permittedCount, policy.maxMessages)} permitted messages. Hidden content stays excluded.</p>}
          {action === 'skill' && <div className="studio-field"><label className="studio-skill-selector">Saved skill<select value={chosenSkill?.id || ''} onChange={event => { setSkillId(event.target.value); setOutput(null); }} disabled={!!busy || !!blocked(feature)} required>{!skills.length && <option value="">Create a skill first</option>}{skills.map(skill => <option key={skill.id} value={skill.id} disabled={skill.enabled === false}>{skill.name}{skill.enabled === false ? ' (disabled)' : ''}</option>)}</select></label>{chosenSkill && <small>{chosenSkill.instructions}</small>}<button type="button" className="studio-text-button" onClick={() => setTab('skills')}>Manage my skills<ArrowRight size={13} /></button></div>}
          {usesDraft && <label className="studio-field">Your draft<textarea rows={6} value={draftText} onChange={event => { setDraftText(event.target.value); setOutput(null); }} placeholder="Paste the text you want to work on…" required disabled={!!busy || !!blockReason} maxLength={100000} /></label>}
          {!feature.mock && <label className="studio-field">{action === 'write' ? 'What would you like to say?' : action === 'ask' ? 'Your question' : action === 'translate' ? 'Language or translation instructions' : 'Additional instructions (optional)'}<textarea rows={action === 'write' ? 4 : 2} value={prompt} onChange={event => setPrompt(event.target.value)} required={['write', 'ask'].includes(action)} disabled={!!busy || !!blockReason} maxLength={2000} placeholder={action === 'write' ? 'Write a warm follow-up about our conversation…' : action === 'ask' ? 'Which messages need a response from me?' : action === 'translate' ? `Translate to ${state.settings.preferences?.translationLanguage || state.settings.preferences?.language || 'English'}` : 'A little context or a preferred tone…'} /></label>}
          {['followup', 'schedule'].includes(action) && <label className="studio-field">{action === 'followup' ? 'Remind me on' : 'Proposed date and time'}<input type="datetime-local" value={when} onChange={event => { setWhen(event.target.value); setPreview(null); }} disabled={!!busy || !!blockReason} required /><small>Local timezone: {timezone}. Stored as a local workspace record only.</small></label>}
          {feature.mock && <p className="studio-simulation-note"><ShieldCheck size={15} />{mockNotes[action]}</p>}
          {(blockReason || modelMissing) && <div className="studio-notice"><p>{blockReason || 'Connect an AI model in Settings to use this tool with your mailbox.'}</p><button type="button" onClick={() => skillReason && !blocked(feature, usesDraft) ? setTab('skills') : onSettings(blockReason ? 'permissions' : 'model')}>{skillReason && !blocked(feature, usesDraft) ? 'Manage skills' : 'Open Settings'}<ArrowRight size={14} /></button></div>}
          <div className="studio-form-actions"><span>{feature.mock ? 'Review the full preview before applying.' : state.settings.ai?.configured ? 'Permitted content is sent to your configured model.' : 'Illustrative demo output. Configure a model for real AI.'}</span><button type="submit" className="button primary" disabled={!!busy || !!blockReason || modelMissing || invalid}>{['generate', 'preview'].includes(busy) ? <LoaderCircle className="spinning" size={16} /> : <Sparkles size={16} />}{feature.mock ? 'Create preview' : 'Generate response'}</button></div>
        </form>
        {output && <section className="studio-result" aria-live="polite"><div className="studio-result-title"><Sparkles size={16} /><h3>Your result</h3><span className="studio-badge">{output.source === 'demo' ? 'Illustrative demo' : 'AI response'}</span></div><div className="studio-result-text">{output.text}</div>{output.source === 'demo' && <p className="studio-caption">This is sample output, not an AI analysis. Connect your model in Settings for real responses.</p>}{['reply', 'write', 'rewrite', 'translate'].includes(output.action) && <button className="button primary" onClick={useDraft} disabled={!!busy || composeOpen}>Review in a draft<ArrowRight size={15} /></button>}</section>}
        {preview && <section className="studio-result" aria-live="polite"><div className="studio-result-title"><ShieldCheck size={16} /><h3>{preview.title}</h3><span className="studio-badge simulation">Local simulation</span></div><p className="studio-caption">{preview.summary}</p><ul className="studio-preview-items">{preview.items?.map((item, index) => <li key={`${item.messageId || ''}-${index}`}><Check size={15} /><div><strong>{item.title}</strong><p>{item.detail}</p></div></li>)}</ul><div className="studio-preview-footer"><p>Preview expires after 10 minutes. Applying changes only this local workspace.</p><div><button className="button secondary" onClick={() => setPreview(null)} disabled={!!busy}>Dismiss</button><button className="button primary" onClick={applyPreview} disabled={!!busy || !!blockReason}>{busy === 'apply' ? <LoaderCircle size={16} className="spinning" /> : <Check size={16} />}Apply local simulation</button></div></div></section>}
      </section>
    </>}

    {tab === 'brain' && <section className="studio-section"><div className="studio-section-heading"><div><span className="eyebrow">MEMORY WITH YOUR PERMISSION</span><h2>Your Email Brain</h2><p>Save the writing preferences and context you want your assistant to remember.</p></div><span className="studio-badge simulation">Local notes</span></div><div className="studio-notice"><Brain size={17} /><p>{policy.enabled && policy.behaviors.memory ? 'Explicitly saved voice and notes may inform AI responses while Email Brain is enabled.' : 'Email Brain is disabled. Saved notes will not inform AI responses.'} Contact entries are local and editable only through a new reviewed preview.</p></div><form onSubmit={event => { event.preventDefault(); request('/workspace/brain', { voice, notes }, 'brain-save', next => { onUpdate(next); notify('Email Brain saved.'); }); }}><label className="studio-field">Your writing voice<textarea rows={3} value={voice} onChange={event => setVoice(event.target.value)} maxLength={2000} disabled={!!busy} placeholder="Warm and direct. Short paragraphs. Sign off with my first name." /></label><label className="studio-field">Notes to remember<textarea rows={5} value={notes} onChange={event => setNotes(event.target.value)} maxLength={4000} disabled={!!busy} placeholder="Save context you want the assistant to use…" /></label><div className="studio-brain-contacts"><h3>Saved contacts <span>{brain?.contacts?.length || 0}</span></h3>{brain?.contacts?.length ? <ul>{brain.contacts.map((contact, index) => <li key={`${contact.email}-${index}`}><UserRound size={16} /><div><strong>{contact.name || 'Contact'}</strong><span>{contact.email}</span></div></li>)}</ul> : <p>No saved contacts. Preview Email Brain from your permitted messages to get started.</p>}</div><div className="studio-form-actions"><button type="button" className="studio-text-button" onClick={() => selectAction('memory')} disabled={!!busy || !!blocked(AI_BEHAVIORS.find(item => item.id === 'memory'))}>Preview from my inbox<ArrowRight size={14} /></button><div className="studio-inline-actions"><button type="button" className="button secondary" disabled={!!busy || !brain} onClick={() => { if (window.confirm('Clear your saved Email Brain voice, notes, and contacts?')) request('/workspace/brain', undefined, 'brain-clear', next => { onUpdate(next); setVoice(''); setNotes(''); notify('Email Brain cleared.'); }, 'DELETE'); }}><Trash2 size={15} />Clear Brain</button><button className="button primary" type="submit" disabled={!!busy}>{busy === 'brain-save' ? <LoaderCircle size={15} className="spinning" /> : <Save size={15} />}Save Brain</button></div></div></form></section>}

    {tab === 'skills' && <div className="studio-skills-layout"><section className="studio-section"><div className="studio-section-heading"><div><span className="eyebrow">YOUR OWN WAY OF WORKING</span><h2>Reusable email skills</h2><p>Save instructions, then run them when you need them.</p></div></div><div className="studio-skill-list">{skills.length ? skills.map(skill => <article className="studio-skill" key={skill.id}><span className="studio-feature-icon"><Sparkles size={17} /></span><div><h3>{skill.name}{skill.enabled === false && <span className="studio-badge">Disabled</span>}</h3><p>{skill.instructions}</p><p className="studio-skill-scope">Allowed folders: {Object.entries(skill.folders || policy.folders).filter(([, allowed]) => allowed).map(([folder]) => folder).join(', ') || 'none'}. Global AI permissions always apply.</p><div className="studio-inline-actions"><button className="studio-text-button" onClick={() => { setSkillId(skill.id); selectAction('skill'); }} disabled={!!busy || skill.enabled === false || !!blocked(AI_BEHAVIORS.find(item => item.id === 'skill')) || !permitted.some(message => !skill.folders || skill.folders[message.folder])}>Use skill<ArrowRight size={13} /></button><button className="studio-text-button" onClick={() => setSkillForm({ ...emptySkill(), ...skill, folders: { ...emptySkill().folders, ...skill.folders } })} disabled={!!busy}><Pencil size={13} />Edit</button><button className="studio-text-button studio-danger" onClick={() => { if (window.confirm(`Delete the skill “${skill.name}”?`)) request(`/skills/${encodeURIComponent(skill.id)}`, undefined, 'skill-delete', next => { onUpdate(next); if (skillForm.id === skill.id) setSkillForm(emptySkill()); notify('Email skill deleted.'); }, 'DELETE'); }} disabled={!!busy}><Trash2 size={13} />Delete</button></div></div></article>) : <p className="studio-empty">No saved skills yet. Give your first one a name and a clear instruction.</p>}</div></section><section className="studio-section"><h2>{skillForm.id ? 'Edit skill' : 'Create a skill'}</h2><form onSubmit={saveSkill}><label className="studio-field">Skill name<input value={skillForm.name} onChange={event => setSkillForm({ ...skillForm, name: event.target.value })} required maxLength={80} placeholder="Prepare my weekly check-in" disabled={!!busy} /></label><label className="studio-field">Instructions<textarea value={skillForm.instructions} onChange={event => setSkillForm({ ...skillForm, instructions: event.target.value })} required rows={7} maxLength={4000} placeholder="Find decisions, open questions, and next steps. Group by conversation. Don’t invent deadlines." disabled={!!busy} /></label><label className="studio-checkbox"><input type="checkbox" checked={skillForm.enabled} onChange={event => setSkillForm({ ...skillForm, enabled: event.target.checked })} disabled={!!busy} />Enable this skill</label><fieldset className="studio-skill-folders" disabled={!!busy}><legend>Folders this skill can use</legend><p>These choices are limited by your global AI permissions.</p>{Object.entries(skillForm.folders).map(([folder, allowed]) => <label className="studio-checkbox" key={folder}><input type="checkbox" checked={allowed} onChange={event => setSkillForm({ ...skillForm, folders: { ...skillForm.folders, [folder]: event.target.checked } })} />{folder.charAt(0).toUpperCase() + folder.slice(1)}{!policy.folders[folder] && <span>Restricted globally</span>}</label>)}</fieldset><p className="studio-caption">Skills use only permitted mail and never send messages or execute external actions.</p><div className="studio-inline-actions">{skillForm.id && <button type="button" className="button secondary" onClick={() => setSkillForm(emptySkill())} disabled={!!busy}>Cancel edit</button>}<button className="button primary" type="submit" disabled={!!busy || !skillForm.name.trim() || !skillForm.instructions.trim()}>{busy === 'skill-save' ? <LoaderCircle size={15} className="spinning" /> : skillForm.id ? <Save size={15} /> : <Plus size={15} />}{skillForm.id ? 'Save changes' : 'Create skill'}</button></div></form></section></div>}

    {tab === 'activity' && <section className="studio-section"><div className="studio-section-heading"><div><span className="eyebrow">A CLEAR RECORD OF YOUR CHOICES</span><h2>Local workspace activity</h2><p>These are simulated records. Morrow has not sent reminders, created real events, or unsubscribed you.</p></div><span className="studio-badge simulation">Local only</span></div><div className="studio-record-grid">{[['reminders', Bell, 'Follow-up reminders'], ['events', CalendarDays, 'Calendar & preparation']].map(([collection, Icon, label]) => <div className="studio-record-group" key={collection}><h3><Icon size={16} />{label}</h3>{workspace[collection]?.length ? <ul>{workspace[collection].map(record => <li key={record.id} className={record.done || record.cancelled ? 'is-done' : ''}><div className="studio-record-title"><strong>{record.title}</strong><span className="studio-badge">{record.cancelled ? 'Cancelled' : record.done ? 'Done' : 'Simulated'}</span></div><p>{record.detail}</p>{record.when && <time dateTime={record.when}>{dateLabel(record.when)} · {timezone}</time>}<div className="studio-inline-actions">{!record.cancelled && <button className="studio-text-button" onClick={() => updateRecord(collection, record, { done: !record.done })} disabled={!!busy}><CheckCheck size={14} />{record.done ? 'Mark incomplete' : 'Mark complete'}</button>}{collection === 'events' && !record.cancelled && <button className="studio-text-button" onClick={() => updateRecord(collection, record, { cancelled: true })} disabled={!!busy}><X size={14} />Cancel record</button>}</div></li>)}</ul> : <p className="studio-empty">No records yet. Create a preview from All tools.</p>}</div>)}</div><div className="studio-activity-log"><h3>Applied simulations</h3>{workspace.activity?.length ? <ul>{workspace.activity.map((record, index) => <li key={record.id || index}><span className="studio-log-dot" /><div><strong>{record.title || AI_BEHAVIORS.find(item => item.id === record.action)?.label || 'Local workspace update'}</strong>{(record.summary || record.detail) && <p>{record.summary || record.detail}</p>}<time dateTime={record.createdAt}>{dateLabel(record.createdAt)}</time></div><span className="studio-badge simulation">Simulated</span></li>)}</ul> : <p className="studio-empty">Your reviewed changes will appear here.</p>}</div>{!!workspace.unsubscribed?.length && <div className="studio-activity-log"><h3>Simulated unsubscribe requests</h3><p className="studio-caption">Records of intent only. You remain subscribed until you unsubscribe with the sender.</p><ul>{workspace.unsubscribed.map((record, index) => <li key={record.id || index}><Mail size={16} /><div><strong>{record.title}</strong><p>{record.detail}</p></div></li>)}</ul></div>}</section>}
    <footer className="studio-footer"><ShieldCheck size={13} />Private by choice. Helpful on request. Always reviewed by you.</footer>
  </section>;
}
