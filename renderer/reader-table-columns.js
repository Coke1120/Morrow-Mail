"use strict";

window.morrowReaderTableColumns = (() => {
  const MAX_ROWS = 500;
  const MAX_COLUMNS = 24;
  const MAX_CELLS = 6000;
  const MAX_TEXT = 250000;
  const PREVIEW_ROWS = 10;
  const unsafeText = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
  const hiddenMarkup = '[hidden], [aria-hidden="true" i], [role="presentation" i], [role="none" i]';
  const inlineText = "a,b,code,em,font,i,s,small,span,strong,sub,sup,u";

  function failedSpan(cell) {
    return ["colspan", "rowspan"].some(name =>
      cell.hasAttribute(name) && !/^0*1$/.test(cell.getAttribute(name).trim()));
  }

  function sourceCheck(wrapper, html, parkStyles, count) {
    if (!/\b(?:colspan|rowspan|hidden|role|scope|headers)\b/i.test(html)) return () => true;
    let sourceTables;
    return index => {
      if (!sourceTables) {
        // The sanitizer drops some structural attributes, including oversized
        // spans. Inspect attributes in an inert template, never source text or
        // a live mail tree. Pair tables only if sanitizing kept their inventory.
        const template = wrapper.ownerDocument.createElement("template");
        template.innerHTML = parkStyles(html);
        sourceTables = template.content.querySelectorAll("table");
      }
      if (sourceTables.length !== count) return false;
      const table = sourceTables[index];
      return !table.closest(hiddenMarkup) && !table.querySelector(hiddenMarkup) &&
        Array.from(table.querySelectorAll("th,td")).every(cell =>
          !failedSpan(cell) && !cell.hasAttribute("headers") &&
          (!cell.hasAttribute("scope") || cell.getAttribute("scope").trim().toLowerCase() === "col"));
    };
  }

  function layout(wrapper) {
    const view = wrapper.ownerDocument.defaultView;
    const cache = new WeakMap();
    const style = node => {
      if (!cache.has(node)) cache.set(node, view.getComputedStyle(node));
      return cache.get(node);
    };
    function hidden(node) {
      const css = style(node);
      return node.matches(hiddenMarkup) || css.display === "none" ||
        /^(hidden|collapse)$/.test(css.visibility) || parseFloat(css.opacity) === 0;
    }
    function text(cell, limit = MAX_TEXT) {
      let value = "";
      function read(node) {
        const css = style(node);
        if (hidden(node) || parseFloat(css.fontSize) === 0 ||
            /^(?:transparent|rgba\(.*[,/]\s*0(?:\.0+)?\s*\))$/i.test(css.color) ||
            (css.textTransform && css.textTransform !== "none")) return false;
        for (const child of node.childNodes) {
          if (child.nodeType === 3) {
            if (child.length > limit - value.length || unsafeText.test(child.data)) return false;
            // Offscreen rows are still copyable. Reject text clipped by mail
            // markup itself, when layout rectangles are available.
            if (child.data.trim() && isClipped(child, wrapper, style)) return false;
            value += child.data;
          } else if (child.nodeType === 1 &&
              (!child.matches(inlineText) || !["", "inline"].includes(style(child).display) || !read(child))) {
            return false;
          }
        }
        return true;
      }
      return read(cell) ? value : null;
    }
    return { hidden, text, style };
  }

  function isClipped(text, wrapper, style) {
    let range;
    for (let node = text.parentElement; node && node !== wrapper; node = node.parentElement) {
      const css = style(node);
      const clipX = (css.overflowX || css.overflow) === "hidden";
      const clipY = (css.overflowY || css.overflow) === "hidden";
      if ((!clipX && !clipY) || css.display === "inline") continue;
      if (!range) {
        range = text.ownerDocument.createRange();
        if (typeof range.getClientRects !== "function") return false;
        range.selectNodeContents(text);
      }
      const box = node.getBoundingClientRect();
      const left = box.left + node.clientLeft;
      const top = box.top + node.clientTop;
      if (Array.from(range.getClientRects()).some(rect =>
        (clipX && (rect.left < left - 1 || rect.right > left + node.clientWidth + 1)) ||
        (clipY && (rect.top < top - 1 || rect.bottom > top + node.clientHeight + 1)))) return true;
    }
    return false;
  }

  function headersOf(table, wrapper, { hidden, text, style }) {
    if (!["table", "inline-table"].includes(style(table).display)) return null;
    for (let node = table; node; node = node.parentElement) {
      if (hidden(node)) return null;
    }
    const sections = Array.from(table.children);
    if (sections.some(node => !node.matches("caption,thead,tbody")) ||
        sections.filter(node => node.localName === "thead").length > 1 || table.tHead?.rows.length > 1) return null;
    const row = table.rows[0];
    if (!row || hidden(row) || hidden(row.parentElement) || style(row).display !== "table-row" ||
        (table.tHead && row.parentElement !== table.tHead) ||
        style(row.parentElement).display !== (table.tHead ? "table-header-group" : "table-row-group") ||
        row.cells.length < 1 || row.cells.length > MAX_COLUMNS) return null;
    const labels = Array.from(row.cells, cell =>
      cell.localName === "th" && style(cell).display === "table-cell" && !failedSpan(cell)
        ? text(cell, 160)?.trim().replace(/ +/g, " ") : null);
    if (labels.some(label => !label) ||
        new Set(labels.map(label => label.normalize("NFKC").toLowerCase())).size !== labels.length) return null;
    return labels;
  }

  function readRows(table, labels, wrapper) {
    const tableRows = table.rows;
    const dataCount = tableRows.length - 1;
    if (dataCount < 1 || dataCount > MAX_ROWS || dataCount * labels.length > MAX_CELLS) return null;
    const current = layout(wrapper);
    if (JSON.stringify(headersOf(table, wrapper, current)) !== JSON.stringify(labels)) return null;
    const { hidden, text, style } = current;
    const rows = [];
    let size = 0;
    for (let i = 1; i < tableRows.length; i++) {
      const row = tableRows[i];
      if (row.cells.length !== labels.length || row.childElementCount !== labels.length ||
          Array.from(row.cells).some(cell => cell.localName !== "td" || failedSpan(cell))) return null;
      if (hidden(row.parentElement) || hidden(row)) continue;
      if (style(row.parentElement).display !== "table-row-group" || style(row).display !== "table-row") return null;
      const values = [];
      for (const cell of row.cells) {
        if (style(cell).display !== "table-cell") return null;
        const value = text(cell);
        if (value !== null && (size += value.length) > MAX_TEXT) return null;
        values.push(value === null || /^\s*[=+@"'-]/u.test(value) ? null : value);
      }
      rows.push(values);
    }
    return rows.length ? rows : null;
  }

  function mount(wrapper, html, parkStyles) {
    const doc = wrapper.ownerDocument;
    const make = (tag, text) => {
      const node = doc.createElement(tag);
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const tables = Array.from(wrapper.querySelectorAll("table"));
    if (!tables.length) return;
    const nested = new Set();
    for (const table of tables) {
      const outer = table.parentElement.closest("table");
      if (outer) { nested.add(outer); nested.add(table); }
    }
    const originalIsSimple = sourceCheck(wrapper, html, parkStyles, tables.length);
    // Hidden attributes may have been dropped by the sanitizer. Avoid
    // repeating their text in an entry before checking the original structure.
    const labelHeaders = !/\bhidden\b/i.test(html);
    const controls = make("div");
    controls.className = "meta";
    const initial = layout(wrapper);

    for (const [index, table] of tables.entries()) {
      if (nested.has(table) || !table.rows[1]) continue;
      const labels = headersOf(table, wrapper, initial);
      if (!labels) continue;
      const details = make("details");
      details.dataset.readerTableColumns = "";
      const summary = labels.slice(0, 3).join(", ") + (labels.length > 3 ? ", …" : "");
      details.append(make("summary", `Table ${index + 1} · Choose columns` + (labelHeaders ? ` (${summary})` : "")));
      const panel = make("div");
      details.append(panel);
      controls.append(details);

      const selected = [];
      details.addEventListener("toggle", () => {
        panel.replaceChildren();
        if (!details.open) return;
        const rows = readRows(table, labels, wrapper);
        if (!rows || !originalIsSimple(index)) {
          panel.append(make("p", "This table can’t be copied as columns. Select text in the message to copy it manually."));
          return;
        }
        const fields = make("fieldset");
        fields.append(make("legend", "Select columns in paste order"));
        for (const [column, name] of labels.entries()) {
          const label = make("label");
          label.className = "check";
          const check = make("input");
          check.type = "checkbox";
          check.checked = selected.includes(column);
          check.addEventListener("change", () => {
            if (check.checked) selected.push(column);
            else selected.splice(selected.indexOf(column), 1);
            update();
          });
          label.append(check, make("span", name));
          fields.append(label);
        }
        const order = make("p");
        order.setAttribute("aria-live", "polite");
        const preview = make("div");
        preview.tabIndex = 0;
        preview.setAttribute("role", "region");
        preview.setAttribute("aria-label", "Table data preview");
        preview.style.overflowX = "auto";
        const copy = make("button", "Copy visible data rows");
        copy.type = "button";
        copy.className = "ghost";
        const status = make("p");
        status.setAttribute("role", "status");
        panel.append(fields, order, preview, make("p", "Paste into cells formatted as Text to keep values such as leading zeros."), copy, status);

        let value;
        function update() {
          status.textContent = "";
          preview.replaceChildren();
          preview.hidden = !selected.length;
          order.textContent = selected.length
            ? "Paste order: " + selected.map((column, i) => `${i + 1}. ${labels[column]}`).join(" → ")
            : "Choose at least one column.";
          const projected = rows.map(row => selected.map(column => row[column]));
          if (projected.some(row => row.includes(null))) {
            value = "";
            copy.disabled = true;
            status.textContent = "A selected column contains a value that cannot be copied as plain rows. Deselect it or copy manually.";
            return;
          }
          const blankRecords = selected.length === 1 && projected.some(([cell]) => !cell.trim());
          value = selected.length && !blankRecords ? projected.map(row => row.join("\t")).join("\n") : "";
          copy.disabled = !value;
          if (!selected.length) return;
          if (blankRecords) status.textContent = "A blank row in one column may be lost on paste. Select another column or copy manually.";
          const grid = make("table");
          grid.append(make("caption", rows.length > PREVIEW_ROWS
            ? `Preview · first ${PREVIEW_ROWS} of ${rows.length} rows` : `Preview · ${rows.length} data rows`));
          const head = grid.createTHead().insertRow();
          for (const column of selected) {
            const cell = make("th", labels[column]);
            cell.scope = "col";
            head.append(cell);
          }
          const content = grid.createTBody();
          for (const values of projected.slice(0, PREVIEW_ROWS)) {
            const row = content.insertRow();
            for (const text of values) {
              const cell = row.insertCell();
              cell.style.whiteSpace = "pre-wrap";
              cell.textContent = text;
            }
          }
          preview.append(grid);
        }

        copy.addEventListener("click", async () => {
          if (!value || !details.open || !copy.isConnected || !table.isConnected) return;
          if (JSON.stringify(readRows(table, labels, wrapper)) !== JSON.stringify(rows)) {
            copy.disabled = true;
            status.textContent = "The table changed. Close and reopen this preview before copying.";
            return;
          }
          const text = value;
          const count = rows.length;
          try {
            await doc.defaultView.navigator.clipboard.writeText(text);
            if (value === text) status.textContent = `Copied ${count} data rows without headers.`;
          } catch {
            if (value === text) status.textContent = "Clipboard unavailable. Select text in the message to copy it manually.";
          }
        });
        update();
      });
    }
    if (controls.childElementCount) wrapper.before(controls);
  }

  return { mount };
})();
