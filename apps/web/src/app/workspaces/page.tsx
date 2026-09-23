"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Sprint 4 (RB-ROLE-005) built the workspace switcher here. Sprint 13
// moved it into the account page (and the header menu) so it is
// reachable from normal navigation; this route is kept so existing
// links and bookmarks keep working.
export default function WorkspacesPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/account");
  }, [router]);
  return (
    <div className="page-shell">
      <p className="muted">جارٍ التحويل إلى حسابي...</p>
    </div>
  );
}
