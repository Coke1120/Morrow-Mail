// Synthetic startup IPC only. Never connects to a provider or reads credentials.
(function (root) {
  function install(window, options = {}) {
    const state = {
      version: options.version || '0.3.18',
      status: options.status || { ready: false, source: 'none', imported: false },
      accounts: options.accounts || [],
      calls: [],
      ready: false,
      readStatus: null,
      readSeen: null,
    };
    if (options.seen !== undefined) window.localStorage.setItem('synthetic.changelogSeen', options.seen);
    if (options.saved) window.localStorage.setItem('morrow.googleOnboarding.v1', options.saved);
    window.morrow = {
      on() { return () => {}; },
      reportUpdateReady() { state.ready = true; },
      async invoke(channel, ...args) {
        state.calls.push(channel);
        if (channel === 'app:getVersion') return state.version;
        if (channel === 'morrow:configGetChangelogSeen') return state.readSeen ? state.readSeen() : window.localStorage.getItem('synthetic.changelogSeen') || '';
        if (channel === 'morrow:configSetChangelogSeen') { window.localStorage.setItem('synthetic.changelogSeen', args[0]); return true; }
        if (channel === 'mail:googleOauthStatus') return { success: true, data: state.readStatus ? await state.readStatus() : { ...state.status } };
        if (channel === 'mail:listAccounts') return { success: true, data: state.accounts };
        if (channel === 'mail:oauthStatus') return { success: true, data: { google: state.status.ready, accounts: [] } };
        if (channel.startsWith('mail:')) return { success: true, data: [] };
        if (channel === 'config:getTheme') return 'light';
        return null;
      },
    };
    return state;
  }
  if (typeof module === 'object' && module.exports) module.exports = install;
  else root.syntheticStartup = install(root, { version: new URLSearchParams(root.location.search).get('version') || '0.3.18' });
})(typeof window === 'object' ? window : globalThis);
