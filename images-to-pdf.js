(function () {
  const MAX_MB = 10;

  const drop = document.getElementById("drop");
  const fileInput = document.getElementById("fileInput");
  const fileListEl = document.getElementById("fileList");
  const emptyHintEl = document.getElementById("emptyListHint");
  const statusEl = document.getElementById("status");
  const loaderEl = document.getElementById("loader");
  const convertBtn = document.getElementById("convertPdfBtn");

  function setStatus(msg, type = "info") {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.dataset.tone = type === "error" ? "error" : type === "success" ? "success" : "info";
    statusEl.style.color =
      type === "error" ? "red" : type === "success" ? "green" : "#333";
  }

  function setLoading(on) {
    if (loaderEl) loaderEl.classList.toggle("visible", on);
    if (convertBtn) convertBtn.disabled = on;
  }

  function getExt(file) {
    return ((file.name || "").split(".").pop() || "").toLowerCase();
  }

  function classifyFile(file) {
    const ext = getExt(file);
    if (file.type.startsWith("image/")) return "image";
    if (ext === "heic" || ext === "heif") return "image";
    if (file.type === "text/plain" || ext === "txt") return "text";
    if (
      ext === "docx" ||
      file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      return "docx";
    }
    if (ext === "doc") return "legacy-doc";
    return "unsupported";
  }

  function validateFile(file) {
    if (file.size > MAX_MB * 1024 * 1024) {
      return `Too large (max ${MAX_MB} MB): ${file.name}`;
    }
    const kind = classifyFile(file);
    if (kind === "unsupported") {
      return `Unsupported: ${file.name}`;
    }
    if (kind === "legacy-doc") {
      return `Old .doc format not supported (use .docx or save as PDF from Word): ${file.name}`;
    }
    return null;
  }

  function syncInputFiles(files) {
    const dt = new DataTransfer();
    files.forEach(f => dt.items.add(f));
    fileInput.files = dt.files;
  }

  function updateFileListUI(files) {
    if (!fileListEl) return;
    fileListEl.innerHTML = "";
    if (emptyHintEl) emptyHintEl.hidden = files.length > 0;
    if (!files.length) {
      fileListEl.hidden = true;
      return;
    }
    fileListEl.hidden = false;
    files.forEach((file, i) => {
      const li = document.createElement("li");
      const kind = classifyFile(file);
      const label =
        kind === "image"
          ? "Image"
          : kind === "text"
            ? "Text"
            : kind === "docx"
              ? "Word"
              : kind;
      li.textContent = `${i + 1}. ${file.name} · ${label}`;
      fileListEl.appendChild(li);
    });
  }

  function getFilesFromInput() {
    return fileInput && fileInput.files ? Array.from(fileInput.files) : [];
  }

  function handleFilesPicked(files) {
    const valid = [];
    const errors = [];
    for (const file of files) {
      const err = validateFile(file);
      if (err) errors.push(err);
      else valid.push(file);
    }
    if (errors.length) {
      setStatus(errors.slice(0, 3).join(" · ") + (errors.length > 3 ? " …" : ""), "error");
    } else {
      setStatus(`${valid.length} file(s) ready`, "success");
    }
    syncInputFiles(valid);
    updateFileListUI(valid);
  }

  if (drop && fileInput) {
    drop.addEventListener("click", () => fileInput.click());
    drop.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fileInput.click();
      }
    });
    fileInput.addEventListener("change", () => handleFilesPicked(getFilesFromInput()));
    drop.addEventListener("dragover", e => {
      e.preventDefault();
      drop.classList.add("active");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("active"));
    drop.addEventListener("drop", e => {
      e.preventDefault();
      drop.classList.remove("active");
      if (e.dataTransfer.files?.length) {
        handleFilesPicked(Array.from(e.dataTransfer.files));
      }
    });
  }

  function yieldThread() {
    return new Promise(r => setTimeout(r, 0));
  }

  async function normalizeImageFile(file) {
    if (window.heic2any && /\.(heic|heif)$/i.test(file.name)) {
      setStatus("Converting HEIC…", "info");
      const out = await heic2any({
        blob: file,
        toType: "image/jpeg",
        quality: 0.92
      });
      const blob = Array.isArray(out) ? out[0] : out;
      return new File([blob], file.name.replace(/\.[^.]+$/i, ".jpg"), { type: "image/jpeg" });
    }
    return file;
  }

  function loadImageForPDF(file, quality) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        const maxDim = 2000;
        let w = img.width;
        let h = img.height;
        if (w > maxDim || h > maxDim) {
          const r = Math.min(maxDim / w, maxDim / h);
          w *= r;
          h *= r;
        }
        canvas.width = w;
        canvas.height = h;
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        URL.revokeObjectURL(img.src);
        resolve({ width: w, height: h, dataUrl });
      };
      img.onerror = () => {
        URL.revokeObjectURL(img.src);
        reject(new Error("Could not read image"));
      };
      img.src = URL.createObjectURL(file);
    });
  }

  function scaleToFit(w, h, maxW, maxH) {
    const ratio = Math.min(maxW / w, maxH / h);
    return { width: w * ratio, height: h * ratio };
  }

  let mammothLoading = null;
  function ensureMammoth() {
    if (window.mammoth) return Promise.resolve();
    if (mammothLoading) return mammothLoading;
    mammothLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://unpkg.com/mammoth@1.6.0/mammoth.browser.min.js";
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Could not load document converter"));
      document.head.appendChild(s);
    });
    return mammothLoading;
  }

  async function fileToPlainText(file) {
    const kind = classifyFile(file);
    if (kind === "text") {
      return new TextDecoder("utf-8").decode(await file.arrayBuffer());
    }
    if (kind === "docx") {
      await ensureMammoth();
      const result = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
      return result.value || "";
    }
    throw new Error("Not a text document");
  }

  function addTextDocument(pdf, fileName, text, pageW, pageH, needNewPageFirst) {
    const margin = 18;
    const maxW = pageW - margin * 2;
    const lineH = 5;
    const bodySize = 10;

    if (needNewPageFirst) pdf.addPage();

    let y = margin + 6;
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(11);
    pdf.setTextColor(45, 55, 72);
    pdf.text(fileName, margin, y);
    y += 8;
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(bodySize);
    pdf.setTextColor(15, 23, 42);

    const body = text.length ? text : " ";
    const lines = pdf.splitTextToSize(body, maxW);
    const bottom = pageH - margin;

    for (let i = 0; i < lines.length; i++) {
      if (y + lineH > bottom) {
        pdf.addPage();
        y = margin;
      }
      pdf.text(lines[i], margin, y);
      y += lineH;
    }
  }

  async function buildPdf() {
    const files = getFilesFromInput();
    if (!files.length) {
      setStatus("Add at least one image or document", "error");
      return;
    }

    const JsPDF = window.jspdf?.jsPDF || window.jsPDF;
    if (typeof JsPDF !== "function") {
      setStatus("PDF library failed to load", "error");
      return;
    }

    setLoading(true);
    setStatus("Building PDF…", "info");

    const quality = parseFloat(document.getElementById("pdfQuality")?.value || "0.85");
    const jsPDF = JsPDF;
    const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const pageWidth = 210;
    const pageHeight = 297;

    let firstContent = true;
    const skipped = [];

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const kind = classifyFile(file);
        const err = validateFile(file);
        if (err || kind === "unsupported" || kind === "legacy-doc") {
          skipped.push(file.name);
          continue;
        }

        if (kind === "image") {
          try {
            const imgFile = await normalizeImageFile(file);
            const imgData = await loadImageForPDF(imgFile, quality);
            const { width, height } = scaleToFit(imgData.width, imgData.height, pageWidth, pageHeight);

            if (!firstContent) pdf.addPage();
            firstContent = false;

            pdf.addImage(
              imgData.dataUrl,
              "JPEG",
              (pageWidth - width) / 2,
              (pageHeight - height) / 2,
              width,
              height
            );
          } catch (e) {
            console.error(e);
            skipped.push(file.name);
          }
        } else if (kind === "text" || kind === "docx") {
          let text;
          try {
            if (kind === "docx") {
              setStatus(`Reading Word file ${i + 1}/${files.length}…`, "info");
            }
            text = await fileToPlainText(file);
          } catch (e) {
            console.error(e);
            skipped.push(file.name);
            continue;
          }
          addTextDocument(pdf, file.name, text, pageWidth, pageHeight, !firstContent);
          firstContent = false;
        }

        if (i % 2 === 0) await yieldThread();
      }

      if (firstContent) {
        setStatus("No supported files to convert", "error");
        return;
      }

      pdf.save("document.pdf");
      setStatus(
        skipped.length
          ? `PDF saved (${skipped.length} file(s) skipped)`
          : "PDF downloaded successfully",
        "success"
      );

      if (window.gtag) {
        gtag("event", "pdf_conversion_success", { event_category: "engagement" });
      }
    } catch (e) {
      console.error(e);
      setStatus(e.message || "Could not create PDF", "error");
      if (window.gtag) {
        gtag("event", "pdf_conversion_error", {
          event_category: "error",
          event_label: String(e.message || e)
        });
      }
    } finally {
      setLoading(false);
    }
  }

  const qualityInput = document.getElementById("pdfQuality");
  if (qualityInput) {
    const syncQuality = () => {
      const v = qualityInput.value;
      qualityInput.setAttribute("aria-valuenow", v);
    };
    qualityInput.addEventListener("input", syncQuality);
    syncQuality();
  }

  window.buildImagesAndDocsPdf = buildPdf;
})();
