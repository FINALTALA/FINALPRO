"use client";

import Link from "next/link";
import { EmptyState } from "@/components/States";
import { adminTiles } from "@/lib/nav";
import { useAdminGate } from "@/lib/useAdminGate";

// Sprint 16 (SRS-K1A-11): the platform workspace hub. A reviewer sees the
// verification queue; a platform admin also sees vendors and rename
// requests. Hiding a tile is UX only - the API authorizes every route.
export default function AdminHubPage() {
  const gate = useAdminGate();

  if (gate.status === "loading") {
    return (
      <div className="page-shell">
        <div className="skeleton" style={{ height: 120, width: "100%", maxWidth: 1000 }} />
      </div>
    );
  }
  if (gate.status === "forbidden") {
    return (
      <div className="page-shell">
        <EmptyState
          title="هذه الصفحة لموظفي المنصة فقط"
          actionHref="/account"
          actionLabel="حسابي"
        />
      </div>
    );
  }

  return (
    <div className="page-shell">
      <div className="wide-shell" style={{ maxWidth: 1000 }}>
        <div className="top-bar">
          <div>
            <h1 className="page-title" style={{ margin: 0 }}>إدارة المنصة</h1>
            <span className="badge badge-active">
              {gate.role === "PLATFORM_ADMIN" ? "مدير المنصة" : "مراجع التحقق"}
            </span>
          </div>
        </div>
        <div className="hub-grid">
          {adminTiles(gate.role).map((t) => (
            <Link key={t.href} href={t.href} className="hub-tile">
              <strong>{t.title}</strong>
              <span>{t.description}</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
