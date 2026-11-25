"use strict";

window.morrowReplySelection = (() => {
  function includesObscuredText(body, range) {
    // Chromium can copy text that mail CSS makes transparent or zero-sized.
    const document = body.ownerDocument;
    const view = document.defaultView;
    const nodes = document.createNodeIterator(range.commonAncestorContainer, view.NodeFilter.SHOW_TEXT);
    const styles = new Map();
    function styleFor(element) {
      if (!styles.has(element)) styles.set(element, view.getComputedStyle(element));
      return styles.get(element);
    }
    for (let node = nodes.nextNode(); node; node = nodes.nextNode()) {
      if (!range.intersectsNode(node)) continue;
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : node.length;
      if (!node.data.slice(start, end).trim()) continue;

      // A descendant can restore the font size or color of its own text.
      const style = styleFor(node.parentElement);
      if (style.visibility === "hidden") continue;
      let obscured = style.fontSize === "0px" || style.color === "transparent" ||
        /^rgba\([^)]*,\s*0\)$/.test(style.color);
      // Ancestor opacity applies to the whole subtree. display:none text is not copied.
      let element = node.parentElement;
      for (; element !== body; element = element.parentElement) {
        const { display, opacity } = styleFor(element);
        if (display === "none") break;
        if (opacity === "0") obscured = true;
      }
      if (element === body && obscured) return true;
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
