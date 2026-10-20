(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.morrowFolderCollapse = api;
})(typeof window === "object" ? window : globalThis, function () {
  const MAX_ACCOUNTS = 80;
  const MAX_IDS = 300;
  const MAX_ACCOUNT = 200;
  const MAX_FOLDER = 500;

  function cleanId(value, max) {
    if (typeof value !== "string") return "";
    const id = value.trim();
    if (!id || id.length > max) return "";
    if (id === "__proto__" || id === "constructor" || id === "prototype") return "";
    return id;
  }

  function normalize(value) {
    const out = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return out;
    const accounts = [];
    const seenAccounts = new Set();
    for (const key of Object.keys(value)) {
      const accountId = cleanId(key, MAX_ACCOUNT);
      if (!accountId || seenAccounts.has(accountId)) continue;
      seenAccounts.add(accountId);
      accounts.push(accountId);
    }
    for (const accountId of accounts.slice(-MAX_ACCOUNTS)) {
      const raw = value[accountId];
      if (!Array.isArray(raw)) continue;
      const ids = [];
      const seen = new Set();
      for (const item of raw) {
        const id = cleanId(item, MAX_FOLDER);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
      }
      if (ids.length) out[accountId] = ids.slice(-MAX_IDS);
    }
    return out;
  }

  function cast(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Collapsed folders must be an object of folder ids.");
    }
    return normalize(value);
  }

  function idsFor(store, accountId) {
    const map = normalize(store);
    const id = cleanId(String(accountId || ""), MAX_ACCOUNT);
    return id && map[id] ? map[id].slice() : [];
  }

  function toggle(store, accountId, folderId) {
    const map = normalize(store);
    const account = cleanId(String(accountId || ""), MAX_ACCOUNT);
    const folder = cleanId(String(folderId || ""), MAX_FOLDER);
    if (!account || !folder) return map;
    const list = map[account] ? map[account].slice() : [];
    const index = list.indexOf(folder);
    if (index >= 0) list.splice(index, 1);
    else list.push(folder);
    if (list.length) map[account] = list.slice(-MAX_IDS);
    else delete map[account];
    return map;
  }

  function visibleRows(tree, store, accountId) {
    const list = Array.isArray(tree) ? tree : [];
    const collapsed = new Set(idsFor(store, accountId));
    const parents = new Set();
    for (const folder of list) {
      if (folder && folder.parentId) parents.add(String(folder.parentId));
    }
    const hidden = new Set();
    const out = [];
    for (const folder of list) {
      if (!folder || folder.id == null || folder.id === "") continue;
      const id = String(folder.id);
      const parentId = folder.parentId ? String(folder.parentId) : "";
      if (parentId && hidden.has(parentId)) {
        hidden.add(id);
        continue;
      }
      const hasChild = parents.has(id);
      const expanded = !collapsed.has(id);
      out.push(Object.assign({}, folder, { hasChild: hasChild, expanded: expanded }));
      if (hasChild && !expanded) hidden.add(id);
    }
    return out;
  }

  return { normalize: normalize, cast: cast, idsFor: idsFor, toggle: toggle, visibleRows: visibleRows };
});
