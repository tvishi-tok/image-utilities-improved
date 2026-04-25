/**
 * passport-photo-sw.js
 *
 * Tiny service worker dedicated to caching the ML model assets used by the
 * passport-photo tool. Goal: after the first run, repeat use is instant and
 * works offline.
 *
 * What we cache (cache-first, network-fallback):
 * • MediaPipe Tasks Vision WASM + bin (cdn.jsdelivr.net)
 * • MediaPipe BlazeFace TFLite face model (storage.googleapis.com)
 * • MediaPipe selfie_segmenter TFLite model (storage.googleapis.com)
 *
 * We deliberately do NOT cache the app's own HTML/JS/CSS — the regular
 * browser HTTP cache handles those, and we don't want stale code shipped
 * after deploys.
 */

// Bump on schema/asset changes so stale entries (e.g. the old imgly bundles)
// get wiped on the next page load.
const CACHE_NAME = "passport-photo-models-v2";

const MODEL_HOSTS = [
 "cdn.jsdelivr.net",
 "storage.googleapis.com",
];

const MODEL_PATH_HINTS = [
 "@mediapipe/tasks-vision",
 "blaze_face_short_range",
 "selfie_segmenter",
 ".tflite",
 ".wasm",
];

self.addEventListener("install", (event) => {
 self.skipWaiting();
});

self.addEventListener("activate", (event) => {
 event.waitUntil((async () => {
 const keys = await caches.keys();
 await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
 await self.clients.claim();
 })());
});

self.addEventListener("fetch", (event) => {
 const req = event.request;
 if (req.method !== "GET") return;

 let url;
 try { url = new URL(req.url); } catch { return; }

 const isModelHost = MODEL_HOSTS.includes(url.hostname);
 const isModelHint = MODEL_PATH_HINTS.some(h => url.href.includes(h));
 if (!isModelHost && !isModelHint) return;

 event.respondWith((async () => {
 const cache = await caches.open(CACHE_NAME);
 const cached = await cache.match(req, { ignoreVary: true });
 if (cached) return cached;

 try {
 const fresh = await fetch(req);
 // Only cache successful, basic/cors responses.
 if (fresh && fresh.ok && (fresh.type === "basic" || fresh.type === "cors")) {
 cache.put(req, fresh.clone()).catch(() => { /* quota etc — non-fatal */ });
 }
 return fresh;
 } catch (err) {
 // Last resort: re-check cache (race) and fail clearly.
 const fallback = await cache.match(req, { ignoreVary: true });
 if (fallback) return fallback;
 throw err;
 }
 })());
});
