(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.morrowMailColumns = api;
})(typeof window === "object" ? window : globalThis, function () {
  const defaults = ["date", "time", "recipient", "sender", "subject"];
  function normalize(value) {
    const order = [];
    for (const key of Array.isArray(value) ? value : []) if (defaults.includes(key) && !order.includes(key)) order.push(key);
    // Older layouts have no Time column. Keep their relative order and put the
    // new column beside Date; an explicitly saved Time position wins.
    if (order.includes("date") && !order.includes("time")) order.splice(order.indexOf("date") + 1, 0, "time");
    return order.concat(defaults.filter(key => !order.includes(key)));
  }
  function move(order, source, target, after = false) {
    const current = normalize(order);
    if (!current.includes(source) || !current.includes(target) || source === target) return current;
    const next = current.filter(key => key !== source);
    next.splice(next.indexOf(target) + (after ? 1 : 0), 0, source);
    return next;
  }
  // Subject remains visible so corrupt settings cannot produce an empty list.
  function normalizeHidden(value) {
    return defaults.filter(key => key !== "subject" && Array.isArray(value) && value.includes(key));
  }
  function visible(order, hidden) {
    const excluded = normalizeHidden(hidden);
    return normalize(order).filter(key => !excluded.includes(key));
  }
  const widthBounds = Object.freeze({ date: Object.freeze([80, 360]), time: Object.freeze([60, 240]),
    recipient: Object.freeze([100, 640]), sender: Object.freeze([100, 640]), subject: Object.freeze([140, 1200]) });
  function normalizeWidths(value) {
    const widths = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return widths;
    for (const key of defaults) {
      if (!Object.hasOwn(value, key) || typeof value[key] !== "number" || !Number.isFinite(value[key])) continue;
      const [min, max] = widthBounds[key];
      widths[key] = Math.max(min, Math.min(max, Math.round(value[key])));
    }
    return widths;
  }
  return { defaults, normalize, move, normalizeHidden, visible, widthBounds, normalizeWidths };
});
