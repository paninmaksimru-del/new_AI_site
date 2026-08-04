import test from "node:test";
import assert from "node:assert/strict";
import {
  createClassicDocx,
  parseClassicDocument,
  wordLengthToTwips
} from "../public/anonymizer-docx.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const fakeFflate = {
  strToU8(value) { return encoder.encode(value); },
  zipSync(archive) { return archive; }
};

test("Strict OOXML размеры переводятся в twips", () => {
  assert.equal(wordLengthToTwips("12pt"), 240);
  assert.equal(Math.round(wordLengthToTwips("1.25cm")), 709);
  assert.equal(wordLengthToTwips("1440"), 1440);
});

test("классический документ понимает заголовки, списки и Markdown-таблицы", () => {
  const blocks = parseClassicDocument("# Отчёт\n\nВводный абзац.\n\n1. Первый пункт\n- Второй пункт\n\n| Имя | Значение |\n| --- | --- |\n| А | Б |");
  assert.deepEqual(blocks.map((block) => block.type), ["heading", "paragraph", "list", "list", "table"]);
  assert.equal(blocks.at(-1).rows.length, 2);
});

test("новый Word получает классическое офисное оформление и точную геометрию", () => {
  const created = createClassicDocx("# Документ\n\nПервый абзац.\n\n| Поле | Значение |\n| --- | --- |\n| ФИО | Иванов |", fakeFflate);
  const documentXml = decoder.decode(created.bytes["word/document.xml"]);
  const stylesXml = decoder.decode(created.bytes["word/styles.xml"]);
  const numberingXml = decoder.decode(created.bytes["word/numbering.xml"]);
  assert.match(documentXml, /w:pgSz w:w="11906" w:h="16838"/);
  assert.match(documentXml, /w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1701"/);
  assert.match(documentXml, /w:tblW w:w="9355" w:type="dxa"/);
  assert.match(stylesXml, /Times New Roman/);
  assert.match(stylesXml, /w:sz w:val="28"/);
  assert.match(stylesXml, /w:ind w:firstLine="708"/);
  assert.match(stylesXml, /w:spacing w:line="360" w:lineRule="auto"/);
  assert.match(numberingXml, /w:numFmt w:val="bullet"/);
  assert.match(numberingXml, /w:numFmt w:val="decimal"/);
  assert.ok(created.bytes["word/footer1.xml"]);
});
