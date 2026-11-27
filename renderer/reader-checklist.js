"use strict";

window.morrowReaderChecklist = (() => {
  const active = new WeakMap();

  function mount(pane, before, source, { invoke, current }) {
    const doc = pane.ownerDocument;
    const element = (tag, text, className) => {
      const node = doc.createElement(tag);
      if (text) node.textContent = text;
      if (className) node.className = className;
      return node;
    };
    const panel = element("section", "", "reader-checklist");
    panel.setAttribute("aria-label", "Private checklist");
    panel.hidden = true;
    const heading = element("h3", "Private checklist");
    const list = element("ul");
    const status = element("p", "", "hint");
    status.setAttribute("role", "status");
    panel.append(heading, list, status);
    pane.insertBefore(panel, before);

    let items = [], revision = 0;
    const ownerCurrent = () => panel.isConnected && current();
    async function request(action, fields = {}, dirty = false) {
      if (!ownerCurrent()) return;
      const ticket = ++revision;
      let error = "";
      try {
        const reply = await invoke({ ...source, action, ...fields });
        if (reply?.ok !== true || !Array.isArray(reply.items)) throw new Error(reply?.message || "Private checklist unavailable.");
        if (ticket === revision) items = reply.items;
      } catch (failure) { error = failure.message || "Private checklist unavailable."; }
      if (ticket !== revision || !ownerCurrent() || (action === "list" && error)) return;
      paint(error, dirty && !error);
    }

    function paint(error, changed) {
      const focus = panel.contains(doc.activeElement) ? doc.activeElement : null;
      const focusKey = focus?.dataset.item;
      const wasRemove = focus?.tagName === "BUTTON";
      list.replaceChildren();
      for (const item of items) {
        const row = element("li");
        const label = element("label");
        const check = element("input");
        check.type = "checkbox";
        check.dataset.item = item.id;
        check.checked = item.done;
        check.addEventListener("change", () => request("set", { id: item.id, done: check.checked }, true));
        const text = element("span", item.text, "reader-checklist-excerpt");
        label.append(check, text);
        const remove = element("button", "Remove", "ghost");
        remove.type = "button";
        remove.dataset.item = item.id;
        remove.setAttribute("aria-label", "Remove checklist item: " + item.text);
        remove.addEventListener("click", () => request("remove", { id: item.id }, true));
        row.append(label, remove);
        list.append(row);
        if (item.id === focusKey) (wasRemove ? remove : check).focus();
      }
      panel.hidden = !items.length && !changed && !error;
      status.textContent = error || (items.length
        ? `${items.filter(item => item.done).length} of ${items.length} done · On this device only`
        : changed ? "Checklist cleared." : "");
      if (focusKey && !panel.contains(doc.activeElement)) {
        const target = panel.querySelector("input") || heading;
        if (target === heading) heading.tabIndex = -1;
        target.focus();
      }
    }

    active.set(pane, { add(text) { return request("add", { text }, true); } });
    void request("list");
  }

  function add(pane, text) {
    return active.get(pane)?.add(text);
  }

  return { mount, add };
})();
