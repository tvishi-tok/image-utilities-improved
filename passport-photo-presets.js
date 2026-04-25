
/**
 * passport-photo-presets.js
 *
 * Versioned, data-driven country presets for passport / visa / official photos.
 * All measurements are in millimetres unless otherwise noted, at 300 DPI output.
 *
 * Sources:
 * US: travel.state.gov passport photo requirements (2x2 inch, head 1"–1 3/8",
 * eye line 1 1/8"–1 3/8" from bottom, white background).
 * India: passportindia.gov.in photo specs (35x45 mm, head 25–35 mm, eyes
 * ~28–35 mm from bottom, plain white/off-white background).
 *
 * Sheet defaults: 4x6 inch (102x152 mm) photo paper, the universal print-shop
 * size in both countries.
 */

export const PRESETS_VERSION = "1.0.0";

const MM_PER_INCH = 25.4;

export const PRESETS = {
 us_passport: {
 id: "us_passport",
 country: "US",
 label: "US Passport (2 × 2 in)",
 description: "Official US Department of State requirement: 2×2 inch, head 1–1⅜ in, white background.",
 photo: {
 widthMm: 2 * MM_PER_INCH, // 50.8
 heightMm: 2 * MM_PER_INCH, // 50.8
 dpi: 300,
 },
 head: {
 // Fraction of photo height covered by top-of-head to bottom-of-chin.
 // 1.0–1.375 in within a 2 in photo → 0.500–0.6875
 minRatio: 0.500,
 maxRatio: 0.6875,
 targetRatio: 0.59, // ≈ 1 3/16 in head height
 },
 eyeLine: {
 // Fraction of photo height from BOTTOM where eye line should sit.
 // 1.125–1.375 in within a 2 in photo → 0.5625–0.6875
 minFromBottomRatio: 0.5625,
 maxFromBottomRatio: 0.6875,
 targetFromBottomRatio: 0.625,
 },
 background: {
 label: "Plain white",
 hex: "FFFFFF_1FFFFFF_1",
 tolerance: 0.92, // mean luminance threshold for "white"
 },
 fileSize: {
 // US gov online passport upload: between 54 KB and 10 MB, JPEG.
 minKB: 54,
 maxKB: 10240,
 preferredKB: 240,
 },
 output: {
 format: "image/jpeg",
 quality: 0.92,
 },
 notes: [
 "Single subject, facing camera, neutral expression with mouth closed.",
 "No glasses (rule effective Nov 2016).",
 "Plain white or off-white background only.",
 "Taken within the last 6 months.",
 ],
 },

 india_passport: {
 id: "india_passport",
 country: "IN",
 label: "India Passport (35 × 45 mm)",
 description: "Government of India / Passport Seva: 35×45 mm, head 25–35 mm, plain white background.",
 photo: {
 widthMm: 35,
 heightMm: 45,
 dpi: 300,
 },
 head: {
 // 25–35 mm head height within 45 mm photo → 0.555–0.778
 minRatio: 0.555,
 maxRatio: 0.778,
 targetRatio: 0.70, // ≈ 31.5 mm head height
 },
 eyeLine: {
 // Recommended eye position ≈ 28–35 mm from bottom in a 45 mm photo
 // → 0.622–0.778
 minFromBottomRatio: 0.622,
 maxFromBottomRatio: 0.778,
 targetFromBottomRatio: 0.70,
 },
 background: {
 label: "Plain white",
 hex: "FFFFFF_1FFFFFF_1",
 tolerance: 0.92,
 },
 fileSize: {
 // Passport Seva online upload: 10 KB to 1 MB, JPEG.
 minKB: 10,
 maxKB: 1024,
 preferredKB: 200,
 },
 output: {
 format: "image/jpeg",
 quality: 0.90,
 },
 notes: [
 "Front-facing, neutral expression, mouth closed, eyes open.",
 "No caps or hats (religious head coverings allowed if face fully visible).",
 "Plain white or very light background, no shadows.",
 "Sharp focus, even lighting, no red-eye.",
 ],
 },

 india_visa: {
 id: "india_visa",
 country: "IN",
 label: "India Visa / OCI (2 × 2 in, square)",
 description: "Indian visa & OCI applications: 2×2 inch square, plain light background.",
 photo: {
 widthMm: 2 * MM_PER_INCH,
 heightMm: 2 * MM_PER_INCH,
 dpi: 300,
 },
 head: {
 minRatio: 0.50,
 maxRatio: 0.69,
 targetRatio: 0.60,
 },
 eyeLine: {
 minFromBottomRatio: 0.55,
 maxFromBottomRatio: 0.70,
 targetFromBottomRatio: 0.62,
 },
 background: {
 label: "Plain white",
 hex: "FFFFFF_1FFFFFF_1",
 tolerance: 0.90,
 },
 fileSize: {
 minKB: 10,
 maxKB: 300,
 preferredKB: 200,
 },
 output: {
 format: "image/jpeg",
 quality: 0.90,
 },
 notes: [
 "Square 2×2 inch, head occupies 50–69% of photo height.",
 "Both ears visible if possible, no hair across the face.",
 "Plain light background with no patterns.",
 ],
 },
};

/** Ordered list for UI rendering. */
export const PRESET_ORDER = ["us_passport", "india_passport", "india_visa"];

/** Standard print sheet (4x6 inch photo paper). */
export const PRINT_SHEET = {
 widthMm: 6 * MM_PER_INCH, // 152.4
 heightMm: 4 * MM_PER_INCH, // 101.6
 dpi: 300,
 marginMm: 3,
 gapMm: 3,
};

/** Convert mm @ given DPI to integer pixels. */
export function mmToPx(mm, dpi = 300) {
 return Math.round((mm / MM_PER_INCH) * dpi);
}

/** Convenience: returns target photo size in pixels for a preset. */
export function presetPhotoPx(preset) {
 return {
 widthPx: mmToPx(preset.photo.widthMm, preset.photo.dpi),
 heightPx: mmToPx(preset.photo.heightMm, preset.photo.dpi),
 dpi: preset.photo.dpi,
 };
}
