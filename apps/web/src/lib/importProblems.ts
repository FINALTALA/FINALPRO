"use client";

import { useEffect, useState } from "react";
import { authHeadersFor } from "./api";
import "./importText";
import { fill } from "./offerWizardText";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api/v1";

/** A problem of the product import, by sheet, row and column - or an image file of the ZIP. */
export interface ImportProblem {
  sheet: "products" | "versions" | "measurements" | "images" | "zip" | "file";
  row: number | null;
  column: string | null;
  code: string;
  value?: string;
  file?: string;
}

type T = (key: string) => string;

/** Where a problem is, in plain words: «الصور» · صف 5 · اسم ملف الصورة. */
export function problemWhere(t: T, p: ImportProblem): string {
  if (p.sheet === "zip") return p.file ? fill(t("imp.where_zip_file"), { file: p.file }) : t("imp.sheet.zip");
  const sheet = t(`imp.sheet.${p.sheet}`);
  if (p.row && p.column) return fill(t("imp.where"), { sheet, row: p.row, column: p.column });
  if (p.column) return fill(t("imp.where_sheet"), { sheet, column: p.column });
  if (p.row) return fill(t("imp.where_row"), { sheet, row: p.row });
  return sheet;
}

/** What is wrong, in plain words (a HEIC photo says it is an iPhone photo). */
export function problemMessage(t: T, p: ImportProblem): string {
  const key = p.code === "IMAGE_FORMAT" && p.value === "HEIC" ? "imp.e.IMAGE_FORMAT_HEIC" : `imp.e.${p.code}`;
  const words = t(key) !== key ? t(key) : t("imp.e.other");
  return fill(words, { value: p.value ?? "", file: p.file ?? p.value ?? "", gate: gateReason(t, p.value ?? "") });
}

/** A publish-gate code (STOCK_REQUIRED, COLOR_IMAGE_REQUIRED:c1, CHANGED, ...) as short words. */
export function gateReason(t: T, code: string): string {
  const base = code.split(":")[0];
  for (const key of [`bp.reason.${base}`, `imp.missing.${base}`]) if (t(key) !== key) return t(key);
  return t("imp.missing.other");
}

/**
 * An image the API serves only with the owner's session (the check's private
 * thumbnails): fetched with the session headers into an object URL that only
 * this page can show, released when the component goes away. null while
 * loading, when there is none, or when it is gone.
 */
export function useAuthedImage(path: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    let made: string | null = null;
    void fetch(`${API_BASE_URL}${path}`, { headers: authHeadersFor(path) })
      .then((res) => (res.ok ? res.blob() : null))
      .then((blob) => {
        if (!blob || cancelled) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [path]);
  return path ? url : null;
}
