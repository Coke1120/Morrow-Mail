// Runs from <head> before the body paints. CSP blocks an inline script.
(function () {
  try {
    var params = new URLSearchParams(window.location.search);
    if (params.get("role") === "compose") document.documentElement.dataset.window = "compose";
  } catch (error) { /* a non-browser check has no location */ }
})();
