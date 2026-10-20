import { EmptyState } from "@/components/States";

// A deliberately quiet placeholder: no advertising system or data is
// implied or invented until that product scope is planned separately.
export default function AdsPage() {
  return (
    <div className="page-shell">
      <EmptyState
        title="الإعلانات قريباً"
        message="هذه المساحة قيد التخطيط حالياً."
        actionHref="/"
        actionLabel="العودة للرئيسية"
      />
    </div>
  );
}
