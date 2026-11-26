/* Shared by the first-party settings panel and the native AI Setup window. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else root.morrowChatgptSettings = { mount: factory, connectionSaveInput };

  function connectionSaveInput(input, baseline) {
    if (input.authMode !== "chatgpt" || !baseline) return input;
    if (input.apiKey || input.baseUrl.trim() !== baseline.baseUrl || input.model.trim() !== baseline.model) return input;
    // Send the API connection as a group when edited. Otherwise keep the host's current values.
    return { authMode: input.authMode, chatgptModel: input.chatgptModel };
  }
})(typeof window === "object" ? window : globalThis, function mount({ container, consentContainer = container, compact = false, invoke, onChange = () => {}, onMode = () => {}, onContext = () => {} }) {
  container.innerHTML = `
    <label for="ai-auth-mode">AI authentication</label>
    <select id="ai-auth-mode" aria-describedby="ai-auth-mode-help"><option value="api_key">API key / custom endpoint</option><option value="chatgpt">Sign in with ChatGPT</option></select>
    <p id="ai-auth-mode-help" class="hint">Use a compatible API endpoint, or use an eligible ChatGPT plan without an API key.</p>
    <section id="chatgpt-panel" hidden aria-label="Sign in with ChatGPT">
      ${compact ? "" : '<p class="hint">Use your eligible ChatGPT plan for Morrow Mail AI. Plan, app and workspace limits apply.</p>'}
      <label for="chatgpt-account">ChatGPT account registration</label>
      <select id="chatgpt-account"><option value="">Add a new ChatGPT account or workspace</option></select>
      <p id="chatgpt-active" class="hint"></p>
      <div class="row">
        <button id="chatgpt-login" type="button" class="primary">Continue with ChatGPT</button>
        <button id="chatgpt-select" type="button" class="ghost">Use selected account</button>
        <button id="chatgpt-signout" type="button" class="ghost">Sign out active account</button>
        <button id="chatgpt-refresh" type="button" class="ghost">Refresh connection status</button>
        <button id="chatgpt-cancel" type="button" class="ghost" hidden>Cancel sign-in</button>
      </div>
      <p id="chatgpt-status" role="status" aria-live="polite"></p>
      <details id="chatgpt-manual"><summary>Browser callback did not return to Morrow Mail?</summary>
        <p class="hint">After browser approval, copy the complete 127.0.0.1 callback URL from its address bar and paste it here while this attempt is waiting. Do not share that URL. After cancellation finishes, Continue with ChatGPT starts a fresh attempt immediately; an earlier attempt cannot change it.</p>
        <label for="chatgpt-callback">Callback URL (one-time use)</label>
        <input id="chatgpt-callback" type="password" autocomplete="off" spellcheck="false" />
        <button id="chatgpt-submit" type="button" class="ghost">Complete sign-in</button>
      </details>
      <button id="chatgpt-enable" type="button" class="ghost" hidden>Enable ChatGPT plan usage</button>
      <label for="chatgpt-model">ChatGPT model</label>
      <select id="chatgpt-model"><option value="">Fetch models and choose one</option></select>
      ${compact ? "" : `<p class="hint">After browser sign-in, use Fetch models, choose a model available to this ChatGPT account, then select Save AI.</p>`}
      <p><a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">Manage usage in ChatGPT</a></p>
      <button id="chatgpt-resume" type="button" class="ghost" hidden>Retry after checking usage</button>
    </section>`;
  consentContainer.insertAdjacentHTML("beforeend", `
    <section class="ai-automatic">
      <label for="ai-automatic-processing">Automatic processing</label>
      <select id="ai-automatic-processing" disabled>
        <option value="manual">Only when requested</option>
        <option value="automatic">Run background AI</option>
      </select>
      <p id="ai-automatic-status" class="hint" role="status" aria-live="polite"></p>
    </section>`);
  const $ = id => container.querySelector("#" + id) || consentContainer.querySelector("#" + id);
  const processing = $("ai-automatic-processing");
  const processingStatus = $("ai-automatic-status");
  let snapshot = {}, busy = false, cancelling = false, timer = null, selectedModel = "";
  let disposed = false, actionRevision = 0, statusRevision = 0, modelRevision = 0;
  let permission = null, consentRevision = 0, consentBusy = false, consentLoading = false, consentRefreshPending = false;
  let connectionDirty = false, connectionSaving = false;

  function consentControls() {
    processing.value = permission?.background ? "automatic" : "manual";
    processing.disabled = disposed || consentBusy || consentLoading || !permission?.ready ||
      (!permission.background && (connectionDirty || connectionSaving));
  }
  function setConnectionState({ dirty = false, saving = false } = {}) {
    connectionDirty = dirty;
    connectionSaving = saving;
    consentControls();
  }
  async function refreshConsent() {
    if (disposed) return;
    if (consentBusy) { consentRefreshPending = true; return; }
    const revision = ++consentRevision;
    consentLoading = true;
    consentControls();
    try {
      const result = await invoke("host:aiConsentStatus");
      if (!disposed && revision === consentRevision) {
        permission = result;
        processingStatus.textContent = result?.ready ? "" : result?.blocker || "Save an AI connection first.";
      }
    } catch (error) {
      if (!disposed && revision === consentRevision) {
        permission = null;
        processingStatus.textContent = error.message || "Could not load automatic processing.";
      }
    } finally {
      if (!disposed && revision === consentRevision) {
        consentLoading = false;
        consentControls();
      }
    }
  }
  processing.addEventListener("change", async () => {
    const enable = processing.value === "automatic";
    if (processing.disabled || !permission || enable === permission.background ||
        (enable && (connectionDirty || connectionSaving))) {
      consentControls();
      return;
    }
    const revision = ++consentRevision;
    consentBusy = true;
    processing.disabled = true;
    processingStatus.textContent = "Saving automatic processing…";
    onContext();
    try {
      const result = enable
        ? await invoke("host:aiConsentGrant", { token: permission.token, background: true })
        : await invoke("host:aiConsentRevoke");
      if (!disposed && revision === consentRevision) {
        permission = result;
        processingStatus.textContent = "";
      }
    } catch (error) {
      if (!disposed && revision === consentRevision) {
        permission = null;
        processingStatus.textContent = error.message || "Could not save automatic processing.";
      }
    } finally {
      if (!disposed && revision === consentRevision) {
        consentBusy = false;
        consentControls();
        if (consentRefreshPending) { consentRefreshPending = false; await refreshConsent(); }
      }
    }
  });
  const context = () => JSON.stringify([snapshot.activeId, snapshot.connected, snapshot.planEnabled]);
  const message = text => { $("chatgpt-status").textContent = text || ""; };
  function mode() {
    const chatgpt = $("ai-auth-mode").value === "chatgpt";
    $("chatgpt-panel").hidden = !chatgpt;
    if (!chatgpt) $("chatgpt-callback").value = "";
    onMode(chatgpt);
  }
  function paint(status) {
    if (disposed) return;
    const previous = snapshot.activeId;
    const previousContext = context();
    snapshot = status || {};
    const select = $("chatgpt-account");
    const chosen = select.value;
    select.replaceChildren();
    const fresh = document.createElement("option");
    fresh.value = "";
    fresh.textContent = "Add a new ChatGPT account or workspace";
    select.appendChild(fresh);
    for (const row of snapshot.accounts || []) {
      const option = document.createElement("option");
      option.value = row.id;
      option.textContent = row.label + (row.connected ? "" : " · signed out");
      select.appendChild(option);
    }
    select.value = previous !== snapshot.activeId ? snapshot.activeId || "" : chosen;
    const active = (snapshot.accounts || []).find(row => row.id === snapshot.activeId);
    $("chatgpt-active").textContent = active ? `Active: ${active.label}${snapshot.connected ? " · connected" : " · signed out"}${snapshot.planEnabled ? " · Using ChatGPT plan" : ""}` : "No ChatGPT account connected.";
    $("chatgpt-login").disabled = snapshot.available === false || snapshot.pending || busy;
    $("chatgpt-signout").disabled = !snapshot.connected || busy;
    $("chatgpt-select").disabled = !snapshot.accounts?.some(row => row.connected) || busy;
    $("chatgpt-cancel").hidden = !snapshot.pending;
    $("chatgpt-cancel").disabled = cancelling;
    $("chatgpt-submit").disabled = !snapshot.pending || snapshot.phase !== "waiting";
    $("chatgpt-enable").hidden = !snapshot.connected || snapshot.planEnabled;
    $("chatgpt-resume").hidden = !snapshot.usagePaused;
    message(snapshot.available === false ? snapshot.message || "Unlock operating system secure storage to sign in." : snapshot.message);
    if (previousContext !== context()) {
      modelRevision++;
      if (previous && previous !== snapshot.activeId) choices([]);
      onContext();
      refreshConsent();
    }
    if (!snapshot.pending) $("chatgpt-callback").value = "";
    clearTimeout(timer);
    if (snapshot.pending) timer = setTimeout(() => refresh(), 750);
  }
  async function refresh(owner = actionRevision) {
    const revision = ++statusRevision;
    try {
      const result = await invoke("host:chatgptStatus");
      if (!disposed && owner === actionRevision && revision === statusRevision) paint(result);
    } catch (error) {
      if (!disposed && owner === actionRevision && revision === statusRevision) message(error.message || "Could not refresh ChatGPT status.");
    }
  }
  async function action(channel, input) {
    if (busy || disposed) return false;
    const revision = ++actionRevision;
    statusRevision++;
    busy = true;
    $("chatgpt-login").disabled = true;
    if (channel === "host:chatgptStart") paint({ ...snapshot, pending: true, phase: "starting", message: "Opening ChatGPT sign-in…" });
    let failure = "";
    try {
      const result = await invoke(channel, input);
      if (disposed || revision !== actionRevision) return false;
      paint(result);
      return true;
    }
    catch (error) {
      if (disposed || revision !== actionRevision) return false;
      failure = error.message || "ChatGPT action failed. Retry when ready.";
      await refresh(revision);
      return false;
    }
    finally {
      if (!disposed && revision === actionRevision) {
        busy = false; paint(snapshot); if (failure) message(failure);
      }
    }
  }
  function choices(rows) {
    const select = $("chatgpt-model");
    const current = select.value || selectedModel;
    select.replaceChildren();
    const empty = document.createElement("option");
    empty.value = ""; empty.textContent = "Choose an available ChatGPT model"; select.appendChild(empty);
    for (const row of rows || []) {
      const option = document.createElement("option"); option.value = row.id; option.textContent = row.name; select.appendChild(option);
    }
    select.value = (rows || []).some(row => row.id === current) ? current : "";
    selectedModel = select.value;
    onChange();
  }
  $("ai-auth-mode").addEventListener("change", () => { modelRevision++; mode(); onChange(); });
  $("chatgpt-model").addEventListener("change", () => { selectedModel = $("chatgpt-model").value; onChange(); });
  $("chatgpt-login").addEventListener("click", () => action("host:chatgptStart", { accountId: $("chatgpt-account").value || undefined }));
  // Cancellation must remain usable while start or token exchange is awaiting IPC.
  $("chatgpt-cancel").addEventListener("click", async () => {
    if (cancelling || disposed) return;
    const revision = ++actionRevision; // retire the old start/exchange before awaiting Cancel
    statusRevision++;
    cancelling = true;
    busy = true;
    paint({ ...snapshot, pending: true, phase: "cancelling", message: "Cancelling ChatGPT sign-in…" });
    let failure = "";
    try {
      const result = await invoke("host:chatgptCancel");
      if (!disposed && revision === actionRevision) paint(result);
    } catch (error) {
      if (!disposed && revision === actionRevision) {
        failure = error.message || "ChatGPT cancellation failed.";
        await refresh(revision);
      }
    } finally {
      if (!disposed && revision === actionRevision) {
        cancelling = false; busy = false; paint(snapshot); if (failure) message(failure);
      }
    }
  });
  $("chatgpt-submit").addEventListener("click", () => {
    const url = $("chatgpt-callback").value;
    $("chatgpt-callback").value = ""; // clear before awaiting IPC, including failed callbacks
    action("host:chatgptCallback", url);
  });
  $("chatgpt-signout").addEventListener("click", () => action("host:chatgptSignOut", snapshot.activeId));
  $("chatgpt-refresh").addEventListener("click", () => action("host:chatgptStatus"));
  $("chatgpt-select").addEventListener("click", async () => {
    const id = $("chatgpt-account").value;
    const unchanged = id === snapshot.activeId && snapshot.connected;
    if (await action("host:chatgptSelect", id)) {
      if (!unchanged) choices([]);
      // Recheck the host even if an out-of-band account change was not painted.
      await refreshConsent();
    }
  });
  $("chatgpt-enable").addEventListener("click", () => action("host:chatgptStart", { accountId: snapshot.activeId, enablePlan: true }));
  $("chatgpt-resume").addEventListener("click", () => action("host:chatgptResumeUsage"));
  async function resume() {
    disposed = false;
    consentRevision++; consentBusy = false; consentLoading = false; consentRefreshPending = false;
    permission = null; processingStatus.textContent = ""; consentControls();
    const owner = ++actionRevision; statusRevision++; modelRevision++;
    busy = false; cancelling = false;
    clearTimeout(timer);
    mode();
    await refresh(owner);
    if (disposed || owner !== actionRevision) return;
    await refreshConsent();
  }
  return {
    async load(config) {
      $("ai-auth-mode").value = config.authMode || "api_key";
      selectedModel = config.chatgptModel || "";
      const option = document.createElement("option"); option.value = selectedModel; option.textContent = selectedModel || "Fetch models and choose one";
      $("chatgpt-model").replaceChildren(option);
      $("chatgpt-model").value = selectedModel;
      await resume();
    },
    // Reopen a preserved draft without replacing its authentication/model fields.
    resume,
    draft: () => ({ authMode: $("ai-auth-mode").value, chatgptModel: $("chatgpt-model").value }),
    context,
    accountId: () => snapshot.activeId || "",
    refresh,
    refreshConsent,
    setConnectionState,
    async fetchModels() {
      const revision = ++modelRevision;
      const accountId = snapshot.activeId;
      const result = await invoke("host:aiListModels", { authMode: "chatgpt" });
      if (revision !== modelRevision || accountId !== snapshot.activeId) throw new Error("ChatGPT account or mode changed. Fetch models again.");
      if (!result?.ok) throw new Error(result?.message || "Could not list ChatGPT models.");
      choices(result.choices);
      return result.models.length;
    },
    dispose: () => {
      disposed = true;
      actionRevision++; statusRevision++; modelRevision++;
      consentRevision++; consentBusy = false; consentLoading = false; consentRefreshPending = false; permission = null;
      processingStatus.textContent = "";
      consentControls();
      busy = false; cancelling = false;
      clearTimeout(timer); $("chatgpt-callback").value = "";
    },
  };
});
