/* Email Brain's local compose preferences. Kept separate from the mail shell. */
(function () {
  const policy = window.morrowComposePolicy;
  const get = (id) => document.getElementById(id);
  let api, settings, accountId = "", accountKey = "", ready = false, busy = false;

  function status(text, error) {
    get("brain-compose-status").textContent = text;
    get("brain-compose-status").classList.toggle("error", !!error);
  }
  function lock(value) {
    busy = value;
    for (const node of get("brain-compose-form").querySelectorAll("input, textarea, select, button")) node.disabled = value;
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
      aliases: lines("brain-compose-aliases").map((text) => {
        const parts = text.split("=");
        if (parts.length > 2) throw new Error("Use one alias = CC domain per line.");
        return { address: parts[0].trim(), domain: (parts[1] || "").trim() };
      }),
      preferredFromAddress: get("brain-compose-from").value.trim(),
      defaultDomain: get("brain-compose-default-domain").value.trim(),
    };
  }
  function paintAccount() {
    const prefs = settings.accounts[accountId] || {};
    get("brain-compose-aliases").value = (prefs.aliases || []).map((row) => row.address + (row.domain ? " = " + row.domain : "")).join("\n");
    get("brain-compose-from").value = prefs.preferredFromAddress || "";
    get("brain-compose-default-domain").value = prefs.defaultDomain || "";
    const account = api.accounts().find((row) => row.id === accountId);
    const identities = account ? policy.identities(account, settings) : [];
    get("brain-compose-identities").textContent = identities.length
      ? "Known From addresses: " + identities.map((row) => row.email).join(", ") : "Connect a mailbox to configure aliases.";
    lock(false);
  }
  function syncAccounts() {
    const accounts = api.accounts();
    const key = JSON.stringify(accounts.map((row) => [row.id, row.email]));
    if (key === accountKey) return;
    if (ready) keepAccount();
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
      status("Compose defaults saved. They apply the next time you open compose.");
    } catch (error) { status(error.message, true); }
    finally { lock(false); }
  }
  async function refresh() {
    if (!ready || busy || !accountId) return;
    lock(true); status("Checking From addresses…");
    try {
      const result = await api.call("mail:getComposeContext", { accountId, refresh: true });
      get("brain-compose-identities").textContent = "Known From addresses: " + result.sendAs.map((row) => row.email).join(", ");
      status(result.warning || "From addresses refreshed. Gmail lists only verified send-as identities; configure Outlook and IMAP aliases below.");
    } catch (error) { status(error.message, true); }
    finally { lock(false); }
  }
  function wire() {
    get("brain-compose-form").addEventListener("submit", save);
    get("brain-compose-refresh").addEventListener("click", refresh);
    get("brain-compose-account").addEventListener("change", () => {
      const next = get("brain-compose-account").value;
      try { keepAccount(); accountId = next; paintAccount(); }
      catch (error) { get("brain-compose-account").value = accountId; status(error.message, true); }
    });
  }
  function sync() {
    if (!ready || busy || !api) return;
    try { syncAccounts(); }
    catch (error) { status(error.message, true); }
  }
  window.morrowBrainCompose = { load, wire, parseDomainLines, sync };
})();
