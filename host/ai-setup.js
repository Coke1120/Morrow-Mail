const statusNode = document.getElementById("status");
const baseUrl = document.getElementById("baseUrl");
const model = document.getElementById("model");
const apiKey = document.getElementById("apiKey");
const bridge = window.aiSetup;
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
  onChange: () => { statusNode.textContent = "Unsaved changes. Save AI to apply the mode and model."; },
  onMode: chatgpt => { document.getElementById("api-fields").hidden = chatgpt; },
});
const draft = () => ({ baseUrl: baseUrl.value, model: model.value, apiKey: apiKey.value, ...accountSettings.draft() });
function keyHint(config) { apiKey.placeholder = config.hasKey ? `Saved ${config.keyHint}. Leave blank to keep it.` : "sk-…"; }
async function action(work) {
  try { await work(); } catch (error) { statusNode.textContent = error.message || "AI setup failed."; }
}
action(async () => {
  const config = await bridge.get();
  baseUrl.value = config.baseUrl || "";
  model.value = config.model || "";
  keyHint(config);
  await accountSettings.load(config);
});
document.getElementById("save").onclick = () => action(async () => {
  const saved = await bridge.save(draft());
  apiKey.value = "";
  keyHint(saved);
  statusNode.textContent = "Saved.";
});
document.getElementById("fetch").onclick = () => action(async () => {
  if (accountSettings.draft().authMode === "chatgpt") {
    const count = await accountSettings.fetchModels();
    statusNode.textContent = `Fetched ${count} ChatGPT models. Choose one, then Save AI.`;
  } else {
    const result = await bridge.listModels(draft());
    statusNode.textContent = result.ok ? `Available model ids: ${result.models.join(", ")}` : result.message;
  }
});
document.getElementById("test").onclick = () => action(async () => {
  statusNode.textContent = "Contacting the model… This uses the selected provider's usage.";
  const result = await bridge.test(draft());
  statusNode.textContent = result.ok ? `Connected. ${result.preview}` : result.message;
});
window.addEventListener("pagehide", () => accountSettings.dispose());
