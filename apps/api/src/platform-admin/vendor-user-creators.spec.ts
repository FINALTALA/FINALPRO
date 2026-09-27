import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

const SRC = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
  });
}

// Sprint 16 (D4): a platform reviewer/admin who becomes a member of a
// store must be ordered against every moderation action on that store
// through the `vendors ... FOR UPDATE` row lock. That holds only if EVERY
// code path that creates a VendorUser either takes that lock or provably
// cannot race a moderation action. Exactly two paths exist today:
//  - vendors/vendors.controller.ts (apply): creates the OWNER row in the
//    same transaction as a brand-new vendor - nothing can moderate a
//    vendor that is not committed yet;
//  - auth/auth.controller.ts (acceptStaffInvite): takes the vendor lock
//    immediately before the insert.
// A new creator fails this test on purpose: whoever adds it must decide
// how it is ordered against moderation, then extend this list.
const KNOWN_VENDOR_USER_CREATORS = [
  'auth/auth.controller.ts',
  'vendors/vendors.controller.ts',
];

describe('VendorUser creators (conflict-of-interest ordering)', () => {
  it('are exactly the two known, reviewed code paths', () => {
    const found = sourceFiles(SRC)
      .filter((f) =>
        /vendorUser\s*\.\s*(create|createMany|upsert)\s*\(/.test(
          readFileSync(f, 'utf8'),
        ),
      )
      .map((f) => relative(SRC, f).split(sep).join('/'))
      .sort();
    expect(found).toEqual(KNOWN_VENDOR_USER_CREATORS);
  });

  it('acceptStaffInvite takes the vendor row lock before creating the membership', () => {
    const src = readFileSync(join(SRC, 'auth', 'auth.controller.ts'), 'utf8');
    const lock = src.indexOf(
      'FROM vendors WHERE id = ${invite.vendorId} FOR UPDATE',
    );
    const create = src.indexOf('tx.vendorUser.create(');
    expect(lock).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(lock);
  });
});
