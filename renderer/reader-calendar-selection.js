/* Small, local grammar for a selected appointment range, not prose extraction. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./reader-local-time"));
  else root.morrowReaderCalendarSelection = factory(root.morrowReaderLocalTime);
})(typeof window === "object" ? window : globalThis, function (localTime) {
  const MAX_TEXT = 512;
  const date = String.raw`(?:\d{4}-\d{2}-\d{2}|\d{1,2} [a-z]+\.? \d{4}|[a-z]+\.? \d{1,2},? \d{4})`;
  const offset = String.raw`[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00)`;
  const isoZone = String.raw`(?:Z|${offset})`;
  const range = String.raw`(?:\s+(?:-|to)\s+|\s*[–—]\s*)`;
  const time = String.raw`\d{2}:\d{2}`;
  const stamp = String.raw`\d{4}-\d{2}-\d{2}T${time}${isoZone}`;
  const isoRange = new RegExp(`^(${stamp})${range}(${stamp})$`, "i");
  const datedRange = new RegExp(`^(${date})(?:,? |,? at )(${time})${range}(${time}) ((?:UTC|GMT)(?:${offset})?)$`, "i");
  const nonAppointment = /\b(?:deadlines?|due|rsvp|reply by|arriv(?:e|al)|check[- ]?in|opening hours|opens?|doors?|register|registration|cancell?ed|postponed|rescheduled|propos(?:ed|al)|tentative(?:ly)?|not confirmed|might|maybe|possibly|optional|if)\b/i;

  function parse(text) {
    if (typeof text !== "string" || text.length > MAX_TEXT || !localTime || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) return null;
    const lines = text.trim().split(/\r?\n/).map(line => line.trim().replace(/[\t\u00a0 ]+/g, " ")).filter(Boolean);
    if (lines.length > 3 || !lines.length || nonAppointment.test(lines.join(" "))) return null;
    let title = "", location = "", when = "";
    for (const line of lines) {
      if (/^title: /i.test(line) && !title) title = line.slice(7);
      else if (/^location: /i.test(line) && !location) location = line.slice(10);
      else if (!when) when = line.replace(/^when: /i, "");
      else return null;
    }
    if (!title && lines.length === 1) {
      const prefixed = /^([^:]{1,100}?)(?:: | is on )(.+)$/i.exec(when);
      if (prefixed && /\p{L}/u.test(prefixed[1])) [, title, when] = prefixed;
    }
    if (!when || title.length > 200 || location.length > 200) return null;
    // Do not use the title or location as a hidden second date/time source.
    if (/(?:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}|https?:\/\/|\S@\S)/i.test(title + " " + location)) return null;
    let endpoints = isoRange.exec(when);
    if (!endpoints) {
      const match = datedRange.exec(when);
      if (!match) return null;
      const [, day, start, end, zone] = match;
      if (/^\d{4}-/.test(day)) {
        const iso = zone.slice(3) || "Z";
        endpoints = [null, day + "T" + start + iso, day + "T" + end + iso];
      } else {
        endpoints = [null, [day, start, zone].join(" "), [day, end, zone].join(" ")];
      }
    }
    const result = endpoints.slice(1).map(row => localTime.convertSelection(row, { timeZone: "UTC", locale: "en-GB" }));
    if (result.some(row => row.status !== "ok") || Date.parse(result[0].instant) >= Date.parse(result[1].instant)) return null;
    return { title, location, start: result[0].instant, end: result[1].instant };
  }

  return { parse, MAX_TEXT };
});
