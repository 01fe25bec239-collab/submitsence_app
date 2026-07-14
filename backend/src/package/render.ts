import JSZip from "jszip";
import { PDFDocument, PDFPage, PDFFont, StandardFonts, rgb } from "pdf-lib";
import type { ArtifactWarning, LoadedDocument, PackageSnapshot, RegisterRow, RenderedPdf } from "./package.types";

const A4 = { width: 595.28, height: 841.89 };
const LANDSCAPE = { width: A4.height, height: A4.width };
const FIXED_ZIP_DATE = new Date("2000-01-01T00:00:00.000Z");

function clean(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "?");
}

function safeFilename(value: string): string {
  return clean(value).replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120) || "document";
}

function hexColour(value: string) {
  const match = /^#?([0-9a-f]{6})$/i.exec(value);
  const hex = match?.[1] ?? "16697A";
  return rgb(Number.parseInt(hex.slice(0, 2), 16) / 255, Number.parseInt(hex.slice(2, 4), 16) / 255, Number.parseInt(hex.slice(4, 6), 16) / 255);
}

function wrap(text: string, font: PDFFont, size: number, width: number, maxLines = Number.POSITIVE_INFINITY): string[] {
  const words = clean(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width || !line) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines && words.join(" ") !== lines.join(" ")) {
    let last = lines[lines.length - 1];
    while (last && font.widthOfTextAtSize(`${last}...`, size) > width) last = last.slice(0, -1);
    lines[lines.length - 1] = `${last}...`;
  }
  return lines;
}

function drawLines(page: PDFPage, lines: string[], x: number, y: number, font: PDFFont, size: number, colour = rgb(0.12, 0.16, 0.18), lineHeight = size + 2) {
  lines.forEach((line, i) => page.drawText(line, { x, y: y - i * lineHeight, font, size, color: colour }));
}

function drawFooter(page: PDFPage, regular: PDFFont, label: string) {
  page.drawLine({ start: { x: 36, y: 28 }, end: { x: page.getWidth() - 36, y: 28 }, thickness: 0.5, color: rgb(0.72, 0.75, 0.76) });
  page.drawText(clean(label), { x: 36, y: 15, size: 7, font: regular, color: rgb(0.35, 0.39, 0.4) });
}

async function drawCover(pdf: PDFDocument, snapshot: PackageSnapshot, regular: PDFFont, bold: PDFFont, logo?: LoadedDocument | null) {
  const page = pdf.addPage([A4.width, A4.height]);
  const accent = hexColour(snapshot.cover.primaryColour);
  page.drawRectangle({ x: 0, y: A4.height - 20, width: A4.width, height: 20, color: accent });
  page.drawRectangle({ x: 0, y: 0, width: 14, height: A4.height, color: accent });

  if (logo?.bytes && logo.ref.mimeType?.startsWith("image/")) {
    try {
      const image = logo.ref.mimeType === "image/png" ? await pdf.embedPng(logo.bytes) : await pdf.embedJpg(logo.bytes);
      const scale = Math.min(140 / image.width, 65 / image.height, 1);
      page.drawImage(image, { x: 405, y: 735, width: image.width * scale, height: image.height * scale });
    } catch {
      // The textual company name remains the branding fallback.
    }
  }

  page.drawText(clean(snapshot.cover.companyName), { x: 48, y: 770, size: 17, font: bold, color: accent });
  if (snapshot.cover.legalName && snapshot.cover.legalName !== snapshot.cover.companyName) {
    page.drawText(clean(snapshot.cover.legalName), { x: 48, y: 752, size: 9, font: regular, color: rgb(0.35, 0.39, 0.4) });
  }
  if (snapshot.cover.abn) page.drawText(`ABN ${clean(snapshot.cover.abn)}`, { x: 48, y: 738, size: 8, font: regular, color: rgb(0.35, 0.39, 0.4) });

  page.drawText("SUBMITTAL PACKAGE", { x: 48, y: 650, size: 12, font: bold, color: rgb(0.35, 0.39, 0.4) });
  drawLines(page, wrap(snapshot.packageName, bold, 28, 490, 3), 48, 612, bold, 28, rgb(0.08, 0.12, 0.14), 34);
  page.drawText("Prepared for review", { x: 48, y: 492, size: 16, font: bold, color: accent });
  page.drawText("Human review and approval remain required.", { x: 48, y: 472, size: 9, font: regular, color: rgb(0.35, 0.39, 0.4) });

  const details: [string, string | null][] = [
    ["Project", snapshot.cover.projectName],
    ["Client", snapshot.cover.clientName],
    ["Site", snapshot.cover.siteAddress],
    ["Trade", snapshot.cover.trade],
    ["Package version", String(snapshot.version)],
    ["Prepared by", snapshot.cover.preparedBy],
    ["Prepared at", snapshot.generatedAt],
  ];
  let y = 405;
  for (const [label, value] of details) {
    if (!value) continue;
    page.drawText(label.toUpperCase(), { x: 48, y, size: 7, font: bold, color: rgb(0.4, 0.44, 0.45) });
    drawLines(page, wrap(value, regular, 10, 360, 2), 165, y, regular, 10);
    y -= 33;
  }

  const contact = [snapshot.cover.address, snapshot.cover.phone, snapshot.cover.email].filter(Boolean).map(clean).join(" | ");
  if (contact) drawLines(page, wrap(contact, regular, 8, 500, 2), 48, 72, regular, 8, rgb(0.35, 0.39, 0.4));
  drawFooter(page, regular, `${snapshot.packageName} | Prepared for review`);
}

function drawRegisterHeader(page: PDFPage, snapshot: PackageSnapshot, regular: PDFFont, bold: PDFFont) {
  const accent = hexColour(snapshot.cover.primaryColour);
  page.drawText("SUBMITTAL REGISTER", { x: 34, y: LANDSCAPE.height - 36, size: 16, font: bold, color: accent });
  page.drawText(clean(`${snapshot.cover.projectName} | ${snapshot.packageName} | Version ${snapshot.version}`), { x: 34, y: LANDSCAPE.height - 51, size: 8, font: regular, color: rgb(0.35, 0.39, 0.4) });
  const columns = [
    ["Item", 34, 35], ["Description", 69, 160], ["Worksection", 229, 78], ["Clause", 307, 75],
    ["Required evidence", 382, 120], ["Status", 502, 78], ["Responsible", 580, 92], ["Due", 672, 65], ["Docs", 737, 66],
  ] as const;
  page.drawRectangle({ x: 34, y: LANDSCAPE.height - 78, width: 769, height: 18, color: rgb(0.9, 0.93, 0.94) });
  for (const [label, x] of columns) page.drawText(label, { x: x + 2, y: LANDSCAPE.height - 72, size: 7, font: bold, color: rgb(0.12, 0.16, 0.18) });
  return columns;
}

function addRegisterPages(pdf: PDFDocument, snapshot: PackageSnapshot, regular: PDFFont, bold: PDFFont) {
  let page = pdf.addPage([LANDSCAPE.width, LANDSCAPE.height]);
  let columns = drawRegisterHeader(page, snapshot, regular, bold);
  let y = LANDSCAPE.height - 87;
  const rows = snapshot.rows.filter((row) => row.included);

  for (const row of rows) {
    const cells = [
      String(row.itemNumber), [row.description, row.productName ? `Product: ${row.productName}` : null, row.vendorName ? `Vendor: ${row.vendorName}` : null].filter(Boolean).join(" | "), row.worksection ?? "", row.clauseReference ?? "",
      row.requiredEvidence, row.status, row.responsibleParty ?? "", row.dueDate ?? "", String(row.documents.length),
    ];
    const wrapped = cells.map((value, i) => wrap(value, regular, 6.7, columns[i][2] - 5, i === 1 || i === 4 ? 4 : 3));
    const rowHeight = Math.max(18, ...wrapped.map((lines) => lines.length * 8 + 6));
    if (y - rowHeight < 34) {
      drawFooter(page, regular, `${snapshot.packageName} | Prepared for review`);
      page = pdf.addPage([LANDSCAPE.width, LANDSCAPE.height]);
      columns = drawRegisterHeader(page, snapshot, regular, bold);
      y = LANDSCAPE.height - 87;
    }
    page.drawRectangle({ x: 34, y: y - rowHeight + 4, width: 769, height: rowHeight, color: row.overdue ? rgb(1, 0.94, 0.94) : rgb(1, 1, 1), borderColor: rgb(0.82, 0.84, 0.85), borderWidth: 0.35 });
    wrapped.forEach((lines, i) => drawLines(page, lines, columns[i][1] + 2, y - 5, regular, 6.7, rgb(0.12, 0.16, 0.18), 8));
    y -= rowHeight;
  }
  if (rows.length === 0) page.drawText("No included register items.", { x: 36, y: y - 10, size: 10, font: regular });
  drawFooter(page, regular, `${snapshot.packageName} | Prepared for review`);
}

function addCrossReferencePages(pdf: PDFDocument, snapshot: PackageSnapshot, regular: PDFFont, bold: PDFFont) {
  let page = pdf.addPage([A4.width, A4.height]);
  const accent = hexColour(snapshot.cover.primaryColour);
  page.drawText("CLAUSE CROSS-REFERENCES", { x: 40, y: 795, size: 16, font: bold, color: accent });
  page.drawText("References only - source clause text is not reproduced.", { x: 40, y: 776, size: 8, font: regular, color: rgb(0.35, 0.39, 0.4) });
  let y = 742;
  for (const row of snapshot.rows.filter((item) => item.included)) {
    const reference = [row.worksection, row.clauseReference, row.clauseLocation].filter(Boolean).join(" | ") || "No clause reference recorded";
    const description = wrap(`${row.itemNumber}. ${row.description}`, regular, 9, 505, 2);
    const details = [row.productName ? `Accepted product: ${row.productName}` : null, row.vendorName ? `Vendor: ${row.vendorName}` : null, row.manualNotes ? `Notes: ${row.manualNotes}` : null].filter(Boolean).join(" | ");
    const detailLines = details ? wrap(details, regular, 8, 490, 3) : [];
    const height = 30 + description.length * 11 + detailLines.length * 10;
    if (y - height < 45) {
      drawFooter(page, regular, `${snapshot.packageName} | Clause references`);
      page = pdf.addPage([A4.width, A4.height]);
      page.drawText("CLAUSE CROSS-REFERENCES (CONTINUED)", { x: 40, y: 795, size: 14, font: bold, color: accent });
      y = 755;
    }
    drawLines(page, description, 40, y, regular, 9, rgb(0.12, 0.16, 0.18), 11);
    const referenceY = y - description.length * 11 - 3;
    page.drawText(clean(reference), { x: 55, y: referenceY, size: 8, font: bold, color: accent });
    if (detailLines.length) drawLines(page, detailLines, 55, referenceY - 13, regular, 8, rgb(0.35, 0.39, 0.4), 10);
    y -= height;
  }
  drawFooter(page, regular, `${snapshot.packageName} | Clause references`);
}

function addPhysicalPages(pdf: PDFDocument, snapshot: PackageSnapshot, regular: PDFFont, bold: PDFFont) {
  const physical = snapshot.rows.flatMap((row) => row.physicalDeliverables.map((item) => ({ ...item, itemNumber: row.itemNumber })));
  if (physical.length === 0) return;
  let page = pdf.addPage([A4.width, A4.height]);
  const accent = hexColour(snapshot.cover.primaryColour);
  page.drawText("PHYSICAL DELIVERABLES", { x: 40, y: 795, size: 16, font: bold, color: accent });
  page.drawText("Tracked line items only. SubmitSense does not generate stamped or certified drawings.", { x: 40, y: 776, size: 8, font: regular, color: rgb(0.35, 0.39, 0.4) });
  let y = 742;
  for (const item of physical) {
    if (y < 90) {
      drawFooter(page, regular, `${snapshot.packageName} | Physical deliverables`);
      page = pdf.addPage([A4.width, A4.height]);
      page.drawText("PHYSICAL DELIVERABLES (CONTINUED)", { x: 40, y: 795, size: 14, font: bold, color: accent });
      y = 755;
    }
    page.drawText(clean(`${item.itemNumber}. ${item.kind.replaceAll("_", " ")}`), { x: 40, y, size: 9, font: bold, color: rgb(0.12, 0.16, 0.18) });
    const detail = [item.description, `Status: ${item.status}`, item.responsibleParty ? `Responsible: ${item.responsibleParty}` : null, item.dueDate ? `Due: ${item.dueDate}` : null, item.notes].filter(Boolean).join(" | ");
    drawLines(page, wrap(detail, regular, 8, 500, 3), 55, y - 15, regular, 8, rgb(0.35, 0.39, 0.4), 10);
    y -= 58;
  }
  drawFooter(page, regular, `${snapshot.packageName} | Physical deliverables`);
}

async function createBasePdf(snapshot: PackageSnapshot, logo?: LoadedDocument | null, includeCover = true) {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const fixedDate = new Date(snapshot.generatedAt);
  pdf.setTitle(clean(snapshot.packageName));
  pdf.setAuthor(clean(snapshot.cover.companyName));
  pdf.setSubject("Prepared for review submittal package");
  pdf.setCreator("SubmitSense");
  pdf.setProducer("SubmitSense");
  pdf.setCreationDate(fixedDate);
  pdf.setModificationDate(fixedDate);
  if (includeCover) await drawCover(pdf, snapshot, regular, bold, logo);
  addRegisterPages(pdf, snapshot, regular, bold);
  addCrossReferencePages(pdf, snapshot, regular, bold);
  addPhysicalPages(pdf, snapshot, regular, bold);
  return pdf;
}

export async function renderPackagePdf(snapshot: PackageSnapshot, documents: LoadedDocument[], logo?: LoadedDocument | null): Promise<RenderedPdf> {
  const pdf = await createBasePdf(snapshot, logo, true);
  const warnings: ArtifactWarning[] = documents.filter((doc) => !doc.bytes).map((doc) => ({ documentId: doc.ref.id, title: doc.ref.title, reason: doc.error ?? "Document unavailable" }));
  if (logo && !logo.bytes) warnings.push({ documentId: logo.ref.id, title: logo.ref.title, reason: logo.error ?? "Logo unavailable" });
  for (const doc of documents.filter((item) => item.bytes)) {
    try {
      if (doc.ref.mimeType === "application/pdf") {
        const source = await PDFDocument.load(doc.bytes!, { ignoreEncryption: false, updateMetadata: false });
        const pages = await pdf.copyPages(source, source.getPageIndices());
        pages.forEach((page) => pdf.addPage(page));
      } else if (doc.ref.mimeType?.startsWith("image/")) {
        const image = doc.ref.mimeType === "image/png" ? await pdf.embedPng(doc.bytes!) : await pdf.embedJpg(doc.bytes!);
        const page = pdf.addPage([A4.width, A4.height]);
        const scale = Math.min((A4.width - 72) / image.width, (A4.height - 100) / image.height, 1);
        page.drawText(clean(doc.ref.title), { x: 36, y: A4.height - 35, size: 9, font: await pdf.embedFont(StandardFonts.HelveticaBold) });
        page.drawImage(image, { x: (A4.width - image.width * scale) / 2, y: 36, width: image.width * scale, height: image.height * scale });
      } else {
        warnings.push({ documentId: doc.ref.id, title: doc.ref.title, reason: `Unsupported attachment type ${doc.ref.mimeType ?? "unknown"}; retained in Aconex bundle only` });
      }
    } catch (error) {
      warnings.push({ documentId: doc.ref.id, title: doc.ref.title, reason: error instanceof Error ? error.message : "Attachment could not be merged" });
    }
  }
  const bytes = await pdf.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
  return { bytes, pageCount: pdf.getPageCount(), warnings };
}

export async function renderRegisterPdf(snapshot: PackageSnapshot): Promise<RenderedPdf> {
  const pdf = await createBasePdf(snapshot, null, false);
  const bytes = await pdf.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
  return { bytes, pageCount: pdf.getPageCount(), warnings: [] };
}

const REGISTER_HEADERS = ["Item number", "Description", "Worksection", "Clause reference", "Clause location", "Required evidence", "Status", "Responsible party", "Due date", "Overdue", "Accepted product", "Vendor", "Included documents", "Manual notes"];

function registerValues(row: RegisterRow): string[] {
  return [
    String(row.itemNumber), row.description, row.worksection ?? "", row.clauseReference ?? "", row.clauseLocation ?? "",
    row.requiredEvidence, row.status, row.responsibleParty ?? "", row.dueDate ?? "", row.overdue ? "Yes" : "No",
    row.productName ?? "", row.vendorName ?? "", row.documents.map((doc) => doc.title).join("; "), row.manualNotes ?? "",
  ].map(clean);
}

function csvCell(value: string): string {
  const safe = /^[\t ]*[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function renderRegisterCsv(snapshot: PackageSnapshot): Uint8Array {
  const lines = [REGISTER_HEADERS, ...snapshot.rows.map(registerValues)].map((row) => row.map(csvCell).join(","));
  return Buffer.from(`\uFEFF${lines.join("\r\n")}\r\n`, "utf8");
}

function xml(value: string): string {
  return clean(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function columnName(index: number): string {
  let out = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  return out;
}

function addZipFile(zip: JSZip, path: string, data: string | Uint8Array) {
  zip.file(path, data, { date: FIXED_ZIP_DATE, createFolders: true });
}

export async function renderRegisterXlsx(snapshot: PackageSnapshot): Promise<Uint8Array> {
  const rows = [REGISTER_HEADERS, ...snapshot.rows.map(registerValues)];
  const sheetRows = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, columnIndex) => `<c r="${columnName(columnIndex)}${rowIndex + 1}" t="inlineStr" s="${rowIndex === 0 ? 1 : 0}"><is><t xml:space="preserve">${xml(value)}</t></is></c>`).join("")}</row>`).join("");
  const zip = new JSZip();
  addZipFile(zip, "[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`);
  addZipFile(zip, "_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  addZipFile(zip, "xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Submittal Register" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  addZipFile(zip, "xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  addZipFile(zip, "xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Arial"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF16697A"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf></cellXfs></styleSheet>`);
  addZipFile(zip, "xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="12" customWidth="1"/><col min="2" max="2" width="42" customWidth="1"/><col min="3" max="6" width="22" customWidth="1"/><col min="7" max="14" width="18" customWidth="1"/></cols><sheetData>${sheetRows}</sheetData><autoFilter ref="A1:N${rows.length}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews></worksheet>`);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 9 }, platform: "UNIX" });
}

export async function renderAconexBundle(snapshot: PackageSnapshot, packagePdf: Uint8Array, documents: LoadedDocument[], warnings: ArtifactWarning[]): Promise<Uint8Array> {
  const zip = new JSZip();
  const includedSnapshot = { ...snapshot, rows: snapshot.rows.filter((row) => row.included) };
  const base = safeFilename(`${snapshot.packageName}-v${snapshot.version}`);
  addZipFile(zip, `${base}.pdf`, packagePdf);
  addZipFile(zip, "register/submittal-register.csv", renderRegisterCsv(includedSnapshot));
  addZipFile(zip, "register/submittal-register.xlsx", await renderRegisterXlsx(includedSnapshot));
  const included: { documentId: string; path: string; role: string; registerItemId: string | null }[] = [];
  documents.forEach((document, index) => {
    if (!document.bytes) return;
    const filename = safeFilename(document.ref.originalFilename ?? document.ref.title);
    const path = `attachments/${String(index + 1).padStart(3, "0")}-${filename}`;
    addZipFile(zip, path, document.bytes);
    included.push({ documentId: document.ref.id, path, role: document.ref.role, registerItemId: document.ref.registerItemId });
  });
  const metadata = {
    schemaVersion: "submitsense.aconex-bundle.v1",
    package: { id: snapshot.packageId, name: snapshot.packageName, version: snapshot.version, projectId: snapshot.projectId },
    preparedForReview: true,
    generatedAt: snapshot.generatedAt,
    register: includedSnapshot.rows.map((row) => ({ itemNumber: row.itemNumber, registerItemId: row.registerItemId, status: row.status, clauseReference: row.clauseReference, dueDate: row.dueDate, productName: row.productName, vendorName: row.vendorName })),
    files: included,
    warnings,
  };
  addZipFile(zip, "metadata.json", `${JSON.stringify(metadata, null, 2)}\n`);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 9 }, platform: "UNIX" });
}
