"use strict";

window.morrowCreateComposeInboxPicker = function ({ list, newer, older, confirm, status, cancel,
  shownWhen, fileSize, owns, reportError, listPage, pinPart }) {
  function sync(picker) {
    list.inert = picker.busy;
    newer.disabled = picker.busy || picker.page === 0;
    older.disabled = picker.busy || !picker.cursors[picker.page + 1];
    confirm.disabled = picker.busy || !picker.selected.size;
  }

  function paintSources(picker, sources) {
    list.replaceChildren();
    for (const [index, source] of sources.entries()) {
      const group = document.createElement("fieldset");
      group.className = "preview-meta";
      group.dataset.inboxMessageId = source.id;
      const subject = document.createElement("legend");
      subject.textContent = source.subject || "(no subject)";
      const details = document.createElement("p");
      details.className = "hint";
      details.id = "compose-inbox-source-details-" + index;
      details.textContent = `${source.from || "Unknown sender"} · ${shownWhen(new Date(source.date || ""), true) || "Unknown date"}`;
      group.append(subject, details);
      for (const file of source.files) {
        const label = document.createElement("label");
        label.className = "check";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.dataset.inboxPartId = file.id;
        input.setAttribute("aria-describedby", details.id);
        const name = document.createElement("span");
        const duplicate = source.files.some(other => other !== file && other.filename === file.filename && other.size === file.size);
        name.textContent = `${file.filename} · ${fileSize(file.size)}${duplicate ? ` · Part ${file.id}` : ""}`;
        input.addEventListener("change", () => selectFile(picker, source, file, input));
        label.append(input, name);
        group.appendChild(label);
      }
      list.appendChild(group);
    }
  }

  async function selectFile(picker, source, file, input) {
    if (picker.busy || !owns(picker)) return;
    if (input.checked) {
      picker.busy = true;
      picker.requestId = crypto.randomUUID();
      sync(picker);
      status.textContent = "Checking selected file…";
      try {
        const part = { emailId: source.id, partId: file.id, proof: file.proof };
        const result = await pinPart(picker.review, picker.requestId, part);
        if (!owns(picker)) return;
        const contentProof = result?.attachments?.[0]?.contentProof;
        if (!contentProof) throw new Error("Select the Inbox file again.");
        picker.selected.set(file.proof, { ...file, emailId: source.id, contentProof });
      } catch (error) {
        if (!owns(picker)) return;
        input.checked = false;
        reportError(picker, error);
        return;
      } finally {
        picker.busy = false;
        picker.requestId = null;
        if (owns(picker)) sync(picker);
      }
    } else picker.selected.delete(file.proof);
    sync(picker);
    status.textContent = picker.selected.size ? `${picker.selected.size} selected.` : "Choose files to add to the draft.";
  }

  async function loadPage(picker, page) {
    if (!picker || picker.busy || !owns(picker) || page < 0 || page >= picker.cursors.length) return;
    picker.busy = true;
    picker.selected.clear();
    list.replaceChildren();
    sync(picker);
    status.textContent = "Checking stored Inbox files…";
    if (picker.loaded) cancel.focus();
    try {
      const result = await listPage(picker.review, picker.cursors[page]);
      if (!owns(picker)) return;
      if (!Array.isArray(result?.sources)) throw new Error("Could not list stored Inbox files. Reopen the picker to try again.");
      picker.loaded = true;
      picker.page = page;
      picker.cursors.length = page + 1;
      if (result.nextCursor) picker.cursors.push(result.nextCursor);
      paintSources(picker, result.sources);
      status.textContent = result.sources.length ? "Choose files to add to the draft."
        : result.nextCursor ? "No stored Inbox files on this page. Choose Older to keep looking." : "No stored Inbox files on this page.";
    } catch (error) { reportError(picker, error); }
    finally {
      picker.busy = false;
      if (owns(picker)) sync(picker);
    }
  }

  return { loadPage, sync };
};
