/**
 * Minimal, deterministic Office Open XML writers (Word, Excel, PowerPoint)
 * for the document bench. They write the parts a user's text can live in,
 * the way Office lays them out: body and tables, headers and footers,
 * footnotes and endnotes, comments, tracked deletions, text boxes, runs
 * split mid-word, hidden and "very hidden" sheets, formula results, cell
 * comments, sheet headers, slides (hidden ones too), slide tables, speaker
 * notes, document properties (core, app, custom), embedded packages and a
 * macro project. No timestamps or random ids: the same spec gives the same
 * bytes.
 */
import { writeZip, type ZipInput } from "./zip.ts";

export const xmlEscape = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";

export interface DocProperties {
  title?: string;
  subject?: string;
  creator?: string;
  keywords?: string;
  description?: string;
  lastModifiedBy?: string;
  company?: string;
  manager?: string;
  /** Custom properties (File › Properties › Custom). */
  custom?: Array<[string, string]>;
}

export interface Embedded {
  /** File name inside the embeddings folder, with its extension (`.xlsx`, `.docx`, `.pdf`, `.bin`). */
  name: string;
  bytes: Uint8Array;
}

/** A body block: a paragraph (lines become paragraphs) or a table. */
export type Block = { type: "p"; text: string } | { type: "table"; rows: string[][] };

// ------------------------------------------------------------ shared parts

function coreXml(p: DocProperties): string {
  const el = (tag: string, v?: string) => (v ? `<${tag}>${xmlEscape(v)}</${tag}>` : "");
  return `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${el("dc:title", p.title)}${el("dc:subject", p.subject)}${el("dc:creator", p.creator ?? "Bench Writer")}${el("cp:keywords", p.keywords)}${el("dc:description", p.description)}${el("cp:lastModifiedBy", p.lastModifiedBy ?? "Bench Writer")}<cp:revision>1</cp:revision><dcterms:created xsi:type="dcterms:W3CDTF">2026-01-02T10:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-01-02T10:00:00Z</dcterms:modified></cp:coreProperties>`;
}
function appXml(p: DocProperties, app: string): string {
  return `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>${app}</Application>${p.company ? `<Company>${xmlEscape(p.company)}</Company>` : ""}${p.manager ? `<Manager>${xmlEscape(p.manager)}</Manager>` : ""}<AppVersion>16.0000</AppVersion></Properties>`;
}
function customXml(custom: Array<[string, string]>): string {
  return `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">${custom
    .map(([name, value], i) => `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="${i + 2}" name="${xmlEscape(name)}"><vt:lpwstr>${xmlEscape(value)}</vt:lpwstr></property>`)
    .join("")}</Properties>`;
}
function rels(list: Array<[id: string, type: string, target: string, external?: boolean]>): string {
  return `${XML}<Relationships xmlns="${PKG_REL}">${list.map(([id, type, target, external]) => `<Relationship Id="${id}" Type="${type.startsWith("http") ? type : `${REL}/${type}`}" Target="${xmlEscape(target)}"${external ? ' TargetMode="External"' : ""}/>`).join("")}</Relationships>`;
}
function contentTypes(defaults: Array<[string, string]>, overrides: Array<[string, string]>): string {
  return `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${defaults
    .map(([ext, type]) => `<Default Extension="${ext}" ContentType="${type}"/>`)
    .join("")}${overrides.map(([part, type]) => `<Override PartName="/${part}" ContentType="${type}"/>`).join("")}</Types>`;
}
const EMBED_TYPES: Record<string, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
  bin: "application/vnd.openxmlformats-officedocument.oleObject",
};

/** Root parts every package shares: content types, root rels, properties. */
function packageRoot(main: string, mainType: string, p: DocProperties, app: string, overrides: Array<[string, string]>, defaults: Array<[string, string]>): ZipInput[] {
  const rootRels: Array<[string, string, string]> = [
    ["rId1", "officeDocument", main],
    ["rId2", "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", "docProps/core.xml"],
    ["rId3", "extended-properties", "docProps/app.xml"],
  ];
  const ov: Array<[string, string]> = [
    [main, mainType],
    ["docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml"],
    ["docProps/app.xml", "application/vnd.openxmlformats-officedocument.extended-properties+xml"],
    ...overrides,
  ];
  const out: ZipInput[] = [];
  if (p.custom?.length) {
    rootRels.push(["rId4", "custom-properties", "docProps/custom.xml"]);
    ov.push(["docProps/custom.xml", "application/vnd.openxmlformats-officedocument.custom-properties+xml"]);
    out.push({ name: "docProps/custom.xml", data: customXml(p.custom) });
  }
  return [
    { name: "[Content_Types].xml", data: contentTypes(defaults, ov) },
    { name: "_rels/.rels", data: rels(rootRels) },
    { name: "docProps/core.xml", data: coreXml(p) },
    { name: "docProps/app.xml", data: appXml(p, app) },
    ...out,
  ];
}

// ------------------------------------------------------------ Word

export interface WordSpec {
  /** First paragraph (it carries the comment anchors and note references). */
  title?: string;
  body: Block[];
  header?: string[];
  footer?: string[];
  footnotes?: string[];
  endnotes?: string[];
  /** Comments, anchored on the first body paragraph. */
  comments?: string[];
  /** Paragraphs inserted as tracked deletions (still in the file, struck through in Word). */
  deletions?: string[];
  /** Paragraphs inside a floating text box (DrawingML with a VML fallback, as Word saves it). */
  textBoxes?: string[];
  /** Hyperlinks: the shown text, and the target (a `mailto:` address, a URL with a token...). */
  links?: Array<{ text: string; target: string }>;
  /** Paragraphs whose text is split into runs every few characters (formatting / revision ids). */
  splitRuns?: string[];
  properties?: DocProperties;
  embedded?: Embedded[];
  /** Adds an (empty) VBA project: a .docm. */
  macros?: boolean;
}

const run = (text: string, props = "") => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
const para = (text: string, extra = "") => `<w:p>${extra}${text ? run(text) : ""}</w:p>`;
const paras = (text: string) => text.split("\n").map((line) => para(line)).join("");
function wordBlocks(blocks: Block[]): string {
  return blocks
    .map((b) =>
      b.type === "p"
        ? paras(b.text)
        : `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr>${b.rows
            .map((row) => `<w:tr>${row.map((cell) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${paras(cell || " ")}</w:tc>`).join("")}</w:tr>`)
            .join("")}</w:tbl><w:p/>`,
    )
    .join("");
}

/** Splits text into runs of 3-7 characters with alternating formatting, like Word's revision-id runs. */
function splitRunsXml(text: string): string {
  let out = "";
  let i = 0;
  let n = 0;
  while (i < text.length) {
    const len = 3 + (n % 5);
    out += run(text.slice(i, i + len), n % 2 ? '<w:rFonts w:ascii="Calibri"/>' : "<w:noProof/>");
    i += len;
    n++;
  }
  return `<w:p>${out}</w:p>`;
}

export function writeDocx(spec: WordSpec): Uint8Array {
  const p = spec.properties ?? {};
  const relList: Array<[string, string, string, boolean?]> = [["rId1", "styles", "styles.xml"], ["rId2", "settings", "settings.xml"]];
  const overrides: Array<[string, string]> = [
    ["word/styles.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"],
    ["word/settings.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"],
  ];
  const parts: ZipInput[] = [];
  let sect = "";
  const addPart = (file: string, type: string, ct: string, xml: string) => {
    const id = `rId${relList.length + 1}`;
    relList.push([id, type, file]);
    overrides.push([`word/${file}`, ct]);
    parts.push({ name: `word/${file}`, data: xml });
    return id;
  };
  if (spec.header?.length)
    sect += `<w:headerReference w:type="default" r:id="${addPart("header1.xml", "header", "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml", `${XML}<w:hdr ${W}>${spec.header.map((l) => para(l)).join("")}</w:hdr>`)}"/>`;
  if (spec.footer?.length)
    sect += `<w:footerReference w:type="default" r:id="${addPart("footer1.xml", "footer", "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml", `${XML}<w:ftr ${W}>${spec.footer.map((l) => para(l)).join("")}</w:ftr>`)}"/>`;
  const notes = (kind: "footnote" | "endnote", list: string[]) =>
    `${XML}<w:${kind}s ${W}><w:${kind} w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:${kind}><w:${kind} w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:${kind}>${list
      .map((t, i) => `<w:${kind} w:id="${i + 1}"><w:p><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:${kind}Ref/></w:r>${run(` ${t}`)}</w:p></w:${kind}>`)
      .join("")}</w:${kind}s>`;
  if (spec.footnotes?.length) addPart("footnotes.xml", "footnotes", "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml", notes("footnote", spec.footnotes));
  if (spec.endnotes?.length) addPart("endnotes.xml", "endnotes", "application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml", notes("endnote", spec.endnotes));
  if (spec.comments?.length)
    addPart(
      "comments.xml",
      "comments",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml",
      `${XML}<w:comments ${W}>${spec.comments.map((t, i) => `<w:comment w:id="${i}" w:author="Reviewer" w:date="2026-01-02T10:00:00Z" w:initials="R">${paras(t)}</w:comment>`).join("")}</w:comments>`,
    );
  const embedRefs: string[] = [];
  const defaults: Array<[string, string]> = [];
  for (const [i, e] of (spec.embedded ?? []).entries()) {
    const ext = e.name.split(".").pop()!.toLowerCase();
    const id = `rId${relList.length + 1}`;
    relList.push([id, ext === "bin" ? "oleObject" : "package", `embeddings/${e.name}`]);
    if (!defaults.some(([x]) => x === ext)) defaults.push([ext, EMBED_TYPES[ext] ?? "application/octet-stream"]);
    parts.push({ name: `word/embeddings/${e.name}`, data: e.bytes });
    embedRefs.push(`<w:p><w:r><w:object><o:OLEObject xmlns:o="urn:schemas-microsoft-com:office:office" Type="Embed" ProgID="Package" ShapeID="_x0000_i10${i}" DrawAspect="Icon" ObjectID="_10${i}" r:id="${id}"/></w:object></w:r></w:p>`);
  }
  if (spec.macros) {
    relList.push([`rId${relList.length + 1}`, "http://schemas.microsoft.com/office/2006/relationships/vbaProject", "vbaProject.bin"]);
    defaults.push(["bin", "application/vnd.ms-office.vbaProject"]);
    parts.push({ name: "word/vbaProject.bin", data: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new Array(504).fill(0)]) });
  }
  const commentAnchors = (spec.comments ?? []).map((_, i) => `<w:commentRangeStart w:id="${i}"/>`).join("");
  const commentEnds = (spec.comments ?? []).map((_, i) => `<w:commentRangeEnd w:id="${i}"/><w:r><w:commentReference w:id="${i}"/></w:r>`).join("");
  // The title paragraph carries the comment anchors and the note references.
  const firstPara = `<w:p>${commentAnchors}${run(spec.title ?? "Notes")}${commentEnds}${(spec.footnotes ?? []).map((_, i) => `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="${i + 1}"/></w:r>`).join("")}${(spec.endnotes ?? []).map((_, i) => `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:endnoteReference w:id="${i + 1}"/></w:r>`).join("")}</w:p>`;
  const deletions = (spec.deletions ?? [])
    .map((t, i) => `<w:p><w:del w:id="${900 + i}" w:author="Reviewer" w:date="2026-01-02T10:00:00Z"><w:r><w:delText xml:space="preserve">${xmlEscape(t)}</w:delText></w:r></w:del></w:p>`)
    .join("");
  const textBoxes = (spec.textBoxes ?? [])
    .map(
      (t, i) =>
        `<w:p><w:r><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="wps"><w:drawing><wp:anchor xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="${251659264 + i}" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="2743200" cy="914400"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="${10 + i}" name="Text Box ${i + 1}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:txbx><w:txbxContent>${paras(t)}</w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml"><v:textbox><w:txbxContent>${paras(t)}</w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>`,
    )
    .join("");
  const split = (spec.splitRuns ?? []).map(splitRunsXml).join("");
  const links = (spec.links ?? [])
    .map((link) => {
      const id = `rId${relList.length + 1}`;
      relList.push([id, "hyperlink", link.target, true]);
      return `<w:p><w:hyperlink r:id="${id}">${run(link.text, '<w:rStyle w:val="Hyperlink"/>')}</w:hyperlink></w:p>`;
    })
    .join("");
  const document = `${XML}<w:document ${W}><w:body>${firstPara}${wordBlocks(spec.body)}${split}${links}${deletions}${textBoxes}${embedRefs.join("")}<w:sectPr>${sect}<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const styles = `${XML}<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style></w:styles>`;
  const settings = `${XML}<w:settings ${W}><w:trackRevisions/><w:defaultTabStop w:val="708"/></w:settings>`;
  const mainType = spec.macros ? "application/vnd.ms-word.document.macroEnabled.main+xml" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
  return writeZip([
    ...packageRoot("word/document.xml", mainType, p, "Microsoft Office Word", overrides, defaults),
    { name: "word/document.xml", data: document },
    { name: "word/_rels/document.xml.rels", data: rels(relList) },
    { name: "word/styles.xml", data: styles },
    { name: "word/settings.xml", data: settings },
    ...parts,
  ]);
}

// ------------------------------------------------------------ Excel

/** A cell: text, a number, or a formula with its cached result (what Excel saves). */
export type Cell = string | number | { formula: string; result: string } | null;

export interface SheetSpec {
  name: string;
  hidden?: boolean | "very";
  rows: Cell[][];
  /** Page header and footer (Page Layout), Excel codes allowed. */
  header?: string;
  footer?: string;
  /** Cell notes (legacy comments). */
  comments?: Array<{ ref: string; text: string }>;
}
export interface WorkbookSpec {
  sheets: SheetSpec[];
  properties?: DocProperties;
  /** Shared strings for text (default) or inline strings in each cell. */
  inlineStrings?: boolean;
}

const colName = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : colName(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));

export function writeXlsx(spec: WorkbookSpec): Uint8Array {
  const strings: string[] = [];
  const index = new Map<string, number>();
  const sst = (s: string) => {
    let i = index.get(s);
    if (i === undefined) {
      i = strings.length;
      strings.push(s);
      index.set(s, i);
    }
    return i;
  };
  const parts: ZipInput[] = [];
  const overrides: Array<[string, string]> = [
    ["xl/styles.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"],
    ["xl/sharedStrings.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"],
  ];
  const wbRels: Array<[string, string, string]> = [];
  const defaults: Array<[string, string]> = [];
  spec.sheets.forEach((sheet, s) => {
    const n = s + 1;
    wbRels.push([`rId${n}`, "worksheet", `worksheets/sheet${n}.xml`]);
    overrides.push([`xl/worksheets/sheet${n}.xml`, "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"]);
    const rowsXml = sheet.rows
      .map((row, r) => {
        const cells = row
          .map((cell, c) => {
            if (cell === null || cell === "") return "";
            const ref = `${colName(c)}${r + 1}`;
            if (typeof cell === "number") return `<c r="${ref}"><v>${cell}</v></c>`;
            if (typeof cell === "object") return `<c r="${ref}" t="str"><f>${xmlEscape(cell.formula)}</f><v>${xmlEscape(cell.result)}</v></c>`;
            if (spec.inlineStrings) return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(cell)}</t></is></c>`;
            return `<c r="${ref}" t="s"><v>${sst(cell)}</v></c>`;
          })
          .join("");
        return `<row r="${r + 1}">${cells}</row>`;
      })
      .join("");
    const hf = sheet.header || sheet.footer ? `<headerFooter>${sheet.header ? `<oddHeader>${xmlEscape(sheet.header)}</oddHeader>` : ""}${sheet.footer ? `<oddFooter>${xmlEscape(sheet.footer)}</oddFooter>` : ""}</headerFooter>` : "";
    const sheetRels: Array<[string, string, string]> = [];
    let legacy = "";
    if (sheet.comments?.length) {
      sheetRels.push(["rId1", "comments", `../comments${n}.xml`]);
      sheetRels.push(["rId2", "vmlDrawing", `../drawings/vmlDrawing${n}.vml`]);
      if (!defaults.some(([x]) => x === "vml")) defaults.push(["vml", "application/vnd.openxmlformats-officedocument.vmlDrawing"]);
      overrides.push([`xl/comments${n}.xml`, "application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"]);
      parts.push({
        name: `xl/comments${n}.xml`,
        data: `${XML}<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>Reviewer</author></authors><commentList>${sheet.comments
          .map((cm) => `<comment ref="${cm.ref}" authorId="0"><text><r><t xml:space="preserve">${xmlEscape(cm.text)}</t></r></text></comment>`)
          .join("")}</commentList></comments>`,
      });
      parts.push({ name: `xl/drawings/vmlDrawing${n}.vml`, data: `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"></xml>` });
      legacy = `<legacyDrawing r:id="rId2"/>`;
    }
    parts.push({
      name: `xl/worksheets/sheet${n}.xml`,
      data: `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheetData>${rowsXml}</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>${hf}${legacy}</worksheet>`,
    });
    if (sheetRels.length) parts.push({ name: `xl/worksheets/_rels/sheet${n}.xml.rels`, data: rels(sheetRels) });
  });
  const k = spec.sheets.length;
  wbRels.push([`rId${k + 1}`, "styles", "styles.xml"], [`rId${k + 2}`, "sharedStrings", "sharedStrings.xml"]);
  const workbook = `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${spec.sheets
    .map((sh, i) => `<sheet name="${xmlEscape(sh.name)}" sheetId="${i + 1}"${sh.hidden ? ` state="${sh.hidden === "very" ? "veryHidden" : "hidden"}"` : ""} r:id="rId${i + 1}"/>`)
    .join("")}</sheets></workbook>`;
  const styles = `${XML}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf/></cellXfs></styleSheet>`;
  const shared = `${XML}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t xml:space="preserve">${xmlEscape(s)}</t></si>`).join("")}</sst>`;
  return writeZip([
    ...packageRoot("xl/workbook.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml", spec.properties ?? {}, "Microsoft Excel", overrides, defaults),
    { name: "xl/workbook.xml", data: workbook },
    { name: "xl/_rels/workbook.xml.rels", data: rels(wbRels) },
    { name: "xl/styles.xml", data: styles },
    { name: "xl/sharedStrings.xml", data: shared },
    ...parts,
  ]);
}

// ------------------------------------------------------------ PowerPoint

export interface SlideSpec {
  title?: string;
  body?: string[];
  table?: string[][];
  notes?: string[];
  hidden?: boolean;
}
export interface DeckSpec {
  slides: SlideSpec[];
  /** Modern comments on the first slide. */
  comments?: string[];
  properties?: DocProperties;
}

const P_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const aPara = (t: string) => `<a:p><a:r><a:rPr lang="en-GB" dirty="0"/><a:t>${xmlEscape(t)}</a:t></a:r></a:p>`;
const shape = (id: number, name: string, lines: string[], y: number) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="${y}"/><a:ext cx="8229600" cy="1143000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${lines.map(aPara).join("")}</p:txBody></p:sp>`;

export function writePptx(spec: DeckSpec): Uint8Array {
  const parts: ZipInput[] = [];
  const overrides: Array<[string, string]> = [
    ["ppt/slideMasters/slideMaster1.xml", "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"],
    ["ppt/slideLayouts/slideLayout1.xml", "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"],
  ];
  const presRels: Array<[string, string, string]> = [["rId1", "slideMaster", "slideMasters/slideMaster1.xml"]];
  const spTree = (inner: string) => `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${inner}</p:spTree></p:cSld>`;
  spec.slides.forEach((slide, i) => {
    const n = i + 1;
    presRels.push([`rId${n + 1}`, "slide", `slides/slide${n}.xml`]);
    overrides.push([`ppt/slides/slide${n}.xml`, "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"]);
    let inner = "";
    if (slide.title) inner += shape(2, "Title 1", [slide.title], 457200);
    if (slide.body?.length) inner += shape(3, "Content 2", slide.body, 1600200);
    if (slide.table?.length) {
      const cols = Math.max(...slide.table.map((r) => r.length));
      inner += `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table 3"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="457200" y="3200400"/><a:ext cx="8229600" cy="1483360"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblGrid>${'<a:gridCol w="2743200"/>'.repeat(cols)}</a:tblGrid>${slide.table
        .map((row) => `<a:tr h="370840">${row.map((c) => `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${aPara(c)}</a:txBody><a:tcPr/></a:tc>`).join("")}</a:tr>`)
        .join("")}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
    }
    const slideRels: Array<[string, string, string]> = [["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"]];
    if (slide.notes?.length) {
      slideRels.push(["rId2", "notesSlide", `../notesSlides/notesSlide${n}.xml`]);
      overrides.push([`ppt/notesSlides/notesSlide${n}.xml`, "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"]);
      parts.push({
        name: `ppt/notesSlides/notesSlide${n}.xml`,
        data: `${XML}<p:notes ${P_NS}>${spTree(shape(2, "Notes Placeholder 1", slide.notes, 4800600))}</p:notes>`,
      });
      parts.push({ name: `ppt/notesSlides/_rels/notesSlide${n}.xml.rels`, data: rels([["rId1", "slide", `../slides/slide${n}.xml`]]) });
    }
    if (i === 0 && spec.comments?.length) {
      slideRels.push(["rId3", "http://schemas.microsoft.com/office/2018/10/relationships/comments", "../comments/modernComment_1.xml"]);
      overrides.push(["ppt/comments/modernComment_1.xml", "application/vnd.ms-powerpoint.comments+xml"]);
      parts.push({
        name: "ppt/comments/modernComment_1.xml",
        data: `${XML}<p188:cmLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p188="http://schemas.microsoft.com/office/powerpoint/2018/8/main">${spec.comments
          .map((t, k) => `<p188:cm id="{00000000-0000-0000-0000-00000000000${k}}" authorId="{00000000-0000-0000-0000-000000000001}" created="2026-01-02T10:00:00.000"><p188:txBody><a:bodyPr/><a:lstStyle/>${aPara(t)}</p188:txBody></p188:cm>`)
          .join("")}</p188:cmLst>`,
      });
    }
    parts.push({ name: `ppt/slides/slide${n}.xml`, data: `${XML}<p:sld ${P_NS}${slide.hidden ? ' show="0"' : ""}>${spTree(inner)}</p:sld>` });
    parts.push({ name: `ppt/slides/_rels/slide${n}.xml.rels`, data: rels(slideRels) });
  });
  const presentation = `${XML}<p:presentation ${P_NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${spec.slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("")}</p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
  const master = `${XML}<p:sldMaster ${P_NS}>${spTree("")}<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`;
  const layout = `${XML}<p:sldLayout ${P_NS}>${spTree("")}</p:sldLayout>`;
  return writeZip([
    ...packageRoot("ppt/presentation.xml", "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml", spec.properties ?? {}, "Microsoft Office PowerPoint", overrides, []),
    { name: "ppt/presentation.xml", data: presentation },
    { name: "ppt/_rels/presentation.xml.rels", data: rels(presRels) },
    { name: "ppt/slideMasters/slideMaster1.xml", data: master },
    { name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", data: rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"]]) },
    { name: "ppt/slideLayouts/slideLayout1.xml", data: layout },
    { name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", data: rels([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]]) },
    ...parts,
  ]);
}
