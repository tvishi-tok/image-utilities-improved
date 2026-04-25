/**
 * pwa-register.js — site-wide service-worker registrar.
 *
 * Loaded by every page via a single <script defer src="pwa-register.js"></script>.
 * Tiny, dependency-free, fail-silent. Skips registration on environments that
 * shouldn't have a service worker (file://, no SW support, private mode where
 * SW registration throws).
 *
 * The actual caching logic lives in site-sw.js.
 */
(() => {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
    // Service workers only run on https or localhost. Quietly bail on file://.
    return;
  }
  // Defer to idle so we never compete with first-paint or user input.
  const register = () => {
    navigator.serviceWorker
      .register("./site-sw.js", { scope: "./" })
      .catch(() => { /* non-fatal; PWA features just won't be available */ });
  };
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(register, { timeout: 4000 });
  } else {
    window.addEventListener("load", () => setTimeout(register, 800));
  }
})();
