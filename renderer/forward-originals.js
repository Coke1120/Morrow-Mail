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

  if (typeof module === "object" && module.exports) module.exports = { paintReview };
  else root.morrowForwardOriginals = { paintReview };
})(globalThis);
