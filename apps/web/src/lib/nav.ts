// Sprint 13: the navigation model, kept as pure functions so it can be
// unit-tested without a browser. Hiding a link here is UX only - every
// vendor/branch route is still authorized by the backend
// (VendorMembershipGuard); nothing in this file is a security boundary.

export type PlatformRoleName = "PLATFORM_ADMIN" | "VERIFICATION_REVIEWER";

export type WorkspaceInfo =
  | { type: "customer" }
  // Sprint 16: platform staff (reviewer / admin). The API only sends this
  // entry to a user who actually holds a platform role.
  | { type: "platform"; role: PlatformRoleName }
  | {
      type: "vendor";
      vendor_id: string;
      vendor_legal_name: string;
      storefront_slug: string;
      role: "OWNER" | "BRANCH_EMPLOYEE";
      branch_id: string | null;
      branch_name: string | null;
      // Sprint 18b (G-IN-05): SUSPENDED only ever occurs for
      // role=BRANCH_EMPLOYEE (enforced at the DB level) - workspaceEntry()
      // below renders this as a disabled card with a reason, never a
      // normal actionable link (product decision: show it, don't hide it).
      status: "ACTIVE" | "SUSPENDED";
    };

export interface NavLink {
  key: "home" | "discover" | "cart" | "orders" | "following" | "account";
  href: string;
  label: string;
}

const HOME: NavLink = { key: "home", href: "/", label: "الرئيسية" };
const DISCOVER: NavLink = { key: "discover", href: "/discovery", label: "اكتشف" };
const CART: NavLink = { key: "cart", href: "/cart", label: "السلة" };
const ORDERS: NavLink = { key: "orders", href: "/cart?tab=orders", label: "طلباتي" };
// Saved stores now live inside the private shopping profile, alongside
// favourites. Keep the destination explicit so the profile opens on its
// relevant tab rather than showing a disconnected standalone page.
const FOLLOWING: NavLink = { key: "following", href: "/profile?tab=following", label: "أتابعه" };

/** Desktop header links, in display order. */
export function desktopLinks(): NavLink[] {
  return [HOME, DISCOVER, CART, ORDERS, FOLLOWING];
}

/** Mobile bottom-navigation tabs, in display order. */
export function mobileTabs(loggedIn: boolean): NavLink[] {
  return [
    HOME,
    DISCOVER,
    CART,
    ORDERS,
    {
      key: "account",
      href: loggedIn ? "/account" : "/login",
      label: "حسابي",
    },
  ];
}

export interface WorkspaceEntry {
  id: string;
  label: string;
  subtitle: string;
  href: string;
  kind: "customer" | "owner" | "employee" | "platform";
  // Sprint 18b: true only for a SUSPENDED branch-employee membership -
  // the switcher renders this entry as a disabled card (no navigation),
  // not a normal clickable workspace.
  disabled?: boolean;
}

/**
 * Where choosing a workspace takes you. An owner lands on the store
 * dashboard; an employee first sees their store's public storefront. Their
 * own branch operations are exposed there as a staff-only control, never as
 * an owner-only route.
 */
export function workspaceEntry(w: WorkspaceInfo): WorkspaceEntry {
  if (w.type === "customer") {
    return {
      id: "customer",
      label: "التسوّق",
      subtitle: "تصفّح ومقارنة وشراء",
      href: "/profile",
      kind: "customer",
    };
  }
  if (w.type === "platform") {
    return {
      id: "platform",
      label: "إدارة المنصة",
      subtitle:
        w.role === "PLATFORM_ADMIN" ? "مدير المنصة" : "مراجع التحقق",
      href: w.role === "PLATFORM_ADMIN" ? "/admin" : "/admin/verification",
      kind: "platform",
    };
  }
  if (w.role === "OWNER") {
    return {
      id: `vendor:${w.vendor_id}`,
      label: w.vendor_legal_name,
      subtitle: "مالك المتجر - لوحة المتجر",
      // 2026-11-24: straight to the store page (the owner's entry) - never
      // through the old /vendor/<id> redirect, whose wait showed the legacy bar
      href: w.storefront_slug ? `/store/${w.storefront_slug}` : `/vendor/${w.vendor_id}`,
      kind: "owner",
    };
  }
  if (w.status === "SUSPENDED") {
    return {
      id: `vendor:${w.vendor_id}`,
      label: w.vendor_legal_name,
      subtitle: `حسابك في هذا الفرع معلّق من صاحب المتجر${w.branch_name ? ` (${w.branch_name})` : ""}`,
      href: "/account",
      kind: "employee",
      disabled: true,
    };
  }
  return {
    id: `vendor:${w.vendor_id}`,
    label: w.vendor_legal_name,
    subtitle: `موظف فرع${w.branch_name ? ` - ${w.branch_name}` : ""}`,
    href: `/store/${w.storefront_slug}`,
    kind: "employee",
  };
}

/** Whether `href` is the current section for the given pathname. */
export function isActivePath(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export interface HubTile {
  href: string;
  title: string;
  description: string;
  /** a deferred tool: last in the grid and visually quiet */
  deferred?: boolean;
}

/** The owner dashboard's direct links (owner only - see the hub page). */
export function ownerHubTiles(vendorId: string): HubTile[] {
  const base = `/vendor/${vendorId}`;
  return [
    // 2026-11-23 «صفحتي»: the store page's identity (name, logo, cover,
    // contact, link, publishing) and - from its «الرئيسية» action - the home
    // page designer, in the same management window. One card for both.
    { href: `${base}/storefront`, title: "صفحتي", description: "الشعار والغلاف ومعلومات المتجر وحالته وتصميم صفحتك الرئيسية" },
    // «مجموعات المتجر» are reached from «المنتجات والعروض» (its toolbar), not a tile of their own.
    { href: `${base}/offers`, title: "المنتجات والعروض", description: "قائمة عروض المتجر وحالتها" },
    // 2026-11-23: «إدارة الفروع» holds each branch's daily tools (orders - with
    // the owner's «كل الفروع» -, stock, delivery, hours, returns and the
    // return-code redeem), «إعدادات الفرع» and «إعدادات المتجر» (delivery
    // zones and fees, the return policy). Their old cards are gone; the old
    // addresses redirect there.
    // 2026-11-23: «الموظفون» is a tab of «إدارة الفروع» (owner only) and
    // «حالة التحقق» is «حالة المتجر» inside «صفحتي» - no cards of their own.
    { href: `${base}/branches`, title: "إدارة الفروع", description: "طلبات الفروع ومخزونها وتوصيلها وساعاتها وإرجاعاتها وموظفوها، وإعدادات المتجر" },
    // 2026-11-23 «أداء المتجر»: ONE card for the performance indicators,
    // the sales (online in the last 30 days, the shop's sales log), the
    // customers' reviews and the shop's quick tools (labels, the cashier).
    // The old cards (تقييمات العملاء، مبيعات آخر 30 يوماً، مبيعات المحل،
    // طباعة ملصقات) are gone; their old addresses open the right view.
    { href: `${base}/performance`, title: "أداء المتجر", description: "المؤشرات والمبيعات وتقييمات العملاء وأدوات المحل" },
    // Deferred (2026-11-20): kept and still openable, but last and muted -
    // it may be removed later and must not compete with the active tiles.
    { href: `${base}/match-review`, title: "مراجعة التطابق", description: "مرشّحو التطابق غير الدقيق بانتظار قرارك", deferred: true },
  ];
}

/**
 * Sprint 16: the admin workspace's tiles. A verification reviewer gets
 * the queue only; a platform admin also gets vendors and rename
 * requests. Hiding is UX only - every /admin API route is authorized by
 * PlatformRoleGuard on the server.
 */
export function adminTiles(role: PlatformRoleName): HubTile[] {
  const tiles: HubTile[] = [
    {
      href: "/admin/verification",
      title: "طابور التحقق",
      description: "أدلة الفروع والمستودعات بانتظار القرار",
    },
  ];
  if (role === "PLATFORM_ADMIN") {
    tiles.push(
      {
        href: "/admin/vendors",
        title: "المتاجر",
        description: "قائمة المتاجر وتعليقها وإعادة تفعيلها",
      },
      {
        href: "/admin/name-change-requests",
        title: "طلبات تغيير الاسم",
        description: "طلبات تغيير أسماء المنتجات الأساسية",
      },
      // Sprint 17b: the platform catalog - categories/brands/canonical
      // products - PLATFORM_ADMIN only (a reviewer has no catalog-edit
      // role per Part 1's role table).
      {
        href: "/admin/categories",
        title: "التصنيفات",
        description: "شجرة تصنيفات المنتجات، إنشاؤها وتقييدها وحذفها",
      },
      {
        href: "/admin/brands",
        title: "العلامات التجارية",
        description: "قائمة العلامات التجارية وإضافتها",
      },
      {
        href: "/admin/canonical-products",
        title: "المنتجات المرجعية",
        description: "حالات المنتجات المرجعية، متغيّراتها، دمجها وتقسيمها",
      },
      // Sprint 20a (BR-019): the admin's break-glass override on a
      // single BranchOrder - PLATFORM_ADMIN only, same reasoning as
      // every other admin-only tile above.
      {
        href: "/admin/branch-orders",
        title: "إلغاء/استرداد الطلبات",
        description: "إلغاء قسري أو استرداد يدوي لطلب فرع محدد",
      },
      // Sprint 21 (EPIC-RET, PDR-031): the Return state machine's own
      // escalation queue - PLATFORM_ADMIN only, same break-glass shape
      // as the branch-order override above.
      {
        href: "/admin/returns",
        title: "الإرجاعات المتصاعدة",
        description: "إرجاعات اعترض عليها العميل أو تجاوزت مهلة المتجر، بانتظار قرارك",
      },
      // Sprint 23 (PDR-032, EPIC-REV): the review-report queue -
      // PLATFORM_ADMIN only (no separate content-moderator role exists
      // in this codebase).
      {
        href: "/admin/reviews",
        title: "بلاغات المراجعات",
        description: "مراجعات عليها بلاغ معلَّق، بانتظار تجاهله أو إخفاء المراجعة",
      },
      // Sprint 25 (FR-ADMIN-005): سجل التدقيق الكامل - PLATFORM_ADMIN
      // فقط، بحث/تصدير عبر كل الكيانات المتتبَّعة.
      {
        href: "/admin/audit-logs",
        title: "سجل التدقيق",
        description: "بحث وتصدير سجل كل العمليات المتتبَّعة في النظام",
      },
      // Sprint 25 (FR-ADMIN-004): تبديل الأعلام المعتمدة - PLATFORM_ADMIN
      // فقط، registry ثابت في الكود لا إنشاء حر.
      {
        href: "/admin/feature-flags",
        title: "أعلام الميزات",
        description: "تفعيل أو تعطيل الميزات المعتمدة",
      },
      // Sprint 25 (FR-VEND-011): مؤشرات أداء كل متجر - PLATFORM_ADMIN فقط.
      {
        href: "/admin/vendors/performance",
        title: "أداء المتاجر",
        description: "معدل الإلغاء وزمن الاستجابة والتقييم لكل متجر",
      },
      // PD-4: أدلة المقاسات وطلبات المتاجر - PLATFORM_ADMIN فقط.
      {
        href: "/admin/size-guides",
        title: "أدلة المقاسات",
        description: "إنشاء أدلة المقاسات ونشرها وربطها بالتصنيفات، وطلبات المتاجر",
      },
      // PD-5b: مجموعات المنصة التحريرية - PLATFORM_ADMIN فقط.
      {
        href: "/admin/collections",
        title: "مجموعات المنصة",
        description: "مجموعات تحريرية من المنتجات، نشرها وأرشفتها وترتيبها",
      },
      // TB-12.3: مستلمو تنبيهات المنصة لكل فئة - PLATFORM_ADMIN فقط.
      {
        href: "/admin/alert-recipients",
        title: "مستلمو تنبيهات المنصة",
        description: "من يستقبل تنبيهات سلامة الطلبات وتصعيد الإرجاعات",
      },
    );
  }
  return tiles;
}
