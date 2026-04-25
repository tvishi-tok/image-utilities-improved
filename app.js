// ================= CONFIG =================
const CONFIG = {
  DEFAULT_SIZE: Number(window.DEFAULT_SIZE) || 50,
  MAX_FILE_MB: 10,
  SUPPORTED_TYPES: ["image/jpeg", "image/png", "image/webp"],
  MAX_DIMENSION: 4000
};

let state = {
  file: null,
  objectUrl: null,
  resultUrl: null
};
let worker = initWorker();

// ================= INIT =================
window.addEventListener("load", initPage);
window.addEventListener("pageshow", initPage);

function initPage() {
  if (!worker) {
    worker = initWorker();
  }

  const targetInput = document.getElementById("target");
  if (targetInput) {
    targetInput.value = CONFIG.DEFAULT_SIZE;
  }

  const pdfInputEl = document.getElementById("pdfInput");
  const fileNamesEl = document.getElementById("fileNames");
  if (pdfInputEl && fileNamesEl) {
    pdfInputEl.addEventListener("change", () => {
      const files = Array.from(pdfInputEl.files);
      fileNamesEl.innerText = files.length ? files.map(f => f.name).join(", ") : "";
    });
  }

  setupDragAndDrop();
  setupKbPresets();
}

function initWorker() {
  try {
    const w = new Worker("worker.js");
    w.onmessage = handleWorkerMessage;
    w.onerror = handleWorkerError;
    w.onmessageerror = handleWorkerError;
    return w;
  } catch (err) {
    console.warn("Worker unavailable:", err);
    return null;
  }
}

function handleWorkerMessage(event) {
  const data = event.data;
  if (data.type !== "result") return;

  toggleLoading(false);

  if (!data.success) {
    setStatus(data.error || "Processing failed", "error");
    return;
  }

  const blob = new Blob([data.blob], { type: data.mimeType });
  showResult(blob, data.mimeType);

  const size = Math.round(data.sizeKB);
  setStatus(
    size <= data.targetKB ? "Done" : "Processed (limit not exact)",
    size <= data.targetKB ? "success" : "error"
  );
}

function handleWorkerError(error) {
  console.error("Worker error:", error);
  worker = null;
  toggleLoading(false);
  setStatus("Worker failed, using fallback mode", "error");
}

// ================= UI =================
function setStatus(msg, type = "info") {
  const el = document.getElementById("status");
  if (!el) return;

  el.innerText = msg;
  el.dataset.tone = type === "error" ? "error" : type === "success" ? "success" : "info";
}

function toggleLoading(isLoading) {
  const loader = document.getElementById("loader");
  const btn = document.getElementById("resizeBtn") || document.querySelector("button.resize-primary");

  if (loader) loader.classList.toggle("visible", isLoading);
  if (btn) btn.disabled = isLoading;
}

// ================= VALIDATION =================
function validateFile(file) {
  if (!file) return "No file selected";

  const ext = (file.name || "").split(".").pop().toLowerCase();
  const isHeic = /^(heic|heif)$/.test(ext);

  const isSupported =
    CONFIG.SUPPORTED_TYPES.includes(file.type) ||
    isHeic ||
    /^(jpe?g|png|webp)$/.test(ext);

  if (!isSupported) {
    return "Unsupported format (JPG, PNG, WebP, HEIC allowed)";
  }

  if (file.size > CONFIG.MAX_FILE_MB * 1024 * 1024) {
    return "File too large (Max 10MB)";
  }

  return null;
}

// ================= FILE =================
async function handleFile(file) {
  const error = validateFile(file);
  if (error) return setStatus(error, "error");

  try {
    let processed = file;

    if (window.heic2any && /\.(heic|heif)$/i.test(file.name)) {
      setStatus("Loading image (HEIC)...");
      const blob = await heic2any({
        blob: file,
        toType: "image/jpeg",
        quality: 0.9
      });

      processed = new File([blob], "converted.jpg", {
        type: "image/jpeg"
      });
    }

    state.file = processed;
    updatePreview(processed);
    setStatus("Image loaded", "success");

  } catch (e) {
    console.error(e);
    setStatus("Failed to process image", "error");
  }
}

// ================= PREVIEW =================
function updatePreview(file) {
  const preview = document.getElementById("preview");
  const info = document.getElementById("fileInfo");

  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = URL.createObjectURL(file);
  if (preview) {
    preview.src = state.objectUrl;
    preview.classList.remove("hidden");
    preview.style.display = "block";
    const targetInput = document.getElementById("target");
    if (targetInput) targetInput.value = Math.round(file.size / 1024);
  }

  if (info) {
    info.innerText = `Original: ${Math.round(file.size / 1024)} KB`;
  }

  const nameEl = document.getElementById("fileNameDisplay");
  if (nameEl) {
    nameEl.textContent = file.name || "Image";
  }
}

// ================= MAIN =================
async function processImage() {
  if (!state.file) return setStatus("Upload an image first", "error");

  const targetKB = Number(document.getElementById("target")?.value);
  if (!targetKB || targetKB <= 0) {
    return setStatus("Enter valid size", "error");
  }

  toggleLoading(true);
  setStatus("Processing...");

  const format = getFormat();
  const exact = document.getElementById("exactMode")?.checked;

  if (worker) {
    const fileBuffer = await state.file.arrayBuffer();
    worker.postMessage({
      type: "process",
      fileBuffer,
      fileType: state.file.type || "image/jpeg",
      targetKB,
      format,
      exact,
      maxDimension: CONFIG.MAX_DIMENSION
    }, [fileBuffer]);
    return;
  }

  try {
    const img = await loadImage(state.file);
    const canvas = createCanvasForImage(img);
    const blob = await processImageMainThread(canvas, targetKB, format, exact);
    if (!blob) throw new Error("Compression failed");

    showResult(blob, format);
    const size = Math.round(blob.size / 1024);
    setStatus(
      size <= targetKB ? "Done" : "Processed (limit not exact)",
      size <= targetKB ? "success" : "error"
    );
  } catch (e) {
    console.error(e);
    setStatus("Processing failed", "error");
  }

  toggleLoading(false);
}

function createCanvasForImage(img) {
  let width = img.width;
  let height = img.height;

  if (width > CONFIG.MAX_DIMENSION || height > CONFIG.MAX_DIMENSION) {
    const scale = Math.min(
      CONFIG.MAX_DIMENSION / width,
      CONFIG.MAX_DIMENSION / height
    );
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(img, 0, 0, width, height);
  return canvas;
}

async function processImageMainThread(canvas, targetKB, format, exact) {
  let blob = await compressQualityOnly(canvas, targetKB, format);

  if (
    (exact || (blob && blob.size / 1024 > targetKB)) &&
    format !== "image/png"
  ) {
    blob = await compressWithScaling(canvas, targetKB, format);
  }

  return blob;
}

// ================= IMAGE LOAD =================
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject();
    };

    img.src = url;
  });
}

// ================= FORMAT =================
function getFormat() {
  return document.getElementById("format")?.value || "image/jpeg";
}

function getExt(format) {
  return format.split("/")[1];
}

// ================= UTILS =================
function canvasToBlob(canvas, type, quality) {
  return new Promise(res => canvas.toBlob(res, type, quality));
}

function yieldThread() {
  return new Promise(r => setTimeout(r, 0));
}

// ================= COMPRESSION =================
async function compressQualityOnly(canvas, targetKB, format) {
  // PNG is lossless — canvas.toBlob quality hint is ignored for PNG.
  // Fall back to JPEG for quality-based compression; the caller handles
  // the "still too large" case via compressWithScaling.
  if (format === "image/png") {
    format = "image/jpeg";
  }

  let low = 0.1, high = 0.95;
  let best = null;
  const tolerance = Math.max(2, targetKB * 0.05);

  for (let i = 0; i < 8; i++) {
    const q = (low + high) / 2;
    const blob = await canvasToBlob(canvas, format, q);
    if (!blob) break;

    const size = blob.size / 1024;

    if (Math.abs(size - targetKB) < tolerance) return blob;

    if (size > targetKB) {
      high = q;
    } else {
      best = blob;
      low = q;
    }

    await yieldThread();
  }

  return best || canvasToBlob(canvas, format, low);
}

async function compressWithScaling(canvas, targetKB, format) {
  const temp = document.createElement("canvas");
  const ctx = temp.getContext("2d");
  const tolerance = Math.max(2, targetKB * 0.05);

  // Allow scaling all the way down to 5 % of original dimensions so even
  // very aggressive KB targets (e.g. 10 KB) can be satisfied.
  let low = 0.05, high = 1;
  let best = null;

  for (let i = 0; i < 9; i++) {
    const scale = (low + high) / 2;

    temp.width = Math.max(1, Math.round(canvas.width * scale));
    temp.height = Math.max(1, Math.round(canvas.height * scale));

    ctx.clearRect(0, 0, temp.width, temp.height);
    ctx.drawImage(canvas, 0, 0, temp.width, temp.height);

    const blob = await compressQualityOnly(temp, targetKB, format);
    if (!blob) break;

    const size = blob.size / 1024;

    if (Math.abs(size - targetKB) < tolerance) return blob;

    if (size > targetKB) {
      high = scale;
    } else {
      best = blob;
      low = scale;
    }

    await yieldThread();
  }

  return best || canvasToBlob(temp, format);
}

// ================= RESULT =================
function showResult(blob, format) {
  const preview = document.getElementById("preview");
  const download = document.getElementById("download");

  if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
  const url = URL.createObjectURL(blob);
  state.resultUrl = url;

  if (preview) {
    preview.src = url;
    preview.classList.remove("hidden");
    preview.style.display = "block";
  }

  if (download) {
    download.href = url;
    download.download = `image.${getExt(format)}`;
    download.style.display = "inline-block";
    download.innerText = `Download (${Math.round(blob.size / 1024)} KB)`;
  }
}

// ================= DRAG DROP =================
function setupDragAndDrop() {
  
  const drop = document.getElementById("drop");
  const input = document.getElementById("fileInput");

  if (!drop || !input) return;

  drop.onclick = () => input.click();

  input.onchange = () => {
    if (input.files?.[0]) handleFile(input.files[0]);
  };

  drop.addEventListener("dragover", e => {
    e.preventDefault();
    drop.classList.add("active");
  });

  drop.addEventListener("dragleave", () => {
    drop.classList.remove("active");
  });

  drop.addEventListener("drop", e => {
    e.preventDefault();
    drop.classList.remove("active");
    if (e.dataTransfer.files?.[0]) handleFile(e.dataTransfer.files[0]);
  });
}

function setupKbPresets() {
  const root = document.getElementById("kbPresets");
  if (!root) return;

  root.addEventListener("click", e => {
    const btn = e.target.closest("[data-kb]");
    if (!btn || !root.contains(btn)) return;
    const kb = btn.getAttribute("data-kb");
    const target = document.getElementById("target");
    if (target && kb != null) target.value = kb;
  });
}

// ================= IMAGE TO PDF =================

const pdfInput = document.getElementById("pdfInput");
const pdfBtn = document.getElementById("convertPDFBtn");
const pdfStatus = document.getElementById("pdfStatus");

if (pdfBtn) {
  pdfBtn.addEventListener("click", convertImagesToPDF);
}

async function convertImagesToPDF() {
  if (!pdfInput || !pdfInput.files.length) {
    setPDFStatus("Please select images", "error");
    return;
  }

  setPDFStatus("Processing...", "loading");

  const { jsPDF } = window.jspdf;
  const quality = parseFloat(document.getElementById("pdfQuality")?.value || 0.8);

  const pdf = new jsPDF({
    orientation: "portrait",
    unit: "mm",
    format: "a4"
  });

  const pageWidth = 210;
  const pageHeight = 297;

  let firstPage = true;

  try {
    const files = Array.from(pdfInput.files);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      if (!file.type.startsWith("image/")) {
        continue;
      }

      if (file.size > 10 * 1024 * 1024) {
        console.warn("Skipping large file:", file.name);
        continue;
      }

      const imgData = await loadImageForPDF(file, quality);

      const { width, height } = scaleToFit(
        imgData.width,
        imgData.height,
        pageWidth,
        pageHeight
      );

      if (!firstPage) pdf.addPage();
      firstPage = false;

      pdf.addImage(
        imgData.dataUrl,
        "JPEG",
        (pageWidth - width) / 2,
        (pageHeight - height) / 2,
        width,
        height
      );

      // Yield thread for UI responsiveness
      if (i % 2 === 0) await yieldThread();
    }

    pdf.save("images.pdf");

    setPDFStatus("PDF created successfully!", "success");

    // Analytics
    if (window.gtag) {
      gtag("event", "pdf_conversion_success", {
        event_category: "engagement"
      });
    }

  } catch (err) {
    console.error(err);
    setPDFStatus("Failed to create PDF", "error");

    if (window.gtag) {
      gtag("event", "pdf_conversion_error", {
        event_category: "error",
        event_label: err.message
      });
    }
  }
}

function loadImageForPDF(file, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();

    img.onload = () => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");

      // Resize large images for performance
      const maxDim = 2000;
      let { width, height } = img;

      if (width > maxDim || height > maxDim) {
        const ratio = Math.min(maxDim / width, maxDim / height);
        width *= ratio;
        height *= ratio;
      }

      canvas.width = width;
      canvas.height = height;

      ctx.drawImage(img, 0, 0, width, height);

      const dataUrl = canvas.toDataURL("image/jpeg", quality);

      URL.revokeObjectURL(img.src);

      resolve({ width, height, dataUrl });
    };

    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function scaleToFit(w, h, maxW, maxH) {
  const ratio = Math.min(maxW / w, maxH / h);
  return {
    width: w * ratio,
    height: h * ratio
  };
}

function setPDFStatus(msg, type) {
  if (!pdfStatus) return;

  pdfStatus.innerText = msg;
  pdfStatus.className = type;
}


(function initXMLTool() {
  const inputEl = document.getElementById("inputText");
  const outputEl = document.getElementById("outputText");
  const xmlBtn = document.getElementById("xmlBtn");
  const jsonBtn = document.getElementById("jsonBtn");

  if (!inputEl || !outputEl) return;

  xmlBtn?.addEventListener("click", xmlToJson);
  jsonBtn?.addEventListener("click", jsonToXml);

  async function xmlToJson() {
    try {
          await loadParser(); 

      if (!window.XMLParser) throw new Error("Parser not loaded");

      const parser = new XMLParser({ ignoreAttributes: false });
      const json = parser.parse(inputEl.value);

      outputEl.value = JSON.stringify(json, null, 2);
      setStatus("XML → JSON success", "success");

    } catch (e) {
      setStatus(e.message, "error");
    }
  }
  let parserLoadingPromise = null;

function loadParser() {
  if (window.XMLParser && window.XMLBuilder) {
    return Promise.resolve();
  }

  if (parserLoadingPromise) return parserLoadingPromise;

  parserLoadingPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");

    script.src = "fx.js"; // local file
    script.async = true;

    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load parser"));

    document.body.appendChild(script);
  });

  return parserLoadingPromise;
}

async function jsonToXml() {
  try {
    await loadParser(); 

    const obj = JSON.parse(inputEl.value);

    const builder = new XMLBuilder({ ignoreAttributes: false });
    const xml = builder.build(obj);

    outputEl.value = formatXML(xml);
    setStatus("JSON → XML success", "success");

  } catch {
    setStatus("Invalid JSON", "error");
  }
}
})();

// ================= FORMAT XML =================
function formatXML(xml) {
  let formatted = "";
  let indent = 0;

  xml.split(/>\s*</).forEach(node => {
    if (node.match(/^\/\w/)) indent--;

    formatted += "  ".repeat(indent) + "<" + node + ">\n";

    if (node.match(/^<?\w[^>]*[^\/]$/)) indent++;
  });

  return formatted.trim();
}