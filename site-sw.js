/**
 * site-sw.js — site-wide service worker for image-tools.
 *
 * Two responsibilities:
 *   1. App-shell cache: HTML/CSS/JS/icons — stale-while-revalidate.
 *      The site keeps working offline once a page has been visited.
 *   2. ML-model cache: bulky WASM/ONNX/TFLite from CDNs — cache-first.
 *      One-time download cost, instant on every subsequent run.
 *
 * Strategy notes:
 *   - We bump CACHE_VERSION on shipping behavioural changes so old shells are
 *     evicted and fresh code reaches users (page <link rel=manifest> stays
 *     stable; only this file changes).
 *   - We never cache POST/non-GET, opaque cross-origin responses we don't
 *     trust, or anything from analytics-style endpoints.
 *   - We fall back to the network on cache miss; on network failure we serve
 *     the cached copy if any.
 */

const CACHE_VERSION = "v2";
const SHELL_CACHE   = `image-tools-shell-${CACHE_VERSION}`;
const MODEL_CACHE   = `image-tools-models-${CACHE_VERSION}`;

// Files we prefetch on install so the first offline visit works.
// Keep this minimal — large/optional pages are picked up lazily on first visit.
const SHELL_PRECACHE = [
  "./image-resize.html",
  "./compress-image.html",
  "./convert-to-pdf.html",
  "./format-convert.html",
  "./passport-photo.html",
  "./styles.css",
  "./image-resize.css",
  "./passport-photo.css",
  "./app.js",
  "./worker.js",
  "./passport-photo.js",
  "./passport-photo-worker.js",
  "./passport-photo-presets.js",
  "./images-to-pdf.js",
  "./format-convert.js",
  "./xsd-sample-xml.js",
  "./site.webmanifest",
  "./icons/app-icon.svg",
];

const MODEL_HOSTS = [
  "cdn.jsdelivr.net",
  "storage.googleapis.com",
  "esm.sh",
  "unpkg.com",
];

const MODEL_PATH_HINTS = [
  "@mediapipe/tasks-vision",
  "blaze_face_short_range",
  "selfie_segmenter",
  "heic2any",
  "jspdf",
  "fast-xml-parser",
  ".tflite",
  ".wasm",
];

// ─── Install / activate ─────────────────────────────────────────────────────

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Use { cache: "reload" } to bypass HTTP cache during precache.
    await Promise.allSettled(
      SHELL_PRECACHE.map(url => cache.add(new Request(url, { cache: "reload" })))
    );
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(k => k !== SHELL_CACHE && k !== MODEL_CACHE)
        .map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

// ─── Fetch ──────────────────────────────────────────────────────────────────

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch { return; }

  if (isModelAsset(url)) {
    event.respondWith(cacheFirst(req, MODEL_CACHE));
    return;
  }

  if (url.origin === self.location.origin && isShellAsset(url)) {
    event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
    return;
  }
  // Otherwise: don't intercept (let the browser handle it normally).
});

function isShellAsset(url) {
  // Only same-origin GETs of HTML/CSS/JS/PNG/SVG/JSON/manifest.
  return /\.(html?|css|m?js|png|jpg|jpeg|webp|svg|json|webmanifest|ico)$/i.test(url.pathname)
      || url.pathname.endsWith("/")
      || url.pathname === "";
}

function isModelAsset(url) {
  if (MODEL_HOSTS.includes(url.hostname)) return true;
  return MODEL_PATH_HINTS.some(h => url.href.includes(h));
}

// ─── Strategies ─────────────────────────────────────────────────────────────

async function cacheFirst(req, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(req, { ignoreVary: true });
  if (cached) return cached;
  try {
    const fresh = await fetch(req);
    if (shouldCache(fresh)) cache.put(req, fresh.clone()).catch(() => {});
    return fresh;
  } catch (err) {
    const fallback = await cache.match(req, { ignoreVary: true });
    if (fallback) return fallback;
    throw err;
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(req, { ignoreVary: true });

  const network = fetch(req)
    .then(res => {
      if (shouldCache(res)) cache.put(req, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);

  // Serve cached immediately if we have it; else wait for network; else fail.
  if (cached) {
    network.catch(() => {}); // keep the revalidate alive
    return cached;
  }
  const fresh = await network;
  if (fresh) return fresh;
  // Last-chance: a navigation request? serve a basic HTML shell to avoid the
  // browser's offline error page.
  if (req.mode === "navigate") {
    const fallback = await cache.match("./image-resize.html");
    if (fallback) return fallback;
  }
  return new Response("Offline and not cached", { status: 503, statusText: "Offline" });
}

function shouldCache(res) {
  return res
      && res.ok
      && (res.type === "basic" || res.type === "cors");
}
