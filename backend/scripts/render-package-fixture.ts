import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderPackagePdf } from "../src/package/render";
import type { PackageSnapshot, RegisterRow } from "../src/package/package.types";

const baseRow: RegisterRow = {
  itemNumber: 1,
  registerItemId: "00000000-0000-4000-8000-000000000010",
  description: "Diesel fire pump product data and current technical schedule",
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
  manualNotes: "Include the current technical schedule and installation limitations.",
  documents: [],
  physicalDeliverables: [{
    id: "00000000-0000-4000-8000-000000000020",
    kind: "stamped_shop_drawing",
    description: "Engineer-stamped shop drawing supplied by the responsible engineer",
    status: "required",
    responsibleParty: "Project Engineer",
    dueDate: "2026-01-20",
    notes: "Tracking only - SubmitSense does not generate this drawing.",
    attachmentDocumentId: null,
  }],
};

const snapshot: PackageSnapshot = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  packageId: "00000000-0000-4000-8000-000000000003",
  packageName: "Fire Services Product Data and Shop Drawing Register",
  version: 3,
  generatedAt: "2026-07-14T09:30:00.000Z",
  cover: {
    companyName: "Example Fire Services",
    legalName: "Example Fire Services Pty Ltd",
    abn: "12345678901",
    logoDocumentId: null,
    primaryColour: "#16697A",
    address: "1 Test Street, Sydney NSW 2000",
    phone: "02 0000 0000",
    email: "submittals@example.test",
    projectName: "Synthetic Hospital Redevelopment",
    clientName: "Example Builder",
    siteAddress: "10 Project Road, Sydney NSW 2000",
    trade: "fire_protection",
    preparedBy: "Test Reviewer",
  },
  rows: [
    baseRow,
    { ...baseRow, itemNumber: 2, registerItemId: "00000000-0000-4000-8000-000000000011", description: "Fire brigade booster assembly product data, evidence of conformity, and installation instructions", clauseReference: "0711/2.7 BOOSTER ASSEMBLY", requiredEvidence: "evidence of conformity", status: "draft", overdue: false, dueDate: "2026-08-15", physicalDeliverables: [] },
    { ...baseRow, itemNumber: 3, registerItemId: "00000000-0000-4000-8000-000000000012", description: "Hydrant valve test report and commissioning record", clauseReference: "0711/4.3 TESTING", requiredEvidence: "test report", status: "human_approved", overdue: false, dueDate: null, physicalDeliverables: [] },
  ],
  logoDocument: null,
};

async function main() {
  const outputDir = resolve(process.cwd(), "..", "output", "pdf");
  await mkdir(outputDir, { recursive: true });
  const rendered = await renderPackagePdf(snapshot, []);
  const output = resolve(outputDir, "submittal-package-fixture.pdf");
  await writeFile(output, rendered.bytes);
  console.log(`${output}\n${rendered.pageCount} pages`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
