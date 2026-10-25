/* Shared by the first-party settings panel and the native AI Setup window.
 * The only secret accepted here is a transient manual callback URL. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else root.morrowChatgptSettings = { mount: factory };
})(typeof window === "object" ? window : globalThis, function mount({ container, invoke, onChange = () => {}, onMode = () => {} }) {
  container.innerHTML = `
    <label for="ai-auth-mode">AI authentication</label>
    <select id="ai-auth-mode"><option value="api_key">API key / custom endpoint</option><option value="chatgpt">ChatGPT account</option></select>
    <section id="chatgpt-panel" hidden aria-label="ChatGPT connection">
      <p class="hint">Use your eligible ChatGPT plan for Morrow Mail AI. Plan, app and workspace limits apply. This feature is free in Morrow Mail.</p>
      <p class="hint">Selected mail text, prompts and conversation context needed for AI features are sent directly from this computer to OpenAI. Review the <a href="https://openai.com/policies/privacy-policy/" target="_blank" rel="noreferrer">OpenAI privacy policy</a> and <a href="https://openai.com/policies/sign-in-with-chatgpt-terms/" target="_blank" rel="noreferrer">sign-in terms</a> before continuing. Browser sign-in requests your consent.</p>
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
        <p class="hint">After browser approval, copy the complete 127.0.0.1 callback URL from its address bar and paste it here while this attempt is waiting. Do not share that URL. Retry Continue with ChatGPT after cancellation or timeout.</p>
        <label for="chatgpt-callback">Callback URL (one-time use)</label>
        <input id="chatgpt-callback" type="password" autocomplete="off" spellcheck="false" />
        <button id="chatgpt-submit" type="button" class="ghost">Complete sign-in</button>
      </details>
      <button id="chatgpt-enable" type="button" class="ghost" hidden>Enable ChatGPT plan usage</button>
      <label for="chatgpt-model">ChatGPT model</label>
      <select id="chatgpt-model"><option value="">Fetch models and choose one</option></select>
      <p class="hint">Only models returned for this account are offered. Use Fetch models below. Save AI applies the authentication choice and model.</p>
      <label class="check" for="chatgpt-background"><input id="chatgpt-background" type="checkbox" /> I allow automatic profile refresh, automatic triage and scheduled AI skills to send required mail context to OpenAI using this ChatGPT account while Morrow Mail is open.</label>
      <p class="hint">Background AI is off until you opt in here. This account permission is saved immediately. Other AI requests follow your actions. No automatic API billing fallback or account rotation.</p>
      <p><a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">Manage usage in ChatGPT</a></p>
      <button id="chatgpt-resume" type="button" class="ghost" hidden>Retry after checking usage</button>
      <dialog id="chatgpt-welcome" aria-label="You're using your ChatGPT plan" hidden>
        <strong>You're using your ChatGPT plan</strong>
        <p>Eligible AI requests use your ChatGPT plan. Manage usage and app access in ChatGPT settings.</p>
        <button id="chatgpt-got-it" type="button" class="primary">Got it</button>
      </dialog>
    </section>`;
  const $ = id => container.querySelector(`#${id}`);
  let timer;
  let snapshot = {};
  let selectedModel = "";
  let busy = false;
  let modelRevision = 0;
  const message = text => { $("chatgpt-status").textContent = text || ""; };
  function welcome() {
    const dialog = $("chatgpt-welcome");
    const show = snapshot.welcome === true && $("ai-auth-mode").value === "chatgpt";
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
    const previous = snapshot.activeId;
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
    $("chatgpt-background").checked = snapshot.backgroundConsent === true;
    $("chatgpt-background").disabled = !snapshot.connected;
    $("chatgpt-login").disabled = snapshot.available === false || snapshot.pending || busy;
    $("chatgpt-signout").disabled = !snapshot.connected || busy;
    $("chatgpt-select").disabled = !snapshot.accounts?.some(row => row.connected) || busy;
    $("chatgpt-cancel").hidden = !snapshot.pending;
    $("chatgpt-submit").disabled = !snapshot.pending || snapshot.phase !== "waiting";
    $("chatgpt-enable").hidden = !snapshot.connected || snapshot.planEnabled;
    $("chatgpt-resume").hidden = !snapshot.usagePaused;
    welcome();
    message(snapshot.available === false ? snapshot.message || "Unlock operating system secure storage to sign in." : snapshot.message);
    if (previous && previous !== snapshot.activeId) { modelRevision++; choices([]); }
    if (!snapshot.pending) $("chatgpt-callback").value = "";
    clearTimeout(timer);
    if (snapshot.pending) timer = setTimeout(() => refresh().catch(error => message(error.message)), 750);
  }
  async function refresh() { paint(await invoke("host:chatgptStatus")); }
  async function action(channel, input) {
    if (busy) return;
    busy = true;
    $("chatgpt-login").disabled = true;
    if (channel === "host:chatgptStart") paint({ ...snapshot, pending: true, phase: "starting", message: "Opening ChatGPT sign-in…" });
    let failure = "";
    try { paint(await invoke(channel, input)); }
    catch (error) {
      failure = error.message || "ChatGPT action failed. Retry when ready.";
      try { await refresh(); } catch { /* preserve last known status */ }
    }
    finally { busy = false; paint(snapshot); if (failure) message(failure); }
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
    try { paint(await invoke("host:chatgptCancel")); }
    catch (error) { message(error.message || "ChatGPT cancellation failed."); }
  });
  $("chatgpt-submit").addEventListener("click", () => {
    const url = $("chatgpt-callback").value;
    $("chatgpt-callback").value = ""; // clear before awaiting IPC, including failed callbacks
    action("host:chatgptCallback", url);
  });
  $("chatgpt-signout").addEventListener("click", () => action("host:chatgptSignOut", snapshot.activeId));
  $("chatgpt-refresh").addEventListener("click", () => action("host:chatgptStatus"));
  $("chatgpt-select").addEventListener("click", async () => {
    await action("host:chatgptSelect", $("chatgpt-account").value);
    choices([]); // an account's catalog never carries over to another registration
  });
  $("chatgpt-enable").addEventListener("click", () => action("host:chatgptStart", { accountId: snapshot.activeId, enablePlan: true }));
  $("chatgpt-background").addEventListener("change", () => action("host:chatgptPreferences", { backgroundConsent: $("chatgpt-background").checked }));
  $("chatgpt-resume").addEventListener("click", () => action("host:chatgptResumeUsage"));
  $("chatgpt-got-it").addEventListener("click", () => action("host:chatgptPreferences", { welcomeSeen: true }));
  $("chatgpt-welcome").addEventListener("cancel", () => action("host:chatgptPreferences", { welcomeSeen: true }));
  return {
    async load(config) {
      $("ai-auth-mode").value = config.authMode || "api_key";
      selectedModel = config.chatgptModel || "";
      const option = document.createElement("option"); option.value = selectedModel; option.textContent = selectedModel || "Fetch models and choose one";
      $("chatgpt-model").replaceChildren(option);
      mode();
      await refresh();
    },
    draft: () => ({ authMode: $("ai-auth-mode").value, chatgptModel: $("chatgpt-model").value }),
    refresh,
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
      clearTimeout(timer); $("chatgpt-callback").value = "";
      const dialog = $("chatgpt-welcome");
      if (dialog.open && typeof dialog.close === "function") dialog.close();
    },
  };
});
