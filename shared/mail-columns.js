(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.morrowMailColumns = api;
})(typeof window === "object" ? window : globalThis, function () {
  const defaults = ["date", "recipient", "sender", "subject", "status"];
  function normalize(value) {
    const order = [];
    for (const key of Array.isArray(value) ? value : []) if (defaults.includes(key) && !order.includes(key)) order.push(key);
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
  return { defaults, normalize, move, normalizeHidden, visible };
});
