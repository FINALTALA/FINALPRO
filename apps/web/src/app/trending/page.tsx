import { EmptyState } from "@/components/States";

// A deliberately quiet placeholder: the home navigation can link here
// without a 404 while the Trending product scope is planned separately.
export default function TrendingPage() {
  return (
    <div className="page-shell">
      <EmptyState
        title="الترند قريباً"
        message="نعمل على تجهيز هذه المساحة لاكتشاف الاختيارات الرائجة."
        actionHref="/"
        actionLabel="العودة للرئيسية"
      />
    </div>
  );
}
