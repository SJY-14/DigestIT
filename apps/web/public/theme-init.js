// Applies a saved theme choice before first paint (DIG-113), so a dark-mode user never sees a
// light flash. This has to be a plain classic script, not a module: a `type="module"` script is
// deferred until after the document is parsed, which would be too late. Served as-is from
// public/ (no bundling, stable URL) and loaded first in index.html's <head>, before the
// stylesheet link, so the parser runs and finishes this before the stylesheet is even requested.
// Keep the storage key and the valid values in sync with theme.ts.
(function () {
  try {
    var v = localStorage.getItem('digestit.theme');
    if (v === 'light' || v === 'dark') document.documentElement.setAttribute('data-theme', v);
  } catch (e) {
    // storage unavailable: "System" behavior (prefers-color-scheme decides) is correct anyway
  }
})();
