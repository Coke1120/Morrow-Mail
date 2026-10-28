/* Email Brain's local compose preferences. Kept separate from the mail shell. */
(function () {
  const policy = window.morrowComposePolicy;
  const get = (id) => document.getElementById(id);
  let api, settings, accountId = "", accountKey = "", ready = false, busy = false;
  const refreshed = new Map();

  function status(text, error) {
    get("brain-compose-status").textContent = text;
    get("brain-compose-status").classList.toggle("error", !!error);
  }
  function lock(value) {
    busy = value;
    for (const node of get("brain-compose-form").querySelectorAll("input, textarea, select, button")) {
      node.disabled = value || (!!node.dataset.senderReset && !Object.hasOwn(settings?.accounts[accountId]?.senderNames || {}, node.dataset.senderReset));
    }
    const noAccount = !accountId;
    for (const id of ["brain-compose-aliases", "brain-compose-from", "brain-compose-default-domain", "brain-compose-refresh"]) get(id).disabled = value || noAccount;
  }
  function lines(id) {
    return get(id).value.split(/\r?\n/).map((text) => text.trim()).filter(Boolean);
  }
  function domainLines(map) {
    return Object.entries(map || {}).map(([key, rows]) => "@" + key + " = " + rows.join(", ")).join("\n");
  }
  function parseDomainLines(text, label) {
    const map = {};
    for (const line of String(text || "").split(/\r?\n/).map((row) => row.trim()).filter(Boolean)) {
      const parts = line.split("=");
      const key = policy.domain(parts[0]);
      if (parts.length !== 2 || !key) throw new Error("Use @domain = address, address on each " + label + " line.");
      if (Object.hasOwn(map, key)) throw new Error("Each " + label + " domain can appear only once.");
      map[key] = parts[1].split(/[,;]/).map((row) => row.trim()).filter(Boolean);
    }
    return map;
  }
  function keepAccount() {
    if (!accountId) return;
    settings.accounts[accountId] = {
      ...settings.accounts[accountId],
      aliases: lines("brain-compose-aliases").map((text) => {
        const parts = text.split("=");
        if (parts.length > 2) throw new Error("Use one alias = CC domain per line.");
        return { address: parts[0].trim(), domain: (parts[1] || "").trim() };
      }),
      preferredFromAddress: get("brain-compose-from").value.trim(),
      defaultDomain: get("brain-compose-default-domain").value.trim(),
    };
  }
  function providerKey(account) {
    return JSON.stringify([account.email, account.senderName, (account.sendAs || []).filter(row => row.source !== "configured")
      .map(row => [row.email, row.name, row.source, row.isDefault, row.verified, row.verificationStatus])]);
  }
  function identityAccount() {
    const account = api.accounts().find(row => row.id === accountId);
    if (!account) return null;
    const cached = refreshed.get(accountId);
    if (cached && cached.key !== providerKey(account)) refreshed.delete(accountId);
    const sendAs = refreshed.get(accountId)?.rows || account.sendAs || [];
    return { ...account, sendAs: sendAs.filter(row => row.source !== "configured") };
  }
  function paintIdentities() {
    const account = identityAccount();
    const normalized = policy.normalizeSettings(settings);
    const identities = account ? policy.identities(account, normalized) : [];
    const container = get("brain-compose-senders");
    container.replaceChildren();
    get("brain-compose-identities").textContent = identities.length
      ? "Names are saved per mailbox and exact From address. Gmail states reflect the last successful lookup."
      : "Connect a mailbox to set a display name.";
    const preferred = account ? policy.preferredFrom(account, normalized) : "";
    for (const [index, row] of identities.entries()) {
      const card = document.createElement("section"); card.className = "sender-identity";
      const title = document.createElement("h5"); title.textContent = row.email;
      const states = document.createElement("p"); states.className = "hint";
      const labels = [];
      if (row.isPrimary) labels.push("Primary address");
      else if (row.source === "gmail" && row.verified) labels.push("Gmail-verified send-as");
      else if (row.source === "configured") labels.push("Manually configured — provider sending permission not checked");
      if (row.source === "gmail" && row.isDefault) labels.push("Gmail default");
      if (row.email === preferred) labels.push("From for new mail");
      states.textContent = labels.join(" · ");
      const inputId = "sender-name-" + index;
      const label = document.createElement("label"); label.setAttribute("for", inputId);
      label.textContent = "Morrow display name for " + row.email;
      const input = document.createElement("input"); input.setAttribute("id", inputId); input.type = "text";
      input.maxLength = 200; input.value = row.displayName; input.placeholder = row.defaultName || "Address only";
      input.autocomplete = "off"; input.dataset.senderEmail = row.email;
      const source = document.createElement("p"); source.className = "hint";
      const preview = document.createElement("p"); preview.className = "sender-preview";
      preview.setAttribute("id", "sender-preview-" + index); input.setAttribute("aria-describedby", preview.id);
      const reset = document.createElement("button"); reset.type = "button"; reset.className = "ghost";
      reset.dataset.senderReset = row.email;
      reset.textContent = row.source === "gmail" ? "Use Gmail name" : "Use default name";
      const ownerId = accountId;
      const currentIdentity = () => !busy && accountId === ownerId && api.accounts().some(item => item.id === ownerId && item.email === account.email);
      function paintName() {
        const overridden = Object.hasOwn(settings.accounts[accountId]?.senderNames || {}, row.email);
        reset.disabled = !overridden;
        source.textContent = (overridden ? "Morrow override. " : "Using default. ")
          + (row.source === "gmail" ? "Gmail name: " : "Default name: ") + (row.defaultName || "address only") + ".";
        try { preview.textContent = "Recipients see: " + policy.senderPreview(row.email, policy.displayName(input.value)); }
        catch (error) { preview.textContent = error.message; }
      }
      input.addEventListener("input", () => {
        if (!currentIdentity()) return;
        const prefs = settings.accounts[accountId] ||= { aliases: [], preferredFromAddress: "", defaultDomain: "" };
        (prefs.senderNames ||= {})[row.email] = input.value;
        paintName();
      });
      reset.addEventListener("click", () => {
        if (!currentIdentity()) return;
        const names = settings.accounts[accountId]?.senderNames;
        if (names) delete names[row.email];
        input.value = row.defaultName; paintName();
      });
      paintName();
      for (const child of [title, states, label, input, source, preview, reset]) card.appendChild(child);
      container.appendChild(card);
    }
  }
  function paintAccount() {
    const prefs = settings.accounts[accountId] || {};
    get("brain-compose-aliases").value = (prefs.aliases || []).map((row) => row.address + (row.domain ? " = " + row.domain : "")).join("\n");
    get("brain-compose-from").value = prefs.preferredFromAddress || "";
    get("brain-compose-default-domain").value = prefs.defaultDomain || "";
    paintIdentities();
    lock(false);
  }
  function syncAccounts() {
    const accounts = api.accounts();
    const key = JSON.stringify(accounts.map((row) => [row.id, providerKey(row)]));
    if (key === accountKey) return;
    if (ready && accounts.some(row => row.id === accountId)) keepAccount();
    for (const id of refreshed.keys()) if (!accounts.some(row => row.id === id)) refreshed.delete(id);
    accountKey = key;
    const select = get("brain-compose-account");
    select.replaceChildren();
    for (const account of accounts) {
      const option = document.createElement("option");
      option.value = account.id; option.textContent = account.email;
      select.appendChild(option);
    }
    if (!accounts.some((row) => row.id === accountId)) {
      accountId = accounts.some((row) => row.id === api.selectedId()) ? api.selectedId() : (accounts[0]?.id || "");
    }
    select.value = accountId;
    paintAccount();
  }
  async function load(options) {
    api = options;
    if (busy) return;
    if (ready) {
      try { syncAccounts(); } catch (error) { status(error.message, true); }
      return;
    }
    lock(true);
    try {
      settings = await api.call("emailBrain:getComposeSettings");
      syncAccounts();
      get("brain-compose-domains").value = domainLines(settings.ccByDomain);
      get("brain-compose-bcc").value = domainLines(settings.bccByDomain);
      paintAccount();
      revealAdvanced();
      ready = true;
      status("Saved on this computer. No AI key is required.");
    } catch (error) { status(error.message, true); }
    finally { lock(!ready); busy = false; }
  }
  async function save(event) {
    event.preventDefault();
    if (!ready || busy) return;
    lock(true);
    try {
      keepAccount();
      const ccByDomain = parseDomainLines(get("brain-compose-domains").value, "CC");
      const bccByDomain = parseDomainLines(get("brain-compose-bcc").value, "BCC");
      const normalized = policy.normalizeSettings({ ...settings, ccByDomain, bccByDomain });
      settings = await api.call("emailBrain:saveComposeSettings", normalized);
      paintAccount();
      status("Compose defaults saved. New compositions use these names; saved drafts and scheduled mail keep their selected name.");
    } catch (error) { status(error.message, true); }
    finally { lock(false); }
  }
  async function refresh() {
    if (!ready || busy || !accountId) return;
    const target = api.accounts().find(row => row.id === accountId);
    if (!target) { syncAccounts(); return; }
    lock(true); status("Checking From addresses…");
    try {
      keepAccount();
      const result = await api.call("mail:getComposeContext", { accountId, refresh: true });
      const current = api.accounts().find(row => row.id === target.id);
      if (!current || current.email !== target.email || accountId !== target.id) throw new Error("The mailbox changed. Reopen Compose settings.");
      refreshed.set(accountId, { key: providerKey(current), rows: result.sendAs });
      paintIdentities();
      status(result.warning || "From addresses refreshed. Morrow name overrides and manually configured aliases were kept.");
    } catch (error) { status(error.message, true); }
    finally { lock(false); syncAccounts(); }
  }
  function wire() {
    get("brain-compose-form").addEventListener("submit", save);
    get("brain-compose-refresh").addEventListener("click", refresh);
    get("brain-compose-account").addEventListener("change", () => {
      if (busy) { get("brain-compose-account").value = accountId; return; }
      const next = get("brain-compose-account").value;
      try { keepAccount(); policy.normalizeSettings(settings); accountId = next; paintAccount(); }
      catch (error) { get("brain-compose-account").value = accountId; status(error.message, true); }
    });
    for (const id of ["brain-compose-aliases", "brain-compose-from"]) get(id).addEventListener("change", () => {
      if (!ready || busy) return;
      try { keepAccount(); paintIdentities(); }
      catch (error) { status(error.message, true); }
    });
  }
  function sync() {
    if (!ready || busy || !api) return;
    try { syncAccounts(); }
    catch (error) { status(error.message, true); }
  }
  function advancedHasRules(value) {
    const cc = value && value.ccByDomain;
    const bcc = value && value.bccByDomain;
    if (cc && typeof cc === "object" && Object.keys(cc).length) return true;
    if (bcc && typeof bcc === "object" && Object.keys(bcc).length) return true;
    const accounts = value && value.accounts;
    if (!accounts || typeof accounts !== "object") return false;
    return Object.values(accounts).some((row) => row && ((row.aliases && row.aliases.length) || String(row.defaultDomain || "").trim()));
  }
  function revealAdvanced() {
    const node = get("brain-compose-advanced");
    if (!node || node.dataset.ready) return;
    node.open = advancedHasRules(settings);
    node.dataset.ready = "1";
  }
  window.morrowBrainCompose = { load, wire, parseDomainLines, sync, advancedHasRules };
})();
