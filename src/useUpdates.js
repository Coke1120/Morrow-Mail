import { useCallback, useEffect, useRef, useState } from 'react';

// Shared by automatic and manual checks. A failed check retains the last known release.
export async function checkForUpdates(state, { force = false, now = Date.now() } = {}) {
  if (state.checking || state.controller.signal.aborted) return;
  const elapsed = now - state.lastAttempt;
  if (!force && state.lastAttempt != null && elapsed >= 0 && elapsed < 3_600_000) return;
  state.checking = true; state.lastAttempt = now; state.error = '';
  try {
    const response = await fetch(`/api/updates?includePrereleases=${state.includePrereleases}`, {
      signal: AbortSignal.any([state.controller.signal, AbortSignal.timeout(15_000)]),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not check for updates.');
    if (!state.controller.signal.aborted) state.result = result;
  } catch (error) {
    if (!state.controller.signal.aborted) state.error = error.message || 'Could not check for updates.';
  } finally { state.checking = false; }
}

export default function useUpdates(enabled, initialChannel) {
  const [includePrereleases, setIncludePrereleases] = useState(initialChannel);
  const [status, setStatus] = useState({});
  const current = useRef(null);
  const check = useCallback(async (force = false) => {
    const state = current.current;
    if (!state) return;
    const pending = checkForUpdates(state, { force });
    setStatus({ ...state });
    await pending;
    if (current.current === state) setStatus({ ...state });
  }, []);
  useEffect(() => {
    if (!enabled) return;
    const state = { includePrereleases, controller: new AbortController(), lastAttempt: null, result: null, error: '', checking: false };
    current.current = state;
    check();
    const timer = setInterval(() => check(), 60_000);
    const wake = () => { if (!document.hidden) check(); };
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      state.controller.abort(); current.current = null;
      clearInterval(timer);
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [enabled, includePrereleases, check]);
  return { ...(status.includePrereleases === includePrereleases ? status : {}), includePrereleases, setIncludePrereleases, check };
}
