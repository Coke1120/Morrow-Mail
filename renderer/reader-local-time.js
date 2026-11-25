(function () {
  "use strict";

  const MAX_SELECTION_LENGTH = 256;
  const months = "january february march april may june july august september october november december".split(" ");
  const weekdays = "sunday monday tuesday wednesday thursday friday saturday".split(" ");

  function englishNames(names, ...variants) {
    return [...names, ...names.map(name => name.slice(0, 3)), ...variants].join("|");
  }

  const monthNames = englishNames(months, "sept");
  const weekdayNames = englishNames(weekdays, "tues", "weds", "thur", "thurs");
  const numericOffset = String.raw`[+-]\d{2}(?::?\d{2})?`;
  const proseZone = String.raw`(?:(?:UTC|GMT)(?: *${numericOffset})?|${numericOffset})`;
  const stampSeconds = String.raw`(?::(?<second>\d{2})(?:\.(?<fraction>\d+))?)?`;

  const isoStamp = new RegExp([
    String.raw`^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})[T ]`,
    String.raw`(?<hour>\d{2}):(?<minute>\d{2})${stampSeconds}`,
    String.raw`(?: *(?<zone>Z|${numericOffset}))?$`,
  ].join(""), "i");
  const proseStamp = new RegExp([
    String.raw`^(?:(?:entries close|(?:submission )?deadline(?: is)?|due(?: on)?|observed at|starts at|ends at|on):? )?`,
    String.raw`(?:(?<weekday>${weekdayNames})\.?(?: *, *| ))?`,
    String.raw`(?:(?<dayFirst>\d{1,2}) (?<monthAfter>${monthNames})\.?|(?<monthFirst>${monthNames})\.? (?<dayAfter>\d{1,2}))`,
    String.raw`(?: *, *| )(?<year>\d{4}) (?:at )?`,
    String.raw`(?<hour>\d{1,2})(?::(?<minute>\d{2})${stampSeconds})?(?: *(?<meridiem>[ap]\.? *m\.?))?`,
    String.raw`(?: *(?<zone>${proseZone}|\( *${proseZone} *\)))?\.?$`,
  ].join(""), "i");

  function namedIndex(names, value) {
    const abbreviation = value.slice(0, 3).toLowerCase();
    return names.findIndex(name => name.startsWith(abbreviation));
  }

  function sourceOffsetMinutes(zone) {
    const value = zone.toUpperCase().replace(/[() ]/g, "").replace(/^(?:UTC|GMT)/, "");
    if (value === "" || value === "Z") return 0;
    const hours = Number(value.slice(1, 3));
    const minutes = Number(value.slice(3).replace(":", ""));
    if (hours > 23 || minutes > 59) return NaN;
    return (value[0] === "-" ? -1 : 1) * (hours * 60 + minutes);
  }

  function formatLocalTime(localWall, fraction, locale) {
    const significantFraction = fraction.replace(/0+$/, "");
    const time = new Intl.DateTimeFormat(locale, {
      timeZone: "UTC", hour: "2-digit", minute: "2-digit",
      second: localWall.getUTCSeconds() || significantFraction ? "2-digit" : undefined,
      fractionalSecondDigits: Math.min(3, significantFraction.length) || undefined,
    });
    if (significantFraction.length <= 3) return time.format(localWall);

    // Intl formats milliseconds. Append finer source precision in the same numbering system.
    const digits = new Intl.NumberFormat(locale, { numberingSystem: time.resolvedOptions().numberingSystem });
    const tail = [...significantFraction.slice(3)].map(digit => digits.format(Number(digit))).join("");
    return time.formatToParts(localWall)
      .map(({ type, value }) => type === "fractionalSecond" ? value + tail : value).join("");
  }

  function formatLocal(instant, sourceWall, fraction, timeZone, locale) {
    try {
      const destination = new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "longOffset" });
      const zone = destination.resolvedOptions().timeZone;
      const gmt = destination.formatToParts(instant).find(part => part.type === "timeZoneName")?.value;
      const offset = /^GMT(?:([+-])(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(gmt);
      if (!offset || /^[+-]/.test(zone)) return null;
      const [, sign = "+", hours = "0", minutes = "0", seconds = "0"] = offset;
      const offsetSeconds = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
      const localWall = new Date(instant.getTime() + (sign === "-" ? -1 : 1) * offsetSeconds * 1000);

      // The shift above gives the local wall clock. UTC formatting preserves those fields.
      const localDate = new Intl.DateTimeFormat(locale, {
        timeZone: "UTC", calendar: "gregory", year: "numeric", month: "short", day: "numeric",
        era: localWall.getUTCFullYear() <= 0 ? "short" : undefined,
      }).format(localWall);
      return {
        localDate,
        localTime: formatLocalTime(localWall, fraction, locale),
        timeZone: zone,
        utcOffset: `UTC${gmt.slice(3) || "+00:00"}`,
        dayChanged: localWall.toISOString().split("T")[0] !== sourceWall.toISOString().split("T")[0],
      };
    } catch (error) {
      if (error instanceof RangeError || error instanceof TypeError) return null;
      throw error;
    }
  }

  const clarify = reason => ({ status: "clarify", reason });

  // A complete ISO stamp or English named date fits within 256 characters. Prose
  // permits common deadline or observation lead-ins and an optional period.
  // Numeric source offsets take ±HH, ±HHMM or ±HH:MM. Success preserves source
  // text and instant precision, with a localized Gregorian date and UTC offset label.
  // `unsupported-format` covers unrecognized, ambiguous or oversized selections.
  // `missing-offset` and `unknown-offset` request an explicit source offset.
  // `invalid-date-time`, `weekday-mismatch` and `invalid-offset` identify bad fields.
  // `invalid-destination` covers invalid locale or IANA time zone options.
  function convertSelection(text, { timeZone, locale } = {}) {
    if (typeof text !== "string" || text.length > MAX_SELECTION_LENGTH) return clarify("unsupported-format");
    const selection = text.trim().replace(/\s+/g, " ").replace(/−/g, "-");
    const iso = isoStamp.exec(selection);
    const parts = (iso ?? proseStamp.exec(selection))?.groups;
    if (!parts) return clarify("unsupported-format");

    const { weekday, meridiem, zone, fraction = "" } = parts;
    const year = Number(parts.year);
    const month = iso ? Number(parts.month) : namedIndex(months, parts.monthFirst ?? parts.monthAfter) + 1;
    const day = Number(parts.day ?? parts.dayFirst ?? parts.dayAfter);
    let hour = Number(parts.hour);
    const minute = Number(parts.minute ?? 0);
    const second = Number(parts.second ?? 0);
    if (meridiem) {
      if (hour < 1 || hour > 12) return clarify("invalid-date-time");
      hour = hour % 12 + (meridiem[0].toLowerCase() === "p" ? 12 : 0);
    } else if (hour > 23 || parts.minute === undefined) {
      return clarify("invalid-date-time");
    }
    if (minute > 59 || second > 59 || (!iso && year === 0)) return clarify("invalid-date-time");

    // Setting the full year avoids the Date.UTC remapping of years 00 through 99.
    const wall = new Date(0);
    wall.setUTCFullYear(year, month - 1, day);
    if (wall.getUTCFullYear() !== year || wall.getUTCMonth() !== month - 1 || wall.getUTCDate() !== day) {
      return clarify("invalid-date-time");
    }
    if (weekday && wall.getUTCDay() !== namedIndex(weekdays, weekday)) return clarify("weekday-mismatch");
    if (!zone) return clarify("missing-offset");
    const offset = sourceOffsetMinutes(zone);
    if (Number.isNaN(offset)) return clarify("invalid-offset");
    if (Object.is(offset, -0)) return clarify("unknown-offset");

    wall.setUTCHours(hour, minute, second, Number(fraction.slice(0, 3).padEnd(3, "0")));
    const instant = new Date(wall.getTime() - offset * 60_000);
    const local = formatLocal(instant, wall, fraction, timeZone, locale);
    if (!local) return clarify("invalid-destination");
    return {
      status: "ok",
      sourceText: text,
      instant: instant.toISOString().replace(/Z$/, `${fraction.slice(3)}Z`),
      ...local,
    };
  }

  const api = { convertSelection };
  if (typeof module === "object" && module.exports) module.exports = api;
  else (typeof window === "object" ? window : globalThis).morrowReaderLocalTime = api;
})();
