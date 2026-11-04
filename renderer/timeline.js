(function (root) {
  function mount({ api, document = root.document,
    openDialog = id => document.getElementById(id).showModal(),
    closeDialog = id => document.getElementById(id).close() }) {
    const node = id => document.getElementById(id);
    const dialog = node("timeline-dialog");
    if (!dialog || !api) return null;
    let sourceToken = null;
    let source = null, defaults = null, prepared = null, jobId = null, stored = null, serial = 0, listSerial = 0;
    let working = false, starting = false, earlyProgress = null, cancelRequested = false, cancelling = false;
    const errorText = {
      "timeline-selection-limit": "This downloaded thread exceeds 1,000 messages or 200 threads. Nothing was silently truncated.",
      "timeline-budget": "This downloaded thread exceeds a run limit. Nothing was sent automatically.",
      "timeline-empty": "Open a downloaded message before creating a timeline.",
      "timeline-source-changed": "Source mail or its account changed. Reopen Timeline from the message.",
      "timeline-manifest": "The source snapshot expired or changed. Reopen Timeline from the message.",
      "timeline-partial": "No usable complete bodies, or partial coverage was not accepted. Download missing mail in Mail, or accept the shown omissions.",
      "timeline-busy": "Another timeline operation is active. Wait or cancel it first.",
      "timeline-validation": "AI output failed validation after one retry. Earlier saved timelines remain unchanged.",
      "timeline-cancelled": "Generation cancelled. Data already delivered to the provider cannot be recalled.",
      "timeline-not-found": "This saved timeline is no longer available. Account removal also deletes related timelines.",
      "ai-consent-required": "Allow explicit AI actions for the saved destination in Settings → AI → AI data permission, then reopen Timeline.",
      "timeline-input": "Check the keywords and contact emails, then try again.",
      "timeline-contacts": "Use up to 100 email addresses, separated by commas or new lines.",
      "timeline-revision": "The saved timeline changed. Open it again before exporting.",
    };
    const status = text => { node("timeline-status").textContent = text; };
    async function invoke(channel, payload = {}) {
      const result = await api.invoke(channel, payload);
      if (!result?.success) throw Object.assign(new Error("Timeline operation failed"), { code: result?.error?.code });
      return result.data;
    }
    function report(error) { status(errorText[error?.code] || "Timeline operation failed. Check the AI connection and retry explicitly. No alternate provider is used."); }
    function element(tag, text, className) {
      const value = document.createElement(tag);
      value.textContent = text;
      if (className) value.className = className;
      return value;
    }
    function buttons() {
      const busy = working || starting || !!jobId;
      for (const id of ["timeline-keywords", "timeline-contacts", "timeline-partial", "timeline-format", "timeline-export-confirm"]) node(id).disabled = busy;
      node("timeline-generate").disabled = busy || !source || !dialog.open || !!(prepared && (!prepared.allowed || !prepared.coverage.included_message_count
        || (prepared.coverage.omitted_message_count > 0 && !node("timeline-partial").checked)));
      node("timeline-cancel").hidden = !jobId;
      node("timeline-cancel").disabled = cancelling;
      node("timeline-export").disabled = busy || !stored || !node("timeline-export-confirm").checked;
      node("timeline-delete").disabled = busy || !stored;
      for (const button of node("timeline-saved").querySelectorAll("button")) button.disabled = busy;
      node("timeline-close").textContent = stored ? "Close" : "Cancel";
      node("timeline-form").setAttribute("aria-busy", String(busy));
    }
    function contacts(email) {
      const list = value => Array.isArray(value) ? value : [value];
      const values = [email.fromAddress || email.from, ...list(email.to), ...list(email.cc), ...list(email.replyTo || email.recipientHeaders?.replyTo)];
      return [...new Set(values.flatMap(value => String(value?.address || value || "").match(/[^\s<>,;:"()[\]\\]+@[^\s<>,;:"()[\]\\]+/g) || []).map(value => value.toLowerCase()))];
    }
    function language() {
      const locale = root.navigator?.language || document.documentElement.lang || "en";
      if (/^zh/i.test(locale)) return /hant|tw|hk|mo/i.test(locale) ? "zh-Hant" : "zh-Hans";
      const base = locale.split("-")[0].toLowerCase();
      return ["en", "ja", "ko", "fr", "de", "es"].includes(base) ? base : "en";
    }
    function options() {
      const contactEmails = [...new Set(node("timeline-contacts").value.split(/[\s,;]+/).filter(Boolean).map(value => value.toLowerCase()))];
      if (contactEmails.length > 100 || contactEmails.some(value => value.length > 254 || !/^[^\s@<>,;]+@[^\s@<>,;]+$/.test(value))) throw { code: "timeline-contacts" };
      return { ...defaults, keywords: node("timeline-keywords").value.trim(), contactEmails };
    }
    function preview(value) {
      const previous = prepared?.coverage;
      prepared = value;
      const coverage = value.coverage;
      if (!previous || previous.selected_message_count !== coverage.selected_message_count || previous.omitted_message_count !== coverage.omitted_message_count) node("timeline-partial").checked = false;
      node("timeline-preview").textContent = `${coverage.included_message_count} downloaded messages · ${coverage.omitted_message_count} omitted (missing, incomplete or unsupported). AI: ${value.provider} · ${value.destination} · ${value.model}.`;
      node("timeline-partial-choice").hidden = !coverage.omitted_message_count;
      if (!value.allowed) report({ code: "ai-consent-required" });
      else if (!coverage.included_message_count) report({ code: "timeline-partial" });
    }
    async function prepare(current) {
      let value;
      try { value = await invoke("timeline:prepare", { selection: source, options: options(), ...(sourceToken ? { manifestToken: sourceToken } : {}) }); }
      catch (error) {
        if (serial === current && ["timeline-source-changed", "timeline-manifest"].includes(error.code)) source = null;
        throw error;
      }
      if (serial !== current) return null;
      sourceToken = value.manifestToken;
      try { await invoke("timeline:check", { manifestToken: sourceToken }); }
      catch (error) { if (serial === current) source = null; throw error; }
      if (serial !== current) return null;
      preview(value);
      return value;
    }
    async function savedList() {
      const current = ++listSerial;
      const rows = await invoke("timeline:list");
      if (current !== listSerial) return;
      node("timeline-saved").replaceChildren(...rows.map(row => {
        const button = element("button", `${new Date(row.generated_at).toLocaleString()} · ${row.id.slice(0, 8)}`, "ghost");
        button.type = "button";
        button.addEventListener("click", () => load(row.id).catch(report));
        return button;
      }));
      node("timeline-history").hidden = !rows.length;
      buttons();
    }
    async function open(email) {
      if (!email?.id || !email.accountId) return;
      openDialog("timeline-dialog");
      if (working || starting || jobId) return;
      const current = ++serial;
      sourceToken = null;
      source = { messages: [{ accountId: email.accountId, messageId: email.id }], expandThreads: true };
      defaults = { title: String(email.subject || "").replace(/[\x00-\x1f\x7f\u2028\u2029]/g, " ").trim().slice(0, 500) || "Email timeline",
        language: language(), displayTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" };
      prepared = null;
      node("timeline-keywords").value = "";
      node("timeline-contacts").value = contacts(email).join("\n");
      node("timeline-partial").checked = false;
      node("timeline-partial-choice").hidden = true;
      node("timeline-history").open = false;
      renderResult(null);
      working = true; buttons(); status("Checking downloaded mail and AI permission. No AI request is made.");
      try {
        const value = await prepare(current);
        if (value?.allowed && value.coverage.included_message_count) status("Choose Generate to send these downloaded messages and your focus to the saved AI destination.");
      } catch (error) { if (serial === current) report(error); }
      finally { if (serial === current) { working = false; buttons(); if (dialog.open) node("timeline-keywords").focus(); } }
      if (serial === current) await savedList().catch(report);
    }
    function address(value) { return value ? `${value.name ? `${value.name} ` : ""}<${value.address}>` : "Unknown sender"; }
    function renderResult(value) {
      stored = value;
      node("timeline-form").hidden = !!stored;
      node("timeline-export-confirm").checked = false;
      node("timeline-exports").hidden = !stored;
      node("timeline-result").replaceChildren();
      if (!stored) { buttons(); return; }
      const documentValue = stored.document;
      const coverage = documentValue.coverage;
      const output = node("timeline-result");
      output.append(element("h2", documentValue.title), element("p", `${coverage.included_message_count} included / ${coverage.selected_message_count} selected / ${coverage.omitted_message_count} omitted · ${documentValue.display_timezone}`),
        element("p", "AI-generated; verify against source mail. Displayed dates are mail timestamps, not dates of events mentioned in the text. Unknown and older cached timestamps are not reliable date evidence."));
      const sequence = element("ol", "", "timeline-sequence");
      sequence.setAttribute("aria-label", "Correspondence, oldest first; undated mail last");
      output.append(sequence);
      const events = [...documentValue.events].sort((a, b) => (a.occurred_at === null) - (b.occurred_at === null)
        || (Date.parse(a.occurred_at) - Date.parse(b.occurred_at)) || a.source_message_id.localeCompare(b.source_message_id));
      let previousDay = null;
      for (const [index, event] of events.entries()) {
        const section = element("li", "", "timeline-event");
        const day = event.occurred_at ? new Intl.DateTimeFormat(undefined, { timeZone: documentValue.display_timezone, dateStyle: "long" }).format(new Date(event.occurred_at)) : "Undated correspondence";
        if (day !== previousDay) { section.append(element("h3", day, "timeline-day")); previousDay = day; }
        const date = event.occurred_at ? new Intl.DateTimeFormat(undefined, { timeZone: documentValue.display_timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(event.occurred_at)) : "Unknown date";
        const time = element("time", `${index + 1}. ${date} · ${event.date_source}`, "hint");
        if (event.occurred_at) time.dateTime = event.occurred_at;
        section.append(time, element("p", event.summary, "timeline-summary"), element("p", `From: ${address(event.from)}`));
        const evidence = element("details", "", "timeline-evidence");
        evidence.append(element("summary", "Source evidence and recipients"),
          element("p", `To: ${event.to.map(address).join(", ") || "None recorded"}`), element("p", `Cc: ${event.cc.map(address).join(", ") || "None recorded"}`));
        if (event.via_alias) evidence.append(element("p", `Via alias: ${event.via_alias}`));
        if (event.attachments.length) evidence.append(element("p", `Attachment names: ${event.attachments.join(", ")}`));
        for (const action of event.open_actions) section.append(element("p", `For review: ${action}`));
        for (const unclear of event.unclear) section.append(element("p", `Unclear: ${unclear}`));
        evidence.append(element("p", `Source: ${event.source_thread_id} / ${event.source_message_id}`, "hint"));
        section.append(evidence);
        sequence.append(section);
      }
      buttons();
    }
    async function load(id) {
      if (!id || working || starting || jobId) return;
      const current = ++serial;
      working = true; buttons();
      try {
        const value = await invoke("timeline:get", { id });
        if (serial !== current) return;
        renderResult(value);
        status("Saved local timeline. Opening it makes no AI request.");
      } finally { if (serial === current) { working = false; buttons(); } }
    }
    async function cancel() {
      cancelRequested = true;
      if (!jobId || cancelling) return;
      cancelling = true; buttons();
      try { await invoke("timeline:cancel", { jobId }); status("Cancellation requested. Data already delivered cannot be recalled."); }
      catch (error) { cancelling = false; buttons(); throw error; }
    }
    function dismissed() {
      serial++; prepared = null; source = null; sourceToken = null; listSerial++;
      if (!starting && !jobId) working = false;
      if (starting || jobId) cancel().catch(report);
      buttons();
    }
    function dismiss() { dismissed(); closeDialog("timeline-dialog"); }
    async function progress(value) {
      if (starting && !jobId) { earlyProgress = value; return; }
      if (!jobId || value.jobId !== jobId) return;
      if (["completed", "failed", "cancelled"].includes(value.phase)) {
        jobId = null; prepared = null; cancelRequested = false; cancelling = false; buttons();
        if (value.phase === "completed") {
          if (dialog.open) { await load(value.timelineId); await savedList(); }
        } else report({ code: value.code || "timeline-cancelled" });
      } else status(`${value.phase === "merging" ? "Consolidating validated summaries" : "Extracting downloaded messages"}: ${value.completed} / ${value.total} · ${value.calls} calls. Cancel stops later calls, not data already delivered.`);
    }
    dialog.addEventListener("keydown", event => event.stopPropagation());
    dialog.addEventListener("cancel", event => { event.preventDefault(); dismiss(); });
    dialog.addEventListener("close", dismissed);
    node("timeline-close").addEventListener("click", dismiss);
    for (const id of ["timeline-keywords", "timeline-contacts"]) node(id).addEventListener("input", () => { prepared = null; node("timeline-partial").checked = false; buttons(); });
    node("timeline-partial").addEventListener("change", buttons);
    node("timeline-export-confirm").addEventListener("change", buttons);
    node("timeline-form").addEventListener("submit", async event => {
      event.preventDefault();
      if (node("timeline-generate").disabled) return;
      const current = ++serial;
      let submitted = false;
      working = true; buttons(); status("Preparing downloaded messages…");
      try {
        const value = await prepare(current);
        if (!value || !value.allowed || !value.coverage.included_message_count) return;
        if (value.coverage.omitted_message_count && !node("timeline-partial").checked) { status("Some messages cannot be included. Accept the shown omissions before generating."); return; }
        submitted = true; starting = true; earlyProgress = null; cancelRequested = false; buttons();
        const result = await invoke("timeline:generate", { manifestToken: value.manifestToken, optionsDigest: value.optionsDigest, acceptPartial: node("timeline-partial").checked });
        jobId = result.jobId;
        status("Starting timeline extraction…");
      } catch (error) { if (serial === current) report(error); }
      finally { if (serial === current || submitted) { working = false; starting = false; buttons(); } }
      if (earlyProgress) await progress(earlyProgress).catch(report);
      if (cancelRequested && jobId) await cancel().catch(report);
    });
    node("timeline-cancel").addEventListener("click", () => cancel().catch(report));
    node("timeline-export").addEventListener("click", async () => {
      if (!stored || !node("timeline-export-confirm").checked || working || starting || jobId) return;
      const current = ++serial;
      working = true; buttons();
      try {
        const value = await invoke("timeline:export", { id: stored.document.timeline_id, revision: stored.revision, format: node("timeline-format").value, confirmed: true });
        if (serial === current) status(value.saved ? "Timeline exported to the file you selected. No AI request or automatic send was made." : "Export cancelled.");
      } catch (error) { if (serial === current) report(error); }
      finally { if (serial === current) { node("timeline-export-confirm").checked = false; working = false; buttons(); } }
    });
    node("timeline-delete").addEventListener("click", async () => {
      if (!stored || working || starting || jobId || !root.confirm("Delete this local timeline? Exported files, backups and historical journal bytes remain.")) return;
      const id = stored.document.timeline_id;
      const current = ++serial;
      working = true; buttons();
      try {
        await invoke("timeline:delete", { id });
        if (serial !== current) return;
        renderResult(null); await savedList(); status("Local timeline deleted.");
      } catch (error) { if (serial === current) report(error); }
      finally { if (serial === current) { working = false; buttons(); } }
    });
    api.on("timeline:progress", value => progress(value).catch(report));
    api.on("mail:accountsUpdated", () => {
      // This notification also carries sync progress and cosmetic account updates.
      // Only the host can compare incarnation, credentials and frozen source data.
      const current = serial, snapshot = sourceToken;
      if (!stored && snapshot && !working && !starting && !jobId) {
        invoke("timeline:check", { manifestToken: snapshot }).catch(error => {
          if (serial !== current || sourceToken !== snapshot) return;
          serial++; prepared = null; source = null; working = false;
          report(error); buttons();
        });
      }
      if (stored) {
        const saved = stored;
        invoke("timeline:get", { id: saved.document.timeline_id }).catch(error => {
          if (serial !== current || stored !== saved || error.code !== "timeline-not-found") return;
          renderResult(null); status("A saved timeline was removed with its source account.");
        });
      }
      if (dialog.open) savedList().catch(error => { if (serial === current) report(error); });
    });
    buttons();
    return { open, renderResult };
  }
  root.morrowTimeline = { mount };
})(typeof window === "object" ? window : globalThis);
