import { createRequire } from "node:module";
import type { Page } from "@playwright/test";

// The product import's two files for browser tests (images in bulk,
// 2026-11-18): an XLSX with «المنتجات», «الألوان والمقاسات» and «الصور», and
// a ZIP with each product's main image (a JPEG, or an iPhone HEIC header to
// be rejected) plus a file no row names. exceljs, jszip and sharp come from
// the workspace root (the API's dependencies).
const req = createRequire(__filename);
const ExcelJS = req("exceljs") as typeof import("exceljs");
const JSZip = req("jszip") as typeof import("jszip");
const sharp = req("sharp") as (input: object) => { jpeg(): { toBuffer(): Promise<Buffer> } };

export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export interface ImportProductSpec {
  title: string;
  /** colour name and family (Arabic, as in the template's list) */
  color: string;
  family: string;
  /** "heic": the image is an iPhone photo - the product is rejected */
  image?: "jpg" | "heic";
  /** a second colour with its own main image, and a shared image */
  second?: { color: string; family: string };
  shared?: boolean;
  /** the product's store barcode (the optional «الباركود» column) */
  barcode?: string;
}

const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic", "latin1"), Buffer.alloc(64)]);

export async function picture(r: number, g: number, b: number): Promise<Buffer> {
  return sharp({ create: { width: 60, height: 80, channels: 3, background: { r, g, b } } }).jpeg().toBuffer();
}

export async function importFiles(branchName: string, products: ImportProductSpec[], shade = 0) {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("المنتجات").addRows([
    ["رقم المنتج في الملف", "الاسم بالعربية", "الجمهور", "الفئة", "العلامة التجارية", "السعر", "نظام المقاسات", "الباركود"],
    ...products.map((p, i) => [i + 1, p.title, "نساء", "فساتين", "بدون علامة تجارية", 200 + i, "حروف", p.barcode ?? null]),
  ]);
  wb.addWorksheet("الألوان والمقاسات").addRows([
    ["رقم المنتج في الملف", "اسم اللون بالعربية", "عائلة اللون", "ترتيب اللون", "المقاس", `الكمية: ${branchName}`],
    ...products.flatMap((p, i) => [
      [i + 1, p.color, p.family, 1, "S", 3],
      ...(p.second ? [[i + 1, p.second.color, p.second.family, 2, "M", 2]] : []),
    ]),
  ]);
  const zip = new JSZip();
  const rows: (string | number | null)[][] = [];
  for (const [i, p] of products.entries()) {
    const n = i + 1;
    if (p.image === "heic") {
      rows.push([n, p.color, `p${n}.heic`, "رئيسية", null]);
      zip.file(`p${n}.heic`, HEIC);
      continue;
    }
    rows.push([n, p.color, `p${n}-main.jpg`, "رئيسية", null]);
    zip.file(`p${n}-main.jpg`, await picture((40 * n) % 255, 80, shade));
    if (p.second) {
      rows.push([n, p.second.color, `p${n}-second.jpg`, "رئيسية", null]);
      zip.file(`p${n}-second.jpg`, await picture(220, (30 * n) % 255, shade));
    }
    if (p.shared) {
      rows.push([n, null, `p${n}-shared.jpg`, "مشتركة", 1]);
      zip.file(`p${n}-shared.jpg`, await picture(30, 30, (50 * n + shade) % 255));
    }
  }
  wb.addWorksheet("الصور").addRows([["رقم المنتج في الملف", "اسم اللون بالعربية", "اسم ملف الصورة", "نوع الصورة", "الترتيب"], ...rows]);
  zip.file("not-used.jpg", await picture(1, 2, shade));
  return {
    xlsx: Buffer.from(await wb.xlsx.writeBuffer()),
    zip: await zip.generateAsync({ type: "nodebuffer" }),
  };
}

/** Chooses both files in the import screen. */
export async function chooseImportFiles(page: Page, f: { xlsx: Buffer; zip: Buffer }) {
  await page.locator('input[type="file"]').setInputFiles([
    { name: "products.xlsx", mimeType: XLSX_TYPE, buffer: f.xlsx },
    { name: "images.zip", mimeType: "application/zip", buffer: f.zip },
  ]);
}
