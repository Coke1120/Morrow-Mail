const statusNode = document.getElementById("status");
const baseUrl = document.getElementById("baseUrl");
const model = document.getElementById("model");
const apiKey = document.getElementById("apiKey");
const bridge = window.aiSetup;
let operation = 0;
let viewRevision = 0;
let saveBusy = false;
const changed = () => { statusNode.textContent = "Unsaved changes. Save to apply them."; };
const authActions = {
  "host:chatgptStatus": bridge.chatgptStatus, "host:chatgptStart": bridge.chatgptStart,
  "host:chatgptCallback": bridge.chatgptCallback, "host:chatgptCancel": bridge.chatgptCancel,
  "host:chatgptSignOut": bridge.chatgptSignOut, "host:chatgptSelect": bridge.chatgptSelect,
  "host:chatgptPreferences": bridge.chatgptPreferences, "host:chatgptResumeUsage": bridge.chatgptResumeUsage,
  "host:aiListModels": bridge.listModels,
};
const accountSettings = window.morrowChatgptSettings.mount({
  container: document.getElementById("ai-account-settings"),
  invoke: (channel, input) => authActions[channel](input),
  onChange: changed,
  onContext: () => { operation++; statusNode.textContent = ""; },
  onMode: chatgpt => { document.getElementById("api-fields").hidden = chatgpt; },
});
const draft = () => ({ baseUrl: baseUrl.value, model: model.value, apiKey: apiKey.value, ...accountSettings.draft() });
const formState = input => JSON.stringify([String(input.baseUrl || "").trim(), String(input.model || "").trim(), !!input.apiKey,
  input.authMode || "api_key", String(input.chatgptModel || "").trim()]);
const current = (owner, view, input, context) => owner === operation && view === viewRevision
  && JSON.stringify(input) === JSON.stringify(draft()) && context === accountSettings.context();
function keyHint(config) { apiKey.placeholder = config.hasKey ? `Saved ${config.keyHint}. Leave blank to keep it.` : "sk-…"; }
async function load() {
  const view = ++viewRevision;
  try {
    const config = await bridge.get();
    if (view !== viewRevision) return;
    baseUrl.value = config.baseUrl || "";
    model.value = config.model || "";
    keyHint(config);
    await accountSettings.load(config);
  } catch (error) {
    if (view === viewRevision) statusNode.textContent = error.message || "AI setup failed.";
  }
}
load();
for (const field of [baseUrl, model, apiKey]) {
  field.addEventListener("input", changed);
  field.addEventListener("change", changed);
}
document.getElementById("save").onclick = async () => {
  if (saveBusy) return;
  const input = draft(), owner = ++operation, view = viewRevision;
  saveBusy = true;
  document.getElementById("save").disabled = true;
  statusNode.textContent = "Saving…";
  try {
    const saved = await bridge.save(input);
    if (view !== viewRevision) return;
    if (apiKey.value === input.apiKey) apiKey.value = "";
    if (baseUrl.value === input.baseUrl) baseUrl.value = saved.baseUrl;
    if (model.value === input.model) model.value = saved.model;
    keyHint(saved);
    if (owner === operation) statusNode.textContent = formState(draft()) === formState(saved)
      ? "Saved." : "Earlier settings saved. Your newer changes are not saved.";
  } catch (error) {
    if (owner === operation && view === viewRevision) statusNode.textContent = error.message || "Could not save AI settings.";
  } finally {
    saveBusy = false;
    document.getElementById("save").disabled = false;
  }
};
document.getElementById("fetch").onclick = async () => {
  const input = draft(), owner = ++operation, view = viewRevision, context = accountSettings.context();
  statusNode.textContent = "Fetching models…";
  try {
    if (input.authMode === "chatgpt") {
      const count = await accountSettings.fetchModels();
      if (owner === operation && view === viewRevision && draft().authMode === "chatgpt" && context === accountSettings.context()) {
        statusNode.textContent = count ? `Fetched ${count} ChatGPT models. Choose one, then Save.` : "No ChatGPT models are available for this account.";
      }
    } else {
      const result = await bridge.listModels(input);
      if (current(owner, view, input, context)) statusNode.textContent = result.ok ? `Available model ids: ${result.models.join(", ")}` : result.message;
    }
  } catch (error) {
    if (current(owner, view, input, context)) statusNode.textContent = error.message || "Could not fetch models.";
  }
};
document.getElementById("test").onclick = async () => {
  const input = draft(), owner = ++operation, view = viewRevision, context = accountSettings.context();
  statusNode.textContent = "Contacting the model… This uses the selected provider's usage.";
  try {
    const result = await bridge.test(input);
    if (current(owner, view, input, context)) statusNode.textContent = result.ok ? `Connected. ${result.preview}` : result.message;
    else if (owner === operation && view === viewRevision) statusNode.textContent = "Settings changed. Test the current settings again.";
  } catch (error) {
    if (current(owner, view, input, context)) statusNode.textContent = error.message || "AI setup failed.";
    else if (owner === operation && view === viewRevision) statusNode.textContent = "Settings changed. Test the current settings again.";
  }
};
window.addEventListener("pagehide", () => {
  viewRevision++; operation++;
  accountSettings.dispose();
});
