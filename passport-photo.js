/**
 * passport-photo.js — main-thread controller for passport-photo.html
 *
 * What lives here (and why):
 *   • UI state, drag-and-drop, preset switching.
 *   • HEIC decoding (heic2any UMD already loaded by the page).
 *   • EXIF orientation fix.
 *   • Aggressive downscale to a working bitmap (≤ 2000 px on long side)
 *     before any ML — keeps memory/time bounded even on mid-range phones.
 *   • MediaPipe Face Detection (loaded from CDN, runs on WebGL/CPU here on
 *     the main thread because it owns its own GL context and can't easily
 *     run inside a module worker).
 *   • Posts the working bitmap + face landmarks to the worker for the heavy
 *     pipeline (background removal, crop, exact mm sizing, encode).
 *   • Receives result, paints preview, exposes downloads.
 *   • Builds a 4×6 inch print-sheet PDF with auto-fit photos using jsPDF.
 *
 * Reliability rules followed:
 *   • All heavy work in worker, MediaPipe excepted (WebGL constraint).
 *   • OffscreenCanvas where supported, on-DOM canvas fallback.
 *   • HEIC support, EXIF orientation honoured.
 *   • Lazy model loading + cached by service worker.
 *   • Memory hygiene (close ImageBitmaps, revoke object URLs).
 *   • Graceful degradation (no face → manual centre crop).
 *   • Clear copy: nothing leaves device.
 */

import { PRESETS, PRESET_ORDER, PRINT_SHEET, mmToPx } from "./passport-photo-presets.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_FILE_BYTES         = 25 * 1024 * 1024;
const WORKING_MAX_DIM_PX     = 2000;             // cap before ML
const FACE_DETECT_MAX_DIM_PX = 1024;             // smaller copy for face detector
const SEGMENT_MAX_DIM_PX     = 1536;             // smaller copy for segmenter (higher = sharper edges)

// Official MediaPipe Tasks Vision ESM bundle (works without bundler glue).
// `vision_bundle.mjs` is the documented entry point; `+esm` is the jsdelivr
// resolver and has had MIME / redirect issues on some networks.
const VISION_BUNDLE_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
const VISION_WASM_BASE  = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";

const FACE_MODEL_URL    = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
const SEGMENT_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  presetId:        "us_passport",
  fileName:        null,
  workingBitmap:   null,    // ImageBitmap of downscaled, EXIF-corrected source
  faces:           null,
  faceDetector:    null,
  faceModelError:  null,    // string set when MediaPipe face model failed to load
  segmenter:       null,
  segModelError:   null,    // string set when MediaPipe segmenter failed to load
  bgModelError:    null,    // string set on actual bg-removal failure at use time
  visionModule:    null,    // cached @mediapipe/tasks-vision import
  visionFileset:   null,
  worker:          null,
  lastJpegUrl:     null,
  lastJpegBlob:    null,
  lastResult:      null,
  // Manual-crop UI state.
  cropOverride:    null,    // { x, y, w, h } in working-bitmap pixels — passed to worker
  crop: {
    active:        false,   // whether the overlay is currently shown
    canvasScale:   1,       // px-on-screen ÷ px-in-source for the crop canvas
    rect:          null,    // current rect in source-pixel space
    drag:          null,    // active pointer drag descriptor
  },
};

// ─── DOM helpers ──────────────────────────────────────────────────────────────

const $  = (id) => document.getElementById(id);
const els = {
  drop:           () => $("drop"),
  fileInput:      () => $("fileInput"),
  fileName:       () => $("fileNameDisplay"),
  presetButtons:  () => document.querySelectorAll(".format-mode[data-preset]"),
  presetSummary:  () => $("presetSummary"),
  optBgRemove:    () => $("optBgRemove"),
  optAutoCrop:    () => $("optAutoCrop"),
  bgColor:        () => $("bgColor"),
  bgColorPreset:  () => $("bgColorPreset"),
  targetSizeKb:   () => $("targetSizeKb"),
  sizeHint:       () => $("sizeHint"),
  processBtn:     () => $("processBtn"),
  resetBtn:       () => $("resetBtn"),
  loader:         () => $("loader"),
  loaderText:     () => $("loaderText"),
  progress:       () => $("progress"),
  progressFill:   () => $("progressFill"),
  progressLabel:  () => $("progressLabel"),
  status:         () => $("status"),
  checks:         () => $("checks"),
  previewCanvas:  () => $("previewCanvas"),
  previewPlaceholder: () => $("previewPlaceholder"),
  photoMeta:      () => $("photoMeta"),
  downloadActions:() => $("downloadActions"),
  downloadJpg:    () => $("downloadJpg"),
  downloadSheet:  () => $("downloadSheet"),
  // Manual crop.
  cropStage:      () => $("cropStage"),
  cropCanvas:     () => $("cropCanvas"),
  cropRect:       () => $("cropRect"),
  cropGuideEye:   () => $("cropGuideEye"),
  cropDim:        () => $("cropDim"),
  cropHint:       () => $("cropHint"),
  resetCropBtn:   () => $("resetCropBtn"),
  reopenCropBtn:  () => $("reopenCropBtn"),
};

function setStatus(msg, tone = "info") {
  const el = els.status();
  if (!el) return;
  el.textContent = msg || "";
  el.dataset.tone = tone;
}

function setLoader(visible, text) {
  const l = els.loader();
  if (!l) return;
  l.style.display = visible ? "inline-flex" : "none";
  if (text) els.loaderText().textContent = text;
}

function setProgress(fraction, label) {
  const p = els.progress();
  if (!p) return;
  p.hidden = fraction == null;
  if (fraction != null) {
    els.progressFill().style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
    els.progressLabel().textContent = label || "";
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
  // Service-worker registration is centralised in pwa-register.js (loaded
  // by every page) so we don't double-register from here.

  els.presetButtons().forEach(btn => {
    btn.addEventListener("click", () => setPreset(btn.dataset.preset));
  });

  wireDropzone();
  wireFileInput();
  wireOptions();

  els.processBtn().addEventListener("click", () => runPipeline());
  els.resetBtn().addEventListener("click", resetAll);
  els.downloadSheet().addEventListener("click", buildPrintSheetPdf);

  els.resetCropBtn().addEventListener("click", resetCropToAuto);
  els.reopenCropBtn()?.addEventListener("click", () => {
    openCropOverlay();
    setStatus("Drag the crop box, then click Generate again.", "info");
  });
  window.addEventListener("resize", onCropWindowResize);

  setPreset(state.presetId);
  setStatus("Drop a clear front-facing photo to begin.", "info");

  // Warm up the heavy models in the background so the first Generate click is
  // snappy. Failures are silent here — we'll surface them at use time.
  ensureFaceDetector({ silent: true }).catch(() => { /* surfaced on use */ });
  ensureSegmenter({ silent: true }).catch(() => { /* surfaced on use */ });
}

// ─── Preset handling ─────────────────────────────────────────────────────────

function setPreset(id) {
  if (!PRESETS[id]) return;
  if (state.presetId !== id) {
    // Aspect ratio likely changes — invalidate any manual crop.
    state.cropOverride = null;
    if (state.crop.active) closeCropOverlay();
  }
  state.presetId = id;
  els.presetButtons().forEach(b => {
    const active = b.dataset.preset === id;
    b.classList.toggle("is-active", active);
    b.setAttribute("aria-selected", active ? "true" : "false");
  });
  const p = PRESETS[id];
  const px = { w: mmToPx(p.photo.widthMm, p.photo.dpi), h: mmToPx(p.photo.heightMm, p.photo.dpi) };
  els.presetSummary().innerHTML =
    `<strong>${p.label}</strong> — ${p.description} ` +
    `Output: <strong>${p.photo.widthMm} × ${p.photo.heightMm} mm</strong> ` +
    `(${px.w} × ${px.h} px @ ${p.photo.dpi} DPI). ` +
    `File size: ${p.fileSize.minKB}–${p.fileSize.maxKB} KB.`;
  els.bgColor().value = p.background.hex;
  els.bgColorPreset().value = p.background.hex;
  els.sizeHint().textContent =
    `Allowed range for ${p.country === "IN" ? "Indian" : "US"} portal: ${p.fileSize.minKB}–${p.fileSize.maxKB} KB. ` +
    `Leave blank to use ~${p.fileSize.preferredKB} KB.`;
}

// ─── Drag & drop / file picker ───────────────────────────────────────────────

function wireDropzone() {
  const drop = els.drop();
  drop.addEventListener("click",   () => els.fileInput().click());
  drop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); els.fileInput().click(); }
  });
  drop.addEventListener("dragover",  (e) => { e.preventDefault(); drop.classList.add("active"); });
  drop.addEventListener("dragleave", ()  => drop.classList.remove("active"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("active");
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  });
}

function wireFileInput() {
  els.fileInput().addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  });
}

function wireOptions() {
  els.bgColorPreset().addEventListener("change", (e) => {
    els.bgColor().value = e.target.value;
  });
}

// ─── File ingestion ──────────────────────────────────────────────────────────

async function handleFile(file) {
  resetResults();

  if (!file) return;
  if (file.size > MAX_FILE_BYTES) {
    setStatus(`File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max is 25 MB.`, "error");
    return;
  }

  state.fileName = file.name;
  els.fileName().textContent = file.name;

  setLoader(true, "Reading image…");
  setProgress(0.05, "Decoding photo…");

  try {
    const decoded = await decodeAnyImage(file);
    setProgress(0.2, "Correcting orientation…");
    const oriented = await applyExifOrientation(decoded.bitmap, decoded.orientation);
    // Only close the source if applyExifOrientation produced a NEW bitmap.
    // When orientation === 1 it returns the same object — closing it here would
    // detach what we're about to use.
    if (oriented !== decoded.bitmap) {
      try { decoded.bitmap.close?.(); } catch { /* ignore */ }
    }

    setProgress(0.3, "Downscaling working copy…");
    state.workingBitmap = await downscaleBitmap(oriented, WORKING_MAX_DIM_PX);
    if (state.workingBitmap !== oriented) {
      try { oriented.close?.(); } catch { /* ignore */ }
    }

    setProgress(0.4, "Detecting face…");
    const detection = await detectFaces(state.workingBitmap);
    state.faces          = detection.faces;
    state.faceModelError = detection.modelError;

    if (state.faceModelError) {
      setStatus(state.faceModelError, "warn");
    } else if (!state.faces.length) {
      setStatus(
        "No face detected in this photo. Drag the crop box on the right to align it manually, then click Generate.",
        "warn",
      );
    } else {
      setStatus("Face detected. Fine-tune the crop on the right if needed, then click Generate.", "success");
    }

    state.cropOverride = null;
    els.processBtn().disabled = false;

    openCropOverlay();
  } catch (err) {
    console.error(err);
    setStatus(err.message || "Could not read this file.", "error");
    els.processBtn().disabled = true;
  } finally {
    setLoader(false);
    setProgress(null);
  }
}

// ─── Decoding (HEIC fallback) ────────────────────────────────────────────────

async function decodeAnyImage(file) {
  const isHeic = /\.(heic|heif)$/i.test(file.name) || /heic|heif/i.test(file.type);

  // Try the browser first — Safari decodes HEIC natively.
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    // imageOrientation:"from-image" means EXIF is already applied; mark accordingly.
    return { bitmap, orientation: 1, exifApplied: true };
  } catch (e) {
    if (!isHeic) throw e;
  }

  // HEIC fallback via heic2any (UMD loaded in the page).
  if (typeof self.heic2any !== "function") {
    throw new Error("HEIC support is unavailable. Please convert to JPG and retry.");
  }
  const jpegBlob = await self.heic2any({ blob: file, toType: "image/jpeg", quality: 0.9 });
  const blob = Array.isArray(jpegBlob) ? jpegBlob[0] : jpegBlob;
  const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  return { bitmap, orientation: 1, exifApplied: true };
}

// EXIF orientation is handled by createImageBitmap's `imageOrientation:"from-image"`
// in modern browsers. This shim is here only for the (rare) case where a fallback
// path delivered a non-oriented bitmap.
async function applyExifOrientation(bitmap, orientation) {
  if (!orientation || orientation === 1) return bitmap;
  const w = bitmap.width, h = bitmap.height;
  const swap = orientation >= 5 && orientation <= 8;
  const c = makeCanvas(swap ? h : w, swap ? w : h);
  const ctx = c.getContext("2d");
  switch (orientation) {
    case 2: ctx.transform(-1, 0, 0,  1,  w, 0); break;
    case 3: ctx.transform(-1, 0, 0, -1,  w, h); break;
    case 4: ctx.transform( 1, 0, 0, -1,  0, h); break;
    case 5: ctx.transform( 0, 1, 1,  0,  0, 0); break;
    case 6: ctx.transform( 0, 1, -1, 0,  h, 0); break;
    case 7: ctx.transform( 0, -1,-1, 0,  h, w); break;
    case 8: ctx.transform( 0, -1, 1, 0,  0, w); break;
  }
  ctx.drawImage(bitmap, 0, 0);
  return await createImageBitmap(c);
}

async function downscaleBitmap(bitmap, maxDim) {
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  if (scale === 1) return bitmap;
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const c = makeCanvas(w, h);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, w, h);
  return await createImageBitmap(c);
}

// OffscreenCanvas where available (workers, modern browsers); fallback to DOM canvas.
function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

// ─── Face detection (MediaPipe Tasks Vision) ─────────────────────────────────

async function loadVision() {
  if (state.visionModule && state.visionFileset) {
    return { vision: state.visionModule, fileset: state.visionFileset };
  }
  // The official ESM bundle. Falls back to the jsdelivr +esm resolver if the
  // primary URL is blocked (some corporate proxies do this).
  let vision;
  try {
    vision = await import(/* @vite-ignore */ VISION_BUNDLE_URL);
  } catch (err) {
    console.warn("[passport-photo] primary MediaPipe URL failed, trying fallback:", err);
    vision = await import(/* @vite-ignore */ "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm");
  }
  const fileset = await vision.FilesetResolver.forVisionTasks(VISION_WASM_BASE);
  state.visionModule  = vision;
  state.visionFileset = fileset;
  return { vision, fileset };
}

async function ensureFaceDetector({ silent = false } = {}) {
  if (state.faceDetector) return state.faceDetector;
  if (!silent) setLoader(true, "Loading face detector (one-time, ~3 MB)…");
  try {
    const { vision, fileset } = await loadVision();
    state.faceDetector = await vision.FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: FACE_MODEL_URL },
      runningMode: "IMAGE",
      // Lowered from 0.5 — BlazeFace short-range can dip into the 0.3-0.5
      // band on slightly-off-axis portraits, and a passport photo by
      // definition almost always *has* a face. Multi-face is filtered later.
      minDetectionConfidence: 0.3,
    });
    state.faceModelError = null;
    return state.faceDetector;
  } catch (err) {
    state.faceModelError =
      "Face detector could not load (network blocked or offline). " +
      "Auto-alignment is disabled — use the crop box on the right to align by hand.";
    throw err;
  }
}

async function ensureSegmenter({ silent = false } = {}) {
  if (state.segmenter) return state.segmenter;
  if (!silent) setLoader(true, "Loading background segmenter (one-time, ~1 MB)…");
  try {
    const { vision, fileset } = await loadVision();
    state.segmenter = await vision.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: SEGMENT_MODEL_URL },
      runningMode: "IMAGE",
      outputCategoryMask:   false,
      outputConfidenceMasks: true,
    });
    state.segModelError = null;
    return state.segmenter;
  } catch (err) {
    state.segModelError =
      "Background segmenter could not load (network blocked or offline). " +
      "The original background was kept.";
    throw err;
  }
}

/**
 * Returns { faces: Array, modelError: string|null }.
 * - faces: detected faces (may be empty if no face in the photo).
 * - modelError: non-null only when the MediaPipe model itself failed to load.
 */
async function detectFaces(bitmap) {
  try {
    const detector = await ensureFaceDetector();

    // Pass 1: detect on a downscaled copy for speed.
    let faces = await detectOnce(detector, bitmap, FACE_DETECT_MAX_DIM_PX);

    // Pass 2: if nothing found, retry on the full working bitmap. Slower but
    // catches faces that fell below the detector's effective resolution.
    if (faces.length === 0 && Math.max(bitmap.width, bitmap.height) > FACE_DETECT_MAX_DIM_PX) {
      faces = await detectOnce(detector, bitmap, Math.max(bitmap.width, bitmap.height));
    }

    return { faces, modelError: null };
  } catch (err) {
    console.warn("[passport-photo] face detection unavailable:", err);
    return { faces: [], modelError: state.faceModelError || (err?.message || "Face detector failed") };
  }
}

async function detectOnce(detector, bitmap, maxDim) {
  const detectBitmap = await downscaleBitmap(bitmap, maxDim);
  let result;
  try {
    result = detector.detect(detectBitmap);
  } finally {
    if (detectBitmap !== bitmap) detectBitmap.close?.();
  }
  const scaleX = bitmap.width  / detectBitmap.width;
  const scaleY = bitmap.height / detectBitmap.height;

  return (result.detections || []).map(d => {
    const box = d.boundingBox;
    const kp  = d.keypoints || [];
    const rightEye = kp[0] ? { x: kp[0].x * bitmap.width, y: kp[0].y * bitmap.height } : null;
    const leftEye  = kp[1] ? { x: kp[1].x * bitmap.width, y: kp[1].y * bitmap.height } : null;
    return {
      box: {
        x: box.originX * scaleX,
        y: box.originY * scaleY,
        w: box.width   * scaleX,
        h: box.height  * scaleY,
      },
      leftEye, rightEye,
      score: d.categories?.[0]?.score ?? 0,
    };
  }).sort((a, b) => (b.box.w * b.box.h) - (a.box.w * a.box.h));
}

// ─── Background replacement (MediaPipe Image Segmenter) ─────────────────────
//
// Uses the selfie_segmenter model from MediaPipe Tasks Vision, same loader as
// face detection. The previous library (@imgly/background-removal via esm.sh)
// was unreliable: it pulled in onnxruntime-web which expects a Node-style
// `path.dirname` polyfill the CDN doesn't always provide, manifesting as
// "Failed to create session: I.dirname is not a function".

/**
 * Returns a NEW ImageBitmap with the original subject pasted onto a solid
 * `bgHex` background.
 *
 * Pipeline:
 *   1. Run segmenter at SEGMENT_MAX_DIM_PX for high-quality confidence mask.
 *   2. Apply a 3x3 box blur to the mask to suppress single-pixel noise that
 *      shows up as "sparkles" on hair / shoulders.
 *   3. For every output pixel, sample the mask with bilinear interpolation
 *      and run the confidence through a smoothstep curve (cubic Hermite)
 *      so the subject→background transition is anti-aliased rather than a
 *      hard ramp.
 */
async function replaceBackground(srcBitmap, bgHex) {
  const segmenter = await ensureSegmenter();

  const segBitmap = await downscaleBitmap(srcBitmap, SEGMENT_MAX_DIM_PX);
  let mask;
  try {
    const result = segmenter.segment(segBitmap);
    mask = result.confidenceMasks?.[0];
    if (!mask) throw new Error("Segmenter returned no mask");

    const maskW = mask.width;
    const maskH = mask.height;
    const rawMask = mask.getAsFloat32Array();

    // 1. Smooth the mask in place with a 3x3 box blur. Cheap and very
    //    effective at killing the speckle the selfie segmenter produces
    //    around hair, glasses, and shoulder edges.
    const smoothed = boxBlurMask(rawMask, maskW, maskH);

    // 2. Composite at the working bitmap's resolution.
    const outW = srcBitmap.width;
    const outH = srcBitmap.height;

    const srcCanvas = makeCanvas(outW, outH);
    srcCanvas.getContext("2d").drawImage(srcBitmap, 0, 0);
    const srcImg = srcCanvas.getContext("2d").getImageData(0, 0, outW, outH);

    const outCanvas = makeCanvas(outW, outH);
    const outCtx    = outCanvas.getContext("2d");
    outCtx.fillStyle = bgHex;
    outCtx.fillRect(0, 0, outW, outH);
    const outImg = outCtx.getImageData(0, 0, outW, outH);

    const [bgR, bgG, bgB] = hexToRgb(bgHex);

    // Wider feather for smoother edges. Smoothstep(LO, HI, x) is cubic so
    // the transition has no visible kink.
    const LO = 0.30;
    const HI = 0.70;

    const sx = maskW / outW;
    const sy = maskH / outH;

    for (let y = 0; y < outH; y++) {
      // Bilinear-sample y coordinate into mask space.
      const fy = y * sy;
      const y0 = Math.min(maskH - 1, Math.floor(fy));
      const y1 = Math.min(maskH - 1, y0 + 1);
      const ty = fy - y0;

      for (let x = 0; x < outW; x++) {
        const fx = x * sx;
        const x0 = Math.min(maskW - 1, Math.floor(fx));
        const x1 = Math.min(maskW - 1, x0 + 1);
        const tx = fx - x0;

        const c00 = smoothed[y0 * maskW + x0];
        const c10 = smoothed[y0 * maskW + x1];
        const c01 = smoothed[y1 * maskW + x0];
        const c11 = smoothed[y1 * maskW + x1];

        const c0 = c00 + (c10 - c00) * tx;
        const c1 = c01 + (c11 - c01) * tx;
        const conf = c0 + (c1 - c0) * ty;

        // Smoothstep(LO, HI, conf) — cubic Hermite ramp.
        let alpha;
        if (conf <= LO) alpha = 0;
        else if (conf >= HI) alpha = 1;
        else {
          const t = (conf - LO) / (HI - LO);
          alpha = t * t * (3 - 2 * t);
        }

        const idx = (y * outW + x) * 4;
        if (alpha === 0) {
          outImg.data[idx]     = bgR;
          outImg.data[idx + 1] = bgG;
          outImg.data[idx + 2] = bgB;
          outImg.data[idx + 3] = 255;
        } else if (alpha === 1) {
          outImg.data[idx]     = srcImg.data[idx];
          outImg.data[idx + 1] = srcImg.data[idx + 1];
          outImg.data[idx + 2] = srcImg.data[idx + 2];
          outImg.data[idx + 3] = 255;
        } else {
          const inv = 1 - alpha;
          outImg.data[idx]     = srcImg.data[idx]     * alpha + bgR * inv;
          outImg.data[idx + 1] = srcImg.data[idx + 1] * alpha + bgG * inv;
          outImg.data[idx + 2] = srcImg.data[idx + 2] * alpha + bgB * inv;
          outImg.data[idx + 3] = 255;
        }
      }
    }
    outCtx.putImageData(outImg, 0, 0);
    return await createImageBitmap(outCanvas);
  } finally {
    try { mask?.close?.(); } catch { /* ignore */ }
    if (segBitmap !== srcBitmap) try { segBitmap.close?.(); } catch { /* ignore */ }
  }
}

/**
 * Tight 3x3 box blur on a Float32 confidence mask. Edges replicate.
 */
function boxBlurMask(src, w, h) {
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    const ym = y === 0 ? 0 : y - 1;
    const yp = y === h - 1 ? y : y + 1;
    for (let x = 0; x < w; x++) {
      const xm = x === 0 ? 0 : x - 1;
      const xp = x === w - 1 ? x : x + 1;
      const s =
        src[ym * w + xm] + src[ym * w + x] + src[ym * w + xp] +
        src[ y * w + xm] + src[ y * w + x] + src[ y * w + xp] +
        src[yp * w + xm] + src[yp * w + x] + src[yp * w + xp];
      out[y * w + x] = s / 9;
    }
  }
  return out;
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "#FFFFFF");
  if (!m) return [255, 255, 255];
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

// ─── Worker pipeline ─────────────────────────────────────────────────────────

function ensureWorker() {
  if (state.worker) return state.worker;
  state.worker = new Worker(new URL("./passport-photo-worker.js", import.meta.url), { type: "module" });
  state.worker.addEventListener("message", onWorkerMessage);
  state.worker.addEventListener("error", (e) => {
    console.error("[passport-photo] worker error:", e);
    setStatus("Image processing failed. Please try a different photo.", "error");
    setLoader(false);
    setProgress(null);
  });
  return state.worker;
}

let pendingResolve = null;
function onWorkerMessage(e) {
  const msg = e.data || {};
  if (msg.type === "progress") {
    setProgress(msg.fraction, msg.message);
  } else if (msg.type === "result") {
    if (pendingResolve) { pendingResolve(msg); pendingResolve = null; }
  } else if (msg.type === "error") {
    if (pendingResolve) { pendingResolve(Promise.reject(new Error(msg.message))); pendingResolve = null; }
  }
}

async function runPipeline() {
  if (!state.workingBitmap) return;

  setLoader(true, "Generating passport photo…");
  setProgress(0.05, "Starting pipeline…");
  setStatus("");
  els.checks().hidden = true;
  state.bgModelError = null;

  try {
    const preset = PRESETS[state.presetId];
    // Whatever rectangle the user is currently looking at IS the crop. If they
    // dragged it manually we honour that; otherwise the auto-default is what
    // they see on screen too.
    const liveCropRect = state.crop.active && state.crop.rect ? { ...state.crop.rect } : null;
    const options = {
      removeBackground: els.optBgRemove().checked,
      autoCrop:         els.optAutoCrop().checked,
      bgColor:          els.bgColor().value || preset.background.hex,
      targetKB:         parseInt(els.targetSizeKb().value || "0", 10) || null,
      cropOverride:     liveCropRect || state.cropOverride || null,
    };

    // 1. Background replacement (main thread, MediaPipe). If it fails we
    //    fall back to the original bitmap and surface the error.
    let bitmapForWorker = state.workingBitmap;
    let bgApplied = false;
    if (options.removeBackground) {
      try {
        setProgress(0.25, "Replacing background…");
        bitmapForWorker = await replaceBackground(state.workingBitmap, options.bgColor);
        bgApplied = true;
      } catch (err) {
        console.warn("[passport-photo] background replacement failed:", err);
        state.bgModelError = state.segModelError || err?.message ||
          "Background replacement failed — original background kept.";
        bitmapForWorker = state.workingBitmap;
      }
    }

    // 2. Send a fresh transferable ImageBitmap; clone if we're using the
    //    user's working bitmap directly (so we keep our own copy alive).
    setProgress(0.6, "Cropping and encoding…");
    const sendBitmap = bitmapForWorker === state.workingBitmap
      ? await cloneBitmap(state.workingBitmap)
      : bitmapForWorker;

    const worker = ensureWorker();
    const result = await new Promise((resolve, reject) => {
      pendingResolve = (v) => v?.then ? v.then(resolve, reject) : resolve(v);
      worker.postMessage(
        {
          type: "process",
          imageBitmap: sendBitmap,
          faces: state.faces,
          preset,
          options: { ...options, bgApplied },
        },
        [sendBitmap],
      );
    });

    state.lastResult = result;
    await displayResult(result, preset, { ...options, bgApplied });
  } catch (err) {
    console.error(err);
    setStatus(err.message || "Failed to generate photo.", "error");
  } finally {
    setLoader(false);
    setProgress(null);
  }
}

async function cloneBitmap(bitmap) {
  // ImageBitmap can be transferred but not reused — clone so the main thread keeps a copy.
  if (!bitmap || typeof bitmap.width !== "number" || bitmap.width === 0) {
    throw new Error("The image is no longer available — please re-upload your photo.");
  }
  const c = makeCanvas(bitmap.width, bitmap.height);
  try {
    c.getContext("2d").drawImage(bitmap, 0, 0);
  } catch (err) {
    throw new Error("The image source has been released — please re-upload your photo.");
  }
  return await createImageBitmap(c);
}

// ─── Render preview & downloads ──────────────────────────────────────────────

async function displayResult(result, preset, options) {
  // The crop overlay was open during the workflow — hide it now that we have
  // a result to show. The user can re-open it via "Adjust crop & regenerate".
  if (state.crop.active) closeCropOverlay();

  // Paint preview canvas from the small preview PNG returned by the worker.
  const previewBlob = new Blob([result.previewBuffer], { type: result.previewMime });
  const previewBitmap = await createImageBitmap(previewBlob);
  const cv = els.previewCanvas();
  cv.width  = previewBitmap.width;
  cv.height = previewBitmap.height;
  cv.getContext("2d").drawImage(previewBitmap, 0, 0);
  cv.classList.remove("hidden");
  els.previewPlaceholder().style.display = "none";
  previewBitmap.close?.();

  // Set up download.
  if (state.lastJpegUrl) URL.revokeObjectURL(state.lastJpegUrl);
  state.lastJpegBlob = new Blob([result.jpegBuffer], { type: result.jpegMime });
  state.lastJpegUrl  = URL.createObjectURL(state.lastJpegBlob);
  const dl = els.downloadJpg();
  dl.href = state.lastJpegUrl;
  dl.download = downloadName(preset, "jpg");
  els.downloadActions().hidden = false;

  els.photoMeta().textContent =
    `${result.widthPx} × ${result.heightPx} px · ${preset.photo.widthMm} × ${preset.photo.heightMm} mm @ ${result.dpi} DPI · ` +
    `${(result.sizeBytes / 1024).toFixed(1)} KB`;

  // Compliance checks.
  renderChecks(result, preset, options);
  if (state.bgModelError) {
    setStatus(state.bgModelError, "warn");
  } else {
    setStatus("Photo generated. Review the checks before downloading.", "success");
  }
}

function downloadName(preset, ext) {
  const base = (state.fileName || "photo").replace(/\.[^.]+$/, "");
  return `${base}-${preset.id}.${ext}`;
}

// ─── Compliance checks (client-side) ────────────────────────────────────────

function renderChecks(result, preset, options) {
  const checks = [];

  const sizeKB = result.sizeBytes / 1024;
  if (sizeKB < preset.fileSize.minKB)
    checks.push({ status: "warn", text: `File size ${sizeKB.toFixed(0)} KB is under the ${preset.fileSize.minKB} KB minimum — increase target size.` });
  else if (sizeKB > preset.fileSize.maxKB)
    checks.push({ status: "fail", text: `File size ${sizeKB.toFixed(0)} KB exceeds ${preset.fileSize.maxKB} KB — set a target file size.` });
  else
    checks.push({ status: "pass", text: `File size ${sizeKB.toFixed(0)} KB within ${preset.fileSize.minKB}–${preset.fileSize.maxKB} KB.` });

  if (state.faceModelError) {
    checks.push({ status: "warn", text: "Face detector unavailable — alignment is based on your manual crop." });
  } else if (state.faces?.length === 1) {
    checks.push({ status: "pass", text: "One face detected." });
  } else if (!state.faces?.length) {
    checks.push({ status: "warn", text: "No face detected in this photo — alignment is based on your manual crop." });
  } else {
    checks.push({ status: "fail", text: `${state.faces.length} faces detected — only one is allowed.` });
  }

  if (state.faces?.[0]?.score >= 0.85)
    checks.push({ status: "pass", text: `Face detection confidence ${(state.faces[0].score * 100).toFixed(0)}%.` });
  else if (state.faces?.[0])
    checks.push({ status: "warn", text: `Low face confidence (${(state.faces[0].score * 100).toFixed(0)}%) — try better lighting.` });

  if (!options.removeBackground) {
    checks.push({ status: "warn", text: "Background not replaced — make sure your original is plain and uniform." });
  } else if (options.bgApplied) {
    checks.push({ status: "pass", text: `Background replaced with ${options.bgColor.toUpperCase()}.` });
  } else {
    checks.push({
      status: "fail",
      text: state.bgModelError ||
        "Background replacement was requested but the model failed to load — original background kept.",
    });
  }

  checks.push({ status: "pass", text: `Output ${preset.photo.widthMm}×${preset.photo.heightMm} mm @ ${result.dpi} DPI (${result.widthPx}×${result.heightPx} px).` });

  const ul = els.checks();
  ul.innerHTML = "";
  for (const c of checks) {
    const li = document.createElement("li");
    li.dataset.status = c.status;
    li.textContent = c.text;
    ul.appendChild(li);
  }
  ul.hidden = false;
}

// ─── Print sheet (4×6 inch) PDF ──────────────────────────────────────────────

async function buildPrintSheetPdf() {
  if (!state.lastJpegBlob || !state.lastResult) {
    setStatus("Generate the photo first.", "error");
    return;
  }
  if (typeof window.jspdf?.jsPDF !== "function") {
    setStatus("PDF library failed to load — please reload the page.", "error");
    return;
  }

  setLoader(true, "Building 4×6 print sheet…");
  try {
    const preset = PRESETS[state.presetId];
    const sheet  = PRINT_SHEET;

    const photoW = preset.photo.widthMm;
    const photoH = preset.photo.heightMm;

    const usableW = sheet.widthMm  - sheet.marginMm * 2;
    const usableH = sheet.heightMm - sheet.marginMm * 2;
    const cols    = Math.max(1, Math.floor((usableW + sheet.gapMm) / (photoW + sheet.gapMm)));
    const rows    = Math.max(1, Math.floor((usableH + sheet.gapMm) / (photoH + sheet.gapMm)));
    const total   = cols * rows;

    const totalW = cols * photoW + (cols - 1) * sheet.gapMm;
    const totalH = rows * photoH + (rows - 1) * sheet.gapMm;
    const offX   = (sheet.widthMm  - totalW) / 2;
    const offY   = (sheet.heightMm - totalH) / 2;

    const dataUrl = await blobToDataUrl(state.lastJpegBlob);

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({
      unit: "mm",
      format: [sheet.widthMm, sheet.heightMm],
      orientation: sheet.widthMm > sheet.heightMm ? "landscape" : "portrait",
      compress: true,
    });

    // Cut-line guides for the print shop.
    pdf.setDrawColor(220);
    pdf.setLineWidth(0.05);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = offX + c * (photoW + sheet.gapMm);
        const y = offY + r * (photoH + sheet.gapMm);
        pdf.addImage(dataUrl, "JPEG", x, y, photoW, photoH, undefined, "FAST");
        pdf.rect(x, y, photoW, photoH);
      }
    }

    pdf.setFontSize(8);
    pdf.setTextColor(120);
    pdf.text(
      `${preset.label} · ${total} photos on 4×6 in · ${preset.photo.dpi} DPI · cut along guides`,
      sheet.widthMm / 2,
      sheet.heightMm - 1,
      { align: "center" },
    );

    pdf.save(downloadName(preset, "pdf").replace(/\.pdf$/, "-sheet.pdf"));
    setStatus(`Print sheet generated (${total} photos).`, "success");
  } catch (err) {
    console.error(err);
    setStatus(err.message || "Failed to build PDF.", "error");
  } finally {
    setLoader(false);
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload  = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error("FileReader failed"));
    r.readAsDataURL(blob);
  });
}

// ─── Reset ────────────────────────────────────────────────────────────────────

function resetResults() {
  if (state.lastJpegUrl) { URL.revokeObjectURL(state.lastJpegUrl); state.lastJpegUrl = null; }
  state.lastJpegBlob = null;
  state.lastResult   = null;
  els.previewCanvas().classList.add("hidden");
  els.previewPlaceholder().style.display = "";
  els.photoMeta().textContent = "";
  els.downloadActions().hidden = true;
  els.checks().hidden = true;
  els.checks().innerHTML = "";
}

function resetAll() {
  resetResults();
  if (state.crop.active) closeCropOverlay();
  state.cropOverride = null;
  state.workingBitmap?.close?.();
  state.workingBitmap = null;
  state.faces = null;
  state.faceModelError = null;
  state.segModelError  = null;
  state.bgModelError   = null;
  state.fileName = null;
  els.fileName().textContent = "No file selected";
  els.fileInput().value = "";
  els.processBtn().disabled = true;
  els.targetSizeKb().value = "";
  setStatus("Drop a clear front-facing photo to begin.", "info");
}

// ─── Manual crop overlay ─────────────────────────────────────────────────────
//
// Lets the user override the auto-crop. The overlay paints the working bitmap
// onto an on-page canvas at fit-to-width scale, then draws an absolutely-
// positioned rectangle the user can drag (move) and resize via 4 corner
// handles. The rectangle is locked to the current preset's aspect ratio.
//
// Internally we keep the rectangle in *source-pixel* coordinates (i.e. in the
// space of state.workingBitmap) so it survives canvas resizes (responsive
// layout, window resize) and is directly usable by the worker.

function openCropOverlay() {
  if (!state.workingBitmap) return;

  // Activate stage first so the canvas can measure its container width.
  els.cropStage().classList.add("is-active");
  els.cropHint().hidden = false;
  els.previewCanvas().classList.add("hidden");
  els.previewPlaceholder().style.display = "none";
  state.crop.active = true;

  paintCropCanvas();
  initialiseCropRect();

  els.cropRect().addEventListener("pointerdown",  onCropPointerDown);
  document.addEventListener("pointermove",         onCropPointerMove);
  document.addEventListener("pointerup",           onCropPointerUp);
  document.addEventListener("pointercancel",       onCropPointerUp);
  els.cropRect().addEventListener("keydown",       onCropKeyDown);
}

function closeCropOverlay() {
  els.cropStage().classList.remove("is-active");
  els.cropHint().hidden = true;
  state.crop.active = false;

  els.cropRect().removeEventListener("pointerdown",  onCropPointerDown);
  document.removeEventListener("pointermove",         onCropPointerMove);
  document.removeEventListener("pointerup",           onCropPointerUp);
  document.removeEventListener("pointercancel",       onCropPointerUp);
  els.cropRect().removeEventListener("keydown",       onCropKeyDown);

  if (state.lastResult) {
    els.previewCanvas().classList.remove("hidden");
  } else {
    els.previewPlaceholder().style.display = "";
  }
}

function paintCropCanvas() {
  const bmp = state.workingBitmap;
  const stage = els.cropStage();
  const cv    = els.cropCanvas();

  // Fit canvas to the available width; height = bmp.height * scale.
  const wrap = stage.parentElement;
  const maxW = Math.max(280, Math.min(wrap.clientWidth - 32, 720));
  const maxH = Math.round(window.innerHeight * 0.6);
  const scale = Math.min(maxW / bmp.width, maxH / bmp.height, 1);

  cv.width  = bmp.width;
  cv.height = bmp.height;
  cv.style.width  = (bmp.width  * scale) + "px";
  cv.style.height = (bmp.height * scale) + "px";
  stage.style.width = (bmp.width * scale) + "px";

  state.crop.canvasScale = scale;

  cv.getContext("2d").drawImage(bmp, 0, 0);
}

function initialiseCropRect() {
  const preset = PRESETS[state.presetId];
  const aspect = preset.photo.widthMm / preset.photo.heightMm;
  const bmp    = state.workingBitmap;

  // Start from the auto-crop estimate if a face was detected; else centre.
  let rect;
  if (state.cropOverride) {
    rect = { ...state.cropOverride };
  } else if (state.faces && state.faces.length) {
    rect = autoCropRectForUI(state.faces[0], preset, bmp.width, bmp.height);
  } else {
    let w = bmp.width * 0.7;
    let h = w / aspect;
    if (h > bmp.height * 0.9) { h = bmp.height * 0.9; w = h * aspect; }
    rect = { x: (bmp.width - w) / 2, y: (bmp.height - h) / 2, w, h };
  }
  state.crop.rect = rect;
  applyRectToDom();
}

// Mirrors the worker's cropRectFromFace logic (kept here too so we can
// pre-fill the manual crop with the same default the worker would compute).
function autoCropRectForUI(face, preset, srcW, srcH) {
  const aspect = preset.photo.widthMm / preset.photo.heightMm;
  const box = face.box || { x: 0, y: 0, w: srcW, h: srcH };
  const leftEye  = face.leftEye  || { x: box.x + box.w * 0.35, y: box.y + box.h * 0.42 };
  const rightEye = face.rightEye || { x: box.x + box.w * 0.65, y: box.y + box.h * 0.42 };
  const eyeY = (leftEye.y + rightEye.y) / 2;
  const eyeX = (leftEye.x + rightEye.x) / 2;
  const headPx = box.h * 1.55;
  const photoH = headPx / preset.head.targetRatio;
  const photoW = photoH * aspect;
  const eyeFromTopRatio = 1 - preset.eyeLine.targetFromBottomRatio;
  let y0 = eyeY - photoH * eyeFromTopRatio;
  let x0 = eyeX - photoW / 2;
  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  if (x0 + photoW > srcW) x0 = srcW - photoW;
  if (y0 + photoH > srcH) y0 = srcH - photoH;
  return { x: x0, y: y0, w: photoW, h: photoH };
}

function applyRectToDom() {
  const r = state.crop.rect;
  const s = state.crop.canvasScale;
  const rectEl = els.cropRect();
  rectEl.style.left   = (r.x * s) + "px";
  rectEl.style.top    = (r.y * s) + "px";
  rectEl.style.width  = (r.w * s) + "px";
  rectEl.style.height = (r.h * s) + "px";

  // Eye-line guide: position relative to the rectangle (not the canvas), so it
  // tracks moves automatically. We position it on the dim layer instead.
  const preset = PRESETS[state.presetId];
  const eyeFromTopRatio = 1 - preset.eyeLine.targetFromBottomRatio;
  const eyeY = (r.y + r.h * eyeFromTopRatio) * s;
  const guide = els.cropGuideEye();
  guide.style.top  = eyeY + "px";
  guide.style.left = (r.x * s) + "px";
  guide.style.right = "auto";
  guide.style.width = (r.w * s) + "px";

  // "Cut out" the rect from the dim layer using a CSS mask.
  const stage = els.cropStage();
  const W = stage.clientWidth;
  const H = parseFloat(els.cropCanvas().style.height) || stage.clientHeight;
  els.cropDim().style.width  = W + "px";
  els.cropDim().style.height = H + "px";
  // SVG mask (black where dimmed, transparent where rect is). Inline to keep file count low.
  const x = r.x * s, y = r.y * s, w = r.w * s, h = r.h * s;
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${W}' height='${H}'>` +
      `<rect width='100%' height='100%' fill='white'/>` +
      `<rect x='${x}' y='${y}' width='${w}' height='${h}' fill='black'/>` +
    `</svg>`;
  const url = `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
  els.cropDim().style.setProperty("--crop-mask", url);
}

// ─── Pointer interaction ────────────────────────────────────────────────────

function onCropPointerDown(ev) {
  if (!state.crop.active) return;
  ev.preventDefault();
  const target = ev.target.closest(".passport-crop-handle, .passport-crop-rect");
  if (!target) return;

  const handle = target.dataset.handle || null; // "tl"|"tr"|"bl"|"br" or null = move
  const rect   = { ...state.crop.rect };
  state.crop.drag = {
    handle,
    startX: ev.clientX,
    startY: ev.clientY,
    startRect: rect,
    pointerId: ev.pointerId,
  };
  try { target.setPointerCapture?.(ev.pointerId); } catch { /* ignore */ }
}

function onCropPointerMove(ev) {
  const drag = state.crop.drag;
  if (!drag) return;
  ev.preventDefault();

  const preset = PRESETS[state.presetId];
  const aspect = preset.photo.widthMm / preset.photo.heightMm;
  const s      = state.crop.canvasScale || 1;
  const dx     = (ev.clientX - drag.startX) / s;   // delta in source-pixel space
  const dy     = (ev.clientY - drag.startY) / s;
  const bmp    = state.workingBitmap;
  let { x, y, w, h } = drag.startRect;

  if (!drag.handle) {
    // Move
    x = drag.startRect.x + dx;
    y = drag.startRect.y + dy;
  } else {
    // Resize, keeping aspect ratio. We treat the *opposite corner* as the anchor.
    const anchor = oppositeCorner(drag.startRect, drag.handle);
    const cur    = {
      x: { tl: x + dx, tr: x + w + dx, bl: x + dx,     br: x + w + dx }[drag.handle],
      y: { tl: y + dy, tr: y + dy,     bl: y + h + dy, br: y + h + dy }[drag.handle],
    };
    let newW = Math.abs(cur.x - anchor.x);
    let newH = Math.abs(cur.y - anchor.y);
    // Lock aspect: width is master.
    if (newW / aspect > newH) { newH = newW / aspect; }
    else                       { newW = newH * aspect; }
    // Compute origin from anchor + sign.
    const minX = Math.min(cur.x, anchor.x);
    const minY = Math.min(cur.y, anchor.y);
    x = anchor.x === minX ? anchor.x : anchor.x - newW;
    y = anchor.y === minY ? anchor.y : anchor.y - newH;
    w = newW; h = newH;
  }

  // Clamp to source bounds.
  if (w > bmp.width)  { w = bmp.width;  h = w / aspect; }
  if (h > bmp.height) { h = bmp.height; w = h * aspect; }
  const minSide = Math.max(40, Math.min(bmp.width, bmp.height) * 0.1);
  if (w < minSide) { w = minSide; h = minSide / aspect; }
  if (h < minSide / aspect) { h = minSide / aspect; w = minSide; }
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x + w > bmp.width)  x = bmp.width  - w;
  if (y + h > bmp.height) y = bmp.height - h;

  state.crop.rect = { x, y, w, h };
  applyRectToDom();
}

function oppositeCorner(r, handle) {
  switch (handle) {
    case "tl": return { x: r.x + r.w, y: r.y + r.h };
    case "tr": return { x: r.x,       y: r.y + r.h };
    case "bl": return { x: r.x + r.w, y: r.y       };
    case "br": return { x: r.x,       y: r.y       };
  }
  return { x: r.x, y: r.y };
}

function onCropPointerUp(ev) {
  if (!state.crop.drag) return;
  state.crop.drag = null;
}

// Arrow-key nudge for accessibility.
function onCropKeyDown(ev) {
  if (!state.crop.active || !state.crop.rect) return;
  const STEP = ev.shiftKey ? 10 : 1;
  const r = { ...state.crop.rect };
  const bmp = state.workingBitmap;
  let handled = true;
  switch (ev.key) {
    case "ArrowLeft":  r.x = Math.max(0, r.x - STEP); break;
    case "ArrowRight": r.x = Math.min(bmp.width  - r.w, r.x + STEP); break;
    case "ArrowUp":    r.y = Math.max(0, r.y - STEP); break;
    case "ArrowDown":  r.y = Math.min(bmp.height - r.h, r.y + STEP); break;
    default: handled = false;
  }
  if (handled) {
    ev.preventDefault();
    state.crop.rect = r;
    applyRectToDom();
  }
}

function onCropWindowResize() {
  if (!state.crop.active) return;
  paintCropCanvas();
  applyRectToDom();
}

function resetCropToAuto() {
  state.cropOverride = null;
  if (state.crop.active) {
    initialiseCropRect();
    setStatus("Crop reset to auto.", "info");
  }
}

// ─── Go ───────────────────────────────────────────────────────────────────────

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
