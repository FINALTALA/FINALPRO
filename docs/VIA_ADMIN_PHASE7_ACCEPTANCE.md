# VIA Admin — Phase 7 focused acceptance

Repository: `C:\fpwt\FINALPRO-v1-local` · Branch: `feat/homepage-v1-updates`

**41/41 executed tests passed. No reproducible product defect or technical blocker was confirmed within this scope. Full Phase 7 acceptance remains open.**

## PASS — latest isolated API run

| Suite in `apps/api/test/` | Result | Evidence |
| --- | --- | --- |
| `users-settings-3.e2e-spec.ts` | 9 passed, 4 skipped | Admin authorization, suspension, session invalidation, protected admins and sole-owner concurrency. |
| `admin-orders-2d.e2e-spec.ts` | 2 passed, 4 skipped | Forced cancellation displays refund and history. Admin’s own order offers no forced cancel. |
| `analytics-4.e2e-spec.ts` | 5 passed, 2 skipped | Refund and fee accounting, dashboard eligibility and held offers, reporting periods, CSV/XLSX figures and permissions. |
| `sprint25-admin-audit-flags-vendor-performance.e2e-spec.ts` | 25 passed | Flag permissions, unknown keys, audited changes, no-ops and concurrent writes. The file-level filter also ran the remaining Sprint 25 audit and vendor-performance cases. |

Runs used marked disposable databases, dedicated Redis and temporary media storage. Initial Postgres readiness and Windows test-filter errors occurred before the affected tests ran. Corrected runs passed. No development data changed.

## PASS — reused evidence

- Offer moderation: Phase 2C API 16/16 and Chrome 6/6, with 41/41 in a separate moderation and exchange follow-up. Fixtures cover held offers disappearing from public results, cart and checkout rejection, stock recovery, and confirmed-order preservation.
- Media Library: Phase 5 API 9/9 and Chrome 3/3. Content Studio: Phase 6 core API 8/8 and Chrome 4/4; audience extension API 3/3 and Chrome 4/4. Recorded coverage includes draft privacy, signed-to-public media, usage protection, scheduling, restores and public text/media parity. Counts are historical and separate from the latest 41.

## UNVERIFIED

- Full module-by-module manual acceptance and current real-catalogue customer search and checkout against eligible offers.
- Manual image and video upload and playback. Firefox and Safari/WebKit coverage is incomplete.
- Original approved Codex specification has not been recovered. Acceptance against its full requirements remains unverified.
- Trending Pieces currently renders static curated cards in `apps/web/src/components/trend/TrendPieces.tsx`. A change to its selection or design awaits a product decision. This is not a confirmed runtime defect.

## BLOCKED — data or editorial action

- Men and Kids are not imported. A platform admin must perform the intended imports and compare public pages before and after. Confirm Women’s current import status independently.
- Trending has 20 English suggestions awaiting owner review. Saving and publishing are separate intentional steps.
- Ads has no eligible published featured store. Curated cards remain the fallback until an eligible storefront is available.

## FAIL

None confirmed. Record a failure only when the product behavior is reproducible with the route, role, steps, expected result and actual result.

[Manual checklist](VIA_ADMIN_MANUAL_ACCEPTANCE_CHECKLIST.md) · [Handoff](VIA_ADMIN_CLAUDE_HANDOFF.md)
