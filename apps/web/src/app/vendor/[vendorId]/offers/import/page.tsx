"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorBanner } from "@/components/States";
import { apiFetch, ApiError } from "@/lib/api";
import { getSessionToken } from "@/lib/session";

interface ImportRowResult {
  row_number: number;
  reason?: string;
  offer_id?: string;
}

interface ImportReport {
  total_rows: number;
  imported: { row_number: number; offer_id: string; variant_id: string }[];
  skipped_already_imported: ImportRowResult[];
  invalid_rows: ImportRowResult[];
  conflicts: ImportRowResult[];
  batch_id: string;
  failed_rows_csv: string | null;
}

interface BatchDto {
  id: string;
  file_name: string;
  status: string;
  total_rows: number;
  imported_count: number | null;
  skipped_count: number | null;
  invalid_count: number | null;
  conflict_count: number | null;
  created_at: string;
}

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api/v1";

function downloadText(filename: string, content: string, mime = "text/csv") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Sprint 17 (D6, blocker 3): the owner's CSV/XLSX import screen -
// template download, upload with the full report (imported/skipped/
// invalid/conflicts), an immediate failed_rows_csv re-download, and
// batch history (counts + status only, per ImportBatch's own scope).
export default function ImportOffersPage() {
  const params = useParams<{ vendorId: string }>();
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [batches, setBatches] = useState<BatchDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  function loadBatches() {
    apiFetch<BatchDto[]>(`/vendors/${params.vendorId}/offers/import/batches`)
      .then(setBatches)
      .catch(() => {});
  }

  useEffect(() => {
    if (!getSessionToken()) {
      router.replace("/login");
      return;
    }
    loadBatches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.vendorId]);

  async function downloadTemplate() {
    try {
      const res = await apiFetch<{ csv: string }>(`/vendors/${params.vendorId}/offers/import/template`);
      downloadText("import-template.csv", res.csv);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر تحميل القالب");
    }
  }

  async function upload() {
    if (!file) {
      setError("اختاري ملف CSV أو XLSX أولًا");
      return;
    }
    setUploading(true);
    setError(null);
    setReport(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const token = getSessionToken();
      const res = await fetch(`${API_BASE_URL}/vendors/${params.vendorId}/offers/import`, {
        method: "POST",
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "Idempotency-Key": `import-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        },
        body: form,
      });
      const text = await res.text();
      const parsed = text ? JSON.parse(text) : {};
      if (!res.ok) {
        throw new ApiError(
          res.status,
          parsed?.error?.code ?? "UNKNOWN_ERROR",
          parsed?.error?.message ?? "تعذّر رفع الملف",
        );
      }
      setReport(parsed as ImportReport);
      loadBatches();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر رفع الملف");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="page-shell">
      <div className="top-bar">
        <h1 className="page-title" style={{ margin: 0 }}>استيراد المنتجات (CSV/XLSX)</h1>
        <Link href={`/vendor/${params.vendorId}/offers`} className="button-link">
          العودة للقائمة
        </Link>
      </div>
      {error && <ErrorBanner message={error} />}

      <div className="card" style={{ maxWidth: 560 }}>
        <h3 style={{ marginTop: 0 }}>1. حمّلي القالب</h3>
        <button className="button-link" onClick={downloadTemplate}>
          تنزيل قالب CSV
        </button>
      </div>

      <div className="card" style={{ maxWidth: 560, marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>2. ارفعي الملف المعبّأ</h3>
        <input
          type="file"
          accept=".csv,.xlsx"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <div style={{ height: 10 }} />
        <button className="button" onClick={upload} disabled={uploading}>
          {uploading ? "جارٍ الرفع..." : "رفع واستيراد"}
        </button>
      </div>

      {report && (
        <div className="card" style={{ maxWidth: 560, marginTop: 16 }}>
          <h3 style={{ marginTop: 0 }}>نتيجة الاستيراد</h3>
          <p>إجمالي الصفوف: {report.total_rows}</p>
          <p>تم استيرادها: {report.imported.length}</p>
          <p>متجاهلة (مستوردة سابقًا): {report.skipped_already_imported.length}</p>
          <p>صفوف غير صالحة: {report.invalid_rows.length}</p>
          <p>تعارضات بحاجة مراجعة: {report.conflicts.length}</p>
          {report.failed_rows_csv && (
            <button
              className="button-link"
              onClick={() => downloadText("failed-rows.csv", report.failed_rows_csv!)}
            >
              تنزيل الصفوف الفاشلة لإعادة المحاولة
            </button>
          )}
        </div>
      )}

      <div className="wide-shell" style={{ marginTop: 16 }}>
        <h3>سجلّ عمليات الاستيراد</h3>
        {batches && batches.length === 0 && <p className="muted">لا توجد عمليات استيراد سابقة.</p>}
        {batches && batches.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>الملف</th>
                  <th>الحالة</th>
                  <th>الصفوف</th>
                  <th>مستوردة</th>
                  <th>غير صالحة</th>
                  <th>تعارضات</th>
                  <th>التاريخ</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id}>
                    <td>{b.file_name}</td>
                    <td>{b.status}</td>
                    <td>{b.total_rows}</td>
                    <td>{b.imported_count ?? "—"}</td>
                    <td>{b.invalid_count ?? "—"}</td>
                    <td>{b.conflict_count ?? "—"}</td>
                    <td>{new Date(b.created_at).toLocaleString("ar")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
