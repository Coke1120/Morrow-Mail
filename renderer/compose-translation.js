"use strict";

window.morrowComposeTranslation = (() => {
  const excluded = "[data-compose-reply-quote], [data-compose-signature], blockquote, [type=cite], .gmail_quote, .yahoo_quoted, [hidden], [aria-hidden=true], [contenteditable=false], img, hr";
  const block = "div, p, li, pre, td, th, h1, h2, h3, h4, h5, h6";
  const stale = "The draft or selection changed. Close this review and select the text again.";
  const instruction = "Review meaning and conditions yourself. The exact-value check does not verify accuracy.";
  const values = /(?:\b(?:USD|HKD|EUR|GBP|JPY|CAD|AUD|SGD|TWD)\s*|(?:US\$|HK\$|[$€£¥])\s*)\d+(?:[,.]\d+)*|\b(?:[01]?\d|2[0-3]):[0-5]\d\b|\b[A-Z]{1,8}-[A-Z0-9]*\d[A-Z0-9]*(?:-[A-Z0-9]+)*\b/g;
  let controls;

  function mount({ editor, owner, invoke, sync, notify }) {
    if (!editor || controls) return;
    const $ = id => document.getElementById(id);
    const dialog = $("compose-translation");
    const source = $("compose-translation-source");
    const output = $("compose-translation-output");
    const sourceLang = $("compose-translation-source-language");
    const targetLang = $("compose-translation-target-language");
    const destination = $("compose-translation-destination");
    const warning = $("compose-translation-hints");
    const status = $("compose-translation-status");
    const send = $("compose-translation-send");
    const replace = $("compose-translation-replace");
    const lang = window.morrowTranslateLang;
    if (!dialog || !lang) return;

    for (const code of lang.CODES) {
      sourceLang.add(new Option(lang.label(code), code));
      targetLang.add(new Option(lang.label(code), code));
    }
    let captured = null, review = null;

    function selectionOkay(range) {
      const element = node => node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      return !range.collapsed && editor.contains(range.startContainer) && editor.contains(range.endContainer)
        && element(range.startContainer).closest(block) === element(range.endContainer).closest(block)
        && ![...editor.querySelectorAll(excluded)].some(node => range.intersectsNode(node));
    }

    function stillCurrent(item) {
      return !!item && owner() === item.owner && item.markup === editor.innerHTML && selectionOkay(item.range)
        && item.range.startContainer === item.startNode && item.range.startOffset === item.startOffset
        && item.range.endContainer === item.endNode && item.range.endOffset === item.endOffset
        && item.range.toString() === item.text;
    }

    function selectionMatches(range) {
      const selection = document.getSelection();
      if (!selection?.rangeCount || selection.isCollapsed) return false;
      const live = selection.getRangeAt(0);
      return live.startContainer === range.startContainer && live.startOffset === range.startOffset
        && live.endContainer === range.endContainer && live.endOffset === range.endOffset;
    }

    function capture(sequence) {
      captured = null;
      const snapshot = owner();
      if (!snapshot || dialog.open || document.activeElement !== editor) return false;
      const selection = document.getSelection();
      if (selection?.rangeCount !== 1) return false;
      const range = selection.getRangeAt(0).cloneRange();
      if (!selectionOkay(range)) return false;
      const text = window.morrowReplySelection?.read(editor);
      // Browser selection may add invisible newlines. Review only exactly the
      // text in this range, not a synthesized cross-block representation.
      if (!text || text.length > 3000 || text !== range.toString()) return false;
      captured = { sequence, owner: snapshot, range, text, markup: editor.innerHTML,
        startNode: range.startContainer, startOffset: range.startOffset, endNode: range.endContainer, endOffset: range.endOffset };
      return true;
    }

    function cancelToken(token) {
      if (token) void invoke({ action: "cancel", token }).catch(() => {});
    }

    function retire(item, message) {
      if (!item || review !== item) return;
      cancelToken(item.token);
      item.phase = "stale";
      item.token = "";
      output.value = "";
      output.disabled = true;
      send.disabled = replace.disabled = true;
      status.textContent = message;
      showHints();
    }

    function showHints() {
      if (!review) return;
      const checked = review.phase === "translated" || review.phase === "replace";
      const translated = checked ? new Set(output.value.match(values) || []) : new Set();
      const marks = [];
      let start = 0;
      const missing = new Set();
      for (const match of review.text.matchAll(values)) {
        if (!checked || translated.has(match[0])) continue;
        if (match.index > start) marks.push(document.createTextNode(review.text.slice(start, match.index)));
        const mark = document.createElement("mark");
        mark.textContent = match[0];
        marks.push(mark);
        missing.add(match[0]);
        start = match.index + match[0].length;
      }
      marks.push(document.createTextNode(review.text.slice(start)));
      source.replaceChildren(...marks);
      warning.textContent = checked && missing.size ? "Check these exact source values: " + [...missing].join(", ") : "";
      replace.disabled = review.phase !== "translated" || !output.value.trim();
    }

    async function prepare() {
      const item = review;
      if (!stillCurrent(item)) return retire(item, stale);
      const revision = ++item.revision;
      cancelToken(item.token);
      item.token = "";
      item.phase = "preparing";
      item.sourceLanguage = sourceLang.value;
      item.targetLanguage = targetLang.value;
      output.value = "";
      output.disabled = true;
      send.disabled = replace.disabled = true;
      destination.textContent = "Checking the saved AI destination locally…";
      status.textContent = "";
      showHints();
      let result;
      try {
        result = await invoke({ action: "prepare", text: item.text, source: item.sourceLanguage, target: item.targetLanguage });
      } catch { result = { ok: false, message: "Could not check the saved AI destination." }; }
      if (review !== item || item.revision !== revision || !dialog.open) { cancelToken(result?.token); return; }
      if (!stillCurrent(item)) { cancelToken(result?.token); return retire(item, stale); }
      if (result?.ok !== true || typeof result.token !== "string") {
        destination.textContent = "";
        status.textContent = result?.message || "The saved AI connection is unavailable.";
        return;
      }
      item.token = result.token;
      item.phase = "review";
      destination.textContent = [result.label, result.destination, result.model, result.locality].filter(Boolean).join(" · ");
      send.disabled = false;
    }

    function open(sequence) {
      const item = captured;
      captured = null;
      if (!item || item.sequence !== sequence || !stillCurrent(item) || !selectionMatches(item.range) || dialog.open) return false;
      review = { ...item, revision: 0, token: "" };
      sourceLang.value = "auto";
      targetLang.value = lang.DEFAULT;
      sourceLang.disabled = targetLang.disabled = false;
      dialog.showModal();
      sourceLang.focus();
      void prepare();
      return true;
    }

    async function translate() {
      const item = review;
      if (!item || item.phase !== "review" || !stillCurrent(item)) return;
      item.phase = "send";
      sourceLang.disabled = targetLang.disabled = true;
      send.disabled = true;
      status.textContent = "Translating the reviewed passage…";
      let result;
      try { result = await invoke({ action: "translate", token: item.token }); }
      catch { result = null; }
      if (review !== item || item.phase !== "send" || !dialog.open) return;
      if (!stillCurrent(item)) return retire(item, stale);
      if (result?.ok !== true || typeof result.text !== "string") {
        return retire(item, result?.message || "Translation failed. Your draft was not changed.");
      }
      item.phase = "translated";
      output.disabled = false;
      output.value = result.text;
      status.textContent = instruction;
      showHints();
      output.focus();
    }

    async function apply() {
      const item = review;
      if (!item || item.phase !== "translated" || !output.value.trim() || output.value.length > 8000 || !stillCurrent(item)) return;
      const reviewedText = output.value;
      item.phase = "replace";
      output.disabled = true;
      replace.disabled = true;
      let result;
      try { result = await invoke({ action: "validate", token: item.token }); } catch { result = null; }
      if (review !== item || item.phase !== "replace" || !dialog.open) return;
      if (!stillCurrent(item) || output.value !== reviewedText) return retire(item, stale);
      if (result?.ok !== true) return retire(item, result?.message || "The saved translation review is unavailable.");
      item.token = "";
      close();
      if (!stillCurrent(item)) { notify(stale); return; }
      editor.focus();
      const selection = document.getSelection();
      selection.removeAllRanges();
      selection.addRange(item.range);
      // insertText preserves native Undo. Never interpret model output as HTML.
      if (document.activeElement === editor && selectionMatches(item.range) && document.execCommand("insertText", false, reviewedText)) sync();
      else notify("The reviewed text could not be replaced. Your draft was not changed.");
    }

    function close() {
      const item = review;
      review = null;
      captured = null;
      cancelToken(item?.token);
      source.replaceChildren();
      output.value = destination.textContent = warning.textContent = status.textContent = "";
      if (dialog.open) dialog.close();
    }

    function invalidate() {
      if (review && review.phase !== "stale" && !stillCurrent(review)) retire(review, stale);
    }

    sourceLang.addEventListener("change", prepare);
    targetLang.addEventListener("change", prepare);
    output.addEventListener("input", showHints);
    send.addEventListener("click", translate);
    replace.addEventListener("click", apply);
    $("compose-translation-cancel").addEventListener("click", close);
    dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
    dialog.addEventListener("close", () => { if (!dialog.open && review) close(); });
    $("compose").addEventListener("close", close);
    document.addEventListener("selectionchange", () => {
      const selection = document.getSelection();
      if (review && review.phase !== "stale" && selection?.rangeCount && editor.contains(selection.anchorNode) &&
          !selection.isCollapsed && !selectionMatches(review.range)) retire(review, stale);
    });
    window.addEventListener("focus", async () => {
      invalidate();
      const item = review, token = item?.token;
      if (!dialog.open || !token || item.phase === "replace") return;
      try {
        const result = await invoke({ action: "check", token });
        if (review === item && item.token === token && result?.ok !== true) retire(item, result?.message || stale);
      } catch { if (review === item && item.token === token) retire(item, stale); }
    });
    new MutationObserver(invalidate).observe(editor, { subtree: true, childList: true, characterData: true, attributes: true });
    controls = { capture, open, current(token, phase) {
      return !!review && dialog.open && review.token === token && review.phase === phase && stillCurrent(review)
        && review.sourceLanguage === sourceLang.value && review.targetLanguage === targetLang.value;
    } };
  }
  return { mount, capture: sequence => controls?.capture(sequence) === true,
    open: sequence => controls?.open(sequence) === true, current: (token, phase) => controls?.current(token, phase) === true };
})();
