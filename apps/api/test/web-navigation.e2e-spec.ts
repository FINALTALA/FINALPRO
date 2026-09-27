import { existsSync } from 'fs';
import * as path from 'path';
import {
  WorkspaceInfo,
  adminTiles,
  desktopLinks,
  isActivePath,
  mobileTabs,
  ownerHubTiles,
  workspaceEntry,
} from '../../web/src/lib/nav';

const WEB_APP = path.resolve(__dirname, '..', '..', 'web', 'src', 'app');

// Maps a concrete href (with a real vendor/branch id substituted) to the
// Next.js page file that must exist for it.
function pageFileFor(href: string, ids: Record<string, string>): string {
  let route = href.split('?')[0];
  for (const [placeholder, id] of Object.entries(ids)) {
    route = route.split(`/${id}`).join(`/[${placeholder}]`);
  }
  return path.join(WEB_APP, route === '/' ? '' : route, 'page.tsx');
}

describe('Sprint 13 - web navigation model', () => {
  const VENDOR = 'v-123';
  const BRANCH = 'b-456';

  it('mobile bottom navigation is exactly: home, discover, cart, orders, account', () => {
    expect(mobileTabs(true).map((t) => t.key)).toEqual([
      'home',
      'discover',
      'cart',
      'orders',
      'account',
    ]);
    expect(mobileTabs(true).map((t) => t.label)).toEqual([
      'الرئيسية',
      'اكتشف',
      'السلة',
      'طلباتي',
      'حسابي',
    ]);
  });

  it('the account tab goes to sign in for a guest and to the account page when signed in', () => {
    expect(mobileTabs(false).find((t) => t.key === 'account')?.href).toBe(
      '/login',
    );
    expect(mobileTabs(true).find((t) => t.key === 'account')?.href).toBe(
      '/account',
    );
  });

  it('the desktop header links home, discover, cart, orders and following (أتابعه)', () => {
    expect(desktopLinks().map((l) => l.href)).toEqual([
      '/',
      '/discovery',
      '/cart',
      '/orders',
      '/following',
    ]);
    expect(desktopLinks().find((l) => l.key === 'following')?.label).toBe(
      'أتابعه',
    );
  });

  it('every primary nav destination is a real page', () => {
    const hrefs = [
      ...desktopLinks().map((l) => l.href),
      ...mobileTabs(true).map((t) => t.href),
      ...mobileTabs(false).map((t) => t.href),
      '/register',
    ];
    for (const href of hrefs) {
      expect(existsSync(pageFileFor(href, {}))).toBe(true);
    }
  });

  describe('workspace switcher', () => {
    const owner: WorkspaceInfo = {
      type: 'vendor',
      vendor_id: VENDOR,
      vendor_legal_name: 'متجر',
      role: 'OWNER',
      branch_id: null,
      branch_name: null,
    };
    const employee: WorkspaceInfo = {
      type: 'vendor',
      vendor_id: VENDOR,
      vendor_legal_name: 'متجر',
      role: 'BRANCH_EMPLOYEE',
      branch_id: BRANCH,
      branch_name: 'الفرع الرئيسي',
    };

    it('customer shops; owner lands on the store dashboard; employee lands on their own branch orders only', () => {
      expect(workspaceEntry({ type: 'customer' })).toMatchObject({
        kind: 'customer',
        href: '/',
      });
      expect(workspaceEntry(owner)).toMatchObject({
        kind: 'owner',
        href: `/vendor/${VENDOR}`,
      });
      expect(workspaceEntry(employee)).toMatchObject({
        kind: 'employee',
        href: `/vendor/${VENDOR}/branches/${BRANCH}/orders`,
      });
    });

    it('an employee entry never points at an owner-only page', () => {
      const href = workspaceEntry(employee).href;
      expect(href).not.toBe(`/vendor/${VENDOR}`);
      for (const tile of ownerHubTiles(VENDOR)) {
        if (tile.href.endsWith('/orders') && tile.href.includes('/branches/')) {
          continue;
        }
        expect(href).not.toBe(tile.href);
      }
    });

    it('an employee without an assigned branch is sent to the account page, not an owner page', () => {
      expect(workspaceEntry({ ...employee, branch_id: null }).href).toBe(
        '/account',
      );
    });
  });

  describe('owner dashboard', () => {
    it('links directly to store, sections, offers, branches, zones, windows and orders', () => {
      expect(ownerHubTiles(VENDOR).map((t) => t.href)).toEqual([
        `/vendor/${VENDOR}/storefront`,
        `/vendor/${VENDOR}/sections`,
        `/vendor/${VENDOR}/offers`,
        `/vendor/${VENDOR}/branches`,
        `/vendor/${VENDOR}/delivery-zones`,
        `/vendor/${VENDOR}/delivery-windows`,
        `/vendor/${VENDOR}/orders`,
        `/vendor/${VENDOR}/verification`,
      ]);
    });

    it('every dashboard tile, the hub itself and the per-branch pages are real pages', () => {
      const ids = { vendorId: VENDOR, branchId: BRANCH };
      const hrefs = [
        `/vendor/${VENDOR}`,
        ...ownerHubTiles(VENDOR).map((t) => t.href),
        `/vendor/${VENDOR}/branches/${BRANCH}/orders`,
        `/vendor/${VENDOR}/branches/${BRANCH}/delivery-windows`,
      ];
      for (const href of hrefs) {
        expect(existsSync(pageFileFor(href, ids))).toBe(true);
      }
    });
  });

  describe('Sprint 16 - platform (admin / reviewer) workspace', () => {
    const reviewer: WorkspaceInfo = {
      type: 'platform',
      role: 'VERIFICATION_REVIEWER',
    };
    const admin: WorkspaceInfo = { type: 'platform', role: 'PLATFORM_ADMIN' };

    it('a reviewer lands on the verification queue and an admin on the admin hub', () => {
      expect(workspaceEntry(reviewer)).toMatchObject({
        kind: 'platform',
        href: '/admin/verification',
      });
      expect(workspaceEntry(admin)).toMatchObject({
        kind: 'platform',
        href: '/admin',
      });
    });

    it('a reviewer sees only the queue; an admin also sees vendors and rename requests', () => {
      expect(adminTiles('VERIFICATION_REVIEWER').map((t) => t.href)).toEqual([
        '/admin/verification',
      ]);
      expect(adminTiles('PLATFORM_ADMIN').map((t) => t.href)).toEqual([
        '/admin/verification',
        '/admin/vendors',
        '/admin/name-change-requests',
      ]);
    });

    it('every admin tile, the hub and the detail pages are real pages, and no admin tile points at an owner page', () => {
      const ids = { vendorId: VENDOR };
      const hrefs = [
        '/admin',
        ...adminTiles('PLATFORM_ADMIN').map((t) => t.href),
        `/admin/verification/${VENDOR}`,
        `/admin/vendors/${VENDOR}`,
      ];
      for (const href of hrefs) {
        expect(existsSync(pageFileFor(href, ids))).toBe(true);
      }
      for (const t of adminTiles('PLATFORM_ADMIN')) {
        expect(t.href.startsWith('/vendor/')).toBe(false);
      }
    });
  });

  describe('isActivePath', () => {
    it('matches sections by prefix, but home only exactly', () => {
      expect(isActivePath('/', '/')).toBe(true);
      expect(isActivePath('/discovery', '/')).toBe(false);
      expect(isActivePath('/discovery', '/discovery')).toBe(true);
      expect(isActivePath('/store/x/products/1', '/discovery')).toBe(false);
      expect(isActivePath('/following', '/following')).toBe(true);
      expect(isActivePath('/orders/123', '/orders')).toBe(true);
    });
  });
});
