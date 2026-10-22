// Display-only date and time formats. Stored timestamps stay ISO.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.morrowDisplayFormat = api;
})(typeof window === "object" ? window : globalThis, function () {
  const TIME_FORMATS = ["system", "12h", "24h"];
  const DATE_FORMATS = ["system", "dd/mm/yyyy", "dd/mmmm/yyyy", "mm/dd/yyyy", "yyyy-mm-dd", "d mmm yyyy"];

  function token(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function castTimeFormat(value, loose) {
    const next = token(value);
    if (TIME_FORMATS.indexOf(next) !== -1) return next;
    return loose ? "system" : null;
  }

  function castDateFormat(value, loose) {
    const next = token(value);
    if (DATE_FORMATS.indexOf(next) !== -1) return next;
    return loose ? "system" : null;
  }

  function isDate(value) {
    return value instanceof Date && !Number.isNaN(value.getTime());
  }

  function localeList(options) {
    const locale = options && typeof options.locale === "string" ? options.locale.trim() : "";
    return locale ? [locale] : [];
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function monthName(date, style, options) {
    return new Intl.DateTimeFormat(localeList(options), { month: style }).format(date);
  }

  function presetDate(date, format, options) {
    const day = date.getDate();
    const month = date.getMonth() + 1;
    const year = date.getFullYear();
    if (format === "dd/mm/yyyy") return pad2(day) + "/" + pad2(month) + "/" + year;
    if (format === "mm/dd/yyyy") return pad2(month) + "/" + pad2(day) + "/" + year;
    if (format === "yyyy-mm-dd") return year + "-" + pad2(month) + "-" + pad2(day);
    if (format === "dd/mmmm/yyyy") return pad2(day) + " " + monthName(date, "long", options) + " " + year;
    if (format === "d mmm yyyy") return String(day) + " " + monthName(date, "short", options) + " " + year;
    return "";
  }

  function formatTime(date, prefs, options) {
    if (!isDate(date)) return "";
    const timeFormat = castTimeFormat(prefs && prefs.timeFormat, true);
    const opts = { hour: "numeric", minute: "2-digit" };
    if (timeFormat === "12h") opts.hour12 = true;
    else if (timeFormat === "24h") opts.hour12 = false;
    return date.toLocaleTimeString(localeList(options), opts);
  }

  function formatDate(date, prefs, options) {
    if (!isDate(date)) return "";
    const dateFormat = castDateFormat(prefs && prefs.dateFormat, true);
    if (dateFormat !== "system") return presetDate(date, dateFormat, options);
    const locales = localeList(options);
    if (options && options.omitYear) {
      return date.toLocaleDateString(locales, { month: "short", day: "numeric" });
    }
    if (options && options.weekday) {
      return date.toLocaleDateString(locales, {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    }
    return date.toLocaleDateString(locales);
  }

  function formatDateTime(date, prefs, options) {
    if (!isDate(date)) return "";
    const timeFormat = castTimeFormat(prefs && prefs.timeFormat, true);
    const dateFormat = castDateFormat(prefs && prefs.dateFormat, true);
    const locales = localeList(options);
    if (dateFormat === "system" && timeFormat === "system") {
      if (options && options.compact) {
        return date.toLocaleString(locales, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
      }
      if (options && options.medium) {
        try {
          return new Intl.DateTimeFormat(locales, { dateStyle: "medium", timeStyle: "short" }).format(date);
        } catch {
          return date.toLocaleString(locales);
        }
      }
      return date.toLocaleString(locales);
    }
    const dateText = formatDate(date, prefs, options);
    const timeText = formatTime(date, prefs, options);
    if (dateText && timeText) return dateText + ", " + timeText;
    return dateText || timeText;
  }

  function formatListWhen(date, now, prefs, options) {
    if (!isDate(date)) return "";
    const clock = isDate(now) ? now : new Date();
    if (date.toDateString() === clock.toDateString()) return formatTime(date, prefs, options);
    const dateFormat = castDateFormat(prefs && prefs.dateFormat, true);
    if (dateFormat === "system") {
      const sameYear = date.getFullYear() === clock.getFullYear();
      return formatDate(date, prefs, Object.assign({}, options, { omitYear: sameYear, weekday: false }));
    }
    return formatDate(date, prefs, options);
  }

  function formatMonthLabel(date, prefs, options) {
    if (!isDate(date)) return "";
    const dateFormat = castDateFormat(prefs && prefs.dateFormat, true);
    const locales = localeList(options);
    if (dateFormat === "system" || dateFormat === "dd/mmmm/yyyy") {
      return date.toLocaleDateString(locales, { month: "long", year: "numeric" });
    }
    if (dateFormat === "d mmm yyyy") {
      return date.toLocaleDateString(locales, { month: "short", year: "numeric" });
    }
    const month = pad2(date.getMonth() + 1);
    const year = String(date.getFullYear());
    if (dateFormat === "yyyy-mm-dd") return year + "-" + month;
    return month + "/" + year;
  }

  function weekdayLabels(options) {
    const style = options && options.narrow ? "narrow" : "short";
    const fmt = new Intl.DateTimeFormat(localeList(options), { weekday: style });
    const labels = [];
    for (let i = 0; i < 7; i += 1) labels.push(fmt.format(new Date(2023, 0, 1 + i)));
    return labels;
  }

  return {
    TIME_FORMATS,
    DATE_FORMATS,
    castTimeFormat,
    castDateFormat,
    formatTime,
    formatDate,
    formatDateTime,
    formatListWhen,
    formatMonthLabel,
    weekdayLabels,
  };
});
