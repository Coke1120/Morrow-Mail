/* Portable basename policy for the single-file Save as… review. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.morrowAttachmentFilename = factory();
})(typeof window === "object" ? window : globalThis, function () {
  const device = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/i;
  const unsafe = /[<>:"/\\|?*\p{Cc}\p{Cf}\p{Cs}]/u;

  function parts(original) {
    const name = typeof original === "string" && original ? original : "attachment";
    const suffix = name.match(/(?:\.tar\.(?:gz|bz2|xz|zst)|\.[\p{L}\p{N}][\p{L}\p{M}\p{N}+-]{0,15})$/iu)?.[0] || "";
    return suffix && suffix.length < name.length
      ? { stem: name.slice(0, -suffix.length), suffix }
      : { stem: name, suffix: "" };
  }

  function basenameOkay(name) {
    return typeof name === "string" && name.length > 0 && !unsafe.test(name) && !device.test(name)
      && name === name.trim() && !/[. ]$/.test(name)
      && new TextEncoder().encode(name).byteLength <= 240;
  }

  function proposed(stem, original) {
    if (typeof stem !== "string" || stem.length > 240) return "";
    const { suffix } = parts(original);
    if (!basenameOkay(stem) || (suffix && stem.toLowerCase().endsWith(suffix.toLowerCase()))) return "";
    const name = stem + suffix;
    return basenameOkay(name) && (suffix || parts(name).suffix === "") ? name : "";
  }

  function nativeSelection(basename, original) {
    if (!basenameOkay(basename)) return false;
    const { suffix } = parts(original);
    if (!suffix) return parts(basename).suffix === "";
    if (!basename.endsWith(suffix)) return false;
    return proposed(basename.slice(0, -suffix.length), original) === basename;
  }

  return { parts, proposed, nativeSelection };
});
