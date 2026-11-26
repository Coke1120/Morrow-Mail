"use strict";

(function (root) {
  function paintReview(list, items, formatDate, formatSize) {
    const document = list.ownerDocument;
    list.replaceChildren(...items.map(item => {
      const row = document.createElement("li");
      const title = document.createElement("strong");
      title.textContent = item.subject || "(No subject)";
      const details = document.createElement("p");
      details.className = "hint";
      details.textContent = [item.from || "Unknown sender", item.date && formatDate(item.date) || "Unknown date",
        formatSize(item.size), item.filename].join(" · ");
      row.append(title, details);
      return row;
    }));
  }

  async function openReview({ template, openDialog, closeDialog, formatDate, formatSize, read, confirm }) {
    const document = template.ownerDocument;
    if (document.getElementById("forward-originals-review")) return;
    const dialog = template.content.firstElementChild.cloneNode(true);
    const items = dialog.querySelector("#forward-originals-items");
    const status = dialog.querySelector("#forward-originals-status");
    const submit = dialog.querySelector("#forward-originals-confirm");
    const cancel = dialog.querySelector("#forward-originals-cancel");
    let review;
    const active = () => dialog.open && dialog.dataset.closing !== "1";
    const dismiss = () => { if (!cancel.disabled) closeDialog(dialog.id); };
    dialog.addEventListener("cancel", event => { event.preventDefault(); dismiss(); });
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    cancel.addEventListener("click", dismiss);
    dialog.querySelector("form").addEventListener("submit", async event => {
      event.preventDefault();
      if (!active() || !review?.proof || submit.disabled) return;
      submit.disabled = true;
      cancel.disabled = true;
      status.textContent = "Preparing the original attachments…";
      try {
        await confirm(review);
        if (active()) closeDialog(dialog.id);
      } catch (error) {
        if (!active()) return;
        status.textContent = error.message || "The originals could not be attached.";
        cancel.disabled = false;
        cancel.focus();
      }
    });
    document.body.appendChild(dialog);
    openDialog(dialog.id);
    try {
      review = await read();
      if (!active()) return;
      paintReview(items, review.items, formatDate, formatSize);
      status.textContent = review.overLimit ? "The selected originals exceed the 25 MiB outgoing attachment limit."
        : "Total: " + formatSize(review.totalBytes);
      submit.disabled = review.overLimit;
    } catch (error) {
      if (active()) status.textContent = error.message || "These originals are no longer available.";
    }
  }

  if (typeof module === "object" && module.exports) module.exports = { paintReview, openReview };
  else root.morrowForwardOriginals = { paintReview, openReview };
})(globalThis);
