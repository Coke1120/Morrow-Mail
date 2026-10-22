(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.morrowTranslateLang = api;
})(typeof window === "object" ? window : globalThis, function () {
  const DEFAULT = "zh-Hant";
  const CODES = ["zh-Hant", "en", "es", "fr", "de", "ja"];
  const LABELS = {
    "zh-Hant": "Traditional Chinese (繁體中文)",
    en: "English",
    es: "Spanish",
    fr: "French",
    de: "German",
    ja: "Japanese",
  };
  const ALIASES = {
    "zh-hant": "zh-Hant",
    "zh-tw": "zh-Hant",
    "zh-hk": "zh-Hant",
    "zh-hans": "zh-Hant",
    "zh-cn": "zh-Hant",
    chinese: "zh-Hant",
    "simplified chinese": "zh-Hant",
    "traditional chinese": "zh-Hant",
    "繁體中文": "zh-Hant",
    "繁体中文": "zh-Hant",
    en: "en",
    english: "en",
    es: "es",
    spanish: "es",
    fr: "fr",
    french: "fr",
    de: "de",
    german: "de",
    ja: "ja",
    japanese: "ja",
  };

  function canonical(value) {
    if (typeof value !== "string" && typeof value !== "number") return "";
    const text = String(value).trim().replace(/\s+/g, " ");
    if (!text || text === "false" || text === "null" || text === "undefined") return "";
    return ALIASES[text.toLowerCase()] || "";
  }

  function cast(value, loose) {
    const code = canonical(value);
    if (code) return code;
    if (loose) return DEFAULT;
    throw new Error("Translation language is not supported");
  }

  function label(value) {
    return LABELS[cast(value, true)];
  }

  function instruction(value) {
    const code = cast(value, true);
    if (code === "zh-Hant") {
      return "Traditional Chinese (zh-Hant), using Traditional characters, not Simplified Chinese";
    }
    return LABELS[code];
  }

  return {
    DEFAULT: DEFAULT,
    CODES: CODES,
    cast: cast,
    label: label,
    instruction: instruction,
  };
});
