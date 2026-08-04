const WORD_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const STRICT_WORD_NAMESPACE = "http://purl.oclc.org/ooxml/wordprocessingml/main";
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
const SUPPORTED_PART = /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/i;
const CLASSIC_PAGE_WIDTH = 11906;
const CLASSIC_CONTENT_WIDTH = 9355;

function elements(node, localName) {
  return Array.from(node?.getElementsByTagNameNS?.("*", localName) || []);
}

function directChildren(node, localName) {
  return Array.from(node?.childNodes || []).filter((child) => child.nodeType === 1 && (!localName || child.localName === localName));
}

function wordAttribute(node, name) {
  for (const namespace of [WORD_NAMESPACE, STRICT_WORD_NAMESPACE]) {
    const value = node?.getAttributeNS?.(namespace, name);
    if (value) return value;
  }
  const prefixed = node?.getAttribute?.(`w:${name}`) || node?.getAttribute?.(name);
  if (prefixed) return prefixed;
  return Array.from(node?.attributes || []).find((attribute) => attribute.localName === name)?.value || "";
}

function firstDescendant(node, localName) {
  return elements(node, localName)[0] || null;
}

export function wordLengthToTwips(value) {
  const source = String(value ?? "").trim().toLowerCase();
  if (!source) return 0;
  const numeric = Number.parseFloat(source);
  if (!Number.isFinite(numeric)) return 0;
  if (source.endsWith("pt")) return numeric * 20;
  if (source.endsWith("in")) return numeric * 1440;
  if (source.endsWith("cm")) return numeric * 1440 / 2.54;
  if (source.endsWith("mm")) return numeric * 1440 / 25.4;
  if (source.endsWith("pc")) return numeric * 240;
  if (source.endsWith("px")) return numeric * 15;
  return numeric;
}

function wordFontSizeToPt(value) {
  const source = String(value ?? "").trim().toLowerCase();
  if (!source) return null;
  const numeric = Number.parseFloat(source);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return source.endsWith("pt") ? numeric : numeric / 2;
}

function readRunStyle(run) {
  const properties = directChildren(run, "rPr")[0] || firstDescendant(run, "rPr");
  const sizePt = wordFontSizeToPt(wordAttribute(firstDescendant(properties, "sz"), "val"));
  return {
    bold: Boolean(firstDescendant(properties, "b")),
    italic: Boolean(firstDescendant(properties, "i")),
    underline: Boolean(firstDescendant(properties, "u")),
    strike: Boolean(firstDescendant(properties, "strike")),
    sizePt,
    color: wordAttribute(firstDescendant(properties, "color"), "val") || null,
    highlight: wordAttribute(firstDescendant(properties, "highlight"), "val") || null
  };
}

function readParagraphStyle(paragraph) {
  const properties = directChildren(paragraph, "pPr")[0] || null;
  const indentation = firstDescendant(properties, "ind");
  const spacing = firstDescendant(properties, "spacing");
  return {
    styleId: wordAttribute(firstDescendant(properties, "pStyle"), "val") || "",
    alignment: wordAttribute(firstDescendant(properties, "jc"), "val") || "",
    leftTwips: wordLengthToTwips(wordAttribute(indentation, "left") || wordAttribute(indentation, "start")),
    rightTwips: wordLengthToTwips(wordAttribute(indentation, "right") || wordAttribute(indentation, "end")),
    firstLineTwips: wordLengthToTwips(wordAttribute(indentation, "firstLine")),
    hangingTwips: wordLengthToTwips(wordAttribute(indentation, "hanging")),
    beforeTwips: wordLengthToTwips(wordAttribute(spacing, "before")),
    afterTwips: wordLengthToTwips(wordAttribute(spacing, "after")),
    lineTwips: wordLengthToTwips(wordAttribute(spacing, "line")),
    lineRule: wordAttribute(spacing, "lineRule") || "auto",
    numbered: Boolean(firstDescendant(properties, "numPr"))
  };
}

function contentValue(node) {
  if (node.localName === "tab") return "\t";
  if (node.localName === "br" || node.localName === "cr") return "\n";
  return node.textContent || "";
}

function documentTextNodes(paragraph) {
  // instrText contains Word field commands such as PAGE \\* MERGEFORMAT.
  // They are not visible document text; the cached w:t result remains visible.
  return ["t", "delText", "tab", "br", "cr"]
    .flatMap((localName) => elements(paragraph, localName))
    .sort((left, right) => {
      if (left === right) return 0;
      return left.compareDocumentPosition(right) & 2 ? 1 : -1;
    });
}

function readTableStyle(table) {
  const properties = directChildren(table, "tblPr")[0] || null;
  const width = firstDescendant(properties, "tblW");
  const widthType = wordAttribute(width, "type") || "auto";
  const rawWidth = wordAttribute(width, "w");
  const borders = firstDescendant(properties, "tblBorders");
  const grid = directChildren(firstDescendant(table, "tblGrid"), "gridCol")
    .map((column) => wordLengthToTwips(wordAttribute(column, "w")))
    .filter((column) => column > 0);
  return {
    widthTwips: widthType === "dxa" || /(?:pt|in|cm|mm|pc|px)$/iu.test(rawWidth) ? wordLengthToTwips(rawWidth) : 0,
    widthPercent: widthType === "pct" ? Number(rawWidth) / 50 : 0,
    layout: wordAttribute(firstDescendant(properties, "tblLayout"), "type") || "auto",
    alignment: wordAttribute(firstDescendant(properties, "jc"), "val") || "left",
    bordered: Boolean(borders && directChildren(borders).length),
    grid
  };
}

function readCellStyle(cell) {
  const properties = directChildren(cell, "tcPr")[0] || null;
  const width = firstDescendant(properties, "tcW");
  const merge = firstDescendant(properties, "vMerge");
  return {
    colSpan: Math.max(1, Number(wordAttribute(firstDescendant(properties, "gridSpan"), "val")) || 1),
    widthTwips: wordLengthToTwips(wordAttribute(width, "w")),
    vMerge: merge ? (wordAttribute(merge, "val") || "continue") : null,
    verticalAlign: wordAttribute(firstDescendant(properties, "vAlign"), "val") || "top"
  };
}

function readTableBlock(table, paragraphByNode) {
  const rows = directChildren(table, "tr").map((row) => {
    let gridStart = 0;
    const cells = directChildren(row, "tc").map((cell) => {
      const style = readCellStyle(cell);
      const result = {
        ...style,
        gridStart,
        rowSpan: 1,
        hidden: false,
        paragraphs: elements(cell, "p")
          .filter((paragraph) => closestAncestor(paragraph, "tc", table) === cell)
          .map((paragraph) => paragraphByNode.get(paragraph))
          .filter(Boolean)
      };
      gridStart += style.colSpan;
      return result;
    });
    return { cells };
  });

  rows.forEach((row, rowIndex) => {
    row.cells.forEach((cell) => {
      if (cell.vMerge !== "restart") return;
      for (let nextIndex = rowIndex + 1; nextIndex < rows.length; nextIndex += 1) {
        const continuation = rows[nextIndex].cells.find((candidate) => candidate.gridStart === cell.gridStart);
        if (!continuation || continuation.vMerge !== "continue") break;
        continuation.hidden = true;
        cell.rowSpan += 1;
      }
    });
  });

  return { type: "table", rows, style: readTableStyle(table) };
}

function closestRun(node, paragraph) {
  let current = node.parentElement;
  while (current && current !== paragraph) {
    if (current.localName === "r") return current;
    current = current.parentElement;
  }
  return null;
}

function closestAncestor(node, localName, boundary = null) {
  let current = node?.parentElement;
  while (current && current !== boundary) {
    if (current.localName === localName) return current;
    current = current.parentElement;
  }
  return null;
}

function buildStructuralBlocks(document, paragraphByNode) {
  const body = firstDescendant(document, "body");
  if (!body) return [];
  const collect = (container) => {
    const blocks = [];
    directChildren(container).forEach((child) => {
      if (child.localName === "p") {
        const paragraph = paragraphByNode.get(child);
        if (paragraph) blocks.push({ type: "paragraph", paragraph });
        return;
      }
      if (child.localName === "tbl") {
        blocks.push(readTableBlock(child, paragraphByNode));
        return;
      }
      blocks.push(...collect(child));
    });
    return blocks;
  };
  return collect(body);
}

function parsePart(name, xmlText, DOMParserCtor) {
  const document = new DOMParserCtor().parseFromString(xmlText, "application/xml");
  if (document.getElementsByTagName("parsererror").length) throw new Error("DOCX_PARSE");
  return { name, document, originalXml: xmlText, paragraphs: [], blocks: [] };
}

export function parseDocxPackage(bytes, fflate, DOMParserCtor = globalThis.DOMParser) {
  if (!fflate?.unzipSync || !fflate?.strFromU8 || !DOMParserCtor) throw new Error("DOCX_LIBRARY");
  const originalBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const archive = fflate.unzipSync(originalBytes);
  const orderedNames = [
    "word/document.xml",
    ...Object.keys(archive).filter((name) => /^word\/header\d+\.xml$/i.test(name)).sort(),
    ...Object.keys(archive).filter((name) => /^word\/footer\d+\.xml$/i.test(name)).sort(),
    "word/footnotes.xml",
    "word/endnotes.xml",
    "word/comments.xml"
  ].filter((name, index, names) => archive[name] && names.indexOf(name) === index && SUPPORTED_PART.test(name));
  if (!orderedNames.length) throw new Error("DOCX_STRUCTURE");

  const parts = orderedNames.map((name) => parsePart(name, fflate.strFromU8(archive[name]), DOMParserCtor));
  const textChunks = [];
  const segments = [];
  let cursor = 0;
  let populatedPartCount = 0;

  parts.forEach((part) => {
    const paragraphByNode = new Map();
    let populatedParagraphCount = 0;
    elements(part.document, "p").forEach((paragraphNode, paragraphIndex) => {
      const contentNodes = documentTextNodes(paragraphNode);
      const paragraphText = contentNodes.map(contentValue).join("");
      const paragraph = {
        partName: part.name,
        paragraphIndex,
        node: paragraphNode,
        text: paragraphText,
        start: cursor,
        end: cursor,
        style: readParagraphStyle(paragraphNode),
        runs: []
      };

      if (paragraphText.trim()) {
        if (populatedPartCount > 0 && populatedParagraphCount === 0) {
          textChunks.push("\n\n");
          cursor += 2;
        } else if (populatedParagraphCount > 0) {
          textChunks.push("\n");
          cursor += 1;
        }
        paragraph.start = cursor;
        const runStyles = new Map();
        contentNodes.forEach((node, nodeIndex) => {
          const value = contentValue(node);
          const run = closestRun(node, paragraphNode);
          if (run && !runStyles.has(run)) runStyles.set(run, readRunStyle(run));
          const segment = {
            partName: part.name,
            paragraphIndex,
            nodeIndex,
            node,
            kind: node.localName,
            text: value,
            start: cursor,
            end: cursor + value.length,
            style: run ? runStyles.get(run) : {}
          };
          segments.push(segment);
          paragraph.runs.push(segment);
          textChunks.push(value);
          cursor += value.length;
        });
        paragraph.end = cursor;
        populatedParagraphCount += 1;
      }
      part.paragraphs.push(paragraph);
      paragraphByNode.set(paragraphNode, paragraph);
    });
    if (populatedParagraphCount > 0) populatedPartCount += 1;
    part.blocks = part.name === "word/document.xml"
      ? buildStructuralBlocks(part.document, paragraphByNode)
      : part.paragraphs.map((paragraph) => ({ type: "paragraph", paragraph }));
  });

  const text = textChunks.join("");
  if (!text.trim()) throw new Error("EMPTY_DOCUMENT");
  const mediaCount = Object.keys(archive).filter((name) => /^word\/media\//iu.test(name)).length;
  return { originalBytes, archive, parts, segments, text, mediaCount };
}

function setTextNode(node, value) {
  node.textContent = value;
  if (node.localName === "t") {
    if (/^\s|\s$/u.test(value)) node.setAttributeNS(XML_NAMESPACE, "xml:space", "preserve");
    else node.removeAttributeNS(XML_NAMESPACE, "space");
  }
}

function applyReplacement(model, replacement) {
  const affected = model.segments.filter((segment) => segment.start < replacement.end && replacement.start < segment.end);
  if (!affected.length) return false;
  const first = affected[0];
  const last = affected[affected.length - 1];
  const replacementText = String(replacement.replacement ?? replacement.token ?? "");
  if (first === last && first.kind === "t") {
    const value = first.node.textContent || "";
    setTextNode(first.node, value.slice(0, replacement.start - first.start) + replacementText + value.slice(replacement.end - first.start));
    return true;
  }

  affected.forEach((segment, index) => {
    if (segment.kind !== "t") {
      segment.node.parentNode?.removeChild(segment.node);
      return;
    }
    const value = segment.node.textContent || "";
    if (index === 0) {
      const prefix = value.slice(0, Math.max(0, replacement.start - segment.start));
      setTextNode(segment.node, prefix + replacementText);
    } else if (index === affected.length - 1) {
      const suffix = value.slice(Math.max(0, replacement.end - segment.start));
      setTextNode(segment.node, suffix);
    } else {
      setTextNode(segment.node, "");
    }
  });
  return true;
}

function scrubWordMetadata(document) {
  Array.from(document.getElementsByTagName("*")).forEach((element) => {
    Array.from(element.attributes || []).forEach((attribute) => {
      if (!/wordprocessingml/iu.test(attribute.namespaceURI || "")) return;
      const qualifiedName = `${attribute.prefix || "w"}:${attribute.localName}`;
      if (attribute.localName === "author") element.setAttributeNS(attribute.namespaceURI, qualifiedName, "Скрыто");
      if (attribute.localName === "initials") element.setAttributeNS(attribute.namespaceURI, qualifiedName, "");
    });
  });
}

function scrubPropertyFile(archive, name, localNames, fflate, DOMParserCtor, XMLSerializerCtor) {
  if (!archive[name]) return;
  const document = new DOMParserCtor().parseFromString(fflate.strFromU8(archive[name]), "application/xml");
  if (document.getElementsByTagName("parsererror").length) return;
  localNames.forEach((localName) => {
    elements(document, localName).forEach((node) => { node.textContent = ""; });
  });
  archive[name] = fflate.strToU8(new XMLSerializerCtor().serializeToString(document));
}

function createModifiedDocx(model, replacements, fflate, DOMParserCtor, XMLSerializerCtor) {
  if (!model?.originalBytes || !fflate?.zipSync || !fflate?.strToU8 || !XMLSerializerCtor) throw new Error("DOCX_LIBRARY");
  const fresh = parseDocxPackage(model.originalBytes, fflate, DOMParserCtor);
  const skipped = [];
  [...(replacements || [])].sort((left, right) => right.start - left.start).forEach((replacement) => {
    if (!applyReplacement(fresh, replacement)) skipped.push(replacement);
  });
  const archive = { ...fresh.archive };
  const serializer = new XMLSerializerCtor();
  fresh.parts.forEach((part) => {
    scrubWordMetadata(part.document);
    archive[part.name] = fflate.strToU8(serializer.serializeToString(part.document));
  });
  scrubPropertyFile(archive, "docProps/core.xml", ["creator", "lastModifiedBy", "lastPrinted"], fflate, DOMParserCtor, XMLSerializerCtor);
  scrubPropertyFile(archive, "docProps/app.xml", ["Manager", "Company"], fflate, DOMParserCtor, XMLSerializerCtor);
  scrubPropertyFile(archive, "docProps/custom.xml", ["lpwstr", "lpstr", "bstr"], fflate, DOMParserCtor, XMLSerializerCtor);
  return { bytes: fflate.zipSync(archive, { level: 6 }), skipped };
}

export function createAnonymizedDocx(model, replacements, fflate, DOMParserCtor = globalThis.DOMParser, XMLSerializerCtor = globalThis.XMLSerializer) {
  return createModifiedDocx(model, replacements, fflate, DOMParserCtor, XMLSerializerCtor);
}

export function createRestoredDocx(model, replacements, fflate, DOMParserCtor = globalThis.DOMParser, XMLSerializerCtor = globalThis.XMLSerializer) {
  return createModifiedDocx(model, replacements, fflate, DOMParserCtor, XMLSerializerCtor);
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function markdownTableCells(line) {
  return String(line || "").trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((cell) => cell.trim());
}

function isMarkdownTableLine(line) {
  return /^\s*\|.+\|\s*$/u.test(line || "");
}

function isMarkdownTableSeparator(line) {
  const cells = markdownTableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
}

export function parseClassicDocument(input) {
  const lines = String(input || "").replace(/\r\n?/gu, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  const flushParagraph = () => {
    const text = paragraph.join(" ").replace(/\s+/gu, " ").trim();
    if (text) blocks.push({ type: "paragraph", text });
    paragraph = [];
  };

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      index += 1;
      continue;
    }
    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/u);
    if (heading) {
      flushParagraph();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
      index += 1;
      continue;
    }
    const list = trimmed.match(/^([-*•]|\d+[.)])\s+(.+)$/u);
    if (list) {
      flushParagraph();
      blocks.push({ type: "list", ordered: /^\d/u.test(list[1]), text: list[2].trim() });
      index += 1;
      continue;
    }
    if (isMarkdownTableLine(line) && isMarkdownTableSeparator(lines[index + 1])) {
      flushParagraph();
      const rows = [markdownTableCells(line)];
      index += 2;
      while (index < lines.length && isMarkdownTableLine(lines[index])) {
        rows.push(markdownTableCells(lines[index]));
        index += 1;
      }
      blocks.push({ type: "table", rows });
      continue;
    }
    paragraph.push(trimmed);
    index += 1;
  }
  flushParagraph();
  return blocks;
}

function classicRunXml(text, options = {}) {
  const properties = options.bold ? "<w:rPr><w:b/></w:rPr>" : "";
  return `<w:r>${properties}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

function classicParagraphXml(block) {
  if (block.type === "heading") {
    const style = block.level === 1 ? "Heading1" : "Heading2";
    return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${classicRunXml(block.text)}</w:p>`;
  }
  if (block.type === "list") {
    const numId = block.ordered ? 2 : 1;
    return `<w:p><w:pPr><w:pStyle w:val="ListText"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>${classicRunXml(block.text)}</w:p>`;
  }
  return `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr>${classicRunXml(block.text)}</w:p>`;
}

function classicTableXml(block) {
  const columnCount = Math.max(1, ...block.rows.map((row) => row.length));
  const baseWidth = Math.floor(CLASSIC_CONTENT_WIDTH / columnCount);
  const widths = Array.from({ length: columnCount }, (_, index) => index === columnCount - 1
    ? CLASSIC_CONTENT_WIDTH - baseWidth * (columnCount - 1)
    : baseWidth);
  const grid = widths.map((width) => `<w:gridCol w:w="${width}"/>`).join("");
  const rows = block.rows.map((row, rowIndex) => {
    const cells = widths.map((width, columnIndex) => {
      const text = row[columnIndex] || "";
      const run = classicRunXml(text, { bold: rowIndex === 0 });
      return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:pStyle w:val="TableText"/></w:pPr>${run}</w:p></w:tc>`;
    }).join("");
    return `<w:tr>${cells}</w:tr>`;
  }).join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="${CLASSIC_CONTENT_WIDTH}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="808080"/><w:left w:val="single" w:sz="4" w:color="808080"/><w:bottom w:val="single" w:sz="4" w:color="808080"/><w:right w:val="single" w:sz="4" w:color="808080"/><w:insideH w:val="single" w:sz="4" w:color="B0B0B0"/><w:insideV w:val="single" w:sz="4" w:color="B0B0B0"/></w:tblBorders><w:tblCellMar><w:top w:w="90" w:type="dxa"/><w:left w:w="110" w:type="dxa"/><w:bottom w:w="90" w:type="dxa"/><w:right w:w="110" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows}</w:tbl>`;
}

function classicStylesXml() {
  const fonts = '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Times New Roman" w:cs="Times New Roman"/>';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${WORD_NAMESPACE}"><w:docDefaults><w:rPrDefault><w:rPr>${fonts}<w:sz w:val="28"/><w:szCs w:val="28"/><w:lang w:val="ru-RU"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:line="360" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Обычный"/><w:pPr><w:spacing w:after="0" w:line="360" w:lineRule="auto"/><w:ind w:firstLine="708"/><w:jc w:val="both"/></w:pPr><w:rPr>${fonts}<w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Заголовок 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:ind w:firstLine="0"/><w:jc w:val="center"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr>${fonts}<w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="Заголовок 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="180" w:after="90"/><w:ind w:firstLine="0"/><w:jc w:val="left"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr>${fonts}<w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListText"><w:name w:val="Текст списка"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="360" w:lineRule="auto"/><w:ind w:left="708" w:hanging="360"/><w:jc w:val="both"/></w:pPr><w:rPr>${fonts}<w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Текст таблицы"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="280" w:lineRule="auto"/><w:ind w:firstLine="0"/><w:jc w:val="left"/></w:pPr><w:rPr>${fonts}<w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style></w:styles>`;
}

function classicNumberingXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="${WORD_NAMESPACE}"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="708"/></w:tabs><w:ind w:left="708" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/></w:rPr></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="708"/></w:tabs><w:ind w:left="708" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
}

export function createClassicDocx(input, fflate) {
  if (!fflate?.zipSync || !fflate?.strToU8) throw new Error("DOCX_LIBRARY");
  const blocks = parseClassicDocument(input);
  const body = blocks.map((block) => block.type === "table" ? classicTableXml(block) : classicParagraphXml(block)).join("");
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${WORD_NAMESPACE}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}<w:sectPr><w:footerReference w:type="default" r:id="rId4"/><w:pgSz w:w="${CLASSIC_PAGE_WIDTH}" w:h="16838"/><w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1701" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const footerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="${WORD_NAMESPACE}"><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`;
  const createdAt = new Date().toISOString();
  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
    "word/document.xml": documentXml,
    "word/styles.xml": classicStylesXml(),
    "word/numbering.xml": classicNumberingXml(),
    "word/settings.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="${WORD_NAMESPACE}"><w:defaultTabStop w:val="708"/><w:compat/></w:settings>`,
    "word/footer1.xml": footerXml,
    "word/_rels/document.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`,
    "docProps/core.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Восстановленный документ</dc:title><dc:creator>Анонимайзер МИК</dc:creator><cp:lastModifiedBy>Анонимайзер МИК</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${createdAt}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${createdAt}</dcterms:modified></cp:coreProperties>`,
    "docProps/app.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Анонимайзер МИК</Application><Company></Company></Properties>`
  };
  const archive = Object.fromEntries(Object.entries(files).map(([name, content]) => [name, fflate.strToU8(content)]));
  return { bytes: fflate.zipSync(archive, { level: 6 }), blocks };
}

export function locateDocxRange(model, start, end) {
  const affected = (model?.segments || []).filter((segment) => segment.start < end && start < segment.end);
  if (!affected.length) return null;
  return {
    part: affected[0].partName,
    paragraphStart: affected[0].paragraphIndex,
    paragraphEnd: affected[affected.length - 1].paragraphIndex,
    nodeStart: affected[0].nodeIndex,
    nodeEnd: affected[affected.length - 1].nodeIndex
  };
}
