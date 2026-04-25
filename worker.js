self.onmessage = async (event) => {
  const data = event.data;
  if (data.type !== "process") return;

  try {
    const result = await processInWorker(data);
    self.postMessage({
      type: "result",
      success: true,
      blob: result.blob,
      mimeType: result.mimeType,
      sizeKB: result.sizeKB,
      targetKB: data.targetKB
    }, [result.blob]);
  } catch (error) {
    self.postMessage({
      type: "result",
      success: false,
      error: error?.message || "Worker processing failed"
    });
  }
};

async function processInWorker({ fileBuffer, fileType, targetKB, format, exact, maxDimension }) {
  const file = new Blob([fileBuffer], { type: fileType });
  const bitmap = await createImageBitmap(file);

  const canvas = createCanvas(bitmap, maxDimension);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  bitmap.close?.();

  let blob = await compressQualityOnly(canvas, targetKB, format);

  if ((exact || (blob && blob.size / 1024 > targetKB)) && format !== "image/png") {
    blob = await compressWithScaling(canvas, targetKB, format);
  }

  if (!blob) throw new Error("Unable to compress image");

  const arrayBuffer = await blob.arrayBuffer();
  return {
    blob: arrayBuffer,
    mimeType: format,
    sizeKB: Math.round(blob.size / 1024)
  };
}

function createCanvas(bitmap, maxDimension) {
  let width = bitmap.width;
  let height = bitmap.height;

  if (width > maxDimension || height > maxDimension) {
    const scale = Math.min(maxDimension / width, maxDimension / height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  const canvas = new OffscreenCanvas(width, height);
  return canvas;
}

async function compressQualityOnly(canvas, targetKB, format) {
  if (format === "image/png") {
    return canvas.convertToBlob({ type: "image/png" });
  }

  let low = 0.1;
  let high = 0.95;
  let best = null;

  for (let i = 0; i < 8; i++) {
    const quality = (low + high) / 2;
    const blob = await canvas.convertToBlob({ type: format, quality });
    const size = blob.size / 1024;

    if (Math.abs(size - targetKB) < 2) return blob;

    if (size > targetKB) {
      high = quality;
    } else {
      best = blob;
      low = quality;
    }
  }

  return best || canvas.convertToBlob({ type: format, quality: low });
}

async function compressWithScaling(canvas, targetKB, format) {
  const temp = new OffscreenCanvas(canvas.width, canvas.height);
  const ctx = temp.getContext("2d");

  let low = 0.2;
  let high = 1;
  let best = null;

  for (let i = 0; i < 7; i++) {
    const scale = (low + high) / 2;
    temp.width = Math.max(1, Math.round(canvas.width * scale));
    temp.height = Math.max(1, Math.round(canvas.height * scale));

    ctx.clearRect(0, 0, temp.width, temp.height);
    ctx.drawImage(canvas, 0, 0, temp.width, temp.height);

    const blob = await compressQualityOnly(temp, targetKB, format);
    const size = blob.size / 1024;

    if (Math.abs(size - targetKB) < 2) return blob;

    if (size > targetKB) {
      high = scale;
    } else {
      best = blob;
      low = scale;
    }
  }

  return best || temp.convertToBlob({ type: format, quality: 0.8 });
}