import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { oauthStart, oauthFinish, refreshMail } from './providers.js';
import { listCalendars, listCalendarEvents, createCalendarEvent, normalizeCalendarReminder, CALENDAR_READ_ERRORS } from './calendar-providers.js';
import { oauthCredentials } from './oauth-client.js';

const PROVIDERS = ['google', 'microsoft'];
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function providerName(value) {
  if (!PROVIDERS.includes(value)) fail('Choose Google Calendar or Outlook Calendar.');
  return value;
}
function text(value, name, max, optional = false) {
  if (typeof value !== 'string' || value.length > max || (!optional && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(`${name} must be ${optional ? 'text' : 'provided'} and at most ${max} characters.`);
  return value;
}
function dateTime(value) {
  if (typeof value !== 'string') fail('Use a date and time with an explicit time zone.');
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) fail('Use a date and time with an explicit time zone.');
  const [, year, month, day, hour, minute, second = '0', , offset] = match;
  const calendar = new Date(Date.UTC(+year, +month - 1, +day));
  if (+year < 1900 || calendar.getUTCFullYear() !== +year || calendar.getUTCMonth() !== +month - 1 || calendar.getUTCDate() !== +day || +hour > 23 || +minute > 59 || +second > 59 || (offset !== 'Z' && (+offset.slice(1, 3) > 14 || +offset.slice(4) > 59 || (+offset.slice(1, 3) === 14 && +offset.slice(4) !== 0)))) fail('Choose a valid calendar date, time, and time zone.');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail('Choose a valid calendar date and time.');
  return date.toISOString();
}
function range(start, end, listing = false) {
  const result = { start: dateTime(start), end: dateTime(end) };
  const duration = Date.parse(result.end) - Date.parse(result.start);
  // Ninety local dates can include a daylight-saving rollback; event durations remain exact.
  if (duration <= 0 || duration > 90 * 86400_000 + (listing ? 2 * 3600_000 : 0)) fail('The end must be after the start, within 90 days.');
  return result;
}
function sameSecret(first, second) {
  if (typeof first !== 'string' || typeof second !== 'string') return false;
  const a = Buffer.from(first), b = Buffer.from(second);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function calendarState(settings) {
  return PROVIDERS.map(provider => {
    const connection = settings.calendars?.[provider];
    return { provider, email: connection?.email || '', clientId: connection?.clientId || '', connected: !!(connection?.email && (connection.accessToken || connection.refreshToken)), hasClientSecret: !!connection?.clientSecret };
  });
}

export function registerCalendarRoutes(app, { store, port, appUrl, services = {}, googleOAuth = null }) {
  const api = { oauthStart, oauthFinish, refreshMail, listCalendars, listCalendarEvents, createCalendarEvent, ...services };
  const pending = new Map(), refreshing = new Map(), generations = new Map(), busy = new Set();
  const getConnection = provider => store.getSettings().calendars?.[provider];
  const saveConnection = (provider, connection) => store.setSettings({ calendars: { ...store.getSettings().calendars, [provider]: connection } });
  function invalidate(provider) {
    generations.set(provider, (generations.get(provider) || 0) + 1);
    for (const [state, attempt] of pending) if (attempt.provider === provider) pending.delete(state);
  }
  function requireIdle(provider) {
    if (busy.has(provider)) fail('Another calendar change is in progress. Wait for it to finish.', 409);
  }
  async function change(provider, work) {
    requireIdle(provider);
    busy.add(provider);
    try { return await work(); } finally { busy.delete(provider); }
  }
  function connected(provider, expectedEmail) {
    const connection = getConnection(provider);
    if (!connection?.email || (!connection.accessToken && !connection.refreshToken)) fail('Connect this calendar in Settings first.', 409);
    if (expectedEmail !== undefined && expectedEmail !== connection.email) fail('This calendar connection changed. Reload the calendars before continuing.', 409);
    return connection;
  }
  async function currentConnection(provider) {
    connected(provider);
    if (!refreshing.has(provider)) {
      const connection = getConnection(provider), generation = generations.get(provider) || 0;
      const promise = (async () => {
        let refreshed;
        try { refreshed = await api.refreshMail(connection); }
        catch { fail('Calendar authorization expired or could not be refreshed. Reconnect in Settings.', 401); }
        if (generation !== (generations.get(provider) || 0)) fail('This calendar connection changed. Reload the calendars.', 409);
        saveConnection(provider, refreshed);
        return refreshed;
      })();
      refreshing.set(provider, promise);
      promise.finally(() => { if (refreshing.get(provider) === promise) refreshing.delete(provider); }).catch(() => {});
    }
    return refreshing.get(provider);
  }
  async function remote(work, message) {
    try { return await work(); } catch { fail(message, 502); }
  }
  function checkGeneration(provider, generation) {
    if (generation !== (generations.get(provider) || 0)) fail('This calendar connection changed. Reload the calendars.', 409);
  }

  app.get('/api/calendars', async (req, res) => {
    const calendars = [], errors = [];
    await Promise.all(PROVIDERS.map(async provider => {
      if (!getConnection(provider)?.email) return;
      const generation = generations.get(provider) || 0;
      try {
        const connection = await currentConnection(provider);
        const result = await remote(() => api.listCalendars(connection), 'Could not load calendars. Check your connection and calendar permissions.');
        checkGeneration(provider, generation);
        calendars.push(...result.map(calendar => ({ ...calendar, provider })));
      } catch (error) { errors.push({ provider, message: error.status ? error.message : 'Could not load calendars.' }); }
    }));
    res.json({ connections: calendarState(store.getSettings()).map(connection => ({ ...connection, hasDefaultClient: connection.provider === 'microsoft' || (connection.provider === 'google' && !!googleOAuth), redirectUri: `http://localhost:${port}/api/calendar-oauth/${connection.provider}/callback` })), calendars, errors });
  });

  app.post('/api/calendars/:provider/connect', (req, res) => {
    const provider = providerName(req.params.provider);
    requireIdle(provider);
    const credentials = oauthCredentials(provider, req.body, googleOAuth);
    const config = { clientId: text(credentials.clientId, 'OAuth client ID', 1024).trim() };
    if (/[\r\n]/.test(config.clientId)) fail('OAuth client ID must be a single line.');
    const existing = getConnection(provider);
    const secret = credentials.clientSecret || (!credentials.useDefaultClient && existing?.clientId === config.clientId ? existing.clientSecret : '');
    if (secret) {
      config.clientSecret = text(secret, 'Client secret', 4096).trim();
      if (/[\r\n]/.test(config.clientSecret)) fail('Client secret must be a single line.');
    }
    for (const [state, attempt] of pending) if (attempt.expiresAt < Date.now() || attempt.provider === provider) pending.delete(state);
    if (pending.size >= 20) fail('Too many pending connections. Try again in ten minutes.', 429);
    const redirectUri = `http://localhost:${port}/api/calendar-oauth/${provider}/callback`;
    const attempt = api.oauthStart(provider, config, redirectUri, 'calendar');
    pending.set(attempt.state, { ...attempt, provider, redirectUri, browserToken: randomBytes(32).toString('hex'), expiresAt: Date.now() + 10 * 60_000 });
    res.json({ url: `http://localhost:${port}/api/calendar-oauth/${provider}/authorize?state=${encodeURIComponent(attempt.state)}` });
  });
  app.get('/api/calendar-oauth/:provider/authorize', (req, res) => {
    const provider = providerName(req.params.provider);
    const attempt = typeof req.query.state === 'string' ? pending.get(req.query.state) : null;
    if (!attempt || attempt.provider !== provider || attempt.expiresAt < Date.now() || attempt.started) fail('Calendar connection expired. Start again from Settings.');
    attempt.started = true;
    res.cookie(`morrow_calendar_${provider}`, attempt.browserToken, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60_000, path: `/api/calendar-oauth/${provider}` });
    res.redirect(attempt.url);
  });
  app.get('/api/calendar-oauth/:provider/callback', async (req, res) => {
    const redirect = new URL(appUrl);
    try {
      const provider = providerName(req.params.provider);
      const attempt = typeof req.query.state === 'string' ? pending.get(req.query.state) : null;
      pending.delete(req.query.state);
      const cookieName = `morrow_calendar_${provider}=`;
      const cookie = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(cookieName))?.slice(cookieName.length);
      res.clearCookie(`morrow_calendar_${provider}`, { path: `/api/calendar-oauth/${provider}` });
      if (!attempt || !attempt.started || attempt.provider !== provider || attempt.expiresAt < Date.now() || !sameSecret(cookie, attempt.browserToken)) fail('Calendar connection expired or could not be verified. Start again from Settings.');
      if (req.query.error) fail('Calendar access was not granted. Try again from Settings.');
      const code = text(req.query.code, 'Authorization code', 8192);
      await change(provider, async () => {
        const connection = await remote(() => api.oauthFinish(provider, { code, verifier: attempt.verifier, config: attempt.config, redirectUri: attempt.redirectUri, purpose: 'calendar' }), 'Calendar connection failed. Check your app registration and calendar permissions.');
        await remote(() => api.listCalendars(connection), 'Calendar access could not be verified. Check the calendar permissions and try again.');
        invalidate(provider);
        saveConnection(provider, connection);
      });
      redirect.searchParams.set('calendarConnected', provider);
    } catch (error) { redirect.searchParams.set('calendarError', error.status ? error.message : 'Calendar connection failed. Try again from Settings.'); }
    res.redirect(redirect.href);
  });
  app.post('/api/calendars/:provider/disconnect', async (req, res) => {
    const provider = providerName(req.params.provider);
    text(req.body?.connectionEmail, 'Connected calendar email', 254);
    await change(provider, () => {
      connected(provider, req.body.connectionEmail);
      invalidate(provider);
      saveConnection(provider, null);
      res.json({ ok: true });
    });
  });
  app.get('/api/calendars/:provider/events', async (req, res) => {
    const provider = providerName(req.params.provider);
    const calendarId = text(req.query.calendarId, 'Calendar', 2048), dates = range(req.query.start, req.query.end, true);
    const generation = generations.get(provider) || 0;
    const connection = await currentConnection(provider);
    let events;
    try { events = await api.listCalendarEvents(connection, { calendarId, ...dates }); }
    catch (error) { fail(Object.hasOwn(CALENDAR_READ_ERRORS, error?.code) ? CALENDAR_READ_ERRORS[error.code] : 'Could not load events. Check your calendar access and try again.', 502); }
    checkGeneration(provider, generation);
    res.json({ events });
  });
  app.post('/api/calendars/:provider/events', async (req, res) => {
    const provider = providerName(req.params.provider), input = req.body || {};
    const allowed = ['calendarId', 'title', 'description', 'location', 'start', 'end', 'requestId', 'connectionEmail', 'reminder'];
    if (Object.keys(input).some(key => !allowed.includes(key))) fail('Only the displayed event details are supported. Attendees and invitations are not supported.');
    const connectionEmail = text(input.connectionEmail, 'Connected calendar email', 254);
    const requestId = text(input.requestId, 'Event request ID', 36).toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)) fail('Use a valid unique event request ID.');
    const value = { calendarId: text(input.calendarId, 'Calendar', 2048), title: text(input.title, 'Event title', 300).trim(), description: text(input.description ?? '', 'Description', 10000, true), location: text(input.location ?? '', 'Location', 1000, true), ...range(input.start, input.end), requestId };
    const reminder = normalizeCalendarReminder(input.reminder, provider);
    // Append only when explicitly selected: old JSON order and fingerprints must remain exact.
    if (reminder !== undefined) value.reminder = reminder;
    if (/[\r\n\t]/.test(value.title) || /[\r\n]/.test(value.location)) fail('Event title and location must be single lines.');
    connected(provider, connectionEmail);
    const payloadHash = createHash('sha256').update(JSON.stringify(value)).digest('hex');
    await change(provider, async () => {
      const matches = record => record.provider === provider && record.email === connectionEmail && record.requestId === requestId;
      let records = store.getSettings().calendarRequests || [], record = records.find(matches);
      if (record && record.payloadHash !== payloadHash) fail('This event request ID was already used for different details. Reload before creating a different event.', 409);
      if (record?.event) return res.json({ event: record.event });
      const connection = await currentConnection(provider);
      connected(provider, connectionEmail);
      const calendars = await remote(() => api.listCalendars(connection), 'Could not verify calendar permissions. Try again.');
      if (!calendars.some(calendar => calendar.id === value.calendarId && calendar.canWrite)) fail('Choose a calendar that permits you to create events.', 403);
      // Persist before the network call; a retry reuses the provider's deterministic event ID.
      if (!record) {
        records = store.getSettings().calendarRequests || [];
        if (records.length >= 100) {
          const completed = records.findIndex(item => item.event);
          if (completed < 0) fail('There are too many unconfirmed calendar requests. Resolve them before adding events.', 409);
          records.splice(completed, 1);
        }
        record = { provider, email: connectionEmail, requestId, payloadHash, payload: value, createdAt: new Date().toISOString() };
        store.setSettings({ calendarRequests: [...records, record] });
      }
      const event = await remote(() => api.createCalendarEvent(connection, value), 'Creating this event could not be confirmed. Check your calendar before retrying; retrying these same details reuses the event request ID.');
      if (!event?.id) fail('The provider did not confirm an event ID. Check your calendar before retrying.', 502);
      store.setSettings({ calendarRequests: (store.getSettings().calendarRequests || []).map(item => matches(item) ? { ...item, event } : item) });
      res.json({ event });
    });
  });
}
