export interface CoverSheetModel {
  companyName: string;
  legalName: string | null;
  abn: string | null;
  logoDocumentId: string | null;
  primaryColour: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  projectName: string;
  clientName: string | null;
  siteAddress: string | null;
  trade: string;
  preparedBy: string | null;
}

export interface PackageDocumentRef {
  id: string;
  title: string;
  originalFilename: string | null;
  mimeType: string | null;
  storageBucket: string;
  objectKey: string;
  checksumSha256: string | null;
  role: string;
  sequence: number;
  registerItemId: string | null;
}

export interface PhysicalLineItem {
  id: string;
  kind: string;
  description: string | null;
  status: string;
  responsibleParty: string | null;
  dueDate: string | null;
  notes: string | null;
  attachmentDocumentId: string | null;
}

export interface RegisterRow {
  itemNumber: number;
  registerItemId: string;
  description: string;
  worksection: string | null;
  clauseReference: string | null;
  clauseLocation: string | null;
  requiredEvidence: string;
  status: string;
  responsibleParty: string | null;
  dueDate: string | null;
  overdue: boolean;
  productName: string | null;
  vendorName: string | null;
  included: boolean;
  manualNotes: string | null;
  documents: PackageDocumentRef[];
  physicalDeliverables: PhysicalLineItem[];
}

export interface PackageSnapshot {
  tenantId: string;
  projectId: string;
  packageId: string | null;
  packageName: string;
  version: number;
  generatedAt: string;
  cover: CoverSheetModel;
  rows: RegisterRow[];
  logoDocument: PackageDocumentRef | null;
}

export interface LoadedDocument {
  ref: PackageDocumentRef;
  bytes: Uint8Array | null;
  error?: string;
}

export interface ArtifactWarning {
  documentId: string;
  title: string;
  reason: string;
}

export interface RenderedPdf {
  bytes: Uint8Array;
  pageCount: number;
  warnings: ArtifactWarning[];
}
