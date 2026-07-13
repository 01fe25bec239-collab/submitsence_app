// Product extraction (B6-B7). Turns a tenant's uploaded catalogue / past-submittal document
// into structured product records: vendor, name, model, category, attributes, and
// standards/certificate references.
//
// ponytail: the default extractor handles STRUCTURED catalogues (CSV/spreadsheet rows - the
// non-PDF mime types the upload endpoint already allows). Extracting products from scanned
// PDFs needs an OCR/LLM step that MUST run on Australian-hosted/approved infra
// (compliance-security-handoff §5-6); that provider is not wired yet, so PDF input yields zero
// products with a recorded reason rather than a silent success. Swap in a real extractor by
// implementing CatalogueExtractor.

export interface ExtractedAttribute {
  key: string;
  value?: string | null;
  unit?: string | null;
  source?: string | null; // e.g. "row:12", "datasheet_p3"
}

export interface ExtractedProduct {
  vendorName: string;
  name: string;
  modelNumber?: string | null;
  category?: string | null;
  description?: string | null;
  attributes: ExtractedAttribute[];
  standards: string[];
}

export interface CatalogueSource {
  mimeType: string;
  rows?: Record<string, unknown>[]; // structured catalogue rows (CSV/xlsx already parsed to JSON)
  text?: string | null; // raw text (PDF/OCR path - not parsed by the default extractor)
}

export interface ExtractionResult {
  products: ExtractedProduct[];
  unsupportedReason?: string;
}

export interface CatalogueExtractor {
  extract(source: CatalogueSource): Promise<ExtractionResult>;
}

const STANDARD_RE = /\b(AS\/NZS|AS|ISO|IEC|EN|BS|UL|NFPA)\s?-?\s?\d{2,5}(?:[.:]\d+)*\b/gi;

// Detect standards/certificate codes (AS 1851, AS/NZS 3000, ISO 9001, ...) in free text.
// Returned in a normalised display form ("AS 1851"); dedup preserves first-seen order.
export function extractStandards(text: string | null | undefined): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(STANDARD_RE)) {
    const display = m[0].replace(/\s?-?\s?/, " ").replace(/\s+/g, " ").toUpperCase().trim();
    const key = display.replace(/[^A-Z0-9]/g, "");
    if (!seen.has(key)) {
      seen.add(key);
      out.push(display);
    }
  }
  return out;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

// Field aliases tolerate real-world catalogue header variance.
const FIELD_ALIASES: Record<keyof Pick<ExtractedProduct, "vendorName" | "name" | "modelNumber" | "category" | "description">, string[]> = {
  vendorName: ["vendor", "vendorname", "vendor_name", "manufacturer", "supplier", "brand"],
  name: ["name", "product", "productname", "product_name", "description", "item", "title"],
  modelNumber: ["model", "modelnumber", "model_number", "modelno", "sku", "partnumber", "part_number", "cat_no", "catalogue_no"],
  category: ["category", "type", "group", "class"],
  description: ["description", "details", "notes", "spec"],
};

function pick(row: Record<string, unknown>, aliases: string[]): string | null {
  const norm: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(row)) norm[k.toLowerCase().replace(/[^a-z0-9]/g, "")] = val;
  for (const a of aliases) {
    const hit = str(norm[a]);
    if (hit) return hit;
  }
  return null;
}

const KNOWN_KEYS = new Set(Object.values(FIELD_ALIASES).flat());

class StructuredCatalogueExtractor implements CatalogueExtractor {
  async extract(source: CatalogueSource): Promise<ExtractionResult> {
    if (!source.rows || source.rows.length === 0) {
      return {
        products: [],
        unsupportedReason: source.text
          ? "PDF/free-text catalogue extraction needs an Australian-hosted OCR/LLM provider (not yet wired)"
          : "No structured catalogue rows supplied",
      };
    }
    const products: ExtractedProduct[] = [];
    source.rows.forEach((row, i) => {
      const name = pick(row, FIELD_ALIASES.name);
      const vendorName = pick(row, FIELD_ALIASES.vendorName);
      if (!name || !vendorName) return; // a product needs at least a vendor + name
      const description = pick(row, FIELD_ALIASES.description);
      // Any non-standard column becomes a structured attribute (source-cited to its row).
      const attributes: ExtractedAttribute[] = [];
      for (const [k, val] of Object.entries(row)) {
        const nk = k.toLowerCase().replace(/[^a-z0-9]/g, "");
        const sval = str(val);
        if (!sval || KNOWN_KEYS.has(nk)) continue;
        attributes.push({ key: k.trim(), value: sval, source: `row:${i + 1}` });
      }
      const standardsText = [name, description, ...attributes.map((a) => `${a.key} ${a.value}`)].join(" ");
      products.push({
        vendorName,
        name,
        modelNumber: pick(row, FIELD_ALIASES.modelNumber),
        category: pick(row, FIELD_ALIASES.category),
        description,
        attributes,
        standards: extractStandards(standardsText),
      });
    });
    return { products };
  }
}

let active: CatalogueExtractor = new StructuredCatalogueExtractor();

export function getExtractor(): CatalogueExtractor {
  return active;
}

export function setExtractor(e: CatalogueExtractor): void {
  active = e;
}
