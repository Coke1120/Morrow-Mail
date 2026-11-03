(function (root) {
  function mount({ api, getSelection, document = root.document }) {
    const node = id => document.getElementById(id);
    if (!node("timeline-panel")) return null;
    let selection = null, prepared = null, jobId = null, stored = null, serial = 0, working = false, starting = false, earlyProgress = null;
    const errorText = {
      "timeline-selection-limit": "Selection exceeds 1,000 messages or 200 threads. Narrow the selection; nothing was silently truncated.",
      "timeline-budget": "This selection exceeds a run limit. Select fewer or shorter messages and review again.",
      "timeline-empty": "Select downloaded messages, open a message, or run a keyword search first.",
      "timeline-source-changed": "Source mail or its account changed. Review the selection again.",
      "timeline-manifest": "The reviewed selection expired or changed. Review it again.",
      "timeline-partial": "No usable complete bodies, or partial coverage was not accepted. Download missing messages or review omissions.",
      "timeline-query": "Use 1–16 downloaded-mail word prefixes, each at most 80 characters. Provider query syntax is not supported.",
      "timeline-busy": "Another timeline operation is active. Wait or cancel it first.",
      "timeline-validation": "AI output failed validation after one retry. Earlier saved timelines remain unchanged.",
      "timeline-cancelled": "Generation cancelled. Data already delivered to the provider cannot be recalled.",
      "timeline-not-found": "This saved timeline is no longer available. Account removal also deletes related timelines.",
      "ai-consent-required": "Review the saved destination in Settings → AI → AI data permission, then review this selection again.",
      "timeline-input": "Check the title, output language and display timezone, then review again.",
      "timeline-timezone": "Enter a supported IANA timezone, such as UTC or Europe/Paris.",
      "timeline-revision": "The saved timeline changed. Open it again before exporting.",
    };
    const status = text => { node("timeline-status").textContent = text; };
    async function invoke(channel, payload = {}) {
      const result = await api.invoke(channel, payload);
      if (!result?.success) throw Object.assign(new Error("Timeline operation failed"), { code: result?.error?.code });
      return result.data;
    }
    function report(error) { status(errorText[error?.code] || "Timeline operation failed. Check the AI connection and retry explicitly. No automatic retry or alternate provider is used."); }
    function element(tag, text, className) {
      const value = document.createElement(tag);
      value.textContent = text;
      if (className) value.className = className;
      return value;
    }
    function buttons() {
      const busy = working || starting || !!jobId;
      for (const id of ["timeline-review", "timeline-from-reader", "timeline-from-selection", "timeline-from-search", "timeline-refresh", "timeline-download", "timeline-title", "timeline-language", "timeline-timezone", "timeline-expand"]) node(id).disabled = busy;
      node("timeline-generate").disabled = busy || !prepared?.allowed || !prepared.coverage.included_message_count
        || (prepared.coverage.omitted_message_count > 0 && !node("timeline-partial").checked);
      node("timeline-cancel").hidden = !jobId;
      node("timeline-export").disabled = busy || !stored || !node("timeline-export-confirm").checked;
      node("timeline-delete").disabled = busy || !stored;
      node("timeline-load").disabled = busy;
    }
    async function savedList() {
      const rows = await invoke("timeline:list");
      const selected = node("timeline-saved").value;
      const placeholder = element("option", "Choose a saved timeline");
      placeholder.value = "";
      node("timeline-saved").replaceChildren(placeholder);
      for (const row of rows) {
        const option = element("option", `${new Date(row.generated_at).toLocaleString()} · ${row.id.slice(0, 8)}`);
        option.value = row.id;
        node("timeline-saved").append(option);
      }
      if (rows.some(row => row.id === selected)) node("timeline-saved").value = selected;
    }
    function showTab(name, focus = false) {
      const timeline = name === "timeline";
      for (const [id, active] of [["message-tab", !timeline], ["timeline-tab", timeline]]) {
        node(id).setAttribute("aria-selected", String(active));
        node(id).tabIndex = active ? 0 : -1;
        if (active && focus) node(id).focus();
      }
      node("reader").hidden = timeline;
      node("timeline-panel").hidden = !timeline;
      if (timeline) {
        root.morrowMotion?.enter?.(node("timeline-panel"));
        savedList().catch(report);
      }
    }
    function options() {
      return { title: node("timeline-title").value, language: node("timeline-language").value, displayTimezone: node("timeline-timezone").value };
    }
    function invalidate() { serial++; prepared = null; node("timeline-download").hidden = true; buttons(); }
    function preview(value) {
      const coverage = value.coverage;
      const lines = [
        `Accounts (${value.accounts.length}): ${value.accounts.join(", ")}`,
        `${value.threads} threads · ${coverage.selected_message_count} selected messages · ${coverage.included_message_count} included · ${coverage.omitted_message_count} omitted`,
        `${value.missingBodies} missing, incomplete or warned bodies; ${value.invalidMetadata} unsupported metadata records omitted.`,
        value.search ? `Downloaded keyword matches: ${value.search.matched}. ${value.search.expanded ? "Expanded into downloaded threads." : "Only matching messages; no thread expansion."} The ordinary list displays at most 100 matches; this review collects up to 1,000 and refuses larger selections.` : "Selected threads use only the downloaded messages listed by this review.",
        `Provider: ${value.provider} · Destination: ${value.destination} · Model: ${value.model}`,
        `${value.chunks} extraction chunks · about ${value.estimatedInputTokens} conservative input units, before retries or consolidation. Not an exact token or price estimate.`,
        `Limits: ${value.limits.calls} calls, ${value.limits.inputTokens} input / ${value.limits.outputTokens} output units, one validation retry per step, 120 seconds per request / 10 minutes per run. Large selections can hit these limits.`,
        value.locality, value.providerTerms,
        value.allowed ? "Saved destination has explicit-action AI permission. Only Generate timeline starts extraction." : "AI data permission is off. Approve it in Settings → AI, then review again.",
        "Snapshot expires in five minutes. Later arriving mail is not added. Unknown or older cached date provenance remains visible.",
      ];
      node("timeline-preview").replaceChildren(...lines.map(line => element("p", line)));
      node("timeline-download").hidden = !value.missingBodies;
      buttons();
    }
    async function review() {
      if (!selection || working || jobId) return;
      const current = ++serial;
      prepared = null; working = true; buttons(); status("Reviewing downloaded sources. No AI request is made.");
      try {
        const value = await invoke("timeline:prepare", { selection: { ...selection, expandThreads: node("timeline-expand").checked }, options: options() });
        if (serial !== current) return;
        prepared = value;
        preview(value);
        status("Review the data, coverage and destination, then choose Generate timeline.");
      } catch (error) { if (serial === current) report(error); }
      finally { working = false; buttons(); }
    }
    async function startReview(mode) {
      if (working || starting || jobId) return;
      selection = getSelection(mode);
      showTab("timeline");
      node("timeline-preflight").hidden = false;
      node("timeline-expand").checked = selection.expandThreads;
      node("timeline-partial").checked = false;
      await review();
    }
    function address(value) { return value ? `${value.name ? `${value.name} ` : ""}<${value.address}>` : "Unknown sender"; }
    function renderResult(value) {
      stored = value;
      node("timeline-export-confirm").checked = false;
      node("timeline-exports").hidden = !stored;
      node("timeline-result").replaceChildren();
      if (!stored) { buttons(); return; }
      const documentValue = stored.document;
      const coverage = documentValue.coverage;
      const output = node("timeline-result");
      output.append(element("h2", documentValue.title), element("p", `${coverage.included_message_count} included / ${coverage.selected_message_count} selected / ${coverage.omitted_message_count} omitted · ${documentValue.display_timezone}`),
        element("p", "AI-generated; verify against source mail. Displayed dates are mail timestamps, not dates of events mentioned in the text. Unknown and older cached timestamps are not reliable date evidence."));
      for (const event of documentValue.events) {
        const section = element("section", "", "timeline-event");
        const date = event.occurred_at ? new Intl.DateTimeFormat(undefined, { timeZone: documentValue.display_timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(event.occurred_at)) : "Unknown date";
        section.append(element("h3", `${date} · ${event.date_source}`), element("p", `From: ${address(event.from)}`),
          element("p", `To: ${event.to.map(address).join(", ") || "None recorded"}`), element("p", `Cc: ${event.cc.map(address).join(", ") || "None recorded"}`));
        if (event.via_alias) section.append(element("p", `Via alias: ${event.via_alias}`));
        section.append(element("p", event.summary));
        if (event.attachments.length) section.append(element("p", `Attachment names: ${event.attachments.join(", ")}`));
        for (const action of event.open_actions) section.append(element("p", `For review: ${action}`));
        for (const unclear of event.unclear) section.append(element("p", `Unclear: ${unclear}`));
        section.append(element("p", `Source: ${event.source_thread_id} / ${event.source_message_id}`, "hint"));
        output.append(section);
      }
      buttons();
    }
    async function load(id) {
      if (!id) return;
      const current = ++serial;
      const value = await invoke("timeline:get", { id });
      if (serial !== current) return;
      renderResult(value);
      status("Saved local timeline. Opening it makes no AI request.");
    }
    async function progress(value) {
      if (starting && !jobId) { earlyProgress = value; return; }
      if (!jobId || value.jobId !== jobId) return;
      if (["completed", "failed", "cancelled"].includes(value.phase)) {
        jobId = null;
        prepared = null;
        buttons();
        if (value.phase === "completed") {
          await load(value.timelineId);
          await savedList();
        } else report({ code: value.code });
      } else status(`${value.phase === "merging" ? "Consolidating validated summaries" : "Extracting reviewed messages"}: ${value.completed} / ${value.total} · ${value.calls} calls. Cancel stops later calls, not data already delivered.`);
    }
    for (const id of ["message-tab", "timeline-tab"]) {
      node(id).addEventListener("click", () => showTab(id === "timeline-tab" ? "timeline" : "message"));
      node(id).addEventListener("keydown", event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? "message" : event.key === "End" ? "timeline" : id === "message-tab" ? "timeline" : "message";
        showTab(next, true);
      });
    }
    node("timeline-panel").addEventListener("keydown", event => event.stopPropagation());
    node("reader-tabs").addEventListener("keydown", event => {
      if (node("timeline-tab").getAttribute("aria-selected") === "true") event.stopPropagation();
    });
    node("timeline-timezone").value = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    for (const id of ["timeline-title", "timeline-language", "timeline-timezone", "timeline-expand"]) node(id).addEventListener("input", () => { invalidate(); status("Options changed. Review this selection again before generating."); });
    node("timeline-partial").addEventListener("change", buttons);
    node("timeline-export-confirm").addEventListener("change", buttons);
    node("timeline-from-reader").addEventListener("click", () => startReview("current").catch(report));
    node("timeline-from-selection").addEventListener("click", () => startReview("selected").catch(report));
    node("timeline-from-search").addEventListener("click", () => startReview("search").catch(report));
    node("timeline-review").addEventListener("click", () => startReview("current").catch(report));
    node("timeline-refresh").addEventListener("click", () => review().catch(report));
    node("timeline-download").addEventListener("click", async () => {
      if (!prepared || working || jobId) return;
      const current = ++serial;
      working = true; buttons(); status("Downloading only the frozen missing messages, without marking them read. No AI request is made.");
      try {
        const value = await invoke("timeline:download", { manifestToken: prepared.manifestToken });
        if (serial !== current) return;
        prepared = value;
        selection = value.frozenSelection;
        node("timeline-expand").checked = false;
        preview(value);
        status("Only the frozen messages were downloaded and reviewed again; thread expansion is off for this updated review. Check coverage before generating.");
      } catch (error) { prepared = null; report(error); }
      finally { working = false; buttons(); }
    });
    node("timeline-preflight").addEventListener("submit", async event => {
      event.preventDefault();
      if (node("timeline-generate").disabled || !prepared) return;
      starting = true; earlyProgress = null; buttons();
      try {
        const value = await invoke("timeline:generate", { manifestToken: prepared.manifestToken, optionsDigest: prepared.optionsDigest, acceptPartial: node("timeline-partial").checked });
        jobId = value.jobId;
        status("Starting reviewed timeline extraction…");
      } catch (error) { report(error); }
      finally { starting = false; buttons(); }
      if (earlyProgress) progress(earlyProgress).catch(report);
    });
    node("timeline-cancel").addEventListener("click", async () => {
      if (!jobId) return;
      try { await invoke("timeline:cancel", { jobId }); status("Cancellation requested. Data already delivered cannot be recalled."); } catch (error) { report(error); }
    });
    node("timeline-load").addEventListener("click", () => load(node("timeline-saved").value).catch(report));
    node("timeline-export").addEventListener("click", async () => {
      if (!stored || !node("timeline-export-confirm").checked || working || jobId) return;
      working = true; buttons();
      try {
        const value = await invoke("timeline:export", { id: stored.document.timeline_id, revision: stored.revision, format: node("timeline-format").value, confirmed: true });
        status(value.saved ? "Timeline exported to the file you selected. No AI request or automatic send was made." : "Export cancelled.");
      } catch (error) { report(error); }
      finally { node("timeline-export-confirm").checked = false; working = false; buttons(); }
    });
    node("timeline-delete").addEventListener("click", async () => {
      if (!stored || working || jobId || !root.confirm("Delete this local timeline? Exported files, backups and historical journal bytes remain.")) return;
      const id = stored.document.timeline_id;
      working = true; buttons();
      try { await invoke("timeline:delete", { id }); serial++; renderResult(null); await savedList(); status("Local timeline deleted."); }
      catch (error) { report(error); }
      finally { working = false; buttons(); }
    });
    api.on("timeline:progress", value => progress(value).catch(report));
    api.on("mail:accountsUpdated", () => {
      invalidate();
      if (stored) {
        const id = stored.document.timeline_id;
        invoke("timeline:get", { id }).catch(() => {
          if (stored?.document.timeline_id !== id) return;
          renderResult(null); status("A saved timeline was removed with its source account.");
        });
      }
    });
    buttons();
    return { showTab, startReview, renderResult };
  }
  root.morrowTimeline = { mount };
})(typeof window === "object" ? window : globalThis);
