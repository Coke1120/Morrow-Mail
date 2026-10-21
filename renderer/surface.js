(function () {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("surface") === "compose") document.documentElement.dataset.surface = "compose";
  } catch {
    /* the main window keeps the full shell */
  }
})();
