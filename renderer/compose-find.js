(function () {
  "use strict";

  const highlightName = "morrow-compose-find";
  const block = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DIV|DL|DT|DD|FIGCAPTION|FIGURE|FOOTER|H[1-6]|HEADER|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TBODY|TD|TH|TR|UL)$/;
  const boundary = /^(BR|HR|IMG|INPUT)$/;
  const excluded = "[data-compose-reply-quote], [data-compose-signature], [contenteditable=false], [hidden]";
  const matchLimit = 2000;

  // Join adjacent inline text, but never match across a paragraph, line break,
  // image or excluded region. Text and offsets are from the live draft only.
  function matches(editor, needle) {
    if (!needle) return [];
    const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
    const found = [];
    let nodes = [], runOffset = 0;
    function flush() {
      if (!nodes.length || found.length > matchLimit) return;
      const text = nodes.map(node => node.data).join("");
      let cursor = 0, offset = 0;
      function at(position) {
        while (position >= offset + nodes[cursor].length && cursor + 1 < nodes.length) {
          offset += nodes[cursor++].length;
        }
        return [cursor, position - offset];
      }
      for (const item of text.matchAll(re)) {
        const [first, start] = at(item.index);
        const [last, end] = at(item.index + item[0].length - 1);
        found.push({ nodes: nodes.slice(first, last + 1), start, end: end + 1, position: runOffset + item.index });
        if (found.length > matchLimit) break;
      }
      runOffset += text.length;
      nodes = [];
    }
    function visit(node) {
      if (found.length > matchLimit) return;
      if (node.nodeType === 3 && node.length) { nodes.push(node); return; }
      if (node.nodeType !== 1) return;
      if (node !== editor && (boundary.test(node.tagName) || node.matches(excluded))) { flush(); return; }
      const separates = node !== editor && block.test(node.tagName);
      if (separates) flush();
      for (const child of node.childNodes) visit(child);
      if (separates) flush();
    }
    visit(editor);
    flush();
    return found;
  }

  function asRange(match) {
    const range = document.createRange();
    range.setStart(match.nodes[0], match.start);
    range.setEnd(match.nodes.at(-1), match.end);
    return range;
  }

  function applyText(match, replacement) {
    const { nodes, start, end } = match;
    if (nodes.length === 1) {
      nodes[0].replaceData(start, end - start, replacement);
      return;
    }
    nodes[0].replaceData(start, nodes[0].length - start, replacement);
    for (const middle of nodes.slice(1, -1)) middle.data = "";
    nodes.at(-1).replaceData(0, end, "");
  }

  function mount({ dialog, editor, available, sync }) {
    if (!dialog || !editor) return;
    const $ = id => document.getElementById(id);
    const panel = $("compose-find-panel");
    const openButton = $("compose-find-open");
    if (!panel || !openButton) return;
    const query = $("compose-find-query");
    const replacement = $("compose-find-replacement");
    const replaceRow = $("compose-find-replace-row");
    const previous = $("compose-find-previous");
    const next = $("compose-find-next");
    const nextReplace = $("compose-find-replace-next");
    const allReplace = $("compose-find-replace-all");
    const status = $("compose-find-status");
    let index = 0, mutating = false;

    function highlight(match, scroll) {
      CSS.highlights?.delete(highlightName);
      if (!match) return;
      const range = asRange(match);
      if (typeof Highlight === "function") CSS.highlights?.set(highlightName, new Highlight(range));
      if (!scroll) return;
      const target = range.getBoundingClientRect();
      const box = editor.getBoundingClientRect();
      if (target.top < box.top + 8) editor.scrollTop += target.top - box.top - 8;
      else if (target.bottom > box.bottom - 8) editor.scrollTop += target.bottom - box.bottom + 8;
    }

    function refresh(offset = 0, scroll = false, feedback = "", after = null) {
      if (panel.hidden) return;
      const list = matches(editor, query.value);
      const count = Math.min(list.length, matchLimit);
      if (after !== null) index = Math.max(0, list.slice(0, count).findIndex(match => match.position >= after));
      index = count ? ((index + offset) % count + count) % count : 0;
      const tooMany = list.length > matchLimit;
      previous.disabled = next.disabled = count < 2;
      nextReplace.disabled = count === 0 || !available();
      allReplace.disabled = tooMany || nextReplace.disabled;
      const state = count ? `${index + 1} of ${count}${tooMany ? "+" : ""}` : query.value ? "No matches." : "Enter text to find.";
      status.textContent = feedback ? feedback + " " + state : state;
      highlight(count ? list[index] : null, scroll);
    }

    function open(replace) {
      if (!available()) return;
      panel.hidden = false;
      openButton.setAttribute("aria-expanded", "true");
      replaceRow.hidden = !replace;
      query.focus();
      query.select();
      refresh(0, true);
    }

    function close(focusEditor) {
      panel.hidden = true;
      openButton.setAttribute("aria-expanded", "false");
      query.value = replacement.value = status.textContent = "";
      index = 0;
      highlight(null, false);
      if (focusEditor) editor.focus();
    }

    function replace(all) {
      if (!available() || panel.hidden || replaceRow.hidden) return;
      const copy = editor.cloneNode(true);
      const list = matches(copy, query.value);
      if (!list.length || all && list.length > matchLimit) { refresh(); return; }
      const selected = all ? list : [list[index % Math.min(list.length, matchLimit)]];
      const changed = selected.filter(match => asRange(match).toString() !== replacement.value);
      if (!changed.length) { refresh(1, true, "Nothing to replace."); return; }
      for (const match of changed.slice().reverse()) applyText(match, replacement.value);
      // One Chromium editing transaction for Replace All as well as Replace
      // Next, so Undo restores the body instead of replaying separate edits.
      // Clone already-sanitized editor nodes and serialize literal text edits.
      editor.focus();
      const range = document.createRange();
      range.selectNodeContents(editor);
      const selection = document.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      mutating = true;
      let applied;
      try {
        applied = copy.innerHTML
          ? document.execCommand("insertHTML", false, copy.innerHTML)
          : document.execCommand("delete");
      } finally { observer.takeRecords(); mutating = false; }
      if (applied) sync();
      if (applied && all) index = 0;
      refresh(0, true, applied ? `Replaced ${changed.length}.` : "Could not replace text.",
        applied && !all ? changed[0].position + replacement.value.length : null);
    }

    openButton.addEventListener("click", () => open(true));
    $("compose-find-close").addEventListener("click", () => close(true));
    query.addEventListener("input", () => { index = 0; refresh(0, true); });
    previous.addEventListener("click", () => refresh(-1, true));
    next.addEventListener("click", () => refresh(1, true));
    nextReplace.addEventListener("click", () => replace(false));
    allReplace.addEventListener("click", () => replace(true));
    editor.addEventListener("input", () => { if (!mutating) refresh(); });
    // Other Compose actions can repaint the editor without firing input.
    const observer = new MutationObserver(() => refresh());
    observer.observe(editor, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ["contenteditable", "hidden"],
    });
    dialog.addEventListener("close", () => { if (!dialog.open) close(false); });
    dialog.addEventListener("keydown", event => {
      if (event.isComposing || !available()) return;
      const mac = /^Mac/.test(navigator.platform);
      const command = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      const key = event.key.toLowerCase();
      if (command && !event.altKey && !event.shiftKey && (key === "f" || key === "h")) {
        event.preventDefault();
        event.stopPropagation();
        open(key === "h");
      } else if (!panel.hidden && (panel.contains(event.target) || event.target === editor)) {
        if (key === "escape") {
          event.preventDefault();
          event.stopPropagation();
          close(true);
        } else if (key === "enter" && event.target === query && !command) {
          event.preventDefault();
          refresh(event.shiftKey ? -1 : 1, true);
        }
      }
    });
  }

  window.morrowComposeFind = { mount };
})();
