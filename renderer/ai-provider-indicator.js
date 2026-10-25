// A local configuration read identifies the saved billing path near AI work.
(function () {
  let revision = 0;
  function paint(config) {
    revision++;
    for (const node of document.querySelectorAll("[data-ai-provider]")) node.hidden = config?.authMode !== "chatgpt";
  }
  async function refresh() {
    const current = ++revision;
    try {
      const config = await window.morrow.invoke("host:aiGetConfig");
      if (current === revision) paint(config);
    } catch { /* no provider claim when local configuration is unavailable */ }
  }
  window.morrowAiIndicator = { paint, refresh };
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  refresh();
})();
