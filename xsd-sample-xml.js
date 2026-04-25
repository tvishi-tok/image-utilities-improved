/**
 * xsd-sample-xml.js — production-grade XSD → sample XML generator.
 * Production-grade XSD → sample XML generator.
 *
 * Handles:
 *  - xs:element (global, local, ref, abstract, maxOccurs)
 *  - xs:complexType with xs:sequence, xs:all, xs:choice (nested)
 *  - xs:simpleType: restriction (enum/base), list, union
 *  - xs:simpleContent > xs:extension | xs:restriction  (text + attrs)
 *  - xs:complexContent > xs:extension | xs:restriction (inheritance chain)
 *  - xs:group and xs:attributeGroup references
 *  - xs:attribute (required / optional, attributeGroup refs)
 *  - xs:any and xs:anyAttribute (placeholder comments)
 *  - Schemas using xs: prefix, xsd: prefix, or bare default namespace
 *  - External / XBRL type hints via a known-types map
 *  - Cycle detection per type-name expansion
 *  - Abstract element filtering in root-element listing
 */

const XS = "http://www.w3.org/2001/XMLSchema";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isEl(node, ...localNames) {
  if (!node || node.nodeType !== 1 || node.namespaceURI !== XS) return false;
  return localNames.length === 0 || localNames.includes(node.localName);
}

function attr(el, name) {
  return el?.getAttribute?.(name) ?? null;
}

function localName(qname) {
  if (!qname) return "";
  const i = qname.indexOf(":");
  return i === -1 ? qname : qname.slice(i + 1);
}

function parseErrorText(doc) {
  return doc?.querySelector?.("parsererror")?.textContent?.trim() || null;
}

function findSchema(doc) {
  const r = doc.documentElement;
  if (r.namespaceURI === XS && r.localName === "schema") return r;
  return doc.getElementsByTagNameNS(XS, "schema")[0] || null;
}

function childEls(parent, ...localNames) {
  return [...parent.children].filter(c => isEl(c, ...localNames));
}

function firstChild(parent, ...localNames) {
  return [...parent.children].find(c => isEl(c, ...localNames)) || null;
}

// ─── Known external type → sample value map ───────────────────────────────────
// Covers XBRL instance types, ISO 20022, FpML and common financial schemas.

const EXT_TYPE_SAMPLES = {
  // XBRL
  monetaryItemType:    "1000000.00",
  decimalItemType:     "0.00",
  stringItemType:      "text",
  booleanItemType:     "true",
  dateItemType:        "2000-01-01",
  gYearItemType:       "2000",
  sharesItemType:      "0",
  pureItemType:        "1.0",
  integerItemType:     "0",
  fractionItemType:    "1",
  // ISO 20022 / FpML / common financial
  ISODate:             "2000-01-01",
  ISODateTime:         "2000-01-01T00:00:00Z",
  Max35Text:           "Sample text",
  Max70Text:           "Sample text",
  Max105Text:          "Sample text",
  Max140Text:          "Sample text",
  Max255Text:          "Sample text",
  Max350Text:          "Sample text",
  Max500Text:          "Sample text",
  LEIIdentifier:       "5493001KJTIIGC8Y1R12",
  CurrencyCode:        "USD",
  ActiveCurrencyCode:  "USD",
  CountryCode:         "US",
  YesNoIndicator:      "true",
  PercentageRate:      "0.0",
  ExternalSystemPartyType1Code: "PTYP",
  DecimalNumber:       "0.0",
  BaseOneRate:         "1.0",
  NonNegativeDecimalNumber: "0.0",
};

function sampleForExtType(loc) {
  if (!loc) return "text";
  if (loc in EXT_TYPE_SAMPLES) return EXT_TYPE_SAMPLES[loc];
  // heuristic guesses
  const l = loc.toLowerCase();
  if (l.includes("date"))     return "2000-01-01";
  if (l.includes("time"))     return "00:00:00Z";
  if (l.includes("amount") || l.includes("monetary") || l.includes("decimal")) return "0.00";
  if (l.includes("rate") || l.includes("ratio") || l.includes("percent"))     return "0.0";
  if (l.includes("indicator") || l.includes("boolean")) return "true";
  if (l.includes("count") || l.includes("number") || l.includes("integer"))   return "0";
  if (l.includes("code"))     return "CODE";
  if (l.includes("id") || l.includes("identifier")) return "ID001";
  if (l.includes("lei"))      return "5493001KJTIIGC8Y1R12";
  if (l.includes("currency")) return "USD";
  if (l.includes("country"))  return "US";
  if (l.includes("uri") || l.includes("url")) return "https://example.com/";
  return "text";
}

// ─── Built-in XSD types ───────────────────────────────────────────────────────

const BUILTIN = new Set([
  "string","normalizedString","token","Name","NCName","QName","anyURI","language",
  "NMTOKEN","NMTOKENS","ID","IDREF","IDREFS","ENTITY","ENTITIES","notation",
  "boolean","decimal","integer","long","int","short","byte",
  "nonNegativeInteger","positiveInteger","nonPositiveInteger","negativeInteger",
  "unsignedLong","unsignedInt","unsignedShort","unsignedByte",
  "float","double",
  "duration","dateTime","date","time",
  "gYear","gYearMonth","gMonth","gMonthDay","gDay",
  "hexBinary","base64Binary","anySimpleType","anyType",
]);

function isBuiltin(loc) { return BUILTIN.has(loc); }

function sampleForBuiltin(loc) {
  switch (loc) {
    case "boolean":              return "true";
    case "decimal":              return "0.00";
    case "float":
    case "double":               return "0.0";
    case "integer":
    case "long":
    case "int":
    case "short":
    case "byte":
    case "nonNegativeInteger":
    case "positiveInteger":
    case "unsignedLong":
    case "unsignedInt":
    case "unsignedShort":
    case "unsignedByte":         return "0";
    case "negativeInteger":
    case "nonPositiveInteger":   return "-1";
    case "date":                 return "2000-01-01";
    case "dateTime":             return "2000-01-01T00:00:00Z";
    case "time":                 return "00:00:00Z";
    case "gYear":                return "2000";
    case "gYearMonth":           return "2000-01";
    case "gMonth":               return "--01";
    case "gMonthDay":            return "--01-01";
    case "gDay":                 return "---01";
    case "duration":             return "P1Y";
    case "anyURI":               return "https://example.com/";
    case "base64Binary":         return "AA==";
    case "hexBinary":            return "00";
    case "anyType":
    case "anySimpleType":        return "text";
    default:                     return "text";
  }
}

function sampleForType(loc) {
  return isBuiltin(loc) ? sampleForBuiltin(loc) : sampleForExtType(loc);
}

// ─── Schema index ─────────────────────────────────────────────────────────────

function indexSchema(schema) {
  const types      = new Map(); // name → xs:complexType | xs:simpleType
  const groups     = new Map(); // name → xs:group
  const attrGroups = new Map(); // name → xs:attributeGroup
  const globalEls  = new Map(); // name → xs:element

  for (const ch of schema.children) {
    const nm = attr(ch, "name");
    if (!nm) continue;
    if      (isEl(ch, "complexType", "simpleType")) types.set(nm, ch);
    else if (isEl(ch, "group"))                     groups.set(nm, ch);
    else if (isEl(ch, "attributeGroup"))            attrGroups.set(nm, ch);
    else if (isEl(ch, "element"))                   globalEls.set(nm, ch);
  }
  return { types, groups, attrGroups, globalEls };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * List candidate root entries for the schema.
 * Each entry: { name, kind: "element" | "complexType", abstract: boolean }
 *
 * Falls back to global complexTypes when the schema declares none as
 * elements (common in shared-library / WSDL-style XSDs).
 */
export function listRootEntries(xsdString) {
  const doc = new DOMParser().parseFromString(xsdString, "application/xml");
  if (parseErrorText(doc)) throw new Error("Invalid XML — cannot parse as XSD");
  const schema = findSchema(doc);
  if (!schema) throw new Error("No xs:schema element found");

  const { globalEls, types } = indexSchema(schema);
  const out = [];

  for (const [nm, el] of globalEls) {
    out.push({ name: nm, kind: "element", abstract: attr(el, "abstract") === "true" });
  }

  // If no global elements, expose global complexTypes as instantiable roots.
  if (out.length === 0) {
    for (const [nm, t] of types) {
      if (isEl(t, "complexType") && attr(t, "abstract") !== "true") {
        out.push({ name: nm, kind: "complexType", abstract: false });
      }
    }
  }

  return out;
}

/** Backward-compat: array of names (concrete first, abstract fallback). */
export function listRootElements(xsdString) {
  const all = listRootEntries(xsdString);
  const concrete = all.filter(e => !e.abstract).map(e => e.name);
  if (concrete.length) return concrete;
  return all.map(e => e.name);
}

/**
 * Generate a single XML document that contains one sample instance of every
 * non-abstract global element in the schema, wrapped in a <XsdSample> container.
 *
 * @param {string}  xsdString
 * @param {object}  options  – same as generateSampleXmlFromXsd, plus:
 *   wrapperTag {string}  name of the container element (default "XsdSample")
 *   maxElements {number} hard limit on how many elements to emit (default 200)
 * @returns {string}
 */
export function generateAllRootsXml(xsdString, options = {}) {
  const {
    wrapperTag       = "XsdSample",
    maxElements      = 200,
    includeOptional  = true,
    maxDepth         = 20,
    indentSpaces     = 2,
    xmlDeclaration   = false,
    maxOccursSamples = 1,
  } = options;

  const doc = new DOMParser().parseFromString(xsdString, "application/xml");
  const pe  = parseErrorText(doc);
  if (pe) throw new Error("XSD parse error: " + pe.slice(0, 300));

  const schema = findSchema(doc);
  if (!schema) throw new Error("No xs:schema element found");

  const idx     = indexSchema(schema);
  const tns     = attr(schema, "targetNamespace");
  const entries = listRootEntries(xsdString).filter(e => !e.abstract);
  if (!entries.length) {
    throw new Error("Schema declares no instantiable global xs:element or xs:complexType");
  }

  const ctx = {
    ...idx,
    indentSize:      indentSpaces,
    maxDepth,
    includeOptional,
    maxOccursSamples,
    expanding:       new Set(),
  };

  const sp   = " ".repeat(indentSpaces);
  const cap  = Math.min(entries.length, maxElements);
  const warn = entries.length > maxElements
    ? `\n${sp}<!-- ${entries.length - maxElements} element(s) omitted — raise maxElements to include them -->`
    : "";

  const children = entries
    .slice(0, cap)
    .map(e => {
      ctx.expanding.clear();
      if (e.kind === "element") {
        const decl = idx.globalEls.get(e.name);
        return emitElement(decl, ctx, 1, e.name).trimEnd();
      }
      const ctNode = idx.types.get(e.name);
      return ctNode ? emitComplexType(e.name, ctNode, [], ctx, 1).trimEnd() : "";
    })
    .filter(Boolean)
    .join("\n");

  const tnsAttr = tns ? ` xmlns="${tns}"` : "";
  let out = `<${wrapperTag}${tnsAttr}>\n${children}${warn}\n</${wrapperTag}>`;

  if (xmlDeclaration) out = '<?xml version="1.0" encoding="UTF-8"?>\n' + out;
  return out + "\n";
}

export function generateSampleXmlFromXsd(xsdString, options = {}) {
  const {
    rootElementName  = null,
    includeOptional  = true,
    maxDepth         = 20,
    indentSpaces     = 2,
    xmlDeclaration   = false,
    maxOccursSamples = 1,   // how many samples to emit for maxOccurs > 1
  } = options;

  const doc = new DOMParser().parseFromString(xsdString, "application/xml");
  const pe = parseErrorText(doc);
  if (pe) throw new Error("XSD parse error: " + pe.slice(0, 300));

  const schema = findSchema(doc);
  if (!schema) throw new Error("No xs:schema element found");

  const idx = indexSchema(schema);
  const entries = listRootEntries(xsdString);
  if (!entries.length) {
    throw new Error("Schema declares no global xs:element and no global xs:complexType — nothing to instantiate");
  }

  const pickName = rootElementName && entries.some(e => e.name === rootElementName)
    ? rootElementName : entries[0].name;
  const pickEntry = entries.find(e => e.name === pickName) || entries[0];

  const tns = attr(schema, "targetNamespace");
  const ctx = {
    ...idx,
    indentSize:     indentSpaces,
    maxDepth,
    includeOptional,
    maxOccursSamples,
    expanding: new Set(),  // cycle guard by type name
  };

  let out;
  if (pickEntry.kind === "element") {
    const rootDecl = idx.globalEls.get(pickEntry.name);
    out = emitElement(rootDecl, ctx, 0, pickEntry.name).trimEnd();
  } else {
    // Synthesize an element wrapper of the same name as the complexType
    const ctNode = idx.types.get(pickEntry.name);
    if (!ctNode) throw new Error(`Type "${pickEntry.name}" not found`);
    out = emitComplexType(pickEntry.name, ctNode, [], ctx, 0).trimEnd();
  }

  // Inject targetNamespace on root open tag
  if (tns && !out.includes("xmlns=")) {
    const gt = out.indexOf(">");
    if (gt !== -1) {
      const sc = out[gt - 1] === "/";
      out = out.slice(0, sc ? gt - 1 : gt) + ` xmlns="${tns}"` + out.slice(sc ? gt - 1 : gt);
    }
  }

  if (xmlDeclaration) out = '<?xml version="1.0" encoding="UTF-8"?>\n' + out;
  return out + "\n";
}

// ─── Indentation ──────────────────────────────────────────────────────────────

function ind(ctx, level) {
  return " ".repeat(Math.max(0, level) * ctx.indentSize);
}

// ─── Attribute handling ───────────────────────────────────────────────────────

/**
 * Recursively collect xs:attribute / xs:attributeGroup from a container node.
 * Returns Array of [name, sampleValue].
 */
function collectAttrs(node, ctx, acc = []) {
  for (const ch of node.children) {
    if (isEl(ch, "attribute")) {
      const nm  = attr(ch, "name");
      const use = attr(ch, "use") || "optional";
      if (!nm || use === "prohibited") continue;
      if (use !== "required" && !ctx.includeOptional) continue;

      const typeQN = attr(ch, "type") || "";
      const loc    = localName(typeQN);
      let val      = "text";

      if (isBuiltin(loc))           val = sampleForBuiltin(loc);
      else if (loc) {
        const st = ctx.types.get(loc);
        val = st && isEl(st, "simpleType")
          ? evalSimpleType(st, ctx)
          : sampleForExtType(loc);
      }

      // inline simpleType
      const inlineSt = firstChild(ch, "simpleType");
      if (inlineSt) val = evalSimpleType(inlineSt, ctx);

      acc.push([nm, val]);

    } else if (isEl(ch, "attributeGroup")) {
      const ref = attr(ch, "ref");
      if (ref) {
        const ag = ctx.attrGroups.get(localName(ref));
        if (ag) collectAttrs(ag, ctx, acc);
      }

    } else if (isEl(ch, "complexContent", "simpleContent")) {
      const inner = firstChild(ch, "extension", "restriction");
      if (inner) collectAttrs(inner, ctx, acc);

    } else if (isEl(ch, "complexType", "extension", "restriction")) {
      collectAttrs(ch, ctx, acc);
    }
  }
  return acc;
}

function attrsToStr(attrs) {
  return attrs
    .map(([n, v]) => ` ${n}="${String(v).replace(/"/g, "&quot;").replace(/</g, "&lt;")}"`)
    .join("");
}

// ─── simpleType evaluation ────────────────────────────────────────────────────

function evalSimpleType(stEl, ctx) {
  const restr = firstChild(stEl, "restriction");
  if (restr) {
    // enumeration — first value wins
    const enums = [...restr.getElementsByTagNameNS(XS, "enumeration")]
      .filter(e => e.parentNode === restr);
    if (enums.length) return attr(enums[0], "value") || "A";
    const base = localName(attr(restr, "base") || "");
    if (base) return sampleForType(base);
  }

  const list = firstChild(stEl, "list");
  if (list) {
    const itemType = localName(attr(list, "itemType") || "");
    const item     = itemType ? sampleForType(itemType) : "text";
    return `${item} ${item}`;
  }

  const union = firstChild(stEl, "union");
  if (union) {
    const members = (attr(union, "memberTypes") || "").split(/\s+/).filter(Boolean);
    if (members.length) return sampleForType(localName(members[0]));
    const firstInline = firstChild(union, "simpleType");
    if (firstInline) return evalSimpleType(firstInline, ctx);
  }

  return "text";
}

// ─── Element emit ─────────────────────────────────────────────────────────────

function emitElement(elDecl, ctx, level, forcedName) {
  if (level > ctx.maxDepth) return `${ind(ctx, level)}<!-- max depth -->\n`;

  // resolve ref
  const ref = attr(elDecl, "ref");
  if (ref) {
    const nm = localName(ref);
    const g  = ctx.globalEls.get(nm);
    return g ? emitElement(g, ctx, level, nm) : `${ind(ctx, level)}<${nm}/>\n`;
  }

  const name = forcedName || attr(elDecl, "name") || "element";

  // abstract elements must not appear in instance unless substituted
  if (!forcedName && attr(elDecl, "abstract") === "true") return "";

  const minO  = parseInt(attr(elDecl, "minOccurs") ?? "1", 10);
  if (minO === 0 && !ctx.includeOptional) return "";

  const maxO  = attr(elDecl, "maxOccurs");
  const times = (maxO && maxO !== "1") ? Math.max(1, ctx.maxOccursSamples) : 1;

  let out = "";
  for (let i = 0; i < times; i++) out += emitElementOnce(elDecl, ctx, level, name);
  return out;
}

function emitElementOnce(elDecl, ctx, level, name) {
  const typeQN  = attr(elDecl, "type");
  const inlineSt = firstChild(elDecl, "simpleType");
  const inlineCt = firstChild(elDecl, "complexType");

  // inline simpleType
  if (inlineSt) {
    return `${ind(ctx, level)}<${name}>${evalSimpleType(inlineSt, ctx)}</${name}>\n`;
  }

  // inline complexType
  if (inlineCt) {
    return emitComplexType(name, inlineCt, [], ctx, level);
  }

  // typed reference
  if (typeQN) {
    const loc = localName(typeQN);
    if (isBuiltin(loc)) {
      return `${ind(ctx, level)}<${name}>${sampleForBuiltin(loc)}</${name}>\n`;
    }
    const typeDef = ctx.types.get(loc);
    if (typeDef) {
      if (isEl(typeDef, "simpleType")) {
        return `${ind(ctx, level)}<${name}>${evalSimpleType(typeDef, ctx)}</${name}>\n`;
      }
      if (isEl(typeDef, "complexType")) {
        return emitComplexType(name, typeDef, [], ctx, level);
      }
    }
    // Unknown external type — use substitutionGroup or name heuristic
    const subLoc = localName(attr(elDecl, "substitutionGroup") || "");
    if (/tuple/i.test(loc) || /tuple/i.test(subLoc)) {
      return `${ind(ctx, level)}<${name}/>\n`;
    }
    const val = sampleForExtType(loc);
    return `${ind(ctx, level)}<${name}>${val}</${name}>\n`;
  }

  // no type at all — use substitutionGroup heuristic or plain text
  const subLoc = localName(attr(elDecl, "substitutionGroup") || "");
  if (/tuple/i.test(subLoc)) return `${ind(ctx, level)}<${name}/>\n`;

  return `${ind(ctx, level)}<${name}>text</${name}>\n`;
}

// ─── complexType emit ─────────────────────────────────────────────────────────

function emitComplexType(tagName, ctEl, extraAttrs, ctx, level) {
  // Cycle guard keyed on tagName (not type name) to allow same type at different tags
  const cycleKey = `${tagName}@${level}`;
  if (ctx.expanding.has(tagName)) {
    return `${ind(ctx, level)}<!-- recursive: ${tagName} -->\n`;
  }
  ctx.expanding.add(tagName);

  let result;
  const scEl = firstChild(ctEl, "simpleContent");
  const ccEl = firstChild(ctEl, "complexContent");

  if (scEl)      result = emitSimpleContent(tagName, scEl, extraAttrs, ctx, level);
  else if (ccEl) result = emitComplexContent(tagName, ccEl, extraAttrs, ctx, level);
  else           result = emitDirectParticle(tagName, ctEl, extraAttrs, ctx, level);

  ctx.expanding.delete(tagName);
  return result;
}

function emitSimpleContent(tagName, scEl, extraAttrs, ctx, level) {
  const inner = firstChild(scEl, "extension", "restriction");
  if (!inner) return `${ind(ctx, level)}<${tagName}/>\n`;

  const base    = localName(attr(inner, "base") || "");
  let textVal   = "text";
  if (base) {
    if (isBuiltin(base)) textVal = sampleForBuiltin(base);
    else {
      const st = ctx.types.get(base);
      textVal = st && isEl(st, "simpleType") ? evalSimpleType(st, ctx) : sampleForExtType(base);
    }
  }

  const attrs = [...extraAttrs, ...collectAttrs(inner, ctx)];
  return `${ind(ctx, level)}<${tagName}${attrsToStr(attrs)}>${textVal}</${tagName}>\n`;
}

function emitComplexContent(tagName, ccEl, extraAttrs, ctx, level) {
  const derived = firstChild(ccEl, "extension") || firstChild(ccEl, "restriction");
  if (!derived) return `${ind(ctx, level)}<${tagName}${attrsToStr(extraAttrs)}/>\n`;

  const base = localName(attr(derived, "base") || "");

  // Expand base type (guard against recursion)
  let baseChildren = "";
  if (base && !ctx.expanding.has(base)) {
    const baseCt = ctx.types.get(base);
    if (baseCt && isEl(baseCt, "complexType")) {
      ctx.expanding.add(base);
      baseChildren = emitParticle(baseCt, ctx, level + 1);
      ctx.expanding.delete(base);
    }
  }

  const ownAttrs  = collectAttrs(derived, ctx);
  const allAttrs  = [...extraAttrs, ...ownAttrs];
  const ownChildren = emitParticle(derived, ctx, level + 1);
  const children  = baseChildren + ownChildren;

  if (!children.trim()) {
    return `${ind(ctx, level)}<${tagName}${attrsToStr(allAttrs)}/>\n`;
  }
  return `${ind(ctx, level)}<${tagName}${attrsToStr(allAttrs)}>\n${children}${ind(ctx, level)}</${tagName}>\n`;
}

function emitDirectParticle(tagName, ctEl, extraAttrs, ctx, level) {
  const ownAttrs = collectAttrs(ctEl, ctx);
  const allAttrs = [...extraAttrs, ...ownAttrs];
  const children = emitParticle(ctEl, ctx, level + 1);

  if (!children.trim()) {
    return `${ind(ctx, level)}<${tagName}${attrsToStr(allAttrs)}/>\n`;
  }
  return `${ind(ctx, level)}<${tagName}${attrsToStr(allAttrs)}>\n${children}${ind(ctx, level)}</${tagName}>\n`;
}

// ─── Particle (sequence / all / choice / group / any) emit ───────────────────

function emitParticle(container, ctx, level) {
  let out = "";
  for (const ch of container.children) {
    if      (isEl(ch, "sequence", "all"))  out += emitParticle(ch, ctx, level);
    else if (isEl(ch, "choice"))            out += emitChoice(ch, ctx, level);
    else if (isEl(ch, "element"))           out += emitElement(ch, ctx, level, null);
    else if (isEl(ch, "group"))             out += emitGroupRef(ch, ctx, level);
    else if (isEl(ch, "any")) {
      if (ctx.includeOptional || (attr(ch, "minOccurs") || "1") !== "0") {
        out += `${ind(ctx, level)}<!-- xs:any placeholder -->\n`;
      }
    }
    // xs:attribute, xs:attributeGroup, xs:simpleContent, xs:complexContent
    // are handled at the complexType level — skip here
  }
  return out;
}

function emitChoice(choiceEl, ctx, level) {
  const minO = parseInt(attr(choiceEl, "minOccurs") ?? "1", 10);
  if (minO === 0 && !ctx.includeOptional) return "";

  // Emit the first concrete (non-abstract) branch
  for (const ch of choiceEl.children) {
    if (isEl(ch, "element")) {
      const ref  = attr(ch, "ref");
      const nm   = ref ? localName(ref) : attr(ch, "name");
      const decl = ref ? (ctx.globalEls.get(nm) || ch) : ch;
      if (attr(decl, "abstract") === "true") continue;
      return emitElement(decl, ctx, level, nm);
    }
    if (isEl(ch, "sequence")) return emitParticle(ch, ctx, level);
    if (isEl(ch, "group"))    return emitGroupRef(ch, ctx, level);
  }
  return "";
}

function emitGroupRef(groupRefEl, ctx, level) {
  const ref  = attr(groupRefEl, "ref");
  if (!ref)  return "";
  const minO = parseInt(attr(groupRefEl, "minOccurs") ?? "1", 10);
  if (minO === 0 && !ctx.includeOptional) return "";
  const grp  = ctx.groups.get(localName(ref));
  if (!grp)  return `${ind(ctx, level)}<!-- group: ${ref} -->\n`;
  const particle = firstChild(grp, "sequence", "all", "choice");
  return particle ? emitParticle(particle, ctx, level) : "";
}
