import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import JSZip from "jszip";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { renderAconexBundle, renderPackagePdf, renderRegisterCsv, renderRegisterPdf, renderRegisterXlsx } from "../src/package/render";
import type { LoadedDocument, PackageSnapshot } from "../src/package/package.types";

const snapshot: PackageSnapshot = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  packageId: "00000000-0000-4000-8000-000000000003",
  packageName: "Fire Services Product Data",
  version: 2,
  generatedAt: "2026-01-15T00:00:00.000Z",
  cover: {
    companyName: "Example Fire Services",
    legalName: "Example Fire Services Pty Ltd",
    abn: "12345678901",
    logoDocumentId: null,
    primaryColour: "#16697A",
    address: "1 Test Street, Sydney NSW",
    phone: "02 0000 0000",
    email: "submittals@example.test",
    projectName: "Synthetic Hospital",
    clientName: "Example Builder",
    siteAddress: "10 Project Road, Sydney NSW",
    trade: "fire_protection",
    preparedBy: "Test Reviewer",
  },
  rows: [{
    itemNumber: 1,
    registerItemId: "00000000-0000-4000-8000-000000000004",
    description: "Diesel fire pump product data",
    worksection: "0711 - Fire hydrant systems",
    clauseReference: "0711/2.4 PRODUCT DATA",
    clauseLocation: "Source page 42",
    requiredEvidence: "product data",
    status: "submitted",
    responsibleParty: "Project Engineer",
    dueDate: "2026-01-10",
    overdue: true,
    productName: "FP-20 Pump",
    vendorName: "Example Pumps",
    included: true,
    manualNotes: "Include current technical schedule.",
    documents: [{
      id: "00000000-0000-4000-8000-000000000005",
      title: "FP-20 Datasheet",
      originalFilename: "fp-20-datasheet.pdf",
      mimeType: "application/pdf",
      storageBucket: "test-ap-southeast-2",
      objectKey: "test/fp-20.pdf",
      checksumSha256: null,
      role: "datasheet",
      sequence: 1,
      registerItemId: "00000000-0000-4000-8000-000000000004",
    }],
    physicalDeliverables: [{
      id: "00000000-0000-4000-8000-000000000006",
      kind: "stamped_shop_drawing",
      description: "Engineer-stamped shop drawing supplied by the responsible engineer",
      status: "required",
      responsibleParty: "Project Engineer",
      dueDate: "2026-01-20",
      notes: "Tracking only - SubmitSense does not generate this drawing.",
      attachmentDocumentId: null,
    }],
  }],
  logoDocument: null,
};

async function syntheticAttachment(): Promise<LoadedDocument> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([300, 200]);
  page.drawText("Synthetic vendor datasheet", { x: 30, y: 150, size: 14, font });
  const fixed = new Date("2026-01-01T00:00:00.000Z");
  pdf.setCreationDate(fixed);
  pdf.setModificationDate(fixed);
  return { ref: snapshot.rows[0].documents[0], bytes: await pdf.save({ useObjectStreams: false }) };
}

test("package PDF is deterministic, versioned, and merges synthetic attachments", async () => {
  const attachment = await syntheticAttachment();
  const first = await renderPackagePdf(snapshot, [attachment]);
  const second = await renderPackagePdf(snapshot, [attachment]);
  assert.equal(createHash("sha256").update(first.bytes).digest("hex"), createHash("sha256").update(second.bytes).digest("hex"));
  assert.equal(first.warnings.length, 0);
  const parsed = await PDFDocument.load(first.bytes);
  assert.ok(parsed.getPageCount() >= 5);
  assert.equal(parsed.getSubject(), "Prepared for review submittal package");
});

test("missing attachments do not fail package PDF generation", async () => {
  const missing: LoadedDocument = { ref: snapshot.rows[0].documents[0], bytes: null, error: "Synthetic object missing" };
  const rendered = await renderPackagePdf(snapshot, [missing]);
  assert.ok(rendered.bytes.length > 1000);
  assert.deepEqual(rendered.warnings, [{ documentId: missing.ref.id, title: missing.ref.title, reason: "Synthetic object missing" }]);
});

test("missing or invalid logos fall back to text branding with a warning", async () => {
  const logo: LoadedDocument = { ref: { ...snapshot.rows[0].documents[0], id: "00000000-0000-4000-8000-000000000099", title: "Company logo", mimeType: "image/png", role: "logo", registerItemId: null }, bytes: null, error: "Synthetic logo missing" };
  const rendered = await renderPackagePdf(snapshot, [], logo);
  assert.deepEqual(rendered.warnings, [{ documentId: logo.ref.id, title: logo.ref.title, reason: "Synthetic logo missing" }]);
});

test("register CSV, XLSX, and PDF preserve exact clause references", async () => {
  const csv = Buffer.from(renderRegisterCsv(snapshot)).toString("utf8");
  assert.match(csv, /0711\/2\.4 PRODUCT DATA/);
  assert.match(csv, /Source page 42/);
  assert.match(csv, /FP-20 Pump/);
  assert.match(csv, /Example Pumps/);
  const xlsx = await JSZip.loadAsync(await renderRegisterXlsx(snapshot));
  const sheet = await xlsx.file("xl/worksheets/sheet1.xml")!.async("string");
  assert.match(sheet, /0711\/2\.4 PRODUCT DATA/);
  assert.match(sheet, /Source page 42/);
  assert.match(sheet, /FP-20 Pump/);
  const pdf = await renderRegisterPdf(snapshot);
  assert.ok((await PDFDocument.load(pdf.bytes)).getPageCount() >= 2);
});

test("register CSV neutralises spreadsheet formula cells", () => {
  const dangerous = { ...snapshot, rows: [{ ...snapshot.rows[0], description: "=HYPERLINK(\"https://example.test\")", manualNotes: "+cmd|' /C calc'!A0" }] };
  const csv = Buffer.from(renderRegisterCsv(dangerous)).toString("utf8");
  assert.match(csv, /'=HYPERLINK/);
  assert.match(csv, /'\+cmd/);
});

test("Aconex bundle contains package, register formats, attachments, and integration metadata", async () => {
  const attachment = await syntheticAttachment();
  const packagePdf = await renderPackagePdf(snapshot, [attachment]);
  const bytes = await renderAconexBundle(snapshot, packagePdf.bytes, [attachment], packagePdf.warnings);
  const zip = await JSZip.loadAsync(bytes);
  assert.ok(Object.keys(zip.files).some((name) => name.endsWith(".pdf") && !name.startsWith("attachments/")));
  assert.ok(zip.file("register/submittal-register.csv"));
  assert.ok(zip.file("register/submittal-register.xlsx"));
  assert.ok(Object.keys(zip.files).some((name) => name.startsWith("attachments/") && name.endsWith(".pdf")));
  const metadata = JSON.parse(await zip.file("metadata.json")!.async("string"));
  assert.equal(metadata.schemaVersion, "submitsense.aconex-bundle.v1");
  assert.equal(metadata.preparedForReview, true);
  assert.equal(metadata.register[0].clauseReference, "0711/2.4 PRODUCT DATA");
  assert.equal(metadata.register[0].productName, "FP-20 Pump");
});

test("Aconex bundle excludes draft rows marked not included", async () => {
  const excluded = { ...snapshot.rows[0], itemNumber: 2, registerItemId: "00000000-0000-4000-8000-000000000098", description: "EXCLUDED-DRAFT-ROW", included: false, documents: [], physicalDeliverables: [] };
  const withExcluded = { ...snapshot, rows: [...snapshot.rows, excluded] };
  const bytes = await renderAconexBundle(withExcluded, (await renderPackagePdf(withExcluded, [])).bytes, [], []);
  const zip = await JSZip.loadAsync(bytes);
  const csv = await zip.file("register/submittal-register.csv")!.async("string");
  const metadata = JSON.parse(await zip.file("metadata.json")!.async("string"));
  assert.doesNotMatch(csv, /EXCLUDED-DRAFT-ROW/);
  assert.equal(metadata.register.length, 1);
});
