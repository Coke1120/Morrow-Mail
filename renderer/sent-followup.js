/* Bundled first-party controls for local Sent follow-up reminders. */
(function () {
  function make(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function button(text, run, className = "ghost") {
    const node = make("button", text, className);
    node.type = "button";
    node.addEventListener("click", run);
    return node;
  }

  function localDateTime(ms) {
    const date = new Date(ms);
    const local = new Date(ms - date.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 16);
  }

  function create({ call, paintOriginal }) {
    const request = (action, fields) => call("mail:sentFollowups", { action, ...fields });
    const dialog = make("dialog");
    const panel = make("div", "", "dialog-body");
    const heading = make("h2");
    heading.id = "sent-followups-heading";
    dialog.id = "sent-followups-dialog";
    dialog.setAttribute("aria-labelledby", heading.id);
    const status = make("p", "", "hint");
    status.setAttribute("role", "status");
    const content = make("div");
    panel.append(heading, content, status);
    dialog.appendChild(panel);
    document.body.appendChild(dialog);
    let timer, revision = 0, rows = [], page = "", listSignature;
    let running, rerun = false, shortcut;

    function show(title, next) {
      ++revision;
      page = next;
      heading.textContent = title;
      status.textContent = "";
      content.replaceChildren();
      if (!dialog.open) dialog.showModal();
    }
    function close() { dialog.close(); }
    dialog.addEventListener("close", () => { if (!dialog.open) { ++revision; page = ""; } });
    function fail(error) { status.textContent = error?.message || "The reminder could not be checked."; }
    function target(row) {
      return { accountId: row.accountId, messageId: row.messageId, expectedDueAt: row.dueAt };
    }

    function edit(row) {
      show(row.dueAt == null ? "Remind me if there’s no reply" : "Change reminder", "edit");
      const form = make("form");
      const label = make("label", "Date and time on this device");
      const date = make("input");
      date.type = "datetime-local";
      date.required = true;
      date.value = localDateTime(row.dueAt > Date.now() ? row.dueAt : Date.now() + 86_400_000);
      label.appendChild(date);
      const save = make("button", "Save reminder", "primary");
      save.type = "submit";
      const controls = make("div", "", "row");
      controls.append(button("Cancel", close), save);
      form.append(label, controls);
      content.append(make("p", row.subject), make("p", row.recipient, "hint"), form);
      const editing = revision;
      form.addEventListener("submit", async event => {
        event.preventDefault();
        const dueAt = new Date(date.value).getTime();
        if (!Number.isFinite(dueAt) || localDateTime(dueAt) !== date.value || dueAt <= Date.now()) {
          fail(new Error("Choose a valid future date and time."));
          return;
        }
        save.disabled = true;
        try {
          await request("save", { ...target(row), emailId: row.emailId, dueAt });
          if (editing === revision) close();
          refresh();
        } catch (error) {
          if (editing === revision) { fail(error); save.disabled = false; }
        }
      });
      date.focus();
    }

    async function openOriginal(row) {
      const viewing = revision;
      try {
        const { email } = await request("open", target(row));
        if (viewing !== revision) return;
        show(email.subject || "(No subject)", "original");
        content.append(make("p", `From ${email.from || ""}`, "meta"), make("p", `To ${(email.to || []).join(", ")}`, "meta"));
        paintOriginal(content, email);
        content.append(button("Back to follow-ups", showList), button("Close", close));
      } catch (error) { if (viewing === revision) fail(error); }
    }

    function paintList() {
      const signature = JSON.stringify(rows);
      if (signature === listSignature) return;
      listSignature = signature;
      const focus = content.contains(document.activeElement) ? document.activeElement.id : "";
      const list = make("ul");
      list.setAttribute("aria-label", "Sent follow-up reminders");
      for (const row of rows) {
        const item = make("li");
        const label = row.state === "due" ? "Due · No reply seen" : row.state === "check" ? "Check mailbox" : "Upcoming";
        item.append(make("strong", row.subject), make("p", `${row.recipient} · ${label} · ${new Date(row.dueAt).toLocaleString()}`, "hint"));
        const actions = make("div", "", "row");
        const open = button("Open sent message", () => openOriginal(row));
        open.disabled = !row.canOpen;
        if (!row.canOpen) item.append(make("p", "The complete original is not available in the cache.", "hint"));
        const change = button("Change date", () => edit(row));
        const dismiss = button("Dismiss reminder", async () => {
          const viewing = revision;
          dismiss.disabled = true;
          try { await request("dismiss", target(row)); refresh(); }
          catch (error) { if (viewing === revision) { fail(error); dismiss.disabled = false; } }
        });
        const key = encodeURIComponent(JSON.stringify([row.accountId, row.messageId]));
        [open, change, dismiss].forEach((action, position) => { action.id = `sent-followup-${key}-${position}`; });
        actions.append(open, change, dismiss);
        item.append(actions);
        list.appendChild(item);
      }
      const done = button("Close", close);
      done.id = "sent-followups-close";
      content.replaceChildren(rows.length ? list : make("p", "No follow-up reminders.", "hint"), done);
      if (focus) (document.getElementById(focus) || done).focus();
    }

    async function refresh() {
      if (!shortcut) return;
      if (running) { rerun = true; return; }
      running = true;
      clearTimeout(timer);
      try {
        rows = await request("list");
        const attention = rows.filter(row => row.state !== "waiting").length;
        shortcut.textContent = attention ? `Follow-ups (${attention})` : "Follow-ups";
        if (dialog.open && page === "list") paintList();
        const next = rows.find(row => row.state === "waiting")?.dueAt;
        if (next) timer = setTimeout(refresh, Math.max(100, Math.min(2 ** 31 - 1, next - Date.now() + 20)));
      } catch (error) { if (dialog.open && page === "list") fail(error); }
      finally {
        running = false;
        if (rerun) { rerun = false; refresh(); }
      }
    }

    function showList() {
      show("Follow-up reminders", "list");
      listSignature = undefined;
      paintList();
      refresh();
    }

    function installList(parent) {
      shortcut = button("Follow-ups", showList);
      shortcut.setAttribute("aria-haspopup", "dialog");
      shortcut.setAttribute("aria-controls", dialog.id);
      parent.appendChild(shortcut);
      window.addEventListener("focus", refresh);
      refresh();
    }

    function addReaderAction(parent, email) {
      const open = button("Remind me if there’s no reply", async () => {
        try {
          open.disabled = true;
          const row = await request("inspect", { accountId: email.accountId, emailId: email.id });
          if (!open.isConnected) return;
          if (!row) throw new Error("Choose a confirmed Sent message to one recipient.");
          edit(row);
        } catch (error) {
          if (open.isConnected) { show("Follow-up reminder", "error"); content.append(button("Close", close)); fail(error); }
        } finally { open.disabled = false; }
      });
      open.setAttribute("aria-haspopup", "dialog");
      parent.appendChild(open);
    }

    return { installList, addReaderAction, refresh };
  }

  window.morrowSentFollowups = { create };
})();
