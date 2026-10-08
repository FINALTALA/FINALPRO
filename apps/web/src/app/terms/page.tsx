// Sprint 20b (FR-CART-012, platform terms only): a static page, no
// data fetch. The version string below MUST match
// CURRENT_PLATFORM_TERMS_VERSION in checkout/page.tsx and
// CheckoutService's own constant exactly - reserve() rejects a
// mismatch outright. This is a draft starting text, not a final
// legally-reviewed document (OPEN-009 is still unresolved) - bumping
// the version when the real text changes immediately invalidates
// every reservation already accepted under the old one.
const TERMS_VERSION = "2026-10-v1";

export default function TermsPage() {
  return (
    <div className="page-shell">
      <div className="top-bar">
        <div className="brand" style={{ margin: 0 }}>شروط الاستخدام</div>
      </div>
      <div style={{ maxWidth: 640, width: "100%" }} className="card">
        <p className="muted" style={{ marginTop: 0 }}>
          نسخة {TERMS_VERSION} - هذا نص مبدئي بانتظار المراجعة القانونية النهائية، وليس
          نصاً قانونياً ملزماً نهائياً.
        </p>

        <h3>1. استخدام المنصة</h3>
        <p>
          هذه المنصة تتيح للعملاء تصفح متاجر مستقلة والشراء منها. كل متجر مسؤول عن منتجاته
          وأسعاره وسياساته الخاصة بالقدر الذي ينص عليه القانون المعمول به.
        </p>

        <h3>2. الطلبات والدفع</h3>
        <p>
          بإرسال طلب، يوافق العميل على السعر المعروض وقت الطلب. الدفع إما نقداً عند
          الاستلام أو إلكترونياً حسب ما يوفره المتجر. لا تتحمل المنصة مسؤولية جودة
          المنتجات - هذه مسؤولية المتجر البائع.
        </p>

        <h3>3. الإلغاء والاسترداد</h3>
        <p>
          يخضع إلغاء الطلب واسترداد المبالغ المدفوعة إلكترونياً للسياسات المعروضة داخل
          التطبيق وقت الطلب.
        </p>

        <h3>4. حدود المسؤولية</h3>
        <p>
          تُقدَّم المنصة &quot;كما هي&quot; دون ضمانات من أي نوع فيما يخص توفر الخدمة بشكل متواصل أو
          خلوّها من الأخطاء.
        </p>

        <h3>5. التعديلات</h3>
        <p>
          يجوز تعديل هذه الشروط من وقت لآخر؛ يُطلب من العميل الموافقة على النسخة الحالية
          عند كل عملية شراء جديدة.
        </p>
      </div>
    </div>
  );
}
