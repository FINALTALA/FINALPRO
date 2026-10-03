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
const ORDERS: NavLink = { key: "orders", href: "/orders", label: "طلباتي" };
const FOLLOWING: NavLink = { key: "following", href: "/following", label: "أتابعه" };

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
 * dashboard; an employee lands on their own branch's orders and nowhere
 * else - the entry never links to any owner-only page.
 */
export function workspaceEntry(w: WorkspaceInfo): WorkspaceEntry {
  if (w.type === "customer") {
    return {
      id: "customer",
      label: "التسوّق",
      subtitle: "تصفّح ومقارنة وشراء",
      href: "/",
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
      href: `/vendor/${w.vendor_id}`,
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
    href: w.branch_id
      ? `/vendor/${w.vendor_id}/branches/${w.branch_id}/orders`
      : "/account",
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
}

/** The owner dashboard's direct links (owner only - see the hub page). */
export function ownerHubTiles(vendorId: string): HubTile[] {
  const base = `/vendor/${vendorId}`;
  return [
    { href: `${base}/storefront`, title: "صفحة المتجر", description: "الاسم والشعار والغلاف والتواصل والنشر" },
    { href: `${base}/sections`, title: "الأقسام", description: "أقسام المنتجات في صفحة المتجر" },
    { href: `${base}/offers`, title: "المنتجات والعروض", description: "قائمة عروض المتجر وحالتها" },
    { href: `${base}/match-review`, title: "مراجعة التطابق", description: "مرشّحو التطابق غير الدقيق بانتظار قرارك" },
    { href: `${base}/branches`, title: "الفروع", description: "فروع المتجر وطلباتها ونوافذ توصيلها" },
    { href: `${base}/staff`, title: "الموظفون", description: "قائمة موظفي الفروع، نقلهم وتعليقهم" },
    { href: `${base}/delivery-zones`, title: "مناطق التوصيل", description: "الأسعار والمناطق المفعّلة" },
    { href: `${base}/delivery-windows`, title: "نوافذ التوصيل", description: "أوقات التوصيل وسعتها لكل فرع" },
    { href: `${base}/orders`, title: "الطلبات", description: "طلبات كل الفروع" },
    { href: `${base}/verification`, title: "حالة التحقق", description: "نتيجة مراجعة المتجر وملاحظات المراجع" },
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
    );
  }
  return tiles;
}
