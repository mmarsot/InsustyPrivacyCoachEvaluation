/**
 * Minimal, deterministic OpenDocument writers (text, spreadsheet,
 * presentation) for the document bench: body paragraphs and tables, page
 * header and footer (styles.xml), comments (annotations), tracked
 * deletions, hidden sheets, cell comments, slides, speaker notes and
 * metadata (meta.xml). `mimetype` is the first entry, stored, as the format
 * requires.
 */
import { xmlEscape, type Block } from "./ooxml.ts";
import { writeZip } from "./zip.ts";

const XML = '<?xml version="1.0" encoding="UTF-8"?>\n';
const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:version="1.3"';

export interface OdfMeta {
  title?: string;
  subject?: string;
  creator?: string;
  keywords?: string;
  description?: string;
  /** User-defined properties (File › Properties › Custom Properties). */
  custom?: Array<[string, string]>;
}

const p = (t: string) => t.split("\n").map((line) => `<text:p>${xmlEscape(line)}</text:p>`).join("");
const annotation = (t: string) => `<office:annotation><dc:creator>Reviewer</dc:creator><dc:date>2026-01-02T10:00:00</dc:date>${p(t)}</office:annotation>`;

function metaXml(m: OdfMeta = {}): string {
  const el = (tag: string, v?: string) => (v ? `<${tag}>${xmlEscape(v)}</${tag}>` : "");
  return `${XML}<office:document-meta ${NS}><office:meta><meta:generator>BenchWriter/1.0</meta:generator>${el("dc:title", m.title)}${el("dc:subject", m.subject)}${el("dc:description", m.description)}${el("meta:initial-creator", m.creator)}${el("dc:creator", m.creator)}${m.keywords ? `<meta:keyword>${xmlEscape(m.keywords)}</meta:keyword>` : ""}${(m.custom ?? [])
    .map(([k, v]) => `<meta:user-defined meta:name="${xmlEscape(k)}">${xmlEscape(v)}</meta:user-defined>`)
    .join("")}<meta:creation-date>2026-01-02T10:00:00</meta:creation-date></office:meta></office:document-meta>`;
}

function pack(mime: string, content: string, styles: string, meta: OdfMeta | undefined): Uint8Array {
  const manifest = `${XML}<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="${mime}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/></manifest:manifest>`;
  return writeZip([
    { name: "mimetype", data: mime, method: 0 },
    { name: "content.xml", data: content },
    { name: "styles.xml", data: styles },
    { name: "meta.xml", data: metaXml(meta) },
    { name: "META-INF/manifest.xml", data: manifest },
  ]);
}

export interface OdtSpec {
  body: Block[];
  header?: string[];
  footer?: string[];
  comments?: string[];
  deletions?: string[];
  meta?: OdfMeta;
}

export function writeOdt(spec: OdtSpec): Uint8Array {
  const blocks = spec.body
    .map((b) =>
      b.type === "p"
        ? p(b.text)
        : `<table:table table:name="Table1"><table:table-column table:number-columns-repeated="${Math.max(...b.rows.map((r) => r.length))}"/>${b.rows
            .map((r) => `<table:table-row>${r.map((c) => `<table:table-cell office:value-type="string">${p(c)}</table:table-cell>`).join("")}</table:table-row>`)
            .join("")}</table:table>`,
    )
    .join("");
  const comments = (spec.comments ?? []).map((t) => `<text:p>${annotation(t)}Reviewed.</text:p>`).join("");
  const changes = spec.deletions?.length
    ? `<text:tracked-changes>${spec.deletions
        .map((t, i) => `<text:changed-region text:id="ct${i + 1}"><text:deletion><office:change-info><dc:creator>Reviewer</dc:creator><dc:date>2026-01-02T10:00:00</dc:date></office:change-info>${p(t)}</text:deletion></text:changed-region>`)
        .join("")}</text:tracked-changes>`
    : "";
  const marks = (spec.deletions ?? []).map((_, i) => `<text:p><text:change text:change-id="ct${i + 1}"/></text:p>`).join("");
  const content = `${XML}<office:document-content ${NS}><office:body><office:text>${changes}${comments}${blocks}${marks}</office:text></office:body></office:document-content>`;
  const hf = (tag: string, lines?: string[]) => (lines?.length ? `<style:${tag}>${p(lines.join("\n"))}</style:${tag}>` : "");
  const styles = `${XML}<office:document-styles ${NS}><office:automatic-styles><style:page-layout style:name="pm1"/></office:automatic-styles><office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1">${hf("header", spec.header)}${hf("footer", spec.footer)}</style:master-page></office:master-styles></office:document-styles>`;
  return pack("application/vnd.oasis.opendocument.text", content, styles, spec.meta);
}

export interface OdsSheet {
  name: string;
  hidden?: boolean;
  rows: Array<Array<string | number | null>>;
  comments?: Array<{ row: number; col: number; text: string }>;
}
export interface OdsSpec {
  sheets: OdsSheet[];
  meta?: OdfMeta;
}

export function writeOds(spec: OdsSpec): Uint8Array {
  const sheets = spec.sheets
    .map((sh) => {
      const rows = sh.rows
        .map((r, ri) => {
          const cells = r
            .map((c, ci) => {
              const note = sh.comments?.find((cm) => cm.row === ri && cm.col === ci);
              const ann = note ? annotation(note.text) : "";
              if (c === null || c === "") return `<table:table-cell>${ann}</table:table-cell>`;
              if (typeof c === "number") return `<table:table-cell office:value-type="float" office:value="${c}">${ann}<text:p>${c}</text:p></table:table-cell>`;
              return `<table:table-cell office:value-type="string">${ann}${p(c)}</table:table-cell>`;
            })
            .join("");
          return `<table:table-row>${cells}</table:table-row>`;
        })
        .join("");
      return `<table:table table:name="${xmlEscape(sh.name)}"${sh.hidden ? ' table:style-name="taHidden"' : ' table:style-name="ta1"'}>${rows}</table:table>`;
    })
    .join("");
  const content = `${XML}<office:document-content ${NS}><office:automatic-styles><style:style style:name="ta1" style:family="table"><style:table-properties table:display="true"/></style:style><style:style style:name="taHidden" style:family="table"><style:table-properties table:display="false"/></style:style></office:automatic-styles><office:body><office:spreadsheet>${sheets}</office:spreadsheet></office:body></office:document-content>`;
  const styles = `${XML}<office:document-styles ${NS}><office:master-styles><style:master-page style:name="Default"/></office:master-styles></office:document-styles>`;
  return pack("application/vnd.oasis.opendocument.spreadsheet", content, styles, spec.meta);
}

export interface OdpSpec {
  slides: Array<{ title?: string; body?: string[]; notes?: string[] }>;
  meta?: OdfMeta;
}

export function writeOdp(spec: OdpSpec): Uint8Array {
  const frame = (lines: string[], y: number) =>
    `<draw:frame svg:x="2cm" svg:y="${y}cm" svg:width="24cm" svg:height="3cm"><draw:text-box>${p(lines.join("\n"))}</draw:text-box></draw:frame>`;
  const pages = spec.slides
    .map(
      (s, i) =>
        `<draw:page draw:name="page${i + 1}" draw:master-page-name="Default">${s.title ? frame([s.title], 1) : ""}${s.body?.length ? frame(s.body, 5) : ""}${s.notes?.length ? `<presentation:notes>${frame(s.notes, 2)}</presentation:notes>` : ""}</draw:page>`,
    )
    .join("");
  const content = `${XML}<office:document-content ${NS}><office:body><office:presentation>${pages}</office:presentation></office:body></office:document-content>`;
  const styles = `${XML}<office:document-styles ${NS}><office:master-styles><style:master-page style:name="Default"/></office:master-styles></office:document-styles>`;
  return pack("application/vnd.oasis.opendocument.presentation", content, styles, spec.meta);
}
