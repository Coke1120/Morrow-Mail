/* Shared by the first-party settings panel and the native AI Setup window.
 * The only secret accepted here is a transient manual callback URL. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else root.morrowChatgptSettings = { mount: factory };
})(typeof window === "object" ? window : globalThis, function mount({ container, invoke, onChange = () => {}, onMode = () => {}, onContext = () => {} }) {
  container.innerHTML = `
    <label for="ai-auth-mode">AI authentication</label>
    <select id="ai-auth-mode"><option value="api_key">API key / custom endpoint</option><option value="chatgpt">ChatGPT account</option></select>
    <section id="chatgpt-panel" hidden aria-label="ChatGPT connection">
      <p class="hint">Use your eligible ChatGPT plan for Morrow Mail AI. Plan, app and workspace limits apply. This feature is free in Morrow Mail.</p>
      <p class="hint">Review the <a href="https://openai.com/policies/privacy-policy/" target="_blank" rel="noreferrer">OpenAI privacy policy</a> and <a href="https://openai.com/policies/sign-in-with-chatgpt-terms/" target="_blank" rel="noreferrer">sign-in terms</a>. Sign-in connects this account. AI data permission below is a separate choice.</p>
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
      <p class="hint">Only models returned for this account are offered. Use Fetch models below. Save AI applies the authentication choice and model.</p>
      <p class="hint">Use AI data permission below to separately allow background processing for this saved connection. No automatic API billing fallback or account rotation.</p>
      <p><a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">Manage usage in ChatGPT</a></p>
      <button id="chatgpt-resume" type="button" class="ghost" hidden>Retry after checking usage</button>
      <dialog id="chatgpt-welcome" aria-label="You're using your ChatGPT plan" hidden>
        <strong>You're using your ChatGPT plan</strong>
        <p>Eligible AI requests use your ChatGPT plan. Manage usage and app access in ChatGPT settings.</p>
        <button id="chatgpt-got-it" type="button" class="primary">Got it</button>
      </dialog>
    </section>
    <section aria-label="AI data permission">
      <h3>AI data permission</h3>
      <p class="hint">Existing connections start with AI data use off until you approve this disclosure. Saving an API key, fetching models or signing in does not approve it. Save your provider and model first; the permission applies to the saved connection shown here.</p>
      <p id="ai-consent-destination"></p>
      <p id="ai-consent-locality" class="hint"></p>
      <p id="ai-consent-data" class="hint"></p>
      <p id="ai-consent-terms" class="hint"></p>
      <p class="hint">Your explicit AI actions may send relevant context after you allow them. Background processing requires the separate choice below. A provider, endpoint, model, account or material data-use change requires fresh permission. Revocation stops pending work and future requests; data already delivered cannot be recalled from the provider.</p>
      <label class="check" for="ai-consent-manual"><input id="ai-consent-manual" type="checkbox" /> I allow the disclosed AI data use for my explicit AI actions at this saved destination.</label>
      <p id="ai-consent-background-data" class="hint"></p>
      <label class="check" for="ai-consent-background"><input id="ai-consent-background" type="checkbox" /> I separately allow this background AI data use at the same destination.</label>
      <div class="row">
        <button id="ai-consent-allow" type="button" class="primary" disabled>Allow selected AI data use</button>
        <button id="ai-consent-revoke" type="button" class="ghost">Cancel / revoke AI data permission</button>
        <button id="ai-consent-refresh" type="button" class="ghost">Review saved connection</button>
      </div>
      <p id="ai-consent-status" role="status" aria-live="polite"></p>
      <p><a href="https://hwl-hk.com/en/morrow-mail/privacy" target="_blank" rel="noreferrer">Morrow Mail privacy policy</a></p>
    </section>`;
  const $ = id => container.querySelector(`#${id}`);
  let timer;
  let snapshot = {};
  let selectedModel = "";
  let busy = false;
  let actionRevision = 0;
  let statusRevision = 0;
  let disposed = false;
  let cancelling = false;
  let modelRevision = 0;
  let consentRevision = 0;
  let permission = null;
  let consentBusy = false;
  let consentRefreshPending = false;
  function consentControls() {
    $("ai-consent-allow").disabled = disposed || consentBusy || !permission?.ready || !$("ai-consent-manual").checked;
    $("ai-consent-allow").title = permission?.ready === false ? (permission.blocker || "Save a ready connection, then review it again.") : "";
    $("ai-consent-background").disabled = disposed || consentBusy || !$("ai-consent-manual").checked;
  }
  function paintConsent(value) {
    if (permission?.token !== value?.token) {
      $("ai-consent-manual").checked = false;
      $("ai-consent-background").checked = false;
    }
    permission = value;
    $("ai-consent-destination").textContent = value?.destination ? `Saved destination: ${value.label} · ${value.destination} · model ${value.model || "not selected"}` : "Save and review an AI connection first.";
    $("ai-consent-locality").textContent = value?.locality || "";
    $("ai-consent-data").textContent = value?.disclosure || "";
    $("ai-consent-terms").textContent = value?.providerTerms || "";
    $("ai-consent-background-data").textContent = value?.backgroundDisclosure || "";
    $("ai-consent-status").textContent = value?.manual
      ? `Explicit AI actions allowed. Background AI ${value.background ? "allowed" : "off"}.`
      : value?.ready === false
        ? `AI data use is off. ${value.blocker || "Save a ready connection, then review it again."}`
        : "AI data use is off. Review the disclosure and make an explicit choice before using AI.";
    consentControls();
  }
  async function refreshConsent() {
    if (consentBusy) { consentRefreshPending = true; return; }
    const revision = ++consentRevision;
    try {
      const result = await invoke("host:aiConsentStatus");
      if (!disposed && revision === consentRevision) paintConsent(result);
    } catch (error) {
      if (!disposed && revision === consentRevision) {
        permission = null; consentControls();
        $("ai-consent-status").textContent = error.message || "Could not read AI permission. Review again.";
      }
    }
  }
  $("ai-consent-manual").addEventListener("change", () => {
    if (!$("ai-consent-manual").checked) $("ai-consent-background").checked = false;
    consentControls();
  });
  $("ai-consent-refresh").addEventListener("click", refreshConsent);
  async function consentAction(allow) {
    if (disposed || (allow && (consentBusy || !permission?.ready || !$("ai-consent-manual").checked))) return;
    const revision = ++consentRevision;
    const input = allow ? { token: permission.token, manual: true, background: $("ai-consent-background").checked } : undefined;
    consentBusy = true; consentControls();
    $("ai-consent-status").textContent = allow ? "Saving AI data permission…" : "Stopping AI data use…";
    onContext();
    try {
      const result = await invoke(allow ? "host:aiConsentGrant" : "host:aiConsentRevoke", input);
      if (!disposed && revision === consentRevision) paintConsent(result);
    } catch (error) {
      if (!disposed && revision === consentRevision) {
        permission = null;
        $("ai-consent-manual").checked = false;
        $("ai-consent-background").checked = false;
        $("ai-consent-status").textContent = error.message || "Could not save AI permission. Review again.";
      }
    } finally {
      if (!disposed && revision === consentRevision) {
        consentBusy = false; consentControls();
        if (consentRefreshPending) { consentRefreshPending = false; await refreshConsent(); }
      }
    }
  }
  $("ai-consent-allow").addEventListener("click", () => consentAction(true));
  $("ai-consent-revoke").addEventListener("click", () => consentAction(false));
  const context = () => JSON.stringify([snapshot.activeId, snapshot.connected, snapshot.planEnabled]);
  const message = text => { $("chatgpt-status").textContent = text || ""; };
  function welcome() {
    const dialog = $("chatgpt-welcome");
    const show = !disposed && snapshot.welcome === true && $("ai-auth-mode").value === "chatgpt";
    dialog.hidden = !show;
    if (show && !dialog.open && typeof dialog.showModal === "function") dialog.showModal();
    if (!show && dialog.open && typeof dialog.close === "function") dialog.close();
  }
  function mode() {
    const chatgpt = $("ai-auth-mode").value === "chatgpt";
    $("chatgpt-panel").hidden = !chatgpt;
    if (!chatgpt) $("chatgpt-callback").value = "";
    onMode(chatgpt);
    welcome();
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
    welcome();
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
    if (await action("host:chatgptSelect", $("chatgpt-account").value)) choices([]);
  });
  $("chatgpt-enable").addEventListener("click", () => action("host:chatgptStart", { accountId: snapshot.activeId, enablePlan: true }));
  $("chatgpt-resume").addEventListener("click", () => action("host:chatgptResumeUsage"));
  $("chatgpt-got-it").addEventListener("click", () => action("host:chatgptPreferences", { welcomeSeen: true }));
  $("chatgpt-welcome").addEventListener("cancel", () => action("host:chatgptPreferences", { welcomeSeen: true }));
  return {
    async load(config) {
      disposed = false;
      actionRevision++; statusRevision++; modelRevision++;
      busy = false; cancelling = false;
      clearTimeout(timer);
      $("ai-auth-mode").value = config.authMode || "api_key";
      selectedModel = config.chatgptModel || "";
      const option = document.createElement("option"); option.value = selectedModel; option.textContent = selectedModel || "Fetch models and choose one";
      $("chatgpt-model").replaceChildren(option);
      mode();
      await refresh();
      await refreshConsent();
    },
    draft: () => ({ authMode: $("ai-auth-mode").value, chatgptModel: $("chatgpt-model").value }),
    context,
    refresh,
    refreshConsent,
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
      consentRevision++; consentBusy = false; permission = null;
      $("ai-consent-manual").checked = false;
      $("ai-consent-background").checked = false;
      consentControls();
      busy = false; cancelling = false;
      clearTimeout(timer); $("chatgpt-callback").value = "";
      const dialog = $("chatgpt-welcome");
      if (dialog.open && typeof dialog.close === "function") dialog.close();
    },
  };
});
