// Sprint 13: the navigation model, kept as pure functions so it can be
// unit-tested without a browser. Hiding a link here is UX only - every
// vendor/branch route is still authorized by the backend
// (VendorMembershipGuard); nothing in this file is a security boundary.

export type WorkspaceInfo =
  | { type: "customer" }
  | {
      type: "vendor";
      vendor_id: string;
      vendor_legal_name: string;
      role: "OWNER" | "BRANCH_EMPLOYEE";
      branch_id: string | null;
      branch_name: string | null;
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
  kind: "customer" | "owner" | "employee";
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
  if (w.role === "OWNER") {
    return {
      id: `vendor:${w.vendor_id}`,
      label: w.vendor_legal_name,
      subtitle: "مالك المتجر - لوحة المتجر",
      href: `/vendor/${w.vendor_id}`,
      kind: "owner",
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
    { href: `${base}/branches`, title: "الفروع", description: "فروع المتجر وطلباتها ونوافذ توصيلها" },
    { href: `${base}/delivery-zones`, title: "مناطق التوصيل", description: "الأسعار والمناطق المفعّلة" },
    { href: `${base}/delivery-windows`, title: "نوافذ التوصيل", description: "أوقات التوصيل وسعتها لكل فرع" },
    { href: `${base}/orders`, title: "الطلبات", description: "طلبات كل الفروع" },
  ];
}
