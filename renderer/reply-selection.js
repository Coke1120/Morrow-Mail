"use strict";

window.morrowReplySelection = (() => {
  function includesObscuredText(body, range) {
    // Chromium can copy text that mail CSS makes transparent or zero-sized.
    // Mail styles are resolved onto the sanitized elements by the Reader.
    const view = body.ownerDocument.defaultView;
    for (const element of body.querySelectorAll("[style], font[color]")) {
      if (!range.intersectsNode(element) || !element.textContent.trim()) continue;
      const style = view.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (style.opacity === "0" || style.fontSize === "0px" || style.color === "transparent" ||
          /^rgba\([^)]*,\s*0\)$/.test(style.color)) return true;
    }
    return false;
  }

  function read(body) {
    if (!body?.isConnected) return null;
    const selection = body.ownerDocument.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
    const range = selection.getRangeAt(0);
    if (!body.contains(range.startContainer) || !body.contains(range.endContainer)) return null;
    const text = selection.toString();
    return text.trim() && !includesObscuredText(body, range) ? text : null;
  }

  function quoteBody(document, text) {
    const quote = document.createElement("blockquote");
    // The HTML sanitizer keeps preformatted text but drops pre-wrap styles.
    const block = document.createElement("pre");
    const excerpt = document.createElement("span");
    excerpt.textContent = text;
    block.append(excerpt);
    quote.append(block);
    return quote;
  }

  return { read, quoteBody };
})();
