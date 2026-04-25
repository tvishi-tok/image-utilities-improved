/**
 * passport-photo-worker.js
 *
 * Heavy-lifting Web Worker for the passport-photo tool.
 *
 * Responsibilities:
 * • Decode the input ImageBitmap into an OffscreenCanvas working copy.
 * (The bitmap may already have its background replaced by the main
 * thread using MediaPipe Image Segmenter — the worker is bg-agnostic.)
 * • Crop & align using face-landmark coordinates supplied by the main
 * thread (face detection itself runs on the main thread because
 * MediaPipe owns its own WebGL context).
 * • Render the final photo at exact mm × DPI on a solid background.
 * • Encode JPEG/PNG and return as ArrayBuffer (transferable).
 * • Patch the JPEG header to embed the requested DPI density.
 *
 * Message protocol:
 * in : { type: "process", imageBitmap, faces, preset, options }
 * out : { type: "progress" | "result" | "error", ... }
 */

function postProgress(stage, fraction, message) {
 self.postMessage({ type: "progress", stage, fraction, message });
}

self.onmessage = async (event) => {
 const msg = event.data || {};
 if (msg.type !== "process") return;

 try {
 const out = await runPipeline(msg);
 self.postMessage(
 { type: "result", ...out },
 [out.jpegBuffer, out.previewBuffer].filter(Boolean),
 );
 } catch (err) {
 self.postMessage({
 type: "error",
 message: (err && err.message) || String(err) || "Worker pipeline failed",
 });
 }
};

// ─── Pipeline ────────────────────────────────────────────────────────────────

async function runPipeline({ imageBitmap, faces, preset, options }) {
 if (!imageBitmap) throw new Error("No image bitmap provided");
 if (!preset) throw new Error("No preset provided");

 const dpi = preset.photo.dpi;
 const targetWPx = mmToPx(preset.photo.widthMm, dpi);
 const targetHPx = mmToPx(preset.photo.heightMm, dpi);
 const bgColor = options.bgColor || preset.background.hex || "#FFFFFF";
 const useFace = options.autoCrop !== false && faces && faces.length > 0;

 postProgress("decode", 0.0, "Preparing image…");

 // The bitmap may already have its background replaced by the main thread.
 // We just take a defensive canvas copy and close the original.
 const workCanvas = safeBitmapToCanvas(imageBitmap);
 try { imageBitmap.close?.(); } catch { /* ignore */ }

 // Crop rectangle in working-canvas pixel coordinates.
 // Priority: explicit user override > face-detection auto > centred fallback.
 postProgress("crop", 0.85, "Cropping and aligning…");
 let crop;
 if (options.cropOverride && isFiniteRect(options.cropOverride)) {
 crop = sanitiseUserCrop(
 options.cropOverride,
 workCanvas.width,
 workCanvas.height,
 targetWPx / targetHPx,
 );
 } else if (useFace) {
 crop = cropRectFromFace(faces[0], preset, workCanvas.width, workCanvas.height);
 } else {
 crop = centerCropRect(workCanvas.width, workCanvas.height, targetWPx / targetHPx);
 }

 // 4. Render target canvas at exact pixel size.
 const finalCanvas = new OffscreenCanvas(targetWPx, targetHPx);
 const fctx = finalCanvas.getContext("2d");

 fctx.fillStyle = bgColor;
 fctx.fillRect(0, 0, targetWPx, targetHPx);

 fctx.imageSmoothingEnabled = true;
 fctx.imageSmoothingQuality = "high";
 // workCanvas is an OffscreenCanvas — never detached, always safe to draw.
 fctx.drawImage(
 workCanvas,
 crop.x, crop.y, crop.w, crop.h,
 0, 0, targetWPx, targetHPx,
 );

 // 5. Encode at preset quality, then enforce file-size compliance.
 // Priority for target size:
 // a) explicit user input (options.targetKB)
 // b) preset.preferredKB (sane middle of the allowed range)
 // We then do a binary search on JPEG quality to land near the target,
 // *and* enforce a hard floor (preset.minKB) by padding pixel data if the
 // encoder still under-shoots — small flat backgrounds compress so well
 // that even quality 1.0 can come in below 54 KB.
 postProgress("encode", 0.95, "Encoding photo…");
 const format = preset.output.format || "image/jpeg";
 const minKB = preset.fileSize?.minKB || 0;
 const maxKB = preset.fileSize?.maxKB || 10240;
 const userTarget = options.targetKB && options.targetKB > 0 ? options.targetKB : null;
 // Aim for the middle of the allowed band by default so we always land safely
 // above the minimum. Honour the user's explicit value when given.
 const targetKB = userTarget ?? preset.fileSize?.preferredKB ?? null;

 let blob = targetKB
 ? await encodeToTargetSize(finalCanvas, format, targetKB, { minKB, maxKB })
 : await finalCanvas.convertToBlob({ type: format, quality: preset.output.quality || 0.92 });

 let buffer = await blob.arrayBuffer();

 // Patch JPEG with DPI metadata so print drivers honour the physical size.
 if (format === "image/jpeg") {
 buffer = setJpegDpi(buffer, dpi);
 }

 // Build a small preview PNG (≤ 600 px on long side) for fast display.
 const previewCanvas = downscaleCanvas(finalCanvas, 600);
 const previewBlob = await previewCanvas.convertToBlob({ type: "image/png" });
 const previewBuffer = await previewBlob.arrayBuffer();

 postProgress("done", 1.0, "Done.");

 return {
 jpegBuffer: buffer,
 jpegMime: format,
 previewBuffer,
 previewMime: "image/png",
 widthPx: targetWPx,
 heightPx: targetHPx,
 dpi,
 sizeBytes: buffer.byteLength,
 };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mmToPx(mm, dpi) {
 return Math.round((mm / 25.4) * dpi);
}

/**
 * Safely copy an ImageBitmap into an OffscreenCanvas.
 *
 * Throws a clear error if the bitmap has been detached (e.g. because the lib
 * we handed it to internally closed it). Callers should catch and surface a
 * user-friendly message.
 */
function safeBitmapToCanvas(bitmap) {
 if (!bitmap || typeof bitmap.width !== "number" || bitmap.width === 0) {
 throw new Error("Image source is empty or already closed");
 }
 const c = new OffscreenCanvas(bitmap.width, bitmap.height);
 try {
 c.getContext("2d").drawImage(bitmap, 0, 0);
 } catch (err) {
 throw new Error("Image source is detached — please re-upload the photo");
 }
 return c;
}

function downscaleCanvas(src, maxDim) {
 const scale = Math.min(1, maxDim / Math.max(src.width, src.height));
 if (scale === 1) {
 const c = new OffscreenCanvas(src.width, src.height);
 c.getContext("2d").drawImage(src, 0, 0);
 return c;
 }
 const c = new OffscreenCanvas(Math.round(src.width * scale), Math.round(src.height * scale));
 const ctx = c.getContext("2d");
 ctx.imageSmoothingQuality = "high";
 ctx.drawImage(src, 0, 0, c.width, c.height);
 return c;
}

/**
 * Compute crop rectangle (x, y, w, h) in source-pixel coordinates such that:
 * - The aspect ratio matches the target preset.
 * - The face's eye line lands at preset.eyeLine.targetFromBottomRatio.
 * - The head height takes preset.head.targetRatio of the photo height.
 *
 * `face` is { box: {x,y,w,h}, leftEye:{x,y}, rightEye:{x,y} } in source pixels.
 * If eyes are missing, we approximate from the box.
 */
function cropRectFromFace(face, preset, srcW, srcH) {
 const aspect = preset.photo.widthMm / preset.photo.heightMm;

 // Approximate landmarks if MediaPipe didn't provide them.
 const box = face.box || { x: 0, y: 0, w: srcW, h: srcH };
 const leftEye = face.leftEye || { x: box.x + box.w * 0.35, y: box.y + box.h * 0.42 };
 const rightEye = face.rightEye || { x: box.x + box.w * 0.65, y: box.y + box.h * 0.42 };

 const eyeY = (leftEye.y + rightEye.y) / 2;
 const eyeX = (leftEye.x + rightEye.x) / 2;

 // Estimate head height from box (MediaPipe face-detection box is tight on the face,
 // so we scale by ~1.55 to approximate full-head incl. hair + chin to crown).
 const headPx = box.h * 1.55;

 // Photo height in source pixels so head occupies the target ratio.
 const photoH = headPx / preset.head.targetRatio;
 const photoW = photoH * aspect;

 // y0: top of crop. eye line should sit at (1 - eyeFromBottomRatio) from top.
 const eyeFromTopRatio = 1 - preset.eyeLine.targetFromBottomRatio;
 let y0 = eyeY - photoH * eyeFromTopRatio;
 let x0 = eyeX - photoW / 2;

 // Clamp into source bounds; if the crop is bigger than the source we shrink it
 // and centre it (the source photo is then inevitably below ideal resolution).
 const fit = clampCropToSource(x0, y0, photoW, photoH, srcW, srcH, aspect);
 return fit;
}

/**
 * Validate and snap a user-supplied crop rectangle:
 * - clamp inside source bounds
 * - enforce target aspect ratio (height derived from width)
 * - reject zero/negative dimensions
 */
function sanitiseUserCrop(rect, srcW, srcH, aspect) {
 let { x, y, w, h } = rect;
 // Force the height to match aspect (width is the user's primary axis).
 h = w / aspect;
 // Clamp within the source.
 if (w > srcW) { const k = srcW / w; w *= k; h *= k; }
 if (h > srcH) { const k = srcH / h; w *= k; h *= k; }
 if (x < 0) x = 0;
 if (y < 0) y = 0;
 if (x + w > srcW) x = srcW - w;
 if (y + h > srcH) y = srcH - h;
 return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

function isFiniteRect(r) {
 return r
 && Number.isFinite(r.x) && Number.isFinite(r.y)
 && Number.isFinite(r.w) && Number.isFinite(r.h)
 && r.w > 0 && r.h > 0;
}

function centerCropRect(srcW, srcH, aspect) {
 let w = srcW, h = srcW / aspect;
 if (h > srcH) { h = srcH; w = srcH * aspect; }
 return {
 x: Math.round((srcW - w) / 2),
 y: Math.round((srcH - h) / 2),
 w: Math.round(w),
 h: Math.round(h),
 };
}

function clampCropToSource(x, y, w, h, srcW, srcH, aspect) {
 // If crop exceeds source on either axis, shrink uniformly.
 if (w > srcW) { const k = srcW / w; w *= k; h *= k; }
 if (h > srcH) { const k = srcH / h; w *= k; h *= k; }
 // Re-enforce aspect after clamping (defensive, in case of float drift).
 const desiredH = w / aspect;
 if (Math.abs(desiredH - h) > 0.5) h = desiredH;

 // Keep inside bounds.
 if (x < 0) x = 0;
 if (y < 0) y = 0;
 if (x + w > srcW) x = srcW - w;
 if (y + h > srcH) y = srcH - h;

 return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

// ─── Encode-to-target-size (binary search on JPEG quality + floor pad) ───────

async function encodeToTargetSize(canvas, format, targetKB, { minKB = 0, maxKB = Infinity } = {}) {
 if (format === "image/png") {
 return canvas.convertToBlob({ type: "image/png" });
 }

 // 1. Binary search for quality that lands near targetKB.
 let lo = 0.4, hi = 0.97, best = null;
 for (let i = 0; i < 9; i++) {
 const q = (lo + hi) / 2;
 const blob = await canvas.convertToBlob({ type: format, quality: q });
 const kb = blob.size / 1024;
 if (kb > targetKB) { hi = q; }
 else { best = blob; lo = q; }
 if (Math.abs(kb - targetKB) < 3) { best = blob; break; }
 }
 if (!best) best = await canvas.convertToBlob({ type: format, quality: 0.97 });

 // 2. Try quality 1.0 if we're still under the floor — flat backgrounds
 // (e.g. after segmentation) compress so well that mid-quality JPEGs can
 // fall under 54 KB even at 600x600 px.
 if (best.size / 1024 < minKB) {
 const qmax = await canvas.convertToBlob({ type: format, quality: 1.0 });
 if (qmax.size > best.size) best = qmax;
 }

 // 3. Last resort: pad the JPEG with a custom APP15 segment until we reach
 // the floor. Padding bytes are ignored by every decoder; this is the same
 // trick official passport portals' own clients use.
 if (best.size / 1024 < minKB && minKB > 0 && minKB <= maxKB) {
 const buf = await best.arrayBuffer();
 const pad = padJpegToMinSize(buf, Math.ceil(minKB * 1024));
 return new Blob([pad], { type: format });
 }

 // 4. Cap at maxKB if we somehow shot over (shouldn't happen with bin-search).
 if (best.size / 1024 > maxKB) {
 // Encode at the lowest quality we tested as a fallback.
 return canvas.convertToBlob({ type: format, quality: lo });
 }

 return best;
}

/**
 * Append an APP15 (0xFFEF) segment full of zeroes to a JPEG so total file size
 * reaches at least `minBytes`. Inserted right after the SOI (0xFFD8).
 */
function padJpegToMinSize(arrayBuffer, minBytes) {
 const src = new Uint8Array(arrayBuffer);
 if (src.length >= minBytes || src.length < 2 || src[0] !== 0xFF || src[1] !== 0xD8) {
 return arrayBuffer;
 }
 const need = minBytes - src.length;
 // Each APP segment payload max is 65533 (length field is uint16 incl. itself).
 const chunks = [];
 let remaining = need;
 while (remaining > 0) {
 const payload = Math.min(remaining, 65533 - 2); // -2 for length bytes
 const segLen = payload + 2;
 const seg = new Uint8Array(4 + payload);
 seg[0] = 0xFF; seg[1] = 0xEF; // APP15 marker
 seg[2] = (segLen >> 8) & 0xFF;
 seg[3] = segLen & 0xFF; // body is already zeroed
 chunks.push(seg);
 remaining -= seg.length;
 }
 const padTotal = chunks.reduce((n, c) => n + c.length, 0);
 const out = new Uint8Array(src.length + padTotal);
 out[0] = 0xFF; out[1] = 0xD8;
 let off = 2;
 for (const c of chunks) { out.set(c, off); off += c.length; }
 out.set(src.subarray(2), off);
 return out.buffer;
}

// ─── JPEG DPI patcher ────────────────────────────────────────────────────────
//
// We rewrite/insert a JFIF APP0 segment immediately after SOI (0xFFD8) so the
// file declares the requested density. This is what print drivers and
// image-info tools read to determine "300 DPI".
//
// Most browser-encoded JPEGs already have a JFIF APP0 (density 1x1, units 0)
// — we just patch it. If absent, we insert a fresh one.

function setJpegDpi(arrayBuffer, dpi) {
 const src = new Uint8Array(arrayBuffer);
 if (src.length < 4 || src[0] !== 0xFF || src[1] !== 0xD8) return arrayBuffer;

 // Look for an existing APP0 ("JFIF\0") at offset 2.
 if (src[2] === 0xFF && src[3] === 0xE0) {
 const segLen = (src[4] << 8) | src[5];
 if (segLen >= 16
 && src[6] === 0x4A && src[7] === 0x46 && src[8] === 0x49 && src[9] === 0x46 && src[10] === 0x00) {
 // Patch units=1 (DPI), Xdensity, Ydensity (big-endian uint16).
 src[13] = 0x01;
 src[14] = (dpi >> 8) & 0xFF;
 src[15] = dpi & 0xFF;
 src[16] = (dpi >> 8) & 0xFF;
 src[17] = dpi & 0xFF;
 return src.buffer;
 }
 }

 // No JFIF APP0 found — insert one.
 const app0 = new Uint8Array([
 0xFF, 0xE0, // APP0 marker
 0x00, 0x10, // length = 16
 0x4A, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
 0x01, 0x01, // version 1.1
 0x01, // density units = DPI
 (dpi >> 8) & 0xFF, dpi & 0xFF,
 (dpi >> 8) & 0xFF, dpi & 0xFF,
 0x00, 0x00, // thumbnail W/H = 0
 ]);
 const out = new Uint8Array(src.length + app0.length);
 out[0] = 0xFF; out[1] = 0xD8;
 out.set(app0, 2);
 out.set(src.subarray(2), 2 + app0.length);
 return out.buffer;
}
