"use strict";

window.morrowAttachmentSaveList = { mount({ call, notify, formatDate }) {
  const get = name => document.getElementById("reader-save-list" + (name ? "-" + name : ""));
  const dialog = get(), opener = get("open"), title = get("title"), list = get("files");
  const status = get("status"), folder = get("folder"), next = get("next"), back = get("back");
  const close = get("close"), cancel = get("cancel");
  if (!dialog || !opener) return null;
  const request = (action, values) => call("mail:attachmentSaveList", { action, ...values });
  const reasons = {
    collision: "Name taken after review. Existing file kept.",
    cancelled: "Cancelled before writing.",
    "source-unavailable": "Source attachment no longer available.",
    "destination-changed": "The destination changed. Check the folder.",
    "too-large": "Download limit exceeded.",
    "write-failed": "File could not be written.",
  };
  let items = [], review = null, results = null, busy = false, saveRequest = null;
  let adding = 0, addTail = Promise.resolve();

  function text(tag, value, className) {
    const node = document.createElement(tag);
    node.textContent = value;
    if (className) node.className = className;
    return node;
  }

  function paint() {
    opener.hidden = items.length === 0;
    opener.textContent = `Save list (${items.length})`;
    opener.disabled = adding > 0;
    const directory = (review || results)?.directory;
    folder.hidden = !directory;
    folder.textContent = directory ? `Destination: ${directory}` : "";
    title.textContent = results ? "Attachment save results" : "Attachment save list";
    next.hidden = !!results;
    next.disabled = busy || items.length === 0;
    next.textContent = review ? "Save selected files" : "Choose folder…";
    back.hidden = !!results || !!saveRequest;
    back.textContent = review ? "Back to list" : "Continue selecting";
    back.disabled = busy;
    close.disabled = busy;
    close.textContent = results ? "Done" : "Dismiss list";
    cancel.hidden = !saveRequest;
    cancel.disabled = !!saveRequest?.cancelled;
    list.replaceChildren();
    for (const item of results?.files || review?.files || items) {
      const row = document.createElement("li");
      const content = document.createElement("div");
      content.className = "attachment-main";
      const detail = document.createElement("div");
      const source = [item.from || "Unknown sender", item.subject || "(No subject)", formatDate(item.date) || "No date"].join(" · ");
      detail.append(text("strong", item.filename), text("span", source, "hint"));
      if (item.originalName && item.originalName !== item.filename) {
        detail.appendChild(text("span", `Original filename: ${item.originalName}`, "hint"));
      }
      if (results) {
        let outcome = item.status === "saved" ? "Saved." : reasons[item.status] || "File could not be saved.";
        if (item.verification === "destination-changed") outcome = "File was written. The destination changed. Check the folder.";
        else if (item.verification) outcome += " The source or operation changed after writing.";
        if (item.cleanupFailed) outcome += " Check the folder for an incomplete file.";
        detail.appendChild(text("span", outcome, "hint"));
      }
      content.appendChild(detail);
      row.appendChild(content);
      if (!review && !results) {
        const remove = text("button", "Remove", "ghost");
        remove.type = "button";
        remove.setAttribute("aria-label", `Remove ${item.filename} from ${item.subject || "message"}`);
        remove.disabled = busy;
        remove.addEventListener("click", () => run(async () => {
          ({ items } = await request("remove", { id: item.id }));
          status.textContent = items.length ? "Attachment removed." : "No attachments selected.";
        }, next));
        row.appendChild(remove);
      }
      list.appendChild(row);
    }
  }

  async function run(action, focus) {
    if (busy) return;
    busy = true;
    paint();
    try { await action(); }
    catch (error) {
      if (dialog.open) status.textContent = error.message;
      else notify(error.message, true);
    } finally {
      busy = false;
      paint();
      if (dialog.open && focus) (focus.disabled || focus.hidden ? title : focus).focus();
    }
  }

  opener.addEventListener("click", () => {
    status.textContent = "Review the sources, then choose one destination folder.";
    paint();
    dialog.showModal();
    title.focus();
  });
  next.addEventListener("click", () => {
    if (!review) return run(async () => {
      status.textContent = "Choose a folder to see the final filenames.";
      const prepared = await request("prepare");
      if (prepared.cancelled) { status.textContent = "No folder chosen. Your selection is still here."; return; }
      review = prepared;
      status.textContent = "Check the filenames before saving. Existing files are kept.";
    }, title);
    return run(async () => {
      saveRequest = { requestId: crypto.randomUUID(), cancelled: false };
      status.textContent = "Saving selected files…";
      paint();
      cancel.focus();
      try {
        const { files } = await request("save", { reviewId: review.reviewId, requestId: saveRequest.requestId });
        results = { files, directory: review.directory };
        items = [];
        const count = files.filter(item => item.status === "saved" && item.verification !== "destination-changed").length;
        status.textContent = `${count} of ${files.length} files saved.`;
      } finally {
        saveRequest = null;
        review = null;
      }
    }, title);
  });
  back.addEventListener("click", () => {
    if (!review) { dialog.close(); return; }
    return run(async () => {
      await request("revise");
      review = null;
      status.textContent = "Review the sources, then choose one destination folder.";
    }, title);
  });

  function dismiss() {
    return run(async () => {
      if (!results) await request("clear");
      items = [];
      review = results = null;
      dialog.close();
      document.getElementById("reader")?.focus();
    });
  }
  async function cancelSave() {
    const running = saveRequest;
    if (!running || running.cancelled) return;
    running.cancelled = true;
    cancel.disabled = true;
    status.textContent = "Cancelling remaining saves…";
    try { await call("mail:cancelAttachmentRequest", { requestId: running.requestId }); }
    catch {
      if (saveRequest !== running) return;
      running.cancelled = false;
      cancel.disabled = false;
      status.textContent = "Could not cancel. Try again or wait for the results.";
    }
  }

  close.addEventListener("click", dismiss);
  cancel.addEventListener("click", cancelSave);
  dialog.addEventListener("cancel", event => {
    event.preventDefault();
    if (saveRequest) cancelSave();
    else if (!busy) dismiss();
  });
  return {
    add(email, file) {
      if (dialog.open) return;
      const filename = file.filename || "attachment";
      const source = { accountId: email.accountId, emailId: email.id, attachmentId: String(file.id),
        folderId: email.folderId, bodyEpoch: email.bodyEpoch, filename };
      adding++;
      opener.disabled = true;
      addTail = addTail.then(async () => {
        ({ items } = await request("add", source));
        notify(`${filename} is in the save list.`);
      }).catch(error => notify(error.message, true)).finally(() => {
        adding--;
        paint();
      });
      return addTail;
    },
  };
} };
