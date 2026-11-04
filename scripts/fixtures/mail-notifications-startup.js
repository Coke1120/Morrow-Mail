// Browser-only synthetic mail and preferences, loaded after the startup fixture.
(() => {
  const original = window.morrow.invoke.bind(window.morrow), events = new Map();
  const defaults = { MailNotificationsEnabled: true, MailNotificationPreview: "hidden", CompactMessageList: true,
    ConversationViewEnabled: true, SyncHorizonDays: 0, LayoutPanes: { folders: 260, list: 360, reading: 0 }, Accent: "#193C34" };
  const rows = ["a", "b"].map(id => ({ id: `${id}-new`, accountId: id, folderId: "INBOX", subject: `Synthetic ${id.toUpperCase()} arrival`,
    from: `${id.toUpperCase()} Sender <sender@fixture.invalid>`, to: [`${id}@fixture.invalid`], date: new Date().toISOString(),
    unread: true, hasBody: true, bodyComplete: true, textBody: "Synthetic notification click fixture. No real mail.", snippet: "Synthetic preview" }));
  syntheticStartup.accounts = ["a", "b"].map(id => ({ id, email: `${id}@fixture.invalid`, name: `Synthetic ${id.toUpperCase()}`, platform: "imap", imapSmtpProfile: "custom",
    folders: { primary: [{ id: "INBOX", name: "Inbox", wellKnownName: "inbox" }], more: [] } }));
  syntheticStartup.onboarding = { status: "existing", step: 0, accountId: "a" };
  const f = window.notificationFixture = { target: null, osState: "ready", events, calls: [],
    emit(channel, payload) { events.get(channel)?.(payload); } };
  window.morrow.on = (channel, callback) => { events.set(channel, callback); return () => events.delete(channel); };
  window.morrow.invoke = async (channel, params) => {
    f.calls.push(channel);
    if (channel === "morrow:configGetChangelogSeen") return syntheticStartup.version;
    if (channel.startsWith("morrow:configGet")) {
      const key = channel.slice("morrow:configGet".length), value = localStorage.getItem(`synthetic.notification.${key}`);
      if (value !== null) return JSON.parse(value);
      if (Object.hasOwn(defaults, key)) return defaults[key];
    }
    if (channel.startsWith("morrow:configSet")) {
      localStorage.setItem(`synthetic.notification.${channel.slice("morrow:configSet".length)}`, JSON.stringify(params)); return params;
    }
    if (channel === "mail:getNotificationSettings") return { success: true, data: { state: f.osState } };
    if (channel === "mail:takeNotificationTarget") { const value = f.target; f.target = null; return { success: true, data: value }; }
    if (["mail:listFromCache", "mail:listFromNetwork"].includes(channel)) return { success: true, data: { emails: rows.filter(row => !params?.accountId || params.accountId === "*" || row.accountId === params.accountId), total: 1, initialSyncDone: true } };
    if (channel === "mail:openEmail") return { success: true, data: { email: rows.find(row => row.id === params.emailId), threadMessages: [] } };
    return original(channel, params);
  };
})();
