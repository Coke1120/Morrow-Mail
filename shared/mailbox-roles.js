(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.morrowMailboxRoles = api;
})(typeof window === "object" ? window : globalThis, function () {
  const GMAIL_ALL_PATHS = ["[Gmail]/All Mail", "[Google Mail]/All Mail"];

  function isGmailAllPath(value) {
    return GMAIL_ALL_PATHS.indexOf(String(value || "")) >= 0;
  }

  function isAllMail(folder) {
    if (!folder || typeof folder !== "object") return false;
    const well = folder.wellKnownName || folder.well_known || folder.wellKnown || "";
    if (well === "all") return true;
    return isGmailAllPath(folder.path || folder.id);
  }

  function allMailLabel(folder) {
    const name = String((folder && (folder.name || folder.label)) || "");
    if (!isAllMail(folder)) return name;
    if (!name || isGmailAllPath(name)) return "All Mail";
    return name;
  }

  return { GMAIL_ALL_PATHS: GMAIL_ALL_PATHS, isGmailAllPath: isGmailAllPath, isAllMail: isAllMail, allMailLabel: allMailLabel };
});
