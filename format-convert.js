/**
 * format-convert.js — production-grade controller for format-convert.html
 *
 * Modes: xml2json | json2xml | xsd2xml
 * Dependencies: fast-xml-parser (ESM via esm.sh), ./xsd-sample-xml.js
 */

import { XMLParser, XMLBuilder } from "https://esm.sh/fast-xml-parser@4.5.1";
import { generateSampleXmlFromXsd, generateAllRootsXml, listRootElements, listRootEntries } from "./xsd-sample-xml.js";

// ─── DOM refs ────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const srcEl        = () => $("sourceText");
const resEl        = () => $("resultText");
const srcHi        = () => $("sourceHighlight");
const resHi        = () => $("resultHighlight");
const statusEl     = () => $("formatStatus");
const srcStatsEl   = () => $("sourceStats");
const resStatsEl   = () => $("resultStats");

// ─── Syntax highlighting (JSON + XML/XSD) ────────────────────────────────────

function escapeHtml(t) {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function findGt(s, from) {
  let j = from;
  let inQuote = "";
  while (j < s.length) {
    const ch = s[j];
    if (inQuote) {
      if (ch === inQuote) inQuote = "";
      j++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      j++;
      continue;
    }
    if (ch === ">") return j + 1;
    j++;
  }
  return s.length;
}

function highlightJson(src) {
  const n = src.length;
  let i = 0;
  let out = "";
  const jStr = h => `<span class="hl-json-str">${h}</span>`;
  const jNum = h => `<span class="hl-json-num">${h}</span>`;
  const jKw  = h => `<span class="hl-json-kw">${h}</span>`;
  const jPu  = h => `<span class="hl-json-punct">${h}</span>`;

  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\n" || c === "\r" || c === "\t") {
      const a = i;
      while (i < n && " \n\r\t".includes(src[i])) i++;
      out += escapeHtml(src.slice(a, i));
      continue;
    }
    if (c === '"') {
      const a = i;
      i++;
      while (i < n) {
        if (src[i] === "\\" && i + 1 < n) { i += 2; continue; }
        if (src[i] === '"') { i++; break; }
        i++;
      }
      out += jStr(escapeHtml(src.slice(a, i)));
      continue;
    }
    if ("{}[],:".includes(c)) {
      out += jPu(escapeHtml(c));
      i++;
      continue;
    }
    if (c === "-" || (c >= "0" && c <= "9")) {
      const a = i;
      if (c === "-") i++;
      while (i < n && src[i] >= "0" && src[i] <= "9") i++;
      if (i < n && src[i] === ".") {
        i++;
        while (i < n && src[i] >= "0" && src[i] <= "9") i++;
      }
      if (i < n && (src[i] === "e" || src[i] === "E")) {
        i++;
        if (i < n && (src[i] === "+" || src[i] === "-")) i++;
        while (i < n && src[i] >= "0" && src[i] <= "9") i++;
      }
      out += jNum(escapeHtml(src.slice(a, i)));
      continue;
    }
    if (src.startsWith("true", i))  { out += jKw("true");  i += 4; continue; }
    if (src.startsWith("false", i)) { out += jKw("false"); i += 5; continue; }
    if (src.startsWith("null", i))  { out += jKw("null");  i += 4; continue; }
    out += escapeHtml(c);
    i++;
  }
  return out;
}

function xmlNameRe(ch) {
  return /[\w:.\u00B7-]/.test(ch);
}

function highlightXmlElement(tag) {
  const s = tag;
  let out = "";
  let i = 0;
  out += `<span class="hl-xml-punct">${escapeHtml(s[0])}</span>`;
  i = 1;
  if (i < s.length && s[i] === "/") {
    out += `<span class="hl-xml-punct">/</span>`;
    i++;
  }
  const nameStart = i;
  while (i < s.length && xmlNameRe(s[i])) i++;
  if (nameStart < i) out += `<span class="hl-xml-tag">${escapeHtml(s.slice(nameStart, i))}</span>`;

  while (i < s.length - 1) {
    while (i < s.length - 1 && /\s/.test(s[i])) {
      out += escapeHtml(s[i]);
      i++;
    }
    if (i >= s.length - 1) break;
    if (s[i] === "/" && s[i + 1] === ">") {
      out += `<span class="hl-xml-punct">/</span>`;
      i++;
      continue;
    }
    const anStart = i;
    while (i < s.length && xmlNameRe(s[i])) i++;
    if (anStart === i) {
      out += escapeHtml(s[i]);
      i++;
      continue;
    }
    out += `<span class="hl-xml-attr">${escapeHtml(s.slice(anStart, i))}</span>`;
    while (i < s.length - 1 && /\s/.test(s[i])) {
      out += escapeHtml(s[i]);
      i++;
    }
    if (i >= s.length - 1) break;
    if (s[i] !== "=") continue;
    out += `<span class="hl-xml-punct">${escapeHtml("=")}</span>`;
    i++;
    while (i < s.length - 1 && /\s/.test(s[i])) {
      out += escapeHtml(s[i]);
      i++;
    }
    if (i >= s.length) break;
    const q = s[i];
    if (q === '"' || q === "'") {
      const qend = s.indexOf(q, i + 1);
      const end = qend === -1 ? s.length - 1 : qend + 1;
      out += `<span class="hl-xml-str">${escapeHtml(s.slice(i, end))}</span>`;
      i = end;
    }
  }
  if (s.endsWith(">")) out += `<span class="hl-xml-punct">${escapeHtml(">")}</span>`;
  return out;
}

function highlightXml(src) {
  const n = src.length;
  let i = 0;
  let out = "";
  while (i < n) {
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      const j = end === -1 ? n : end + 3;
      out += `<span class="hl-xml-comment">${escapeHtml(src.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    if (src.startsWith("<![CDATA[", i)) {
      const end = src.indexOf("]]>", i + 9);
      const j = end === -1 ? n : end + 3;
      out += `<span class="hl-xml-cdata">${escapeHtml(src.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    if (src.startsWith("<?", i)) {
      const end = src.indexOf("?>", i + 2);
      const j = end === -1 ? n : end + 2;
      out += `<span class="hl-xml-pi">${escapeHtml(src.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    if (src[i] === "<") {
      const j = findGt(src, i + 1);
      const chunk = src.slice(i, j);
      if (chunk.startsWith("<!")) {
        out += `<span class="hl-xml-doctype">${escapeHtml(chunk)}</span>`;
      } else {
        out += highlightXmlElement(chunk);
      }
      i = j;
      continue;
    }
    const next = src.indexOf("<", i);
    const j = next === -1 ? n : next;
    out += escapeHtml(src.slice(i, j));
    i = j;
  }
  return out;
}

function paintHighlight(codeEl, text, lang) {
  if (!codeEl) return;
  const html = lang === "json" ? highlightJson(text) : highlightXml(text);
  codeEl.innerHTML = html;
}

function syncHighlightScroll(ta, codeEl) {
  if (!ta || !codeEl) return;
  const pre = codeEl.closest(".format-code-highlights");
  if (!pre) return;
  pre.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
}

let _hiTimer;
function scheduleHighlights() {
  clearTimeout(_hiTimer);
  _hiTimer = setTimeout(applyHighlights, 48);
}

function applyHighlights() {
  const mode = activeMode();
  const srcLang = mode === "json2xml" ? "json" : "xml";
  const resLang = mode === "xml2json" ? "json" : "xml";
  paintHighlight(srcHi(), srcEl()?.value ?? "", srcLang);
  paintHighlight(resHi(), resEl()?.value ?? "", resLang);
  syncHighlightScroll(srcEl(), srcHi());
  syncHighlightScroll(resEl(), resHi());
}

function wireHighlightScroll(ta, codeEl) {
  if (!ta || !codeEl) return;
  ta.addEventListener("scroll", () => syncHighlightScroll(ta, codeEl), { passive: true });
}

// ─── Status ──────────────────────────────────────────────────────────────────

function setStatus(msg, type = "info") {
  const el = statusEl();
  if (!el) return;
  el.textContent = msg;
  el.dataset.tone = type === "error" ? "error" : type === "success" ? "success" : "info";
}

// ─── Textarea stats ───────────────────────────────────────────────────────────

function stats(text) {
  if (!text) return "0 chars";
  const chars = text.length;
  const lines = text.split("\n").length;
  const kb    = (new TextEncoder().encode(text).byteLength / 1024).toFixed(1);
  return `${lines.toLocaleString()} lines · ${chars.toLocaleString()} chars · ${kb} KB`;
}

function updateStats() {
  const src = srcEl();
  const res = resEl();
  if (src && srcStatsEl()) srcStatsEl().textContent = stats(src.value);
  if (res && resStatsEl()) resStatsEl().textContent = stats(res.value);
}

// ─── XML well-formedness check ────────────────────────────────────────────────

function checkXml(raw) {
  const doc = new DOMParser().parseFromString(raw, "application/xml");
  const err = doc.querySelector("parsererror");
  if (!err) return null;
  // Try to extract line/column from error text
  const txt = err.textContent || "";
  const m   = txt.match(/line[^\d]*(\d+)[^\d]*column[^\d]*(\d+)/i);
  if (m) return `XML error at line ${m[1]}, column ${m[2]}`;
  return "XML is not well-formed";
}

// ─── pretty-print XML ─────────────────────────────────────────────────────────

function formatXml(raw) {
  const doc = new DOMParser().parseFromString(raw, "application/xml");
  const err = doc.querySelector("parsererror");
  if (err) throw new Error(checkXml(raw) || "Not valid XML");
  const s = new XMLSerializer().serializeToString(doc);
  // Re-indent via XMLParser + XMLBuilder round-trip (preserves all content)
  const parser  = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", preserveOrder: true, processEntities: true });
  const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: "@_", format: true, indentBy: "  ", suppressEmptyNode: false, preserveOrder: true, processEntities: true });
  return builder.build(parser.parse(s));
}

// ─── XML → JSON ───────────────────────────────────────────────────────────────

function getX2JOptions() {
  return {
    ignoreAttributes:     $("optIgnoreAttrs")?.checked ?? false,
    attributeNamePrefix:  ($("optAttrPrefix")?.value   || "@_").trim() || "@_",
    textNodeName:         "#text",
    trimValues:           $("optTrim")?.checked ?? true,
    parseTagValue:        $("optParseValues")?.checked ?? true,
    parseAttributeValue:  $("optParseAttrValues")?.checked ?? true,
    removeNSPrefix:       $("optRemoveNs")?.checked ?? false,
    processEntities:      true,
    stopNodes:            [],
  };
}

function runXmlToJson() {
  const raw = srcEl()?.value || "";
  if (!raw.trim()) { setStatus("Paste XML in the left panel", "error"); return; }

  const xmlErr = checkXml(raw);
  if (xmlErr) { setStatus(xmlErr, "error"); return; }

  try {
    const parser = new XMLParser(getX2JOptions());
    const obj    = parser.parse(raw);
    const spaces = parseInt($("optJsonIndent")?.value || "2", 10) || 2;
    const json   = JSON.stringify(obj, null, spaces);
    resEl().value = json;
    updateStats();
    applyHighlights();
    setStatus(`Converted to JSON · ${(json.length / 1024).toFixed(1)} KB`, "success");
  } catch (e) {
    setStatus(e.message || "Conversion failed", "error");
  }
}

// ─── JSON → XML ───────────────────────────────────────────────────────────────

function getJ2XOptions() {
  const char = $("optXmlIndentChar")?.value || "spaces";
  const size = parseInt($("optXmlIndentSize")?.value || "2", 10) || 2;
  return {
    ignoreAttributes:       $("optJ2xIgnoreAttrs")?.checked ?? false,
    attributeNamePrefix:    ($("optJ2xAttrPrefix")?.value || "@_").trim() || "@_",
    textNodeName:           "#text",
    format:                 $("optJ2xFormat")?.checked ?? true,
    indentBy:               char === "tab" ? "\t" : " ".repeat(size),
    suppressEmptyNode:      $("optJ2xSuppressEmpty")?.checked ?? false,
    suppressBooleanAttributes: false,
    processEntities:        true,
  };
}

function runJsonToXml() {
  const raw = srcEl()?.value || "";
  if (!raw.trim()) { setStatus("Paste JSON in the left panel", "error"); return; }

  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    setStatus("Invalid JSON — " + e.message, "error");
    return;
  }

  try {
    const wrap = ($("optJ2xRootWrap")?.value || "").trim();
    if (wrap) obj = { [wrap]: obj };

    const builder = new XMLBuilder(getJ2XOptions());
    let xml = builder.build(obj);
    if ($("optJ2xXmlDecl")?.checked) xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + xml;
    resEl().value = xml;
    updateStats();
    applyHighlights();
    setStatus(`Converted to XML · ${(xml.length / 1024).toFixed(1)} KB`, "success");
  } catch (e) {
    setStatus(e.message || "Build failed", "error");
  }
}

// ─── XSD → sample XML ────────────────────────────────────────────────────────

function refreshXsdRoots(xsdText) {
  const sel = $("optXsdRoot");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = "";

  const raw      = xsdText ?? srcEl()?.value ?? "";
  const allMode  = $("optXsdAllRoots")?.checked ?? false;
  const rootRow  = $("xsdRootRow");
  if (rootRow) rootRow.hidden = allMode;

  if (!raw.trim()) {
    sel.innerHTML = '<option value="">— Paste XSD first —</option>';
    sel.disabled  = true;
    return;
  }
  try {
    const entries = listRootEntries(raw).filter(e => !e.abstract);
    entries.forEach(e => {
      const o = document.createElement("option");
      o.value = e.name;
      o.textContent = e.kind === "complexType" ? `${e.name}  (complexType)` : e.name;
      sel.appendChild(o);
    });
    if (prev && entries.some(e => e.name === prev)) sel.value = prev;
    sel.disabled = allMode || entries.length <= 1;

    const elCount = entries.filter(e => e.kind === "element").length;
    const ctCount = entries.length - elCount;
    const badge = $("optXsdRootCount");
    if (badge) {
      if (ctCount && !elCount) {
        badge.textContent = `${ctCount} global complexType${ctCount !== 1 ? "s" : ""}`;
      } else if (ctCount) {
        badge.textContent = `${elCount} element${elCount !== 1 ? "s" : ""}, ${ctCount} type${ctCount !== 1 ? "s" : ""}`;
      } else {
        badge.textContent = `${elCount} global element${elCount !== 1 ? "s" : ""}`;
      }
    }
  } catch {
    sel.innerHTML = '<option value="">— Invalid XSD —</option>';
    sel.disabled  = true;
  }
}

function runXsdToXml() {
  const raw = srcEl()?.value || "";
  if (!raw.trim()) { setStatus("Paste XSD schema in the left panel", "error"); return; }

  const xmlErr = checkXml(raw);
  if (xmlErr) { setStatus(xmlErr, "error"); return; }

  const allMode = $("optXsdAllRoots")?.checked ?? false;
  const sharedOpts = {
    includeOptional:  $("optXsdOptional")?.checked ?? true,
    maxDepth:         parseInt($("optXsdMaxDepth")?.value     || "20", 10) || 20,
    indentSpaces:     parseInt($("optXsdIndent")?.value       || "2",  10) || 2,
    xmlDeclaration:   $("optXsdDecl")?.checked ?? false,
    maxOccursSamples: parseInt($("optXsdOccurrences")?.value  || "1",  10) || 1,
  };

  try {
    refreshXsdRoots(raw);
    let out, label;

    if (allMode) {
      const wrapper = ($("optXsdWrapper")?.value || "XsdSample").trim() || "XsdSample";
      const maxEls  = parseInt($("optXsdMaxEls")?.value || "200", 10) || 200;
      out   = generateAllRootsXml(raw, { ...sharedOpts, wrapperTag: wrapper, maxElements: maxEls });
      const roots = listRootElements(raw);
      const shown = Math.min(roots.length, maxEls);
      label = `Generated all ${shown}${shown < roots.length ? " of " + roots.length : ""} global elements`;
    } else {
      const root = ($("optXsdRoot")?.value || "").trim() || null;
      out   = generateSampleXmlFromXsd(raw, { ...sharedOpts, rootElementName: root || null });
      label = `Sample XML generated (root: ${root || "auto"})`;
    }

    resEl().value = out;
    updateStats();
    applyHighlights();
    setStatus(label, "success");
  } catch (e) {
    setStatus(e.message || "Could not generate from XSD", "error");
  }
}

// ─── Mode routing ─────────────────────────────────────────────────────────────

function activeMode() {
  return document.querySelector(".format-mode.is-active")?.dataset.mode || "xml2json";
}

function runConvert() {
  const mode = activeMode();
  if      (mode === "xml2json") runXmlToJson();
  else if (mode === "json2xml") runJsonToXml();
  else                          runXsdToXml();
}

// ─── Format source XML ────────────────────────────────────────────────────────

function runFormatSource() {
  const el = srcEl();
  if (!el?.value.trim()) { setStatus("Nothing to format", "error"); return; }
  const mode = activeMode();
  if (mode === "json2xml") {
    try {
      el.value = JSON.stringify(JSON.parse(el.value), null, 2);
      updateStats();
      applyHighlights();
      setStatus("JSON formatted", "success");
    } catch (e) { setStatus("Invalid JSON — " + e.message, "error"); }
    return;
  }
  try {
    el.value = formatXml(el.value);
    updateStats();
    applyHighlights();
    setStatus("XML formatted", "success");
  } catch (e) {
    setStatus(e.message || "Format failed", "error");
  }
}

// ─── Swap source ↔ result ─────────────────────────────────────────────────────

function runSwap() {
  const src = srcEl();
  const res = resEl();
  if (!src || !res) return;
  const tmp   = src.value;
  src.value   = res.value;
  res.value   = tmp;
  const mode  = activeMode();
  if (mode === "xsd2xml") refreshXsdRoots();
  updateStats();
  applyHighlights();
  setStatus("Swapped source and result", "info");
}

// ─── Copy / Download ──────────────────────────────────────────────────────────

async function runCopy() {
  const t = resEl()?.value || "";
  if (!t) { setStatus("Nothing to copy", "error"); return; }
  try {
    await navigator.clipboard.writeText(t);
    setStatus("Copied to clipboard", "success");
  } catch {
    setStatus("Copy failed — select text manually", "error");
  }
}

function runDownload() {
  const t = resEl()?.value || "";
  if (!t) { setStatus("Nothing to download", "error"); return; }
  const mode  = activeMode();
  const isXml = mode === "json2xml" || mode === "xsd2xml";
  const ext   = isXml ? "xml" : "json";
  const mime  = isXml ? "application/xml" : "application/json";
  const name  = mode === "xsd2xml" ? "sample-from-schema.xml" : `output.${ext}`;
  const a     = Object.assign(document.createElement("a"), {
    href:     URL.createObjectURL(new Blob([t], { type: mime })),
    download: name,
  });
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus("Download started", "success");
}

function runClear() {
  const src = srcEl();
  const res = resEl();
  if (src) src.value = "";
  if (res) res.value = "";
  updateStats();
  applyHighlights();
  const mode = activeMode();
  if (mode === "xsd2xml") refreshXsdRoots("");
  setStatus("Cleared", "info");
}

// ─── Mode switch ──────────────────────────────────────────────────────────────

function setMode(mode) {
  document.querySelectorAll(".format-mode").forEach(b => {
    b.classList.toggle("is-active", b.dataset.mode === mode);
    b.setAttribute("aria-selected", b.dataset.mode === mode ? "true" : "false");
  });
  document.querySelectorAll("[data-for]").forEach(p => {
    p.hidden = p.dataset.for !== mode;
  });

  const srcLabel = $("sourceLabel");
  const resLabel = $("resultLabel");
  if (srcLabel) srcLabel.textContent = mode === "json2xml" ? "JSON input" : mode === "xsd2xml" ? "XSD schema input" : "XML input";
  if (resLabel) resLabel.textContent = mode === "xml2json" ? "JSON output" : "XML output";

  const hints = {
    xml2json: "Paste XML · adjust options · Convert.",
    json2xml: "Paste JSON · optionally set a root wrapper · Convert.",
    xsd2xml:  "Paste XSD · pick root element · Convert to sample XML.",
  };
  setStatus(hints[mode] || "", "info");

  if (mode === "xsd2xml") refreshXsdRoots();
  applyHighlights();
}

// ─── File drag-and-drop on textareas ─────────────────────────────────────────

function wireTextareaDrop(textarea) {
  if (!textarea) return;
  textarea.addEventListener("dragover", e => { e.preventDefault(); textarea.classList.add("drag-over"); });
  textarea.addEventListener("dragleave", () => textarea.classList.remove("drag-over"));
  textarea.addEventListener("drop", e => {
    e.preventDefault();
    textarea.classList.remove("drag-over");
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      textarea.value = ev.target.result;
      updateStats();
      applyHighlights();
      const mode = activeMode();
      if (textarea.id === "sourceText" && mode === "xsd2xml") refreshXsdRoots();
      setStatus(`Loaded: ${file.name}`, "info");
    };
    reader.onerror = () => setStatus("Could not read file", "error");
    reader.readAsText(file, "UTF-8");
  });
}

// ─── Keyboard shortcut (Ctrl/Cmd + Enter = Convert) ──────────────────────────

function wireKeyboard() {
  document.addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      runConvert();
    }
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
  document.querySelectorAll(".format-mode").forEach(btn => {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  });

  $("btnConvert")?.addEventListener("click",  runConvert);
  $("btnFormat")?.addEventListener("click",   runFormatSource);
  $("btnSwap")?.addEventListener("click",     runSwap);
  $("btnCopy")?.addEventListener("click",     runCopy);
  $("btnDownload")?.addEventListener("click", runDownload);
  $("btnClear")?.addEventListener("click",    runClear);

  // "Generate all" toggle shows/hides root selector row and wrapper options
  $("optXsdAllRoots")?.addEventListener("change", () => {
    refreshXsdRoots();
    const allMode   = $("optXsdAllRoots")?.checked ?? false;
    const wrapRow   = $("xsdWrapperRow");
    const maxElsRow = $("xsdMaxElsRow");
    if (wrapRow)   wrapRow.hidden   = !allMode;
    if (maxElsRow) maxElsRow.hidden = !allMode;
  });

  // Live stats update
  srcEl()?.addEventListener("input", () => {
    updateStats();
    scheduleHighlights();
    if (activeMode() === "xsd2xml") {
      clearTimeout(srcEl()._xsdTimer);
      srcEl()._xsdTimer = setTimeout(() => refreshXsdRoots(), 600);
    }
  });
  resEl()?.addEventListener("input", () => {
    updateStats();
    scheduleHighlights();
  });

  wireHighlightScroll(srcEl(), srcHi());
  wireHighlightScroll(resEl(), resHi());

  wireTextareaDrop(srcEl());
  wireTextareaDrop(resEl());
  wireKeyboard();

  setMode("xml2json");
  updateStats();
}

init();