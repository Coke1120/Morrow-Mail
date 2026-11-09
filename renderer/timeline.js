(function (root) {
  function mount({ api, document = root.document,
    openDialog = id => document.getElementById(id).showModal(),
    closeDialog = id => document.getElementById(id).close() }) {
    const node = id => document.getElementById(id);
    const dialog = node("timeline-dialog");
    if (!dialog || !api) return null;
    let sourceToken = null;
    let source = null, defaults = null, prepared = null, jobId = null, stored = null, serial = 0, listSerial = 0;
    let working = false, starting = false, earlyProgress = null, cancelRequested = false, cancelling = false, preparationFailed = false;
    let origin = null, selected = new Map(), candidates = [], searchSerial = 0, evidenceSerial = 0, sourceTrigger = null;
    const caseMode = () => node("timeline-mode").value === "case";
    const errorText = {
      "timeline-selection-limit": "This downloaded thread exceeds 1,000 messages or 200 threads. Nothing was silently truncated.",
      "timeline-budget": "Timeline reached a run limit. Shorten optional keywords and contacts, or open a smaller downloaded thread.",
      "timeline-empty": "Open a downloaded message before creating a timeline.",
      "timeline-source-changed": "Source mail or its account changed. Reopen Timeline from the message.",
      "timeline-manifest": "The source snapshot expired or changed. Reopen Timeline from the message.",
      "timeline-partial": "No usable complete bodies, or partial coverage was not accepted. Download missing mail in Mail, or accept the shown omissions.",
      "timeline-busy": "Another timeline operation is active. Wait or cancel it first.",
      "timeline-validation": "AI output failed validation after one retry. Earlier saved timelines remain unchanged.",
      "timeline-consolidation": "AI could not compact the long-message summaries within the run limits. Earlier saved timelines remain unchanged.",
      "timeline-cancelled": "Generation cancelled. Data already delivered to the provider cannot be recalled.",
      "timeline-not-found": "This saved timeline is no longer available. Account removal also deletes related timelines.",
      "ai-consent-required": "Review and allow Thread Timeline and, for Case mode, Case data use for the saved destination in Settings → AI → AI data permission, then reopen Timeline.",
      "timeline-input": "Check the keywords and contact emails, then try again.",
      "timeline-contacts": "Use up to 100 email addresses, separated by commas or new lines.",
      "timeline-revision": "The saved timeline changed. Open it again before exporting.",
      "timeline-query": "Use 1–16 local search words, at most 80 characters each. Every word must match; Gmail query syntax and To/Cc search are unavailable.",
    };
    const status = text => { node("timeline-status").textContent = text; };
    async function invoke(channel, payload = {}) {
      const result = await api.invoke(channel, payload);
      if (!result?.success) throw Object.assign(new Error("Timeline operation failed"), { code: result?.error?.code, budget: result?.error?.budget, calls: result?.error?.calls, validation: result?.error?.validation });
      return result.data;
    }
    function report(error) {
      let text = errorText[error?.code] || "Timeline operation failed. Check the AI connection and retry explicitly. No alternate provider is used.";
      const stages = { extraction: "Message extraction", consolidation: "Long-message consolidation", case: "Case overview" };
      const reasons = { parse: "invalid JSON formatting", schema: "invalid fields or text limits", reference: "missing, repeated or unsupported source references", incomplete: "an incomplete provider response" };
      const validation = error?.validation;
      if (error?.code === "timeline-validation" && Object.hasOwn(stages, validation?.stage) && Object.hasOwn(reasons, validation?.category) && validation.attempts === 2) {
        text = `${stages[validation.stage]} failed after one retry: ${reasons[validation.category]}. Earlier saved timelines remain unchanged.`;
      }
      const labels = { "source-bytes": "Email body text bytes", "metadata-bytes": "Message header and attachment-name bytes", "focus-bytes": "Optional focus bytes",
        "request-bytes": "Request input bytes", "planned-input-bytes": "Planned extraction input bytes", "chunk-count": "Planned extraction requests",
        "call-count": "AI requests", "input-bytes": "Run input bytes", "input-tokens": "Provider-reported input tokens", "output-tokens": "AI output tokens", "duration-ms": "Run time in milliseconds", "consolidation-bytes": "Summary consolidation input bytes" };
      const detail = error?.budget;
      if (error?.code === "timeline-budget" && labels[detail?.kind] && Number.isSafeInteger(detail.actual) && Number.isSafeInteger(detail.limit)) {
        text = `${labels[detail.kind]}: ${detail.kind === "source-bytes" ? "at least " : ""}${detail.actual.toLocaleString()} / ${detail.limit.toLocaleString()} limit. ${["focus-bytes", "request-bytes"].includes(detail.kind) ? "Shorten optional keywords and contacts." : "Open a smaller downloaded thread; focus does not filter messages."}`;
      }
      if (Number.isSafeInteger(error?.calls) && error.calls >= 0) text += error.calls
        ? ` ${error.calls} AI request${error.calls === 1 ? " was" : "s were"} attempted. Data may already have reached the saved provider and cannot be recalled. Retrying sends the reviewed mail again.`
        : " No AI request was started for this attempt.";
      status(text);
    }
    function element(tag, text, className) {
      const value = document.createElement(tag);
      value.textContent = text;
      if (className) value.className = className;
      return value;
    }
    function buttons() {
      const busy = working || starting || !!jobId;
      for (const id of ["timeline-keywords", "timeline-contacts", "timeline-partial", "timeline-format", "timeline-export-confirm", "timeline-mode", "timeline-case-title", "timeline-search", "timeline-search-button", "timeline-review-case"]) node(id).disabled = busy;
      for (const control of node("timeline-case").querySelectorAll("input[type=checkbox], select, .timeline-source-button, .timeline-remove")) control.disabled = busy;
      node("timeline-case-confirm").disabled = busy || !prepared;
      node("timeline-review-case").disabled = busy || !sourceToken || !selected.size;
      node("timeline-generate").disabled = busy || preparationFailed || !source || !dialog.open || !!(prepared && (prepared.budget || !prepared.allowed || !prepared.coverage.included_message_count
        || (prepared.coverage.omitted_message_count > 0 && !node("timeline-partial").checked))) || (caseMode() && (!prepared || !node("timeline-case-confirm").checked));
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
      return { ...defaults, ...(caseMode() ? { mode: "case", title: node("timeline-case-title").value.trim() || defaults.title } : {}), keywords: node("timeline-keywords").value.trim(), contactEmails };
    }
    function preview(value) {
      const previous = prepared?.coverage;
      prepared = value;
      const coverage = value.coverage;
      if (!previous || previous.selected_message_count !== coverage.selected_message_count || previous.omitted_message_count !== coverage.omitted_message_count) node("timeline-partial").checked = false;
      node("timeline-preview").textContent = `${coverage.included_message_count} included / ${coverage.selected_message_count} selected · ${value.threads} threads · ${coverage.omitted_message_count} omitted (missing, incomplete or unsupported). AI: ${value.provider} · ${value.destination} · ${value.model}. ${caseMode() ? "Case overview adds synthesis requests under the same run limits; the estimate covers initial extraction only. " : ""}AI receives body text (including quoted history; exact repeated quotes may reference a complete source in the same request), subject, sender, mail dates/provenance, attachment names and optional focus. To/Cc remain local evidence; body text and focus can still contain recipient addresses. No attachment file contents. ${value.locality || ""} ${value.providerTerms || ""}`;
      const processing = value.processing;
      node("timeline-processing").hidden = !processing;
      const bodyCounts = processing ? `Email body text: ${processing.sourceBytes.toLocaleString()} bytes / ${value.limits.sourceBytes.toLocaleString()}-byte capture limit.` : "";
      const planCounts = processing?.planned === false ? " No valid body-processing or extraction plan; reduce selection or focus. No AI request was started." : processing ? ` Literal body text processed: ${processing.processedBodyBytes.toLocaleString()} bytes; ${processing.repeatedBytes.toLocaleString()} repeated quote bytes shared through ${processing.sharedQuotes} exact references. Planned extraction: ${value.chunks} requests, ${value.estimatedInputBytes.toLocaleString()} serialized input bytes / ${value.limits.inputBytes.toLocaleString()}-byte run budget. Retries and synthesis also use the run budget.` : "";
      node("timeline-processing-counts").textContent = `${bodyCounts}${planCounts} Up to ${value.limits.calls} AI requests, ${value.limits.outputTokens.toLocaleString()} output tokens and ${value.limits.jobMs / 60000} minutes; no exact price estimate.`;
      node("timeline-processing-sources").replaceChildren(...(processing?.messages || []).map(message => element("li", `${message.from?.name || message.from?.address || "Unknown sender"} · ${message.occurredAt || "Unknown mail date"} · ${message.subject || "No subject"}: ${message.bodyBytes.toLocaleString()} body bytes${processing.planned === false ? ". Processing plan unavailable." : `, ${message.processedBodyBytes.toLocaleString()} literal bytes, ${message.sharedQuotes} shared quotes.`}`)));
      node("timeline-partial-choice").hidden = !coverage.omitted_message_count;
      if (value.budget) report({ code: "timeline-budget", budget: value.budget, calls: 0 });
      else if (!value.allowed) report({ code: "ai-consent-required" });
      else if (!coverage.included_message_count) report({ code: "timeline-partial" });
    }
    async function prepare(current) {
      node("timeline-processing").hidden = true;
      let value;
      try { value = await invoke("timeline:prepare", { selection: source, options: options(), ...(sourceToken ? { manifestToken: sourceToken } : {}) }); }
      catch (error) {
        if (serial === current) preparationFailed = true;
        if (serial === current && ["timeline-source-changed", "timeline-manifest"].includes(error.code)) source = null;
        throw error;
      }
      if (serial !== current) return null;
      preparationFailed = false;
      sourceToken = value.manifestToken;
      try { await invoke("timeline:check", { manifestToken: sourceToken }); }
      catch (error) { if (serial === current) source = null; throw error; }
      if (serial !== current) return null;
      preview(value);
      return value;
    }
    function invalidateCase() {
      prepared = null; preparationFailed = false;
      node("timeline-case-confirm").checked = false;
      node("timeline-partial").checked = false;
      node("timeline-processing").hidden = true;
      node("timeline-preview").textContent = "Selection or focus changed. Review selected mail again before Generate.";
      buttons();
    }
    function selectionSource() {
      return { messages: [...selected.values()].map(value => ({ accountId: value.accountId, messageId: value.messageId, phase: value.phase })), expandThreads: false };
    }
    async function showSource(payload, trigger) {
      const current = ++evidenceSerial;
      sourceTrigger = trigger;
      node("timeline-source").hidden = false;
      node("timeline-source-content").textContent = "Reading cached evidence…";
      try {
        const mail = await invoke("timeline:source", payload);
        if (current !== evidenceSerial || !dialog.open) return;
        node("timeline-source-content").replaceChildren(element("h4", mail.subject || "No subject"),
          element("p", `From: ${mail.from}`), element("p", `To: ${(mail.to || []).map(value => typeof value === "string" ? value : address(value)).join(", ")}`), element("p", `Cc: ${(mail.cc || []).map(value => typeof value === "string" ? value : address(value)).join(", ")}`),
          element("p", `Mail date: ${mail.date || "Unknown"} · ${mail.dateSource} · ${mail.complete ? "Downloaded" : "Incomplete or warned"}`),
          element("pre", mail.text || "No cached body. No download was started."));
      } catch (error) {
        if (current === evidenceSerial) node("timeline-source-content").textContent = error.code === "timeline-source-changed"
          ? "Cached source is unavailable or changed since capture. The saved report remains historical evidence; no download was started."
          : "Cannot read this cached source. Reopen Timeline if its source snapshot expired.";
      }
      if (current === evidenceSerial && dialog.open) node("timeline-source").focus();
    }
    function sourceButton(text, payload) {
      const button = element("button", text, "ghost timeline-source-button"); button.type = "button";
      button.addEventListener("click", () => showSource(payload.manifestToken !== undefined ? { ...payload, manifestToken: sourceToken } : payload, button));
      return button;
    }
    function paintSelection() {
      node("timeline-selection").replaceChildren(...[...selected.values()].map(mail => {
        const row = element("div", "", "timeline-pick");
        const label = element("label", "", "timeline-choice");
        const check = element("input", ""); check.type = "checkbox"; check.checked = true;
        label.append(check, element("span", `${mail.subject || "No subject"} · ${mail.from} · ${mail.date || "Unknown mail date"} (${mail.dateSource}) · ${mail.complete ? "Downloaded" : "May be omitted"}`));
        check.addEventListener("change", () => { selected.delete(mail.messageId); source = selectionSource(); invalidateCase(); paintSelection(); });
        const phaseLabel = element("label", ""); phaseLabel.append(element("span", "Role: "));
        const phase = element("select", ""); phase.setAttribute("aria-label", `Role for ${mail.subject || "message"}`);
        for (const [value, text] of [["main", "Main"], ["background", "Background"]]) { const option = element("option", text); option.value = value; phase.append(option); }
        phase.value = mail.phase; phaseLabel.append(phase);
        phase.addEventListener("change", () => { mail.phase = phase.value; source = selectionSource(); invalidateCase(); });
        row.append(label, phaseLabel, sourceButton("Read cached source", { manifestToken: sourceToken, messageId: mail.messageId }));
        return row;
      }));
      node("timeline-candidates").replaceChildren(...candidates.filter(mail => !selected.has(mail.messageId)).map(mail => {
        const row = element("div", "", "timeline-pick");
        const label = element("label", "", "timeline-choice");
        const check = element("input", ""); check.type = "checkbox"; check.disabled = selected.size >= 1000;
        label.append(check, element("span", `${mail.subject || "No subject"} · ${mail.from} · ${mail.date || "Unknown mail date"} (${mail.dateSource})`));
        check.addEventListener("change", () => { if (selected.size >= 1000) return; selected.set(mail.messageId, { ...mail, phase: "main" }); source = selectionSource(); invalidateCase(); paintSelection(); });
        row.append(label, sourceButton("Read cached source", { manifestToken: sourceToken, messageId: mail.messageId }));
        return row;
      }));
      buttons();
    }
    async function search() {
      if (!caseMode() || !sourceToken || working || starting || jobId) return;
      const current = ++searchSerial, session = serial;
      working = true; invalidateCase(); buttons();
      node("timeline-search-status").textContent = "Searching downloaded mail in this account…";
      try {
        const value = await invoke("timeline:search", { manifestToken: sourceToken, query: node("timeline-search").value.trim() });
        if (current !== searchSerial || session !== serial) return;
        candidates = value.messages;
        node("timeline-search-status").textContent = `${value.queryCapped ? "At least " : ""}${value.matched} cached matches (label copies may repeat); showing ${candidates.length}. ${value.limited ? "Query limited; refine or search variants. " : ""}Only selected messages are used. Older, undownloaded or differently worded mail may be missing.`;
        paintSelection();
      } catch (error) { if (current === searchSerial && session === serial) { candidates = []; paintSelection(); report(error); node("timeline-search-status").textContent = "Search failed. Previous selected messages remain; no AI request was made."; } }
      finally { if (current === searchSerial && session === serial) { working = false; buttons(); } }
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
      origin = { source, accountId: email.accountId, email };
      selected = new Map(); candidates = []; searchSerial++; evidenceSerial++;
      node("timeline-processing").hidden = true;
      node("timeline-mode").value = "thread";
      node("timeline-case").hidden = true;
      node("timeline-case-confirm").checked = false;
      node("timeline-search").value = "";
      node("timeline-search-status").textContent = "";
      node("timeline-source").hidden = true;
      node("timeline-description").textContent = "Use this message and its downloaded thread. No older mail is fetched.";
      defaults = { title: String(email.subject || "").replace(/[\x00-\x1f\x7f\u2028\u2029]/g, " ").trim().slice(0, 500) || "Email timeline",
        language: language(), displayTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" };
      node("timeline-case-title").value = defaults.title;
      prepared = null; preparationFailed = false;
      node("timeline-keywords").value = "";
      node("timeline-contacts").value = contacts(email).join("\n");
      node("timeline-partial").checked = false;
      node("timeline-partial-choice").hidden = true;
      node("timeline-history").open = false;
      renderResult(null);
      working = true; buttons(); status("Checking downloaded mail and AI permission. No AI request is made.");
      try {
        const value = await prepare(current);
        if (value) {
          origin.seedMessages = value.messages || [{ messageId: email.id, accountId: email.accountId, subject: email.subject, from: email.from, date: email.date, complete: true, phase: "main" }];
          selected = new Map(origin.seedMessages.map(mail => [mail.messageId, { ...mail, phase: "main" }]));
          node("timeline-case-scope").textContent = `Account: ${value.accounts.join(", ")}. Only local downloaded data from this account. Other mailboxes, calls and undownloaded mail are outside coverage.`;
        }
        if (value?.allowed && !value.budget && value.coverage.included_message_count) status("Choose Generate to send these downloaded messages and your focus to the saved AI destination.");
      } catch (error) { if (serial === current) report({ ...error, calls: 0 }); }
      finally { if (serial === current) { working = false; buttons(); if (dialog.open) node("timeline-keywords").focus(); } }
      if (serial === current) await savedList().catch(report);
    }
    function address(value) { return value ? `${value.name ? `${value.name} ` : ""}<${value.address}>` : "Unknown sender"; }
    function renderResult(value) {
      evidenceSerial++; node("timeline-source").hidden = true; node("timeline-source-content").replaceChildren();
      stored = value;
      node("timeline-form").hidden = !!stored;
      node("timeline-export-confirm").checked = false;
      node("timeline-exports").hidden = !stored;
      node("timeline-result").replaceChildren();
      if (!stored) { buttons(); return; }
      const documentValue = stored.document;
      const coverage = documentValue.coverage;
      const events = [...documentValue.events].sort((a, b) => (a.occurred_at === null) - (b.occurred_at === null)
        || (Date.parse(a.occurred_at) - Date.parse(b.occurred_at)) || a.source_message_id.localeCompare(b.source_message_id));
      const output = node("timeline-result");
      output.append(element("h2", documentValue.title), element("p", `${coverage.included_message_count} included / ${coverage.selected_message_count} selected / ${coverage.omitted_message_count} omitted · ${documentValue.display_timezone}`),
        element("p", "AI-generated; verify against source mail. Displayed dates are mail timestamps, not dates of events mentioned in the text. Unknown and older cached timestamps are not reliable date evidence."));
      const report = documentValue.case_report;
      if (report) {
        const scope = documentValue.case_scope;
        output.append(element("p", `Downloaded mail in one account · ${scope.search_count} local searches · ${scope.limited_search_count} limited queries. Selected sources only; neither mailbox nor search is complete. To/Cc are local evidence and were not independently supplied to AI.`, "hint"));
        for (const [key, heading] of [["current_status", "Current status · as of selected correspondence"], ["follow_ups", "Follow-ups for review"], ["gaps", "Unresolved gaps and contradictions"], ["dates", "Mentioned events and deadlines · separate from mail dates"]]) {
          const section = element("section", "", "timeline-case-section"); section.append(element("h3", heading));
          if (!report[key].length) section.append(element("p", "No specific item identified in selected evidence. This does not establish completeness or completion.", "hint"));
          for (const item of report[key]) {
            const point = element("div", "", "timeline-case-item");
            point.append(element("p", `${item.kind ? `${item.kind === "deadline" ? "Deadline" : "Event"}: ${item.date_text} · ` : ""}${item.text}`), element("p", `Uncertainty: ${item.uncertainty}`, "hint"));
            for (const id of item.source_message_ids) {
              const index = events.findIndex(event => event.source_message_id === id);
              point.append(sourceButton(`Read source ${index + 1}`, { id: documentValue.timeline_id, sourceMessageId: id }));
            }
            section.append(point);
          }
          output.append(section);
        }
        output.append(element("p", "Calls, attachments and other mailboxes may contain information absent here. Follow-ups are suggestions; nothing is automatically checked off, sent or changed.", "hint"));
      }
      output.append(element("h3", report ? "Correspondence · Main / Background" : "Correspondence"));
      const sequence = element("ol", "", "timeline-sequence");
      sequence.setAttribute("aria-label", "Correspondence, oldest first; undated mail last");
      output.append(sequence);
      let previousDay = null;
      for (const [index, event] of events.entries()) {
        const section = element("li", "", "timeline-event");
        if (event.phase) { section.dataset.phase = event.phase; section.append(element("p", event.phase === "main" ? "Main" : "Background", "timeline-phase")); }
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
        evidence.append(sourceButton("Read cached source", { id: documentValue.timeline_id, sourceMessageId: event.source_message_id }));
        section.append(evidence);
        sequence.append(section);
      }
      if (report) {
        const filters = element("div", "", "row timeline-filters"); filters.setAttribute("role", "group"); filters.setAttribute("aria-label", "Chronology phase");
        for (const [phase, text] of [["all", "All"], ["main", "Main"], ["background", "Background"]]) {
          const button = element("button", text, "ghost"); button.type = "button"; button.setAttribute("aria-pressed", String(phase === "all"));
          button.addEventListener("click", () => {
            for (const sibling of filters.children) sibling.setAttribute("aria-pressed", String(sibling === button));
            for (const entry of sequence.children) entry.hidden = phase !== "all" && entry.dataset.phase !== phase;
          }); filters.append(button);
        }
        output.insertBefore(filters, sequence);
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
      searchSerial++; evidenceSerial++; node("timeline-source").hidden = true;
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
        } else {
          if (["timeline-source-changed", "timeline-manifest"].includes(value.code)) node("timeline-processing").hidden = true;
          report({ code: value.code || "timeline-cancelled", budget: value.budget, calls: value.calls, validation: value.validation });
        }
      } else status(`${value.phase === "merging" ? "Consolidating validated summaries" : "Extracting downloaded messages"}: ${value.completed} / ${value.total} · ${value.calls} calls. Cancel stops later calls, not data already delivered.`);
    }
    dialog.addEventListener("keydown", event => event.stopPropagation());
    dialog.addEventListener("cancel", event => { event.preventDefault(); dismiss(); });
    dialog.addEventListener("close", dismissed);
    node("timeline-close").addEventListener("click", dismiss);
    node("timeline-source-close").addEventListener("click", () => { evidenceSerial++; node("timeline-source").hidden = true; if (sourceTrigger?.isConnected) sourceTrigger.focus(); });
    node("timeline-mode").addEventListener("change", async () => {
      if (!origin || working || starting || jobId) return;
      const current = ++serial; searchSerial++; evidenceSerial++; node("timeline-source").hidden = true;
      node("timeline-case").hidden = !caseMode();
      node("timeline-description").textContent = caseMode() ? "Build a case from selected downloaded messages across threads. Review sources before AI transmission." : "Use this message and its downloaded thread. No older mail is fetched.";
      source = caseMode() ? selectionSource() : origin.source;
      invalidateCase();
      if (caseMode()) {
        working = true; buttons();
        try {
          if (!sourceToken) {
            const value = await invoke("timeline:prepare", { contextOnly: true,
              selection: { messages: [{ accountId: origin.accountId, messageId: origin.email.id }], expandThreads: false },
              options: { ...defaults, mode: "thread" } });
            if (serial !== current) return;
            sourceToken = value.manifestToken;
            await invoke("timeline:check", { manifestToken: sourceToken });
            if (serial !== current) return;
            node("timeline-case-scope").textContent = `Account: ${value.accounts.join(", ")}. Only local downloaded data from this account. Other mailboxes, calls and undownloaded mail are outside coverage.`;
          }
          paintSelection(); status("Search variants and choose Main / Background sources, then review the selected mail. No AI request is made.");
        } catch (error) { if (serial === current) { sourceToken = null; preparationFailed = true; report({ ...error, calls: 0 }); } }
        finally { if (serial === current) { working = false; buttons(); } }
        return;
      }
      working = true; buttons();
      try { const value = await prepare(current); if (value?.allowed && !value.budget && value.coverage.included_message_count) status("Choose Generate to send this downloaded thread to the saved AI destination."); }
      catch (error) { if (serial === current) report(error); }
      finally { if (serial === current) { working = false; buttons(); } }
    });
    node("timeline-search-button").addEventListener("click", search);
    node("timeline-search").addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); search(); } });
    node("timeline-review-case").addEventListener("click", async () => {
      if (!caseMode() || working || starting || jobId || !selected.size) return;
      const current = ++serial;
      source = selectionSource(); working = true; node("timeline-case-confirm").checked = false; buttons();
      try { const value = await prepare(current); if (serial === current) { paintSelection(); if (value?.allowed && !value.budget && value.coverage.included_message_count) status("Review selected sources and omissions, then confirm the case review before Generate. No AI request is made."); } }
      catch (error) { if (serial === current) report({ ...error, calls: 0 }); }
      finally { if (serial === current) { working = false; buttons(); } }
    });
    node("timeline-case-confirm").addEventListener("change", buttons);
    for (const id of ["timeline-keywords", "timeline-contacts", "timeline-case-title"]) node(id).addEventListener("input", () => { if (caseMode()) invalidateCase(); else { prepared = null; preparationFailed = false; node("timeline-processing").hidden = true; node("timeline-partial").checked = false; buttons(); } });
    node("timeline-partial").addEventListener("change", buttons);
    node("timeline-export-confirm").addEventListener("change", buttons);
    node("timeline-form").addEventListener("submit", async event => {
      event.preventDefault();
      if (node("timeline-generate").disabled) return;
      const current = ++serial;
      let submitted = false;
      working = true; buttons(); status("Preparing downloaded messages…");
      try {
        const value = caseMode() ? prepared : await prepare(current);
        if (!value || value.budget || !value.allowed || !value.coverage.included_message_count) return;
        if (caseMode() && !node("timeline-case-confirm").checked) return;
        if (value.coverage.omitted_message_count && !node("timeline-partial").checked) { status("Some messages cannot be included. Accept the shown omissions before generating."); return; }
        submitted = true; starting = true; earlyProgress = null; cancelRequested = false; buttons();
        const result = await invoke("timeline:generate", { manifestToken: value.manifestToken, optionsDigest: value.optionsDigest, acceptPartial: node("timeline-partial").checked, ...(caseMode() ? { reviewed: true } : {}) });
        jobId = result.jobId;
        status("Starting timeline extraction…");
      } catch (error) { if (serial === current) report({ ...error, calls: 0 }); }
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
          node("timeline-processing").hidden = true;
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
