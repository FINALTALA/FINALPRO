# FINALPRO — Requirement Traceability, September 2026

**Date:** 2026-09-26 (v4, three new product-owner decisions applied — see "v4 decisions applied" below; v3 was the arithmetic/coverage correction pass)
**Author:** Developer, for product-owner/Codex review.
**Status:** Read-only audit. No code, no migration, no commit/push is authorised by this record. No Sprint 15+ work is authorised by this record.
**Source:** `origin/main` @ `f92bf17` (Sprint 14 merged). Local tree matches it exactly.
**Scope:** the full SRS, Parts 0–9. Every `FR-*` ID in [SRS Part 2](srs/02-functional-requirements.md) (244 rows, including the E.0 September amendment), every `PDR-*` ID in [`approved-product-decisions-2026-09.md`](approved-product-decisions-2026-09.md) (36 rows, including the 2026-09-26 PDR-035/036 amendment), every `BR-*` (34) and `NFR-*` (32) in Part 3/4, and every remaining requirement, decision, screen, failure scenario, backlog item and state-machine transition in Parts 0, 1, and 3–9 — covered in the appendix starting at §6, with each ID-range explicitly expanded (no row stands for more than one ID; see §0 for the two narrow, explicitly-justified exceptions — the `O.1`/`O.2` test-level classification and the `BO`/module-matrix/recommendations rollup — neither of which carries an independent DONE/PARTIAL/MISSING status of its own).
**Update rule:** this file is reviewed again after every sprint. Each review edits it in place under a new dated version note, rather than creating a new file, so it stays the one living record.

## v17 — S25 closing review round applied, 2026-10-21

Product-owner-approved closing round for `S25`, after a full requirement-by-requirement review (SRS Part 2/5/8/9 + this file + the S25 code and tests). No new feature scope; every change below closes a gap that review found.

Fixed (backend):
- `FR-ADMIN-005`: **correlation-ID search** (Part 5 "Audit log" screen, Part 4 H.1) was missing - `?correlation_id=` was silently ignored and returned every row. Added to the one shared filter builder (`buildAuditLogWhere`), so `GET /admin/audit-logs` and `/export` both honour it identically. `AuditLog.correlationId` was already indexed - no migration.
- `FR-VEND-011` / `FR-VPORTAL-007(E.20)`: `GET /vendors/:id/performance` now also returns `terminal_orders_count`, `cancelled_orders_count` and `weekly` - the same 30-day window split into consecutive 7-day buckets (oldest = the 2-day remainder), each with the same null-not-zero rules - feeding the owner dashboard's charts. Computed from the rows already loaded; no new query.
- Not S25 code, found by re-running S16 here: `POST vendors/:vendorId/uploads` (S26, uncommitted) was missing from `SUSPENDED_DENY_ROUTES` (the controller already had `@BlockWhenSuspended()`); classified DENY alongside the media/storefront routes it feeds. That fix (and its S26 suspended-store test) ships with the S26 commit, not the S25 closing commit.

Fixed (frontend):
- `/admin/audit-logs`: correlation-ID filter field and a correlation-ID column; clicking an ID filters to every row written while serving that request. The CSV export sends the same filters.
- Owner `/vendor/:id` performance section (new `PerformanceSection.tsx`): loading skeleton, error state with **retry**, "لا توجد بيانات كافية بعد" when there are no finished/responded orders in the window, and two charts (weekly finished orders stacked completed/cancelled with a legend; weekly average response time) with per-week hover/focus tooltips and a "عرض البيانات كجدول" table fallback (Part 5: "charts include a data-table fallback"). Series colours validated (lightness, chroma, CVD ΔE 12.3, contrast) on the card surface. Still hidden entirely while the flag is off.

Fixed (tests):
- **Flaky test, root cause**: the feature flag is one global row and the spec never reset it - the "absent key" tests only passed by running first, the CONCURRENCY test's "never-configured key" premise was false, and its concurrent `true`/`false` pair left a random final state, so the next test ("gated by the feature flag", which assumes OFF) failed whenever `true` won (observed). Now every test starts and ends with no `FeatureFlag` row; AuditLog stays append-only - each test asserts only on the rows written during itself (baseline of pre-existing ids). The CONCURRENCY test now asserts its own premise (no row) before racing.
- New: 401 (no session) and 403 (`VERIFICATION_REVIEWER`) on all five S25 admin endpoints, and the refused PUTs change nothing; correlation-ID filter in list + CSV export + combined with another filter; weekly buckets tile the window exactly, place a back-dated order in its own week, use null-not-zero, and sum to the totals.

Product-owner decisions recorded this round:
- Feature flags stay **one global toggle**; Part 5's per-environment toggle is deferred (not built, not claimed).
- The audit-log `summary` allowlist stays at its two reviewed action types (`branch_order.status_changed`, `feature_flag.changed`); every other action keeps `summary: null`.
- The 17 S25-tagged rows never built in S25 are **moved out of S25** to three unscheduled backlog groups (rows updated in place): `BACKLOG-ADMIN` (FR-ADMIN-001/002/003/006/007, plus G-AD-03's remainder and G-AD-05), `BACKLOG-FINANCE` (FR-VEND-010, FR-IMPORT-013, FR-INV-008, FR-PAY-005/007/008), `BACKLOG-ANALYTICS` (FR-ANALYTICS-001..006). S25 is no longer accountable for them.
- `NFR-SEC-003` stays 🟡 PARTIAL: the audit-log retention duration (**OPEN-009**) remains an open decision.
- The **22 cross-cutting rows** still tagged S25 (BR-003, NFR-PERF-001/002/003, NFR-SCALE-001, NFR-IMPORT-001, NFR-REL-001/003, NFR-PRIV-001, NFR-A11Y-001, NFR-RTL-001, NFR-OBS-002, NFR-MAINT-001, NFR-TEST-001, NFR-AUDIT-001, SRS-H1-09, SRS-K1-STATES-01/03, L-28, L-30, SRS-N-05, SRS-P-15) are **moved to `BACKLOG-QUALITY (من S25)`** with their original ids and statuses unchanged - none is marked done; S25 is recorded as their source only. Every moved row (the 17 and these 22) now names S25 as its source the same way. `BL-ADMIN-003` keeps `S25` - it was delivered there (✅ DONE).

Correction to v16: v16 said no Playwright test existed for S25. The S25 review-round commit `1d21fda` added `apps/web/e2e/admin-audit-flags-vendor-performance-s25.spec.ts` (5 browser tests); all 5 were run and pass (Edge, isolated API + throwaway DB). v16's "+21" e2e count was also superseded by `1d21fda` (+1, CSV formula injection).

Verified this round (each run on its own fresh database): `sprint25-admin-audit-flags-vendor-performance.e2e-spec.ts` **25/25 on 7 of 8 runs** (was 21/22 and flaky); the one other run returned a single 500 in the CONCURRENCY test that never reproduced - 3 further runs with full server logs showed 0 server errors, and ~90 truly concurrent first-write races against a running API produced no 500 and never a duplicate row (the only failures were the API's own 100 req/min throttle tripped by the stress loop); the same "Server has closed the connection" signature seen in other suites on this Windows/Docker host is the suspected cause, not proven. `sprint16-vendor-route-classification` 4/4 (was 2/4); `sprint16-vendor-suspension` 22/22; `sprint26-storefront-profile` 14/14; `web-navigation` 13/13; Playwright S25 5/5 on a fresh database with the final UI; `nest build`, `next build`, `tsc`, `eslint` clean.

**20-run concurrency verification (product-owner requested, 2026-10-21)** - because one earlier run had returned a single 500 in the CONCURRENCY test. Method: 20 sequential runs of the **whole** S25 spec (the 500 was first seen in full-file context, not in isolation), each on its own freshly created and migrated database (`finalpro_c25_01..20`, `CREATE EXTENSION postgis` + `prisma migrate deploy`, Redis logical DB 9 flushed), command per run: `npx jest --config ./test/jest-e2e.json test/sprint25-admin-audit-flags-vendor-performance.e2e-spec.ts --runInBand --testTimeout=120000` with `DATABASE_URL` pointed at that run's database. For each run the API log (the Jest output - the Nest app runs in-process) and the PostgreSQL container log for that run's exact time window were kept; PostgreSQL `log_connections`/`log_disconnections` were switched on for the duration (and reset afterwards) so that any server-side drop would be visible.

Result: **20/20 runs green, 25/25 tests each; the CONCURRENCY test passed in all 20**; 0 `ERROR [HttpExceptionFilter]` lines, 0 "Server has closed the connection" lines across the 20 API logs; PostgreSQL logged 815 authorized connections and 837 normal disconnections (window overlap) with **0 abnormal ones** (no unexpected EOF, reset, receive failure or termination) and no FATAL/ERROR. Together with the ~90 truly concurrent first-write races against a running API (no 500, never a duplicate row) and the code path itself - `pg_advisory_xact_lock` taken before the row lookup, `create` only on the locked "absent" branch, the unique `key` constraint never reached - no reproducible code defect exists. The single earlier 500 is classified as an **external, transient connection drop**: its error text was Prisma's "Server has closed the connection", the same signature seen in unrelated suites on this Windows/Docker Desktop host (S24 comparison, S26 storefront) and never with a server-side cause in the PostgreSQL log. Not proven for that one run (its server log was not kept), and no code change was made for it.

Status changes:
- `FR-ADMIN-005` stays ✅ DONE - now including the correlation-ID search Part 5 requires.
- `FR-ADMIN-001/002/003/006/007`, `FR-VEND-010`, `FR-IMPORT-013`, `FR-INV-008`, `FR-PAY-005/007/008`, `FR-ANALYTICS-001..006`: status unchanged (❌/🟡), Sprint column S25 → BACKLOG-*.

## v16 — S25-admin-audit-flags-vendor-performance applied, 2026-10-17

`S25` (branch `feat/sprint-25-admin-audit-flags-vendor-performance`) builds FR-ADMIN-004 (feature flags), FR-ADMIN-005 (audit-log search/export), FR-VEND-011 (vendor performance indicators), and the performance/SLA-reporting half of FR-VPORTAL-007(E.20) — the review-response half of that same requirement stays explicitly deferred, per its own literal text, not by a sprint decision. **Deliberately out of scope, matching the final negotiated plan, not an oversight**: FR-ADMIN-001/002/003/006/007 (broader admin screens, configurable role lists, fraud dashboards, data export) — none of these were part of this sprint's negotiated scope despite an earlier planning draft tagging them `S25`; those rows are left exactly as they were.

Built (backend): `FeatureFlag` model + `FeatureFlagsService` — a fixed, code-defined registry (`FEATURE_FLAG_REGISTRY`, no free-form key creation via the API), with the absent-row-means-`false` semantics corrected during planning (round 4): a `PUT` requesting the already-effective value is a true no-op (no row, no `AuditLog`) whether or not a row exists yet, and only a value-changing `PUT` creates/updates the row and writes an `AuditLog` with a real `before`/`after` (never `null → true`); a `pg_advisory_xact_lock` keyed on `'finalpro:feature_flag:' + key` closes the race where two concurrent first-writes to a never-configured key could otherwise collide on the unique constraint (`SELECT ... FOR UPDATE` locks nothing on a row that doesn't exist yet). Exactly one real flag is defined, `vendor_performance_dashboard_enabled`, gating the one real capability built in this same sprint — never a decorative flag. `AdminAuditLogsController` — `GET /admin/audit-logs` (deterministic two-column keyset cursor, `occurredAt DESC, id DESC`, resolving same-timestamp ties) and `GET /admin/audit-logs/export` (identical filters, CSV) share one filter builder; the 50,000-row export cap is enforced by fetching `take: 50_001` in that same deterministic query and rejecting with `400 EXPORT_TOO_LARGE` if the extra row is present — never a `count()` taken before a separate fetch, which would leave a race window. Redaction is an explicit allowlist (`buildSafeAuditSummary`): only two reviewed action types (`branch_order.status_changed`, `feature_flag.changed`) get a safe one-line summary; every other action type — including `address.created`, confirmed by reading its own write site to carry raw `lat`/`lng` — returns `summary: null`, never a partial or guessed pass-through of the raw `beforeState`/`afterState` JSON. `VendorPerformanceService.computeForVendor()` — a rolling 30-day UTC window on `BranchOrder.createdAt`; cancellation rate as `(CANCELLED+REFUNDED)/(COMPLETED+CANCELLED+REFUNDED)` within the window (`null`, never `0`, when that denominator is 0; active/non-terminal orders never enter either side); average response time from `createdAt` to each order's own first (and, per the state machine, only) transition into `PREPARING`, read from the one generic `branch_order.status_changed` `AuditLog` action's `afterState`, with orders that never reached `PREPARING` excluded entirely from the average (never counted as 0) and `responded_orders_count` always shown alongside it; rating reused verbatim from `ReviewsService.getVendorRatingSummary()` (S23), deliberately not re-windowed, for consistency with what a customer already sees publicly. Confirmed by reading `returns.service.ts` (never calls `BranchOrderService.transition()`) that a post-delivery item return can never masquerade as an order-level cancellation in this metric. `AdminVendorPerformanceController` paginates by `Vendor.createdAt DESC, id DESC` — a stable, indexed base — computing each page's metrics only after that selection, never using a computed metric as the cursor key itself.

Built (frontend, new self-contained pages only — `globals.css`/home/women/auth pages were NOT touched, per this project's standing frontend-protection rule): `/admin/audit-logs` (full filter set, cursor "load more", CSV export button sending the exact same filters), `/admin/feature-flags` (always lists every registry key, even one with no DB row yet, with a toggle), `/admin/vendors/performance` (admin's paginated list, with a plain message — not a confusing empty list — when the flag is off). **The one existing-page touch, applied only after an explicit diff-and-approve round**: three new tiles added to `adminTiles()`'s `PLATFORM_ADMIN` branch in `nav.ts` (audit logs, feature flags, vendor performance) — `ownerHubTiles()` and every other part of `nav.ts` were left untouched. A fourth, additive-only change to an existing page: an inline "آخر 30 يوماً" performance section was added to the owner's existing `/vendor/:id` hub page (cancellation rate, response time, rating), which is simply omitted (not an error banner) when the feature flag is off, matching the plan's "hidden when off" requirement.

**Two real regressions the full regression suite caught, not this sprint's own new assertions**: (1) `AdminVendorPerformanceController`'s literal `admin/vendors/performance` route was registered in `platform-admin.module.ts`'s `controllers` array *after* `AdminVendorsController`'s parametric `admin/vendors/:vendorId` route — Express/Nest matches routes in registration order, so the parametric route was silently swallowing the literal one (`vendorId = "performance"`, surfacing as a confusing `VENDOR_NOT_FOUND` instead of the intended `FEATURE_DISABLED`/200). Fixed by moving `AdminVendorPerformanceController` ahead of `AdminVendorsController` in that array, with a comment explaining why the order is load-bearing. (2) Two pre-existing e2e assertions had to be updated to match real, deliberate changes rather than relaxed to hide them: `web-navigation.e2e-spec.ts`'s exact-list assertion of `adminTiles('PLATFORM_ADMIN')` now includes the three new S25 hrefs, in nav.ts order; and `vendor-route-classification.ts`'s `SUSPENDED_ALLOW_ROUTES` list gained `GET vendors/:vendorId/performance` (a plain read, same bucket as every other `GET` already on that list) — `sprint16-vendor-route-classification.e2e-spec.ts` fails loudly on any newly-registered route left unclassified, by design, and did exactly that until this entry was added.

**Not run this sprint, unlike S23/S24**: no Playwright browser test was added or run for the three new admin pages or the inline vendor-dashboard section — verified via `next build` (clean), `eslint` (clean), and the full backend e2e suite hitting the real HTTP endpoints these pages call, but not via an actual browser session. Flagged here rather than silently omitted.

Verified: 257 unit tests (unchanged — no new pure-logic module warranted one; everything new is covered via e2e against real HTTP endpoints), 908 e2e tests across 43 suites (+21 in the new `sprint25-admin-audit-flags-vendor-performance.e2e-spec.ts`: feature-flag registry/no-op/race semantics, audit-log cursor tie-breaking, the data-leak negative test, the 50,001-row export rejection, and vendor-performance's null-not-zero/excluded-non-responder/BOLA/flag-gating/admin-pagination coverage), one pre-existing, unrelated flaky test observed and left untouched (`sprint8-storefront-discovery-comparison.e2e-spec.ts`'s "newest-first" ordering assertion, confirmed to pass cleanly in isolation — a timing-sensitive pre-existing test this sprint did not touch and is out of scope to fix), 2x clean-room green on the full backend suite (fresh `git archive`, fresh `npm ci`, fresh throwaway DB, `migrate diff --exit-code` showing only the same 4 pre-existing cosmetic drift lines every prior clean-room pass has also shown).

Status changes:

- `FR-ADMIN-004`/`SRS-P-04` ❌→✅: feature flags now built (fixed registry, one real flag, advisory-lock-safe first-write, absent-row-is-false semantics).
- `FR-ADMIN-005`/`G-AD-04`/`BL-ADMIN-003` ❌→✅: audit-log search and CSV export now built, with explicit allowlist redaction and a race-free export cap.
- `NFR-SEC-003` stays 🟡 PARTIAL, note updated: the query interface now exists; the retention-duration policy itself (OPEN-009) is still undecided.
- `FR-VEND-011` ❌→✅: vendor performance indicators (cancellation rate, response time, rating) now built, feature-flag-gated.
- `FR-VPORTAL-007 (E.20)` ❌→🟡 PARTIAL: the performance/SLA-reporting half is now built; the review-response half stays deferred, per the requirement's own literal text.



## v15 — S24-favorites-comparison-alerts applied, 2026-10-15

`S24` (branch `feat/sprint-24-favorites-comparison-alerts`) builds FR-FAV-001/002/003/004/005(E.16)/006, FR-COMP-001/002/004/005/006/007, and extends the FR-COMP-003 delivery-fee/warranty/rating fields - saved favorites (product/offer), saved comparison sets with a public share link, cross-product comparison, price-staleness and diff-highlighting, and the three favorite-driven alert types (price drop, back-in-stock, new offer), wired through the existing transactional-outbox/relay pattern (ADR-006). **Deliberately NOT built this sprint, agreed in advance in the plan's own decisions (#1-#7) and documented honestly below rather than silently claimed**: a "best value" formula (no approved scoring exists), distance/ETA in the comparison row (no geolocation/ETA infrastructure exists anywhere in this codebase), alert grouping/frequency control (every qualifying event is its own immediate notification), and a back-in-stock alert for a PRODUCT favorite (OFFER favorites only, decision #4 - a product can have many offers, and "back in stock" is only a crisp, well-defined event at the single-offer level).

Built (backend): `Favorite` (PRODUCT/OFFER, BOLA-safe, idempotent upsert, re-validated against the exact same public-eligibility definitions `ComparisonService` already uses) and `NotificationPreference` (per-alert-type opt-out, absence-of-row = enabled); `ComparisonSet`/`ComparisonSetItem` (owner CRUD + a separate, slug-only public share route, 4-item cap enforced under a row lock proven safe with a real 2-concurrent-adds-at-3-items race test, live re-filtered eligibility on every read so an item that stops being eligible is flagged `available:false`, never silently dropped); `lockOffersWideForRestock()` - the one new batched stock-locking primitive every quantity-increasing writer (manual/POS movement, regular-return restock, exchange's RESELLABLE-original-item leg, order-cancellation's own stock-restore) and the one quantity-decreasing writer sharing a transaction with one of those (exchange's replacement hand-over) now goes through, replacing ad-hoc single-key calls and closing a real class of cross-writer deadlock risk (four correction rounds during planning, each tied to a concrete adversarial scenario - lock order, phantom-row creation, sequential-call AB-BA deadlocks, and sweep-vs-deliberate-release double-counting - proven individually with dedicated deterministic-concurrency tests, not just "it passed once"); `GET /canonical-products/:id/comparison` extended with zone-explicit delivery fee (reusing `resolveDeliveryFee()` verbatim, never a new default), warranty (`"غير متوفر"` only when genuinely unset), seller rating, a price-staleness flag (`PriceHistory`'s own latest `changedAt`, or the variant's `createdAt` if the price never changed, against the already-approved 30-day threshold), a diff block, and a cheapest-offer tag with a plain Arabic reason; `GET /comparison/cross` (mode 2 - 2 to 4 competing canonical products, each represented by its own cheapest eligible offer, same diff/cheapest-tag shape).

Built (frontend, new self-contained pages only - `ProductCard.tsx`/`nav.ts`/`globals.css`/home/women/auth pages were NOT touched, per this project's standing frontend-protection rule): `/account/favorites` (list + remove + the three alert toggles), `/compare/sets` (list + create), `/compare/sets/[id]` (add/remove items, copy share link, delete), `/compare/shared/[slug]` (public, slug-only), `/compare/cross` (2-4 product ids, zone picker, diff/cheapest display). The existing `/compare/[canonicalProductId]` page was extended in place (already covered by the approved plan) with a zone picker, the new warranty/staleness/rating/delivery-fee fields, the backend's own cheapest tag/reason (replacing the old index-based `i===0` guess), a diff block, and "add to favorites"/"save to a new comparison set" actions. `apps/web/src/lib/notifications.ts` (a shared-but-unprotected lib file) was extended with the three new notification types and their destinations - the two offer-scoped alerts route to `/account/favorites` (no buildable store URL exists from an offerVariantId alone, same fallback shape the pre-existing followed-store types already use), the new-offer alert routes to the exact product's own `/compare/:id` page.

**The one existing-page touch, applied only after an explicit diff-and-approve round**: a one-line "المفضلة" tile on `/account`'s existing hub-grid, shown to the product owner as an exact diff before applying (this project's standing rule for any existing, daily-used page) - approved with one change: the page itself lives at `/account/favorites`, not a top-level `/favorites`, specifically so this hub-grid entry is its one coherent entry point. Nothing else on `/account` (or `globals.css`/`ProductCard.tsx`/`nav.ts`) was touched.

**A real regression the full backend test suite caught, not this sprint's own new assertions**: `FavoritesModule` was missing `AuthModule` in its `imports` - every route on `FavoritesController` is guarded by `SessionAuthGuard`, which depends on `SessionService` (exported by `AuthModule`); without that import, NestJS's DI container cannot resolve the guard at all, so the module would fail to even bootstrap in a real running app. This had never been caught because no e2e test had exercised a real `app.init()` against this module before - a `nest build` (pure TypeScript compilation) never instantiates the DI graph, so the bug was invisible until the first full `TestingModule.compile()` + `app.init()` in this sprint's own e2e suite surfaced it immediately. Fixed by adding `AuthModule` to `FavoritesModule`'s `imports`.

**A second real bug the full regression run caught (the sprint24 file in isolation never would have)**: the sprint24 e2e spec's own deadlock-proof concurrency test copied `sprint21b-exchange.e2e-spec.ts`'s exact `R_LOW`/`R_HIGH` deterministic-UUID helper verbatim (`00000000-...`/`ffffffff-...` literal prefixes) - harmless when either file runs alone, but a real primary-key collision on `checkout_reservations` once both files run in the same pass against the one shared database (parallel jest workers, one Postgres instance). Fixed by giving the sprint24 file its own distinct prefix pair (`11111111-...`/`eeeeeeee-...`); only the internal LOW-sorts-before-HIGH property ever mattered, not matching the other file's specific values.

Also fixed in the same pass: `comparison.service.spec.ts` (pre-existing unit test) needed its `EligibleOffer` fixture helper extended with the two new required fields (`condition`, `priceLastConfirmedAt`) this sprint added to that interface; `comparison-sets.service.ts`'s own `lowest_price` was a bare number where every other price in this frontend is a formatted `"X.XX"` string (caught while writing the Playwright spec, before it ever reached a real browser).

Verified: 257 unit tests (+12, the new `favorites`/`comparison-sets` pure-logic coverage already existed via the e2e suite instead - the +12 is `comparison.service.spec.ts`'s own fixture-extension requiring no new test cases, net zero real delta; the file count is unchanged at 31), 885 e2e tests across 42 suites (+27 in the new `sprint24-favorites-comparison-alerts.e2e-spec.ts`: BOLA on Favorite/ComparisonSet, idempotent add, live-eligibility re-filtering, the 4-item-cap concurrency race, the reversed-mutation-order deadlock-proof test, the no-phantom-row test, order-cancellation's own batched restore + its duplicate-offerVariant merge + its concurrency-vs-a-second-writer test, the exchange-replacement-leg-vs-a-real-expired-reservation test, price-drop/back-in-stock/new-offer alert delivery at every real trigger point with opt-out verification, and the comparison-endpoint's zone/warranty/staleness/diff/cheapest-tag/cross-mode coverage), 29 Playwright browser tests (+3 in the new `favorites-comparison-s24.spec.ts`; one pre-existing, unrelated failure observed and left untouched - `account-s22.spec.ts`'s own phone-change/reactivate test hits a strict-mode locator ambiguity between the password field and its show/hide toggle button, a pre-existing test fragility this sprint did not introduce and is out of scope to fix), 2x clean-room green on the full backend suite (fresh `migrate reset`, `migrate diff --exit-code` showing only the same 4 pre-existing cosmetic drift lines every prior clean-room pass has also shown).

Status changes:

- `FR-FAV-001` ❌→✅: `Favorite` (PRODUCT/OFFER) now built; STORE favoriting stays exactly `StoreFollow`, by explicit decision, never duplicated.
- `FR-FAV-002`/`FR-COMP-001`/`BL-COMP-001` ❌→✅: saved comparison sets (up to 4 items, share link) now built.
- `FR-FAV-003`/`BL-NOTIF-004` ❌→✅: price-drop alerts at both the manual-PATCH and scheduled-discount-sweep choke points.
- `FR-FAV-004` ❌→✅ (within the approved OFFER-only scope - see decision #4 above): back-in-stock alerts, offer-wide across every physical branch, never a single branch's local crossing.
- `FR-FAV-005 (E.16)` ❌→🟡 PARTIAL: per-alert-type opt-out now built; frequency/grouping explicitly out of scope this sprint (decision #5).
- `FR-FAV-006` ❌→✅: new-matched-offer alerts on an already-favorited product, fired exactly once per confirmation.
- `FR-COMP-002`/`BL-COMP-004`/`FR-COMP-007` 🟡→✅: cross-product comparison (mode 2) and saved/shared comparison sets now built alongside the existing per-product comparison/share link.
- `FR-COMP-003` stays 🟡 PARTIAL, note updated: condition/warranty/delivery-fee/rating now built; distance/ETA stay out of scope (no infrastructure exists, decision #2).
- `FR-COMP-004` ❌→✅: the diff-highlighting block now built for both comparison modes.
- `FR-COMP-005`/`BL-COMP-002` stays 🟡 PARTIAL, note updated: cheapest-tag-with-reason now built; "best value" stays out of scope (no approved formula, decision #1).
- `FR-COMP-006` ❌→✅: the price-staleness flag now built (30-day threshold, already-approved BR-004/NFR-STALE-002).
- `FR-COMP-008` stays 🟡 PARTIAL, note updated: the new screens follow the same responsive/RTL conventions as the rest of the app, still visual-only verification, no automated UI test for this specific clause.
- `PDR-002`/`FR-AUTH-013`/`BL-NOTIF-003` 🟡→✅: favorites are the last missing piece of the registered-customer's browse/compare/favorite/follow/buy set.



`S22` (branch `feat/sprint-22-account-addresses`) builds FR-AUTH-006 (phone change), FR-AUTH-014/PDR-034 (account deactivation + 30-day reactivation), FR-AUTH-008/PDR-029 (address default/edit/delete + order-level change-address), and a real, scoped i18n foundation (FR-AUTH-009/NFR-L10N-001). **Deliberately NOT built this sprint, agreed in advance and documented honestly below rather than silently claimed**: BR-018/NFR-RETAIN-001 (retention policy, purge, anonymization, PII-hiding) — only the 30-day reactivation window itself was built, which is a recovery deadline, not a retention policy; and retranslating any pre-S22 screen (S1–S21b) — the i18n dictionary/switcher is applied to `AppShell`, shared UI, and S22's own new screens only, by explicit prior agreement, not an oversight.

Built: `PATCH /customers/me {phone?, verification_token?, language_pref?, display_name?}` (phone change over the existing generic OTP request/verify pair, purpose=`phone_change`; `language_pref`/`display_name` write immediately, no OTP) with the exact `LOGIN_REQUIRED`/`ISSUED` session-reissuance discipline `confirmPasswordReset()` established; `DELETE /customers/me` deactivation (`lockCustomerAccountState` on the `User` row, then every owned-vendor row sorted and locked before deciding "last active owner," then an active-order check, then the write — idempotent on repeat calls) and `login()` now rejects a deactivated account with `403 ACCOUNT_DEACTIVATED`; a fully independent reactivation flow (`POST /auth/reactivate-request` → `/auth/otp/verify` with a new `account_reactivation` purpose → `POST /auth/reactivate-confirm`) that never reuses `password/reset-*` (which hardcodes the `PASSWORD_RESET` purpose and could never verify this one); `checkout.confirm()` now takes the account-state lock FIRST, before its own reservation lock, closing the deactivate-vs-checkout race; full address CRUD (`PATCH`/`DELETE .../addresses/:id`, `is_default` folded into the generic `PATCH`) with a partial unique index enforcing at most one non-archived default per customer, auto-default-on-first-address, and default-reassignment-on-delete, every mutation behind `lockCustomerAddressState`; delete hard-deletes an address never referenced by any order, else archives it (`Address.archivedAt`, since `BranchOrder.address` is `onDelete:Restrict` forever); order-level `POST .../orders/:id/change-address` (PLACED only — "before preparation" literally) where ANY delivery-fee difference (higher or lower) in the new zone is `409 ADDRESS_CHANGE_UNSUPPORTED` with `{cancel, convert_to_pickup, retry_with_another_address}` in `details[0]` (no delta-collection mechanism exists or was built), and the customer's own explicit `.../convert-to-pickup` choice releases the delivery slot, issues a fresh pickup code via the same bounded-retry savepoint loop `checkout.confirm()` uses, and refunds the delivery fee via a new `BranchOrderRefund` row for BOTH `ONLINE_GATEWAY` and `COD_CASH` (a genuinely new write path — cancellation never needed a COD delivery-fee refund row before, since a cancelled COD order has nothing left to collect; this order stays ACTIVE). Frontend: `/account/phone`, `/account/deactivate`, `/reactivate` (reachable from `/login`'s own `403 ACCOUNT_DEACTIVATED` response), `/account/addresses` (full management screen), and a `ChangeAddressPanel` wired into the existing `/orders` page — all five bilingual; a real i18n foundation (`lib/i18n.ts` dictionary + `useT()`/`useLang()`, `User.languagePref` read back on login and written on every toggle, a client-side `<html lang/dir>` effect since the root layout renders `lang="ar" dir="rtl"` statically on the server) applied to `AppShell` (nav labels, search, account menu, language switcher) and to the shared `AddressForm`/`lib/address.ts` it now also serves. Five deterministic concurrency tests as explicitly required: deactivate-vs-checkout-confirm, two co-owners deactivating the same vendor in parallel, two concurrent `reactivate-confirm` calls, concurrent first-address-creation, and change-address-vs-start-preparation. Verified: 253 unit tests (unchanged — no new unit-level pure-logic module this sprint), 834 e2e tests across 40 suites (+30 in the new `sprint22-account.e2e-spec.ts`), 23 Playwright browser tests (+4 in the new `account-s22.spec.ts`), 2x clean-room green on both suites (fresh archive, fresh `npm ci`, fresh DB, `migrate diff` showing only the same 4 pre-existing cosmetic drift lines every prior clean-room pass has also shown).

**A real regression the first clean-room pass caught, not the new test file's own assertions**: an early draft added `@UseInterceptors(IdempotencyInterceptor)` to `POST /customers/me/addresses` — a *pre-existing* endpoint since Sprint 2 — requiring an `Idempotency-Key` header no existing caller (six older e2e suites, the frontend `AddressForm`) ever sent. 60 of 804 pre-existing tests failed across exactly the 6 suites that call this endpoint before the fix removed the interceptor from that one route (every genuinely NEW S22 route keeps it, correctly — only this one pre-existing route was ever at risk). Caught by re-running the full existing suite before touching the frontend, exactly as the clean-room discipline is meant to catch.

Status changes:

- `FR-AUTH-006` 🟡→✅: phone change now has a real endpoint + UI (`/account/phone`).
- `FR-AUTH-008` 🟡→✅: default/edit/delete now built (`/account/addresses`); the map-provider absence was already documented as an approved decision, not a gap, and stays that way.
- `FR-AUTH-014` (E.0) ❌→✅ (= `PDR-034`): deactivation + 30-day reactivation fully built, with the required deterministic concurrency tests.
- `PDR-029` 🟡→✅: default/edit/delete plus order-level change-address-before-preparation now built; map-provider absence unchanged as an approved decision.
- `FR-AUTH-009` stays 🟡 PARTIAL, `NFR-L10N-001` ❌→🟡 PARTIAL: a real, working i18n foundation now exists — this is a genuine improvement, not just a note correction — but its coverage is deliberately scoped to `AppShell`/shared UI/S22's own screens, so neither reaches ✅ DONE. `NFR-RTL-001` note extended: the `<html dir>` flip is real and affects the WHOLE app (one shared element), including untranslated old screens rendered under `dir="ltr"` when English is chosen — flagged honestly as an unaudited side effect, not a regression to fix this sprint.
- `FR-AUTH-010` ❌→🟡 PARTIAL: the SRS's own literal "account deletion" route name is satisfied behaviorally by the same deactivation (`FR-AUTH-014`) — never a real delete-and-purge. `BR-018`/`NFR-RETAIN-001` stay exactly ❌ MISSING, by explicit prior agreement before implementation started — no purge, anonymization, or configurable retention duration was built or attempted.
- `G-AC-01`, `G-AC-02`, `G-AC-04` (§4 Account gaps): closed, pulled out of the Roadmap (§5)'s schedulable set. `G-AC-03` (language switcher): closed only for its AppShell/shared-UI/S22-screens scope — still needs a future scope decision for the rest of the app.
- `BL-AUTH-004`/`BL-AUTH-004b` (§13 Part 8): 🟡→✅, inheriting `FR-AUTH-008`'s new status.
- As with v12/v13's own precedent for a scoped pass, this update does not attempt to reconcile the separate, frozen §2/§6/§16/§17 grand-total tables — a future full reconciliation pass should fold these changes in.

## v13 — S21b-exchange applied, 2026-10-11

`S21b` (branch `feat/sprint-21b-exchange`) builds the EXCHANGE outcome of `PDR-030` that S21/S21a deliberately left unbuilt (v11 below, verbatim: "exchange (`EXCHANGE_ONLY`/`BOTH`) — rejected outright by every DTO") — scoped explicitly to the store's own real branches only; `PickupPoint` stays entirely out of scope, deferred to its own future sprint with its own membership model, exactly as v11 scoped it. Built: `Return.desiredOutcome`/`replacementOfferVariantId`/`replacementBranchId`/`replacementUnitPriceSnapshot` plus a DB `CHECK` enforcing all three replacement fields together (never partially set); a unified `approveReturn()` helper used by BOTH the branch's own `decide()` and `PLATFORM_ADMIN`'s `resolveEscalation()`, so an exchange approval's full server-side replacement re-validation and stock reservation (via the SAME `lockAndSweepStockRow` primitive `checkout` itself uses, wrapped in a new `lockSweepOrCreateStockRow` for the case where the receiving branch has no prior stock row for that variant) can never be skipped from either path; a direct `APPROVED_AWAITING_DROPOFF→EXCHANGED` transition (no intermediate processing status - everything happens in one transaction) with a 24-hour code, distinct from the plain return code's 7 days, expired/released by the same `ReturnSweepService`; redemption restricted to the one `replacementBranchId` chosen at submission only (`WRONG_BRANCH_FOR_EXCHANGE` otherwise) - deliberately narrower than the plain-return code's vendor-wide acceptance (`PDR-031`, unchanged); a new, independent, immutable `ExchangeSettlement` ledger (never `BranchOrderRefund`, whose own CHECK constraint assumes a refund reason) computing `net = replacementTotal − originalTotal + exchangeFeeSnapshot` in decimal.js, always settled in cash at the branch regardless of the original payment method; the branch-archive-vs-exchange-reservation race closed by reusing the exact same `lockBranchOperationalStatus` advisory lock `archiveBranch()` already took, which now also refuses archival while an `APPROVED_AWAITING_DROPOFF` exchange reservation targets that branch (`BRANCH_HAS_ACTIVE_EXCHANGE_RESERVATION`); and a real, ownership-scoped, purely-indicative `GET /customers/me/orders/:branchOrderId/items/:itemId/exchange-options` endpoint backing the customer's replacement picker (never itself a reservation). Full UI for all four roles, extending the exact same four S21 pages that already existed per role (no new page/route this sprint) plus the four existing Playwright spec files (no new spec file). Verified: 253 unit tests (+10, all in `return-policy.util.spec.ts`'s new `isOutcomeAllowedBySnapshot`/`computeExchangeSettlement` suites), 801 e2e tests across 39 suites (the entirely new `sprint21b-exchange.e2e-spec.ts` alone holds 19, covering policy/outcome validation, replacement validation, the unified approval path from both `decide()` and admin escalation, exchange redemption including the no-prior-stock-row case, sweep expiry, the branch-archive-vs-reservation race as two barrier-proven deterministic directions, a last-unit concurrency race, and the exchange-options endpoint including BOLA), 19 Playwright browser tests (+5 across all four existing spec files), 2x clean-room green on both suites.

**A real bug the Playwright pass itself caught, not the Jest e2e suite**: `redeemResultDto()`'s privacy-safe shape never actually included `desired_outcome` - the exchange-vs-return-specific UI text on `/vendor/:id/returns/redeem` (`"تم تسليم البديل بنجاح"` vs `"تم استلام المنتج بنجاح"`) silently always rendered the RETURN wording, because `result.desired_outcome` was always `undefined` client-side. The Jest e2e suite's own assertions never checked for this field's presence, so it passed clean-room twice regardless. Fixed by deriving it from `status` (`EXCHANGED` is only ever reached via the EXCHANGE outcome, so the status alone determines it - no need to thread `desiredOutcome` through every caller's input shape); the existing S21a privacy test's exact-key-set assertion is updated to include it, same as it already was for `settlement`. This is exactly the kind of gap the "run the actual app" verification step exists to catch, and it would not have been caught by type-checking, linting, or the Jest suite alone.

Status changes:

- `FR-RET-008` / `PDR-030` note extended: `EXCHANGE_ONLY`/`BOTH` modes and the separate, always-applied exchange fee - the one half of this decision's literal text (`"return/exchange/both/no-return"`, `"separate fixed ILS return/exchange fees"`) that stayed unbuilt through S21/S21a - are now real, with a full settlement ledger backing the exchange fee's actual financial effect. **Self-correction**: v12 (2026-10-10) marked this row ✅ DONE citing only that the owner's return-policy settings *page* had gained a UI; at that time the row's own backend note did not flag that the exchange-mode half of `PDR-030`'s own literal text was still entirely unbuilt (v11, same date range, explicitly said so in its own summary) - an inconsistency within this record itself, not a new regression introduced since. The status symbol does not change (✅ DONE in both v12 and now), but the claim behind it is now actually, fully true, where before it was true only for the RETURN half.
- `FR-RET-009` note extended: the exchange code's own distinct mechanics (24h validity vs. the 7-day return code; redemption restricted to the one `replacementBranchId` chosen at submission, vs. the return code's vendor-wide acceptance across all physical branches) now exist, described here for completeness since both codes are issued by the same underlying mechanism this row covers. Status unchanged - 🟡 PARTIAL, still exactly for the pre-existing `PickupPoint` reason (S21b explicitly excludes `PickupPoint` too, per your own planning instruction - nothing here closes that gap).
- `PDR-031`: unaffected by this pass - its own literal text is specifically the plain RETURN request/SLA/7-day-code flow; the exchange code's own distinct mechanics are described under `PDR-030`/`FR-RET-008` above instead, not here, to avoid implying this row covers them. One cross-reference line added, status/note otherwise unchanged (still 🟡 PARTIAL for `PickupPoint` only).
- `FR-RET-007` Sprint column corrected: `S21b+` → `S22+`. Abuse-rate monitoring has nothing to do with the exchange outcome - this placeholder tag was never literally about `S21b`, and S21b neither could nor did touch it. Status unchanged - ❌ MISSING.
- `BR-033` note extended: "رسومه" (the policy's fees, snapshotted at purchase) now genuinely covers the exchange fee snapshot too (`returnPolicySnapshotExchangeFeeIls`), not just the return fee. The row's own PARTIAL reason (`PickupPoint` acceptance, unbuilt) is completely unaffected and unchanged.
- §5 roadmap: a new row is added directly after **S21**'s own row for **S21b** - closing the one item that row's own note (v12) named by number: "الاستبدال (`EXCHANGE_ONLY`/`BOTH`، `S21b`)". **S21**'s own row/note is left exactly as v12 wrote it - a historically accurate record of what S21a itself deferred - not rewritten to look like it already knew about S21b.
- As with v12, this pass does not reconcile the separate, frozen §2/§6/§16/§17 grand-total tables: no row's status SYMBOL changes outside the Sprint-tag correction named above (`FR-RET-007`), and `FR-RET-008`/`PDR-030` were already counted as ✅ DONE in those totals since v12 - only the accuracy of the claim behind that symbol improves here, not the symbol itself.
- §5's own "فحص المجموع" arithmetic line is deliberately left untouched too: the new **S21b** row's own "1" is `FR-RET-008`/`PDR-030` itself - already one of the 12 original rows counted under **S21** there - not a new backlog item, so adding it to that line's sum would double-count the same requirement under two sprint tags.

## v12 — S21-returns review-round UI pass applied, 2026-10-10

Review-round fix on `feat/sprint-21-returns` (commit `100be5a`) built the full customer/owner/staff/admin UI that v11 (below) flagged as missing, plus a real Playwright browser-test suite (the first in this project) proving it end to end against a real running API/web server. **This update is UI/test documentation only — no backend code, migration, or business-rule change is implied; see `100be5a` for the actual diff.** PickupPoint redemption and exchange (`EXCHANGE_ONLY`/`BOTH`) remain exactly as scoped out in v11 below — this pass does not touch either, and does not mark either DONE.

Status changes verified directly against the actual pages (`apps/web/src/app/{orders/[orderId]/items/[itemId]/return,returns,returns/[returnId],vendor/[vendorId]/return-policy,vendor/[vendorId]/branches/[branchId]/returns,vendor/[vendorId]/returns/redeem,admin/returns}/page.tsx`) and the new Playwright suite (`apps/web/e2e/*.spec.ts`, 14 tests, 2x clean-room green):

- `FR-RET-002` 🟡→✅: customer's "طلب إرجاع" form (`/orders/:id/items/:id/return`).
- `FR-RET-003` 🟡→✅: note corrected, not just "UI added" — this FR is the *automatic* sweep (48h reminder/72h escalate/dispute-window close); it never needed a dedicated UI step, so "لا UI" was a miscategorization, not a real gap. The resulting pending state is visible in the now-built branch-returns queue.
- `FR-RET-004` 🟡→✅: note corrected — the computed refund amount was already surfacing correctly the whole time, via the pre-existing `/orders` page's `amount_refunded` field (`computeAmountRefunded()` sums every `BranchOrderRefund` row regardless of `reason`, so a return's `ITEM_RETURNED` row was already included with zero new code). "لا UI" was never actually true for the ONLINE case; COD shows no amount, by the exact same pre-existing design every other COD refund already follows (physical cash, nothing electronic to confirm on screen).
- `FR-RET-006` 🟡→✅: `PLATFORM_ADMIN`'s escalation queue + decision (`/admin/returns`).
- `FR-RET-008` 🟡→✅ (= `PDR-030`): owner's return-policy settings page (`/vendor/:id/return-policy`) — the 6-month lock renders as a real 409 error state, verified live.
- `FR-VPORTAL-004` 🟡→✅: the return portion's UI gap (the only thing keeping this row PARTIAL) is now closed — branch-returns queue + vendor-wide redeem page.
- `PDR-009`, `SRS-H3A-08`, `SRS-K1A-07`, `SRS-G3-07`: notes corrected to drop the stale "API فقط/لا UI للمرتجعات" claim; each stays exactly 🟡 PARTIAL for its own separate, genuinely unrelated remainder (owner reports, Review, the unified-timeline decision) — none of those reach DONE from this pass.
- `FR-RET-001`, `FR-RET-005`, `FR-RET-007`, `FR-RET-009`, `FR-FUL-009`, `PDR-031`, `BR-012` stay exactly 🟡 PARTIAL/❌ MISSING — their UI column is corrected to name the real pages where one now exists, but each row's own non-UI gap (legal-minimum question still open, reason-based SLA routing not built, abuse-rate monitoring not built, PickupPoint redemption not built, store-level-not-category-level) is untouched by this pass.
- `BL-RET-001`: note corrected (`API فقط` dropped — the backing `FR-RET-002` now has a real UI).
- §5 roadmap's **S21** row: re-derived directly. Of the original 12 rows counted into it (`FR-RET-001` through `009`, `PDR-030/031`, `BR-012`), 6 move to ✅ DONE above, leaving **6** genuinely PARTIAL/MISSING for reasons unrelated to UI (legal minimum, reason-routing, abuse monitoring, PickupPoint ×2, store-vs-category level) — see that row's own updated note for the exact list.
- As with every narrowly-scoped pass before this one (v7/v8/v10's own precedent), this pass does **not** attempt to reconcile the separate, frozen §2/§6/§16/§17 grand-total tables — out of scope for a UI-only documentation pass; a future full-sprint pass should fold this in.

## v11 — S21-returns applied, 2026-10-09

`S21-returns` (branch `feat/sprint-21-returns`) builds EPIC-RET's backend/API in full: return policy selected at `POST /vendors` registration (PDR-030) with a real 6-month-locked update endpoint; a full `Return` model and state machine (`REQUESTED→APPROVED_AWAITING_DROPOFF→RECEIVED→REFUND_PROCESSING→REFUNDED`, plus `REJECTED`/`REJECTED_CLOSED`/`ADMIN_REJECTED`/`ESCALATED`/`EXPIRED`/`CANCELLED_BY_CUSTOMER` — corrected across five review rounds from an earlier draft that wrongly auto-refunded on approval and conflated store-rejection with admin-final-rejection); a policy snapshot on `BranchOrder` at `confirm()` time (never the live policy); a vendor-wide (not branch-scoped) redeem endpoint with resellable/damaged stock handling and a `BranchOrderRefund.method` discriminator (`ONLINE_GATEWAY`/`COD_CASH`) so COD is never conflated with an electronic refund; and `PLATFORM_ADMIN`-only escalation resolution. **Deliberately NOT built this sprint, documented honestly below rather than silently claimed**: any customer/vendor/admin UI (API-only — every FR-RET-*/FR-FUL-009/PDR-030/031 row below is capped at 🟡 PARTIAL specifically for this reason, even where the backend is otherwise complete), exchange (`EXCHANGE_ONLY`/`BOTH` — rejected outright by every DTO), `PickupPoint` redemption (no operational-staff membership model exists for it), per-reason differentiated SLA routing (FR-RET-005), and abuse-rate monitoring (FR-RET-007, stays ❌ MISSING entirely). Verified: 753→779 e2e tests (26 new, including two barrier-proven deterministic concurrency tests), 227→243 unit tests, 2x clean-room green.

**[تصحيح v12، 2026-10-10]:** الادّعاء أعلاه ("لا واجهة مستخدم إطلاقاً - API فقط") أصبح غير دقيق - جولة مراجعة لاحقة على نفس الفرع بنت واجهة كاملة لكل الأدوار الأربعة (عميل/مالك/موظف/أدمن) واختبارات Playwright حقيقية. انظر **v12 أعلاه** وصفوف `FR-RET-*`/`PDR-030`/`PDR-031` المحدَّثة أدناه للتفاصيل الدقيقة لكل صف. الاستبدال (exchange) ونقاط الاستلام (PickupPoint) يبقيان كما وُصفا هنا تماماً - لم يتغيّر أي منهما.

## v10 — S19-notification-relay applied (documentation only), 2026-10-05

`S19-notification-relay` (branch `feat/sprint-19-notification-relay`) is the first real read-side of the Outbox: since Sprint 3, `OutboxEvent` rows were written and never consumed. This pass closes that half — a claim/lease relay with retry/backoff/dead-letter, a real `Notification` model and in-app inbox, and delivery wired into the event types that already existed plus three new triggers (new order for employee, low stock after reserve, followed-store fan-out). **This update is documentation only — no code, migration, or commit beyond this file is authorised or implied by it.** Per explicit product-owner instruction: no row here claims real external delivery — `NotificationChannelService` is still a fallback-log-only service mirroring `SmsService`'s own OPEN-004 contract; no SMS/WhatsApp/email/push provider exists. Any requirement that specifically needs a real external channel stays exactly PARTIAL or MISSING, unchanged. `BR-020` and `BDR-004` are left completely untouched, per the original S19 plan's own explicit decision (the three specific "independently-tracked" notifications they each name still have no approved source defining what they are) and per this pass's own instruction not to change either without a new product decision.

Status changes, verified directly against the actual merged code (`outbox-relay.service.ts`, `notification-channel.service.ts`, `fulfilment-sweep.service.ts`, `discount-activation-sweep.service.ts`, `me.controller.ts`'s `/me/notifications*` routes, `AppShell.tsx`'s bell icon, `/notifications` page) and the dedicated e2e suite (`sprint19-notification-relay.e2e-spec.ts`, 23 tests):

- `FR-NOTIF-008 (E.0)` ❌→✅, `FR-VPORTAL-011` ❌→✅: a real `Notification` model and in-app inbox — `GET /me/notifications` (cursor + `unread_only`), `/me/notifications/unread-count`, idempotent `POST .../read` (BOLA-safe: another user's id 404s, not 403), a bell icon with an unread badge in `AppShell`, and a real `/notifications` page with per-type deep links. `Notification.data` is whitelist-only (never raw payload/free text), proven by a dedicated test.
- `FR-NOTIF-004` ❌→🟡 (not ✅ — see below), `SRS-H1-08` ❌→🟡, `SRS-P-12` ❌→🟡: the full claim/lease state machine — `attemptCount`/`lastError` recorded per row, exponential backoff, `DEAD_LETTER` after `MAX_ATTEMPTS=5` — is built and precisely tested (attempt-count progression asserted step by step). Stays PARTIAL, not DONE, under this file's own DONE rule (§1: a UI route reachable from navigation, not just an API): `GET /admin/outbox/dead-letter` exists and is `PLATFORM_ADMIN`-gated, but there is no dedicated admin page to browse it yet.
- `SRS-P-10` ❌→🟡: `PeriodicTask`, the first real background-scheduling primitive in this codebase, now exists — used by the relay and by `FulfilmentSweepService`/`DiscountActivationSweepService`. It does not yet cover price staleness, FX, subscription, or webhook reconciliation (the requirement's other named jobs).
- `SRS-P-07` stays ❌ MISSING, note updated only: a real queue now exists, but no error-rate/queue-depth alerting was built — the requirement is specifically about alerts, which remain entirely absent.
- `PDR-026` 🟡→✅, `BR-034` 🟡→✅: the 48-hour reminder and 72-hour auto-confirm are no longer "only computed when something happens to read the order" — `FulfilmentSweepService` runs genuinely periodically (every minute) and the resulting notification is now really delivered to the customer's inbox, not just an outbox row.
- `SRS-K1A-04` 🟡→✅: "أتابعه" now fires real, separate notifications for a followed store's new product and new discount (`FOLLOWED_STORE_NEW_PRODUCT`/`FOLLOWED_STORE_DISCOUNT`, fair batch-bounded fan-out — a large follower set no longer monopolizes the relay against an unrelated event, see the Sprint 19 commit's own review-round fix).
- `FR-FAV-005 (E.0)` stays 🟡 PARTIAL, note updated: the separate-notifications clause is now built (same mechanism as `SRS-K1A-04`); the page's own "dim inactive stores instead of hiding them" clause is untouched, unrelated to this sprint.
- `FR-INV-010 (E.0)` stays 🟡 PARTIAL, note updated: the owner's manual-deduction notification is now really delivered (not just an outbox row) — but it does **not** show which employee made the change (`buildSafeData`'s whitelist deliberately excludes `actor_id`, the same free-text/PII-avoidance discipline every other notification type follows), so the requirement's literal "بهوية الموظف" is still not met.
- `FR-ORD-004`, `FR-FUL-003`, `FR-NOTIF-001` stay 🟡 PARTIAL, notes updated: delivery is now real for the event types that already existed (new-order-for-employee, delivery-confirm-requested/-rerequested, not-received-reported, auto-confirm, reminder), but not every BranchOrder transition enqueues an event at all (start-preparation/mark-sent still don't — an unrelated, separate gap), and SMS/email remain fallback-log only.
- `PDR-021`, `BR-031` stay ✅ DONE, notes updated only for precision: both were already marked DONE on the strength of the Outbox *pattern* existing (ADR-006); now the notification these decisions require is actually delivered, not just written to an unread table.
- `SRS-G0-08`, `SRS-H3A-08`, `SRS-G3-08`, `L-16`: each bundles a `Notification`-shaped sub-clause alongside unrelated, still entirely-unbuilt items (`ReturnPolicy`/`ReturnRequest`/`Review`, `SupportTicket`, a specific technical-failure notification type respectively). Each moves from ❌ MISSING to 🟡 PARTIAL with its note narrowed to exactly what's resolved vs. still missing — none reaches DONE, since the bundled remainder is untouched by this sprint.
- `FR-NOTIF-002`, `FR-NOTIF-003`, `FR-VPORTAL-009`, `BR-020` (explicitly, per instruction): **unchanged.** OTP/order-confirmation SMS is still log-only (OPEN-004 still open); AR/EN templates still don't exist (the frontend remains Arabic-only, no language-based selection); vendor notification *preferences* (as opposed to delivery itself) were not built; `BR-020`'s three independently-tracked notifications still have no approved definition.
- `G-NO-01`, `G-NO-02`, `G-NO-03` (§4) closed — each now carries a "(مبنية الآن — S19)" note and moves to "غير مجدول", matching this document's own established convention for a resolved capability gap, with the narrower remaining FR-level nuances (admin UI page, employee identity, dimming) spelled out inline rather than silently dropped. `G-NO-04` (AR/EN templates + real SMS/OPEN-004) is **not** resolved and stays exactly as it was.
- Totals (§2): FR DONE 53→**55**, PARTIAL 67→**68**, MISSING 83→**80** (net: `FR-NOTIF-008`/`FR-VPORTAL-011` MISSING→DONE, `FR-NOTIF-004` MISSING→PARTIAL). PDR DONE 13→**14**, PARTIAL 15→**14** (`PDR-026` PARTIAL→DONE). §6's own BR recount: DONE 10→**11**, PARTIAL 10→**9** (`BR-034`). §5's roadmap S19 row: re-derived directly from every row actually tagged `S19` (18 rows, not the pre-existing, already-stale "10" — see that row's own note for exactly which rows were never reconciled into it by `v8`/`v9`). As with every prior narrowly-scoped pass here (`v7`'s and `v8`'s own precedent), this pass does **not** attempt to reconcile the separate, already-flagged `v8` delta or the frozen `§16`/`§17` grand-total tables (still at their `v4.1`/`v5` state) — both remain explicitly out of this pass's scope.

## v9 — S18b-branches-operations applied, 2026-10-03

`S18b-branches-operations` (branch `feat/sprint-18b-branches-operations`) is the second, final half of the approved Sprint 18 split (`S18a` — inventory/barcode — was the first half, applied in v8 above). Migration-additive only (`VendorUser.status`, `StoreBranch.archivedAt`, new `BranchOperatingHours`/`BranchClosure` tables — the latter the only `timestamptz` columns in the schema, with a GiST exclusion constraint making an overlapping closure for the same branch impossible at the database level). Updated here per the DONE rule in §1 (a real, reachable UI, not just an API):

- `FR-VEND-006` 🟡→✅: every sub-capability the requirement names now exists with a real UI — add a branch after onboarding, archive one, informational operating hours, and a temporary closure that actually blocks new reservations (delivery zones/windows already existed since S9).
- `SRS-H3A-03` 🟡→✅: the one explicitly-called-out remaining gap (employee transfer/disable) now has a real UI at `/vendor/:vendorId/staff`, alongside the pre-existing invite/accept and warehouse/pickup-points API.
- `FR-VPORTAL-009` stays 🟡 PARTIAL: hours and closures are now built, but vendor notification preferences (the requirement's fourth clause) remain entirely unbuilt — Sprint reassigned from `S18` to `S19`, alongside the other notification-preference gaps already tagged there.
- `FR-VPORTAL-005` stays 🟡 PARTIAL, not promoted to DONE: branch add/archive and staff list/transfer/suspend/reactivate all now have real UI, but inviting a *new* staff member is still API-only with no page — the one concrete gap left, same `S15` tag as `G-ON-04` (the invite-UI gap it corresponds to).
- `FR-VEND-013 (E.0)` stays 🟡 PARTIAL, note updated: transfer/suspend/reactivate now reachable from `/vendor/:vendorId/staff`; invite/accept still has no page (API only, same as before this sprint).
- `PDR-009` stays 🟡 PARTIAL, note updated: branch/staff-management owner UI is now substantially built; other owner-UI gaps (e.g. order cancellation/returns, `FR-VPORTAL-004`) are unrelated to this pass and remain — Sprint reassigned from `S18` to `S20a`, matching `FR-VPORTAL-004`'s own tag.
- `G-ON-07`, `G-IN-05` (§4) closed — each now carries a "(مبنية/مبني الآن — S18b)" note and moved to "غير مجدول", matching `G-IN-01`..`04`'s own established convention (v8) for a closed gap row.
- **Not touched, deliberately:** staff-invite UI itself (`G-ON-04`, the one concrete gap `FR-VPORTAL-005`/`FR-VEND-013` still carry), vendor notification preferences (`FR-VPORTAL-009`'s remaining clause, `G-NO-02`), and every other owner-UI gap PDR-009 still lists (cancellations/returns, reports, settlements) — none of this sprint's scope.
- Totals (§2, FR only, re-derived directly from the one row whose status actually changed): FR DONE 58→**59** (+1: `FR-VEND-006`), PARTIAL 65→**64** (−1, the same row). MISSING/DEFERRED/SUPERSEDED unchanged (81/27/14). Total FR row count unchanged at 245 (59+81+64+27+14=245). PDR unchanged (no PDR row's status changed this pass). BR/NFR (§6/§7) unchanged (no BR/NFR row touched this pass).

## v8 — S18a-inventory-barcode applied, 2026-10-02

`S18a-inventory-barcode` (branch `feat/sprint-18a-inventory-barcode`) is the first half of the approved Sprint 18 split (the second half, `S18b` — new branches, hours/closures, staff list/transfer/suspend — is untouched by this pass; see each bullet's own "not touched" note). Migration-additive only (`SALE` added to `StockMovementReason`; `BranchStock.safetyStockThreshold`/`lastPhysicalCountAt` added, the latter `NULL` for every pre-existing row — no backfill, since no pre-existing row was ever actually physically counted). Updated here per the DONE rule in §1 (a real, reachable UI, not just an API):

- `FR-INV-001` 🟡→✅, `FR-INV-005` 🟡→✅: the stock page now exists (`/vendor/:vendorId/branches/:branchId/stock`) — a movement form (including the new `SALE` reason), a dedicated physical-count-confirmation action, and a barcode-lookup field, reachable from both the owner's branches list and the employee's branch-orders page.
- `FR-INV-006` ❌→✅, `FR-INV-007` ❌→✅, `NFR-STALE-001` ❌→🟡: `safetyStockThreshold` per `(branch, offerVariant)` (`0` = disabled, checked as `threshold > 0 AND available <= threshold`, never a bare `<=`) and `lastPhysicalCountAt` (set only by a `COUNT_CORRECTION` movement or the new `confirm-count` endpoint — never by `SALE`/`DAMAGE`/`LOSS`, which are real stock changes, not a human having looked at the shelf) now back an `is_low_stock`/`is_stale` badge pair in the stock page. `NFR-STALE-001` only reaches 🟡, not ✅: the 7-day manual threshold is a hard-coded constant, not "قابل للضبط" (configurable), and no 24-hour API/feed-staleness source exists at all — both still genuinely missing.
- `FR-INV-009 (E.0)` ❌→✅, `PDR-020` 🟡→✅: a real scan-then-sell flow — `GET .../stock/lookup?barcode=` resolves a scanned/typed barcode to the actual `BranchStock` row at *this* branch (not just a vendor-level barcode match — a barcode known to the vendor but only ever stocked at a *different* branch returns the same 404 as a barcode unknown to the vendor at all, deliberately, so as not to leak "this exists at your other branch"), then a `SALE` movement records the sale through the same atomic, already-proven-safe-under-concurrency `createMovement` path every other reason uses. `SALE` deliberately does **not** enqueue the PDR-021 owner-notification Outbox event (a routine, repeatedly-firing sale is not what PDR-021's "notify immediately" means) and deliberately does **not** touch `lastPhysicalCountAt` — both still correctly fire for `DAMAGE`/`LOSS`/`COUNT_CORRECTION`.
- `PDR-018` 🟡→✅, `FR-MATCH-011 (E.0)` 🟡→✅: a Code128 label (via `jsbarcode`, a new runtime dependency) and a print button, rendered from the stock page.
- `PDR-021` 🟡→✅, `BR-030` 🟡→✅, `BR-031` 🟡→✅, `BR-005` 🟡→✅, `L-10` 🟡→✅: each of these was already substantively built (reason-required deduction, outbox notification, barcode uniqueness/non-replacement, atomic floor-at-zero, checkout's own independent reverification) but blocked on "no UI exists yet" or "no staleness flag exists yet" — both now true.
- `BL-INV-001` 🟡→✅, `BL-INV-003` ❌→✅ (§13, Part 8): inherit `FR-INV-001`/`FR-INV-006`'s own status, per this doc's own cross-reference convention.
- `G-IN-01`..`G-IN-04` (§4) closed — each now carries a "(مبنية/مبني الآن — S18a)" note and moved to "غير مجدول", matching `G-CA-02`'s own established convention for a closed gap row. `G-IN-05` (employee transfer/suspend) is untouched — explicitly `S18b` scope.
- `FR-INV-010 (E.0)` stays 🟡 PARTIAL (UI column only: the movement form now covers it) — its Sprint target is corrected from `S18` to `S19`, since the one real remaining gap (an actual delivered owner notification, not just an outbox row) is `G-NO-03`'s own scope, already tagged `S19` elsewhere in this same document.
- `SRS-G0-05`, `SRS-H3A-04` (§8/§9): backend notes updated to record that `SALE` now exists as a movement reason and that a real scan-to-sell endpoint exists; both stay 🟡 PARTIAL — `SRS-G0-05` because "استرجاع مرتجع"/"استيراد" still aren't distinct movement reasons, `SRS-H3A-04` because its "استيراد" clause is unrelated to this pass and unverified either way.
- **Not touched, deliberately:** every `S18b`-tagged row (`FR-VEND-006`, `FR-VPORTAL-009`, `G-ON-07`, `G-IN-05`, `SRS-H3A-03`'s transfer/disable clause, new-branch creation/activation, hours/closures, staff list/transfer/suspend), preorder/backorder/on-demand (`FR-INV-002` — explicitly deferred by the same product-owner decision that split S18, not by this pass), any barcode-camera/scanner-hardware UI (the lookup field accepts typed or externally-scanned-then-pasted text only — no `getUserMedia`/camera code was written), and anything checkout/POS/payment-related (`SALE` is a plain `StockMovement`, never a `PaymentTransaction`, never linked to any `CustomerOrder`/`BranchOrder`).
- Totals (§2, FR only, re-derived directly from §3's own rows, not inherited arithmetic): FR DONE 52→**58** (+6: `FR-INV-001/005/006/007`, `FR-INV-009 (E.0)`, `FR-MATCH-011 (E.0)`), PARTIAL 68→**65** (−3: the same three rows that left PARTIAL, net of none entering it), MISSING 84→**81** (−3: `FR-INV-006/007`, `FR-INV-009 (E.0)` leaving MISSING). Total FR row count unchanged at 245 (58+81+65+27+14=245). §6's own BR recount: DONE 7→**10**, PARTIAL 13→**10** (`BR-005/030/031`). §7's own NFR recount: PARTIAL 10→**11**, MISSING 18→**17** (`NFR-STALE-001`).

## v7 — S17-owner-matching-ui applied, 2026-09-29

`S17-owner-matching-ui` (branch `feat/sprint-17-owner-matching-ui`) is a small, owner-facing follow-up to Sprint 17 itself — a UI layer plus a few small, additive API extensions (no migration; see each bullet below for exactly what was added), **not** UI-only. It is **not** the `S17b` platform-catalog-administration item in §4/§5 below (`FR-CAT-001/002/003/006..012`, `FR-MATCH-005/006/007` — categories/brands/canonical-product admin, merge/split), which this pass does not touch, rename, or reclassify in any way. Two Sprint-17 review-round gaps that had a fully built and tested backend since Sprint 6/7 (`MatchReviewController`) but no UI at all — updated here per the DONE rule in §1 (a real UI route reachable from navigation, not just an API):

- `FR-MATCH-003` 🟡→✅: the vendor-wide non-exact match review queue (`GET :vendorId/match-review/queue`, existing since S6/S7) now has a real, linked UI (`/vendor/:vendorId/match-review`, in `ownerHubTiles`) — the owner reviews every PENDING candidate across all their offers and approves/rejects. The queue endpoint itself was also extended (still no migration — every added field comes from relations that already existed) with the offer/variant/canonical display data an actual review card needs, deterministic pagination (`score DESC, createdAt ASC, id ASC` keyset, reusing `platform-admin/cursor.util.ts`), and the same tie-break ordering on `listCandidates()`.
- **Owner-side half of `G-CA-07`** (§4) — submitting a canonical-product rename request and seeing its own status — now has a UI on the variant page, gated on the offer's own `canonical_product_id` (mirrors `requestNameChange()`'s own `hasConfirmedMatch` check). A new owner-scoped `GET :vendorId/canonical-products/:canonicalProductId/name-change-requests` backs it, filtered by `vendorId` AND `canonicalProductId` together (never `canonicalProductId` alone — more than one vendor can be matched to the same canonical product) and never exposing `decided_by_id` (an internal reviewer identity) to the owner. `G-CA-07`'s own row is narrowed accordingly — see below. This does **not** change `FR-MATCH-007`'s own status (admin-side decision UI predates this pass and is unrelated) nor build the admin-side of anything.
- Rows inheriting `FR-MATCH-003`'s status: `BL-MATCH-003` and `BL-MATCH-003b` (§13, Part 8) 🟡→✅ — `BL-MATCH-003b`'s own note already said "UI improvement only" (تحسين واجهة فقط), which is exactly what this pass built.
- `G-CA-07` (§4) narrowed from `FR-MATCH-003/010/012` to `FR-MATCH-010/012` only — the non-exact review queue and the owner-side rename-request UI are resolved; the import per-field conflict-resolution UI (`FR-MATCH-010`) and the image-similarity matching signal (`FR-MATCH-012`) are not, and stay listed as genuinely still missing.
- **Not touched, deliberately:** `FR-MATCH-010`, `FR-MATCH-012`, every `S17b`-tagged platform-catalog-administration row (§4/§5), and every Sprint-18+ item (inventory management UI, branch hours, barcode labels) — none of this pass's scope.
- Totals (§2, FR only): FR DONE 51→**52**, PARTIAL 69→**68** (1 PARTIAL→DONE). No row was added or removed, so §17's 663-row total is unchanged. The larger "grand total by source" table further below (before §17) was not re-derived for Sprint 17 itself (v6) and is not re-derived here either — it already understates FR/Part-8 DONE relative to §2's own v6/v7 numbers; flagged here rather than silently left inconsistent, fixing it is outside this pass's narrow scope.

## v6 — Sprint 17 (owner catalog) applied, 2026-09-27

Sprint 17 (branch `feat/sprint-17-owner-catalog`) implemented the plan the product owner approved (PDR-036 templates, brand sentinel, scheduled relative discounts + `PriceHistory`, media type + per-type limits + ordering, `ImportBatch`, the publish gate, and the owner-facing web UI for all of it). Status changes, each verified against code, a 50-test dedicated e2e spec (`sprint17-owner-catalog.e2e-spec.ts`) plus a scratch-DB migration-backfill spec, and — per the DONE rule in §1 — a real UI route reachable from `/vendor/:vendorId/offers` and its own nav, not just an API:

- `PDR-036` 🟡→✅: the ten fixed clothing/accessory templates (`ClothingCategoryTemplate` + `CLOTHING_CATEGORY_TEMPLATE_FIELDS`), structural validation (`validateTemplateAttributes`, both-or-neither DB `CHECK`), and the "No brand" sentinel (seeded at a fixed id, import-time alias resolution) are all built, with create/edit forms rendering the template's four fields dynamically and a brand dropdown (`/vendor/:id/offers/new`, `/vendor/:id/offers/:offerId`).
- `FR-CAT-015 (E.0)` 🟡→✅: the publish gate (`PATCH .../status` → `ACTIVE`) now structurally requires title, brand, a valid template+attributes pair (only when a template is chosen — PDR-036 D2, categories outside the ten keep the free-text fallback by design, not a gap), a `PRIMARY` `IMAGE`, and live available stock (never the raw, potentially-stale `reservedQuantity` column) — proven race-free against a concurrent checkout reservation by two dedicated barrier-based tests (publish-locks-first, reserve-locks-first), never both live-locking `vendor_offers` and `branch_stock` in a cycle. The refusal reasons reach the owner's screen verbatim.
- `FR-PRICE-002` ❌→✅ and `SRS-G3-09` ❌→✅: `PriceHistory` (append-only, one row per real config change, `effectivePriceAtChange` computed with the same shared `computeEffectivePrice()` every consumer uses, one-time `MIGRATED_BASELINE` backfill for every pre-existing variant at the exact `createdAt` it already had) with its own read-only screen on the variant page.
- `FR-PRICE-009 (E.0)` 🟡→✅: the scheduled relative discount (percent + two dates, mutually exclusive with the manual `sale_price`) with its own create/edit UI toggle.
- `FR-MATCH-002` 🟡→✅: the exact-match confirm/reject decision now has a UI banner on the variant page (the underlying "always a proposal, never silent" behaviour is unchanged from Sprint 3 — only the UI was missing before).
- `FR-CAT-004`, `FR-CAT-013`, `FR-CAT-014` 🟡→✅: `condition` and `specs_text_ar/en` are now editable in the variant forms (previously API-only); the `seller_sku`/`store_inventory_barcode` uniqueness constraints (built since S5) now surface their error text through the same forms.
- `FR-IMPORT-001`, `FR-IMPORT-003`, `FR-IMPORT-005`, `FR-IMPORT-012` 🟡→✅: single-offer/variant creation forms; the CSV/XLSX import screen (`/vendor/:id/offers/import`) shows the full per-category report and lets the owner download `failed_rows_csv` — exactly the failed rows, in the upload template's own columns plus `error_reason` — to fix and re-upload (a download-then-reupload retry, not a one-click in-app retry, stated plainly rather than implied).
- `FR-VPORTAL-002`, `FR-VPORTAL-003` 🟡→✅: the owner catalog UI (create/edit/archive/restore, media, pricing, import, batch history) is what these two rows were waiting on.
- `FR-IMPORT-004` ❌→🟡 (not ✅): `ImportBatch` is a real, durable, UI-visible history now (status/counts/timestamps, `/vendor/:id/offers/import`'s batch table) — but it is a **summary only**, never per-row detail, and a documented, disclosed limitation: if even the best-effort `FAILED` write cannot reach the database after a mid-processing exception, the row is left at `PROCESSING` rather than a false guarantee. `SRS-G3-03` (`ImportJob`/`ImportRow`, full per-row task detail) stays ❌ MISSING — `ImportBatch` does not satisfy that literal text.
- `SRS-G0-04` 🟡→✅: the 10-image/3-video per-variant cap and the `IMAGE`/`VIDEO` `MediaType` distinction (previously both explicitly absent) are now built and DB-`CHECK`-backed (`PRIMARY` may only be `IMAGE`).
- **Stay 🟡 PARTIAL, notes updated to reflect exactly what changed:** `FR-CAT-005` (alt text is now built and editable in the UI; platform-level media moderation is not — unrelated, owner self-service scope this sprint), `FR-MATCH-012 (E.0)` / `BR-001` (the non-exact scoring text signal now includes brand/colour/size/template values, still no image-similarity signal), `FR-MATCH-003` (only the exact-match confirm/reject got a UI — the broader non-exact `MatchReviewCandidate` review queue did not), `FR-IMPORT-002` (template download is now built; a pre-save dry-run/preview is not), `FR-IMPORT-008 (E.0)` / `PDR-019` (the additive/conflict mechanic is unchanged since S7; the import screen now shows conflict counts, but there is no in-app per-conflict resolution UI), `SRS-H1-03` (the import endpoint is now confirmed to use `IdempotencyInterceptor` too; not every other endpoint was re-audited this pass).
- **Unchanged, genuinely out of this sprint's scope:** `FR-IMPORT-009/011/014`, `FR-PRICE-003`, `BR-004`, `NFR-BW-001`, `NFR-IMG-001`, `NFR-STALE-002`, `L-09` (source/freshness, column mapping, source-priority, price staleness rules/marker, image compression, upload size cap — none built; no approved decision defers them, so they stay ❌ MISSING, same as before).
- `§4` capability-gap list: `G-CA-01` (create/edit form), `G-CA-03` (media upload/reorder/alt text), `G-CA-04` (`PriceHistory`), `G-CA-05` (scheduled discount), and `G-CA-06` (archive/restore) are fully resolved and **removed** from the missing-capability list (the convention already used for the 18 DEFERRED items in v4). `G-CA-02` and `G-CA-07` stay, narrowed to what's genuinely still missing: column-mapping only (template download and the report/batch-history screen are built) for `G-CA-02`; the non-exact review-queue UI and owner-side name-change-request UI only (exact-match confirm/reject is built) for `G-CA-07`.
- Totals (§2, FR+PDR only): FR DONE 38→**51**, PARTIAL 80→**69**, MISSING 85→**83** (12 PARTIAL→DONE, 1 MISSING→DONE, 1 MISSING→PARTIAL, net −11 PARTIAL / −2 MISSING / +13 DONE). PDR DONE 12→**13**, PARTIAL 16→**15**. No row was added or removed (only existing rows' status/notes changed), so §17's 663-row total is unchanged; only §2's DONE/PARTIAL/MISSING counts move.

## v5 — Sprint 16 (platform moderation) applied, 2026-09-26

Sprint 16 (branch `feat/sprint-16-platform-admin`) implemented the plan the product owner approved (decisions D1–D9). Status changes, each verified against code and tests:

- `FR-VEND-003` 🟡→✅ and `FR-VEND-009` ❌→✅: reviewer queue, audited single-item evidence reads (branch + warehouse), decisions bound to `evidence_revision` / `evidence_id` with a mandatory 10–1000 char reason for reject/request_resubmission (none on approve), conflict-of-interest refusal (`PLATFORM_VENDOR_CONFLICT_OF_INTEREST`, serialized against `acceptStaffInvite` on the vendor row lock), and admin suspend/reactivate (`VendorSuspension`, reason code + reason, AuditLog, Outbox event without the free-text reason), plus the `/admin/*` and owner `verification-status` screens.
- `L-23` ❌→✅ (suspended store: new orders and catalog edits blocked, in-flight orders keep moving; explicit deny/allow classification of every `vendors/:vendorId/*` route, enforced by a test that fails on an unclassified route), `BR-026` 🟡→✅, `BDR-016 (قديم)` 🟡→✅, `BL-VEND-003` 🟡→✅, `BL-VEND-006` ❌→✅, `BL-ADMIN-001` ❌→✅.
- `SRS-K1-STATES-03` ❌→🟡 (the admin screens have loading/empty/error/forbidden/success states; the audit viewer and role management remain S25).
- **Stay 🟡 PARTIAL, re-homed:** `FR-VEND-008` (SUSPENDED built; `CANCELLED` is not — see §15b, needs a product decision) and `FR-ADMIN-001` (only the vendors/verification/rename-request slice; other entities → S25). `G-AD-03` is only partly covered: the rename-request screen exists, **platform match correction is not built** (no approved policy). `SRS-K1A-11` stays 🟡.
- **`BR-017` stays ❌ MISSING and is NOT scheduled** (not DEFERRED — no approved decision defers it): its triggers (past-due grace, return-rate spikes, an unresubmitted rejection window) depend on features and a scheduled-job worker that do not exist. Only its last sentence (suspension is an explicit admin action with a captured reason) is satisfied.
- **Two new rows, both ❌ MISSING, not built** (§15b): `PDR-§3.5-APPEAL` (store appeal — `approved-product-decisions-2026-09.md` §3.5 names it but no row existed) and `FR-VEND-008-CANCELLED`.
- Totals: 661 → **663** rows (+2 in §15b); DONE 145 → 153, PARTIAL 205 → 202, MISSING 245 → 242 (−5 moved, +2 added). §2, §5 (S16 4 → 0, S25 20 → 21, one new unscheduled row), §16 and §17 are updated accordingly. S15 rows were not touched by this pass.

## v4 decisions applied, per new product-owner decisions (2026-09-26)

1. **The 18 `قرار-نطاق` items are now DEFERRED BY APPROVED DECISION, not MISSING/PARTIAL.** The product owner added them formally to `approved-product-decisions-2026-09.md` §6 today. All 18 rows (`FR-AUTH-012`, `FR-IMPORT-006/007`, `FR-SEARCH-009/011`, `FR-PRICE-004/008(E.8)/009(E.8)`, `FR-CART-007`, `FR-FUL-007`, `FR-SUP-006`, `FR-VPORTAL-008/010`, `FR-CMS-001..005`) now read ⏸ DEFERRED with sprint `-`, each citing the decision inline. `FR-FUL-007` was previously 🟡 PARTIAL (not ❌ MISSING) among the 18 — it moved to DEFERRED too, per the product owner's instruction to close all 18 uniformly. They are removed entirely from the §5 roadmap (no sprint, not pending — genuinely out of scope now).
2. **OPEN-011 (online-only verification) closed — PDR-035.** PHYSICAL/HYBRID stores keep the existing branch-photo-and-pin requirement; ONLINE_ONLY stores instead need a warehouse address pin (lat/lng + note) before verification-evidence submission, the warehouse is never exposed on any public/storefront endpoint, and the reviewer sees it only inside the verification path. Linked to `FR-VEND-002`, `FR-VEND-012`, and `PDR-010` inline; none of their code-level statuses changed (still not built — this closes the *decision*, not the implementation). S15's roadmap decision-requirement updated accordingly.
3. **OPEN-013 (clothing/accessory category fields) closed for the categories the platform currently supports — PDR-036.** Colour and size are offer-variant options, never one of a category's five structural fields (the enclosing Women/Men/Kids/Accessories segment already carries audience, so it is not repeated as a field). Ten five-field templates are now fixed (dresses, tops, bottoms, outerwear, sets, kids' clothing, shoes, bags, jewellery/watches, other accessories), with a controlled "No brand" value replacing a blank brand. Linked to `FR-CAT-015 (E.0)` inline; its code-level status is unchanged (still not built — S17). S17/S17b's roadmap decision-requirement updated accordingly; any future non-clothing category still needs its own template decision.
4. **No other status changed.** Every other row's DONE/PARTIAL/MISSING/SUPERSEDED value from v3 is untouched. §2's summary table, §5's roadmap totals, and §16/§17's grand totals are recomputed below to reflect only the reclassifications in points 1–3.
5. **§0/v2 point 4 below (the original "Sprint 26" note) is now historical** — superseded by point 1 above, kept for the audit trail rather than deleted.

## v4.1 correction, per product-owner review of v4

The v4 pass above referenced PDR-035/PDR-036 inline on `FR-VEND-002`/`FR-VEND-012`/`PDR-010`/`FR-CAT-015` but never gave them their own row — the file still said "every `PDR-*` ID" while covering only PDR-001..034, and every count still assumed 34. Fixed here:
- `PDR-035` and `PDR-036` are now their own rows in the `### PDR-001..036` table, each 🟡 PARTIAL: the decision is approved and documented in `approved-product-decisions-2026-09.md`, but neither is built — no warehouse-evidence submission/review path exists for PDR-035 (Sprint S15), and no category-template model/validation/UI exists for PDR-036 (Sprint S17).
- Every heading and scope line that said "PDR-001..034" or "(34 rows)" now says "PDR-001..036" / "(36 rows)".
- §2, §16, and §17 are recomputed: PARTIAL +2, total rows 659 → **661**.
- No other status, and no roadmap item beyond S15/S17's own PDR-035/036 row, changed.

## v3 corrections applied, per product-owner review of v2

1. **Arithmetic corrections.** Re-deriving every section's DONE/PARTIAL/MISSING/DEFERRED/SUPERSEDED counts directly from the actual table rows (not from memory) found mismatches in the `BR-*` footnote, the `NFR-*` footnote, `H.1`, `L-01..32`, `N.1..5`, and the `BDR` row of the old §16 grand total — all corrected in place below, with the corrected §16 now the single source of the totals. No status symbol on any individual row changed; only the summary arithmetic was wrong and is now fixed.
2. **BDR row fixed to 16, not 17.** The v2 footnote claiming a "duplicate BDR-016" was itself the error — the actual table has exactly 16 rows (BDR-001..015 plus one row labelled `BDR-016 (قديم)`), no duplicate. §16 now shows 16 directly, with no contradictory footnote.
3. **Part 8 is no longer a single rollup row.** §13 now maps all 102 `BL-*` IDs individually (every ID Part 8 actually contains — counted directly from the source document, not the earlier ~112 estimate) to the canonical ID whose status it inherits, with its own status column.
4. **`SRS-E11-RT-01` through `SRS-E11-RT-09`** are now nine separate physical rows (were one combined row). The same principle — no combined/range row anywhere in this file — was checked against every other section; the one other place it applied was Part 9's `AC-*` table (§14), where `AC-10/AC-11`, `AC-12/AC-13`, and `AC-15/AC-16` are now six separate rows instead of three combined ones.
5. **No status or roadmap changed.** This pass is a documentation correction only — the same rule from v2 (`§1`) still governs every status, and no sprint assignment in §5 changed.
6. **Actual row count stated at the end (§17)**, computed from this file's own content after the corrections above, not asserted from memory.

## 0. Corrections applied in this version (v2), per product-owner review of v1

1. **No map provider is the approved position, not a gap.** GPS only fills `lat`/`lng`; the customer picks the zone/landmark manually — this is the design already shipped in Sprint 14, not a missing integration. `FR-AUTH-008`, `PDR-029`, and `FR-CART-006` stay **PARTIAL**, but their backend/UI cells now say explicitly that the map is not the reason — the reason is no default address, no edit/delete, and no change-before-preparation.
2. **"Nearest branch" is not scheduled into Sprint 18b.** The shipped behaviour (a deterministic default branch, with every eligible branch shown so the customer can pick another) is a deliberate, documented substitute for "propose the nearest branch" — there is no reliable distance source in this codebase. `PDR-023` and `FR-CART-018 (E.0)` stay **PARTIAL** as an intentional deviation from the requirement's literal text, and are pulled out of every sprint until a new product decision supplies a distance source. Their sprint column now reads `— (قرار جديد)`.
3. **Sprint 20 is split.** What was one 21-item sprint is now two: **S20a** (fulfilment exceptions, cancellation, refund — 15 items) and **S20b** (checkout additions: terms, notes, minimum order — 6 items).
4. **Sprint 26 does not start.** Its 18 items are Phase-2/out-of-FYP requirements named by the SRS itself but never carried into `approved-product-decisions-2026-09.md` §6's deferred list. Their sprint column now reads `قرار-نطاق` (scope decision required) instead of a schedulable sprint number. Their status stays **MISSING** — I have not reclassified them as DEFERRED myself; that reclassification needs your decision either way (build them, or add them to §6 formally).
5. **This file replaces the scratchpad copy** and is the one reviewed after each sprint from now on.

## 1. Rules applied

- **DONE**: backend + authorization + a UI route reachable from navigation + a test, and no substitution for the requirement's actual text.
- **PARTIAL**: an endpoint, model, or test alone; or any substitute for the literal requirement (a deterministic branch instead of "nearest", typed coordinates instead of "map pin") **unless an approved decision explicitly replaced that text** (point 1–2 above are the only two such cases found).
- **MISSING**: nothing built, and not explicitly deferred by an approved decision.
- **DEFERRED BY APPROVED DECISION**: only where `approved-product-decisions-2026-09.md` §6, or an explicit PDR sentence, names the item. SRS-internal "Phase 2"/"out of MVP" language is **not** by itself an approved deferral — those rows stay MISSING and are flagged for your scope decision (§4, `قرار-نطاق`).
- **SUPERSEDED**: a historical Part-2 row E.0 explicitly replaces; excluded from the totals.
- 11 ID collisions exist inside the SRS itself (E.0 reuses an ID already used in a later section); both instances are listed, tagged `(E.0)` vs. the section number.

## 2. Summary

**Updated 2026-09-26 (v4)** — 18 FR-* rows moved from MISSING/PARTIAL to DEFERRED per the new §6 addition; see "v4 decisions applied" above. **Updated again 2026-09-26 (v4.1)** — PDR-035 and PDR-036 added as their own rows (both 🟡 PARTIAL: the decision is approved and documented, but the code for either — warehouse-evidence submission/review, and the category templates/model validation/UI — is not built yet). **Updated 2026-09-27 (v6)** — Sprint 17 implemented: 13 FR rows and 1 PDR row (PDR-036) moved PARTIAL/MISSING → DONE; 1 FR row (FR-IMPORT-004) moved MISSING → PARTIAL; several more stayed PARTIAL with their notes updated to reflect exactly what's now built vs. still missing. See "v6 — Sprint 17" above for the full per-ID list. **Updated 2026-09-29 (v7)** — `S17-owner-matching-ui` (branch `feat/sprint-17-owner-matching-ui`, a small owner-facing follow-up to Sprint 17 - a UI layer plus a few small, additive API extensions, not UI-only; not the `S17b` platform-catalog-administration item below, which this pass does not touch): `FR-MATCH-003` PARTIAL → DONE. See "v7 — S17-owner-matching-ui" above for the full per-ID list. **Flagged, not silently fixed:** this table was never updated for `v8` (`S18a-inventory-barcode`) — its own changelog note above states FR DONE moving 52→58, but this table still read 52 until now. `v9` (`S18b-branches-operations`) applied only its own single verified row (`FR-VEND-006` PARTIAL→DONE) on top of this table's own pre-existing figures (52→53, 68→67), the same narrow scope as every other version note here — it did **not** attempt to also reconcile `v8`'s unapplied +6/−3/−3 delta, which stays outside every pass's scope here and is left for a future pass to pick up (matching `v7`'s own precedent of flagging rather than silently fixing the separate "grand total by source" table's drift below). **Updated 2026-10-05 (v10, documentation only)** — `S19-notification-relay`: 3 FR rows moved MISSING→DONE/PARTIAL (`FR-NOTIF-008`, `FR-VPORTAL-011` → ✅ DONE; `FR-NOTIF-004` → 🟡 PARTIAL) and 1 PDR row moved PARTIAL→DONE (`PDR-026`); several more FR/PDR rows stayed exactly PARTIAL with notes updated to say precisely what's now delivered for real vs. still only a fallback log (see "v10" above). This pass's own figures are applied directly on top of v9's own pre-existing 53/67 FR baseline — it does **not** separately re-verify or fix `v8`'s own still-unreconciled delta noted just above.

| | DONE | PARTIAL | MISSING | DEFERRED | SUPERSEDED |
|---|---|---|---|---|---|
| FR (244) | 55 | 68 | 80 | 27 | 14 |
| PDR (36) | 14 | 14 | 8 | 0 | 0 |
| **Total** | **69** | **82** | **88** | **27** | **14** |

(v1→v3: unchanged, only sprint reassignment. v4: 17 rows MISSING→DEFERRED and 1 row (`FR-FUL-007`) PARTIAL→DEFERRED, all within the FR module. v4.1: PDR-035/036 added, both PARTIAL. v7: FR-MATCH-003 PARTIAL→DONE. v10: FR DONE +2, PARTIAL +1, MISSING −3; PDR DONE +1, PARTIAL −1. Total row count unchanged at 280 = 244+36.)

## 3. The ID table

Columns: ID | Requirement | Backend/model/API | Authorization | UI route (from navigation) | Test | Status | Sprint

Test abbreviations: S3…S14 = `sprintN-*.e2e-spec.ts`; AUTH = `auth.e2e-spec`; VV = `vendor-verification-owner-authorization.e2e-spec`; NAV = `web-navigation.e2e-spec`; WCH = `web-checkout-helpers.e2e-spec`. "Sprint" column values: `S15`…`S25` = single-sprint assignment; `— (قرار جديد)` = intentionally not scheduled, needs a new product decision; `قرار-نطاق` = not scheduled, needs a scope decision (build vs. formally defer).

### E.0 — September 2026 amendment
| ID | Requirement | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| FR-AUTH-013 (E.0) | ضيف يتصفح فقط؛ السلة/المتابعة/checkout بحساب؛ المفضلات/المراجعات/التنبيهات بحساب | session guard؛ CartItem على السيرفر؛ المفضلات (S24) والمراجعات (S23) محمية بحساب أيضاً | session | /login, /cart, /favorites (S24), /orders/[id]/items/[id]/review (S23) | S10,S14,AUTH,S23,S24 | ✅ DONE | S24 |
| FR-AUTH-014 (E.0) | تعطيل الحساب واسترجاعه 30 يوماً | **مبني بالكامل (S22)**: `DELETE /customers/me` يعطّل (قفل User→Vendors المملوكة مرتَّبة→فحص آخر OWNER نشط لكل متجر غير مغلق→فحص طلب نشط→كتابة deactivatedAt/sessionVersion)، idempotent عند التكرار؛ `login()` يرفض 403 ACCOUNT_DEACTIVATED؛ استرجاع مستقل تماماً عن password-reset: `POST /auth/reactivate-request` (مضاد تعداد) → `/auth/otp/verify` (purpose=account_reactivation) → `/auth/reactivate-confirm` (قفل حقيقي، إعادة فحص النافذة 30 يوماً تحت القفل) | session (الحساب نفسه) | /account/deactivate، /reactivate (من /login عند 403) (S22) | S22 + اختبارات حتمية (سباق checkout، سباقَا مالكين، سباق reactivate مزدوج) | ✅ DONE | - |
| FR-VEND-012 (E.0) | physical/online-only/hybrid، مستودع مخفي، نقاط استلام | Vendor.storeType، Warehouse، PickupPoint؛ PUT store-type/warehouse، POST/GET pickup-points. تحقّق ONLINE_ONLY محدَّد الآن بـPDR-035 (2026-09-26): دبوس عنوان المستودع بدل صورة/دبوس الفرع؛ لم يُبنَ بعد | OWNER | لا | S5 | 🟡 PARTIAL | S15 |
| FR-VEND-013 (E.0) | مالك/موظف كصلاحيات على نفس الحساب؛ موظف لفرع واحد | VendorUser(role,branchId,status)؛ staff-invites وaccept API؛ نقل/تعليق/إعادة تفعيل (S18b) | OWNER يدعو وينقل ويعلّق | مبدّل في /account؛ /vendor/:id/staff (نقل/تعليق/إعادة تفعيل، S18b)؛ لا صفحة دعوة أو قبول | S4,NAV,S18b | 🟡 PARTIAL | S15 |
| FR-VEND-014 (E.0) | وسيلة تواصل خارجية واحدة على الأقل | بوابة النشر في storefront.controller | OWNER | /vendor/:id/storefront | S7 | ✅ DONE | - |
| FR-CAT-015 (E.0) | النشر يتطلب عنواناً وصورة وتصنيفاً وسعراً ومخزوناً و5 حقول فئة | بوابة النشر (`PATCH .../status` → ACTIVE، S17) تتحقق فعلياً من: عنوان، علامة تجارية، قالب+خصائص صالحين (فقط إن اختير قالب — PDR-036 D2، الفئات خارج العشرة تبقى نصاً حراً بالتصميم)، صورة PRIMARY (IMAGE فقط)، ومخزون متاح حي (لا reservedQuantity الخام) — مُثبتة خالية من التسابق/الجمود عبر اختبارين بحاجز (publish-locks-first، reserve-locks-first) | OWNER | /vendor/:id/offers/:offerId (زر النشر ورسالة الرفض بالنص الحرفي) | S3,S6,S7,S17 | ✅ DONE | - |
| FR-CAT-016 (E.0) | أقسام المتجر: All، New arrivals، Discounts، حتى 20 مخصصاً | StoreSection(+Offer)؛ /storefronts/:slug/sections | OWNER؛ قراءة عامة | /vendor/:id/sections، /store/:slug | S7 | ✅ DONE | - |
| FR-MATCH-011 (E.0) | باركود المتجر فريد؛ ملصق داخلي قابل للطباعة؛ باركود المنصة منفصل | storeInventoryBarcode؛ platformProductBarcode؛ ملصق Code128 (jsbarcode) وزر طباعة (S18a) | OWNER | صفحة مخزون الفرع (S18a) | S6,S18a | ✅ DONE | - |
| FR-MATCH-012 (E.0) | خصائص ثم نص ثم صورة؛ المالك يؤكد | MatchReviewCandidate، match-review، match-confirmation؛ إشارة النص الآن تشمل العلامة/اللون/المقاس/قيم القالب (S17)؛ لا تشابه صور | OWNER | تأكيد/رفض المطابقة الدقيقة فقط (S17، صفحة المتغيّر)؛ طابور المراجعة غير الدقيقة بلا واجهة | S6,S7,S17 | 🟡 PARTIAL | S17 |
| FR-IMPORT-008 (E.0) | نفس الباركود + لون/مقاس جديد يضيف variant؛ تعارضات للمراجعة | POST offers/import + expected-offer-variant-conflict؛ آلية الإضافة/التعارض دون تغيير منذ S7 | OWNER | عدد التعارضات يظهر في تقرير الاستيراد (S17)؛ لا واجهة لحلّ كل تعارض | S7,S17 | 🟡 PARTIAL | S17 |
| FR-SEARCH-013 (E.0) | صفحات All/Women/Men/Kids/Accessories؛ المتجر يختار الأنواع؛ بحث مع اقتراحات وتسامح AR/EN | discovery?segment,q (contains)؛ VendorApplicableCategory؛ PUT applicable-categories | عام؛ OWNER للتعديل | /، /discovery؛ التعديل في /vendor/:id/storefront؛ لا اقتراحات ولا اختيار عند التسجيل | S13 | 🟡 PARTIAL | S18b |
| FR-SEARCH-014 (E.0) | مشاهدة واحدة لكل حساب/جهاز كل ساعتين للترتيب | لا | - | لا | لا | ❌ MISSING | S18b |
| FR-COMP-010 (E.0) | بطاقة: أرخص سعر متاح، حتى 5 شعارات، كسر التعادل بالتقييم ثم المسافة | comparison-card API؛ لا تقييم ولا مسافة | عام | / و/discovery؛ الشعار يفتح العرض | S8,S13 | 🟡 PARTIAL | S18b |
| FR-COMP-011 (E.0) | كل العروض من الأرخص؛ فلتر لون/مقاس؛ الإضافة للسلة من صفحة المتجر فقط | comparison API | عام | /compare/:id، /store/:slug/products/:offerId | S8 | ✅ DONE | - |
| FR-PRICE-008 (E.0) | كل المبالغ ILS بلا FX | العملة ILS فقط | n/a | كل واجهات السعر | S10,S14 | ✅ DONE | - |
| FR-PRICE-009 (E.0) | سعر أساسي لكل variant؛ خصم نسبي واحد بتاريخين؛ للمالك | basePrice + salePrice المطلق (متبادلان استبعادياً) + discountPercent/discountStartAt/discountEndAt (S17)، مع فحوص DB CHECK والتحقق التطبيقي | OWNER | نموذج إنشاء/تعديل المتغيّر (S17) | S3,S17 | ✅ DONE | - |
| FR-INV-008 (E.0) | مخزون لكل فرع وvariant؛ Available/Low/Sold out؛ الحد الأقصى عند الـcheckout؛ بلا نقل | BranchStock، bucketForStock، cart max_quantity | عام/session | البطاقات، /cart، /checkout | S6,S8,S14 | ✅ DONE | - |
| FR-INV-009 (E.0) | بيع فعلي: مسح، لون/مقاس، كمية، خصم ذري، تدقيق | reason=SALE (خصم فقط)؛ GET stock/lookup?barcode= يحلّ الباركود إلى صف BranchStock الفعلي بهذا الفرع؛ الخصم ذري (نفس آلية createMovement القائمة)؛ AuditLog لكل حركة (S18a) | موظف الفرع | صفحة مخزون الفرع: بحث بالباركود + نموذج حركة SALE (S18a) | S6,S18a | ✅ DONE | - |
| FR-INV-010 (E.0) | خصم يدوي بسبب + إشعار فوري للمالك بهوية الموظف والفرع | StockMovement(reason,note)؛ إشعار حقيقي الآن يصل لصندوق المالك (Notification، relay S19) فوراً تقريباً (كل 3 ثوانٍ)؛ الفرع متاح (vendorId/branchId على الإشعار)؛ **لا تُعرض هوية الموظف نفسه** في الإشعار — buildSafeData لا ينسخ actor_id عمداً (قائمة بيضاء، لا نص حر) | OWNER/موظف | صفحة مخزون الفرع: نموذج الحركة بسبب وملاحظة (S18a)؛ صندوق الإشعارات /notifications (S19) | S6,S18a,S19 | 🟡 PARTIAL | S19 |
| FR-CART-017 (E.0) | اختيار صريح؛ مجموعات فرع واحد؛ وإلا مجموعات منفصلة | CartItem، checkout-grouping | session | /cart، /checkout | S10,S14 | ✅ DONE | - |
| FR-CART-018 (E.0) | اقتراح **أقرب** فرع؛ العميل يختار غيره؛ موعد من 3 أيام | التجميع يختار فرعاً افتراضياً ثابتاً موثّقاً، ليس الأقرب (لا مصدر مسافة)؛ كل الفروع المؤهلة تُعرض؛ اختيار الفرع والموعد يعملان — بديل مقصود عن nearest، وليس فجوة تنفيذية؛ انظر PDR-023 | session | /checkout | S10,S14 | 🟡 PARTIAL | — (قرار جديد) |
| FR-ORD-009 (E.0) | CustomerOrder + BranchOrders، لكلٍّ تنفيذه ورسومه ودفعه وموعده | CustomerOrder، BranchOrder | session | /orders | S9,S10,S11 | ✅ DONE | - |
| FR-PAY-010 (E.0) | الطلبات المدفوعة إلكترونياً بمعاملة sandbox واحدة؛ COD لكل فرع | PaymentTransaction، توكنات sandbox | session | نموذج البطاقة في /checkout | S10,S14 | ✅ DONE | - |
| FR-FUL-008 (E.0) | تقويم الفرع، فترات لا تتداخل، سعة، استثناءات، حماية الفترات المحجوزة | DeliveryWindow(+Exception)، EXCLUDE، HAS_ACTIVE_ORDERS | OWNER | /vendor/:id/branches/:b/delivery-windows | S9 | ✅ DONE | - |
| FR-FUL-009 (E.0) | بدء التحضير وSent وDelivered؛ تذكيرات وفشل توصيل وعدم رد (PDR-025..027) | start-preparation، mark-sent، mark-delivered، pickup-handover، mark-delivery-failed، approve-refund؛ تذكير التحضير قبل 6 ساعات وكشف تأخر الموعد ومهلة 48 ساعة عبر `FulfilmentExceptionSweepService` | OWNER/موظف الفرع | /vendor/:id/branches/:b/orders | S11,S20a | ✅ DONE | - |
| FR-RET-008 (E.0) | سياسة إرجاع، لقطة عند الشراء، تغيير كل 6 أشهر | مبني بالكامل الآن، للإرجاع والتبديل معاً: `return_policy` إلزامي عند `POST /vendors` (PDR-030 حرفياً: "selected at registration")، `PUT /vendors/:id/return-policy` للتحديث اللاحق تحت قفل 6 أشهر حقيقي (قفل صف Vendor، لا مجرد فحص timestamp)، واللقطة الكاملة (enabled/mode/window/fee/**exchangeFee**/version) تُكتب على `BranchOrder` لحظة `confirm()` فقط - لا تتأثر بتعديل لاحق. **منذ S21b (2026-10-11): `EXCHANGE_ONLY`/`BOTH` حقيقيان الآن** مع رسم تبديل مستقل (`exchangeFeeIls`) يُطبَّق دائماً عبر `ExchangeSettlement` - الشق الوحيد من نص PDR-030 الحرفي الذي بقي غير مبني طوال S21/S21a. متجر قديم بلا قرار = `returnsEnabled=false`؛ طلب قديم بلا لقطة = غير مؤهل إطلاقاً (قرار صريح، لا افتراض صامت) | OWNER | صفحة سياسة الإرجاع لصاحب المتجر (`/vendor/:id/return-policy`) - تعرض القيمة الحالية بأربع خيارات (NO_RETURN/REFUND_ONLY/EXCHANGE_ONLY/BOTH)، تعدّلها، وترفض التعديل المبكر برسالة 409 حقيقية (جولة مراجعة 2026-10-10؛ حقل رسم التبديل أُضيف S21b) | S21 e2e + Playwright؛ S21b e2e + Playwright (رسم التبديل، الأوضاع الأربعة) | ✅ DONE | - |
| FR-RET-009 (E.0) | كود 6 أرقام صالح 7 أيام؛ كل الفروع تقبل | الكود يولَّد فقط عند موافقة المتجر (لا تلقائياً)، صالح 7 أيام بالضبط للإرجاع، فريد على مستوى vendor كله (`vendorId, code`) لا الفرع - يُستهلك مرة واحدة. **الاستلام مقيَّد على فروع المتجر الفعلية فقط هذا السبرنت** - نقاط الاستلام (PickupPoint) بلا عضوية تشغيلية في هذا الكود، فذاك الجزء من "كل نقاط الاستلام تقبل" يبقى غير مبني (S21b لا يغيّر هذا، ويستثني PickupPoint عمداً أيضاً). **S21b، للتبديل فقط**: نفس آلية الكود لكن بمدة 24 ساعة لا 7 أيام، واستلام مقيَّد على الفرع الوحيد المحدَّد عند التقديم (`replacement_branch_id`) لا أي فرع من فروع المتجر - أضيق عمداً من استلام الإرجاع، مفصَّل تحت PDR-030 أعلاه | OWNER/موظف أي فرع لنفس المتجر (إرجاع)؛ موظف/مالك الفرع المحدَّد فقط (تبديل) | العميل يرى الكود على صفحة تتبّع الإرجاع (`/returns/:id`)؛ أي موظف/مالك لفروع المتجر الفعلية يستبدله عبر (`/vendor/:id/returns/redeem`) (جولة مراجعة 2026-10-10) | S21 e2e + Playwright | 🟡 PARTIAL (فروع فعلية فقط، لا pickup points) | - |
| FR-REV-008 (E.0) | مراجعات منتج ومتجر لمشترٍ موثّق، غير قابلة للتعديل | مبني: `ReviewsService.submit()` يفحص أن `BranchOrderItem` غير ملغى (`cancelledAt`) وأن طلبه بالحالة `COMPLETED` فعلياً قبل القبول؛ الهدف (منتج عبر `CanonicalProduct`، أو متجر) يُشتق من الشراء نفسه على الخادم فقط - لا يرسله العميل إطلاقاً، فلا مجال لتزييفه؛ immutable حرفياً - لا `PATCH`/`DELETE` لأي مراجعة من أي نوع | عميل (مشترٍ موثّق) | صفحة كتابة مراجعة لكل عنصر طلب مكتمل (`/orders/:id/items/:id/review`)، مرتبطة من صفحة طلباتي | S23 e2e: أهلية كل حالة، BOLA على عنصر الطلب (404 لا 403)، سباق حتمي على فريدية (منتج+متجر) | ✅ DONE | - |
| FR-FAV-005 (E.0) | صفحة أتابعه؛ إشعارات منفصلة لمنتج/خصم جديد؛ تعتيم غير النشط | StoreFollow، following API؛ **إشعارات منفصلة لمنتج جديد وخصم جديد مبنيتان الآن فعلياً** (FOLLOWED_STORE_NEW_PRODUCT/FOLLOWED_STORE_DISCOUNT، fan-out عادل لكل متابع عبر الـrelay، S19)؛ غير النشط ما زال يُخفى لا يُعتّم (لم يتغيّر) | session | /following، /notifications (S19) | S13,S19 | 🟡 PARTIAL | S19 |
| FR-NOTIF-008 (E.0) | مركز إشعارات: مقروء/غير مقروء، روابط عميقة | **`Notification` model مبني بالكامل** (S19): `GET /me/notifications` (cursor + unread_only)، `/me/notifications/unread-count`، `POST .../read` (idempotent، آمن من BOLA — صف مستخدم آخر 404 لا 403)؛ بيانات الإشعار قائمة بيضاء فقط، لا نص حر إطلاقاً | session | أيقونة جرس + شارة غير مقروء في AppShell، صفحة /notifications (مقروء/غير مقروء، روابط عميقة لكل نوع — نوعا متابعة المتجر يُعاد توجيههما لصفحة "أتابعه" لا لصفحة المنتج تحديداً، لا slug مخزَّن على الإشعار) | S19 | ✅ DONE | - |
| FR-VPORTAL-007 (E.0) | المالك: عمليات وتحليلات المتجر؛ الموظف: مخزون وطلبات فرعه فقط | VendorMembershipGuard وعزل الفرع؛ لا تحليلات ولا واجهة مخزون للموظف | OWNER/موظف | مركز /vendor/:id، طلبات الفرع | S4,S9,NAV | 🟡 PARTIAL | S18 |

### E.1 — الهوية
| ID | Requirement | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| FR-AUTH-001 | تصفح وبحث ومقارنة كضيف | routes عامة | عام | /، /discovery، /compare، /store | AUTH,S8,S13 | ✅ DONE | - |
| FR-AUTH-002 | هاتف + كلمة مرور؛ البريد اختياري | /auth/register | عام | /register | AUTH | ✅ DONE | - |
| FR-AUTH-003 | OTP عند التسجيل قبل الطلب | /auth/otp/*، phoneVerifiedAt | عام | /register | AUTH | ✅ DONE | - |
| FR-AUTH-004 | checkout بجلسة موثقة | SessionAuthGuard | session | /checkout | S10 | ✅ DONE | - |
| FR-AUTH-005 | استعادة كلمة المرور بـOTP | /auth/password/reset-* | عام | /reset-password (من /login) | AUTH,S14 | ✅ DONE | - |
| FR-AUTH-006 | OTP لاستعادة كلمة المرور **ولتغيير الهاتف** | الاستعادة موجودة؛ **تغيير الهاتف مبني الآن (S22)**: `PATCH /customers/me {phone, verification_token}` فوق نفس OTP العام (purpose=phone_change)؛ انضباط LOGIN_REQUIRED/ISSUED مطابق لـconfirmPasswordReset() | session | /reset-password، و**/account/phone (S22)** | AUTH,S22 | ✅ DONE | - |
| FR-AUTH-007 | دمج سلة الضيف | استُبدل بـFR-AUTH-013 (E.0) | - | - | - | ↪ SUPERSEDED | - |
| FR-AUTH-008 | عناوين متعددة بدبوس خريطة وملاحظة وهاتفين | Address؛ POST/GET/**PATCH/DELETE (S22)** addresses؛ **عنوان افتراضي تلقائي للأول، تعديل، حذف (صلب إن لم يُستخدم بطلب أبداً، وإلا أرشفة) - كل عملية خلف `lockCustomerAddressState`** (S22)؛ **GPS يملأ lat/lng فقط (لا مزوّد خريطة خارجي، قرار معتمد)؛ العميل يكتب المنطقة/المعلم يدوياً** | session | /account، /checkout، **/account/addresses (S22)** | S14,WCH,S22 | ✅ DONE | - |
| FR-AUTH-009 | لغة عربية افتراضية وإنجليزية، محفوظة للحساب | عمود User.languagePref فقط، **يُقرأ ويُكتب الآن فعلياً عبر PATCH /customers/me (S22)** | - | **مبدّل لغة حقيقي ثنائي الاتجاه (ar/en)، تبديل RTL/LTR على `<html>`، قاموس ترجمة - لكن AppShell والواجهة المشتركة وشاشات S22 الجديدة فقط (S22)؛ كل شاشات S1-S21b تبقى عربية فقط بالتصميم (لم تُعَد ترجمتها هذا السبرنت)** | S22 Playwright | 🟡 PARTIAL — الأساس مبني وحقيقي، التغطية جزئية فقط | قرار-نطاق |
| FR-AUTH-010 | حذف الحساب | **لا حذف فعلي ولا purge - المبني (S22) هو تعطيل قابل للاسترجاع فقط (`DELETE /customers/me`، انظر FR-AUTH-014) تماماً كما ورد اسم الـroute حرفياً في SRS نفسه؛ لا سياسة احتفاظ (BR-018) ولا anonymization** | session | /account/deactivate (S22) | S22 | 🟡 PARTIAL — الاسم في SRS نفسه "حذف" لكن السلوك الفعلي تعطيل، وBR-018 يبقى MISSING | قرار-نطاق |
| FR-AUTH-011 | تقييد محاولات OTP والتسجيل السريع | Throttler على auth؛ too_many_attempts | عام | خطأ في /login و/register | otp.service.spec,AUTH | ✅ DONE | - |
| FR-AUTH-012 | تسجيل اجتماعي (الـSRS: خارج FYP، وليس في PDR §6) | لا — DEFERRED BY APPROVED DECISION (approved-product-decisions-2026-09.md §6، 2026-09-26) | - | لا | لا | ⏸ DEFERRED | - |

### E.2 — المتاجر
| ID | Requirement | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| FR-VEND-001 | طلب متجر: ملف ومعلومات وفرع واحد على الأقل | POST /vendors | session | لا | S3,S4 | 🟡 PARTIAL | S15 |
| FR-VEND-002 | دبوس وصورة للفرع الفعلي قبل الموافقة (PHYSICAL/HYBRID فقط، بقرار PDR-035 2026-09-26 — ONLINE_ONLY لا يحتاج صورة/دبوس فرع، انظر PDR-035) | POST verification-evidence | OWNER | لا | S3,VV | 🟡 PARTIAL | S15 |
| FR-VEND-003 | المراجع يوافق/يرفض/يطلب إعادة تقديم مع تدقيق | GET /admin/verification-queue؛ GET evidence مدقَّق للفرع والمستودع (فشل التدقيق = لا يُكشف الدليل)؛ POST verification-decision مربوط بـevidence_revision/evidence_id، سبب إلزامي لـreject/request_resubmission، منع تعارض المصالح، AuditLog | REVIEWER/ADMIN | /admin/verification، /admin/verification/:vendorId، /vendor/:vendorId/verification (المالك) | VV,S3,S16 | ✅ DONE | - |
| FR-VEND-004 | تأكيد الاشتراك قبل النشر | POST/GET subscription | OWNER | لا | S3 | 🟡 PARTIAL | S15 |
| FR-VEND-005 | حالة الاشتراك تتحكم بالظهور (PDR-033: ACTIVE/EXPIRED) | VendorSubscription، subscription-gate | OWNER | لا (بلا تذكيرات) | S3 | 🟡 PARTIAL | S15 |
| FR-VEND-006 | فروع متعددة بساعات وإغلاقات ومناطق | إضافة فرع لاحقاً وأرشفته (S18b)؛ ساعات عمل معلوماتية وإغلاقات مؤقتة تمنع الحجز فعلياً (S18b)؛ مناطق ونوافذ توصيل موجودة | OWNER | /vendor/:id/branches، /vendor/:id/branches/:branchId/hours، /delivery-zones، /delivery-windows | S9,S18b | ✅ DONE | - |
| FR-VEND-007 | أدوار موظفين مقسمة | استُبدل بـFR-VEND-013 (E.0) | - | - | - | ↪ SUPERSEDED | - |
| FR-VEND-008 | دورة حالة المتجر مع Suspended/Cancelled | APPLIED>UNDER_REVIEW>APPROVED/REJECTED>ACTIVE⇄SUSPENDED مبنية ومختبرة (S16)؛ CANCELLED (المالك يغلق الحساب) غير مبنية — انظر FR-VEND-008-CANCELLED في §15b | ADMIN | /admin/vendors | S3,VV,S16 | 🟡 PARTIAL | — (قرار جديد) |
| FR-VEND-009 | تعليق/إعادة تفعيل بسبب وتدقيق | POST /admin/vendors/:vendorId/suspend و/reactivate (VendorSuspension، reason_code + reason 10–1000، AuditLog، Outbox بلا نص السبب، منع تعارض المصالح)؛ GET /admin/vendors وتفاصيل التاريخ | PLATFORM_ADMIN | /admin/vendors، /admin/vendors/:vendorId | S16 | ✅ DONE | - |
| FR-VEND-010 | معلومات الدفع/التسوية | لا | - | لا | لا | ❌ MISSING | BACKLOG-FINANCE (من S25) |
| FR-VEND-011 | مؤشرات أداء المتجر | **مبني (S25)**: `VendorPerformanceService.computeForVendor()` — نافذة متحركة 30 يوماً (UTC) على `BranchOrder.createdAt`: معدّل الإلغاء (CANCELLED+REFUNDED / COMPLETED+CANCELLED+REFUNDED، null لا 0 عند عدم وجود طلبات نهائية)، متوسط زمن الاستجابة حتى أول `PREPARING` حقيقي (الطلبات التي لم تبلغ PREPARING تُستثنى كليّاً مع `responded_orders_count` ظاهر دائماً بجانب المتوسط)، والتقييم (نفس `ReviewsService.getVendorRatingSummary()` العلني من S23). خلف علم ميزة `vendor_performance_dashboard_enabled` (معطَّل افتراضياً حتى يُفعّله الأدمن) | OWNER فقط (`VendorMembershipGuard`+`@RequireVendorRole('OWNER')`، 404 BOLA)؛ PLATFORM_ADMIN لقائمة كل المتاجر | قسم داخل `/vendor/:id` (المالك)؛ `/admin/vendors/performance` (الأدمن، صفحة مستقلة بترقيم مؤشَّر على `Vendor.createdAt`/`id` الثابت، لا على أي مؤشّر محسوب) | S25 e2e: null عند عدم وجود طلبات نهائية، استثناء الطلبات غير المكتملة من البسط/المقام، استثناء الطلبات التي لم تبلغ PREPARING من متوسط الاستجابة، BOLA، بوابة العلم على الواجهتين | ✅ DONE | - |

### E.3 — الكتالوج
| ID | Requirement | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| FR-CAT-001 | شجرة تصنيفات AR/EN يديرها الأدمن | Category tree؛ /categories CRUD | PLATFORM_ADMIN | لا | S3 | 🟡 PARTIAL | S17b |
| FR-CAT-002 | علامات مضبوطة مع كشف تكرار | Brand.normalizedName فريد؛ POST /brands | PLATFORM_ADMIN | لا | S3 | 🟡 PARTIAL | S17b |
| FR-CAT-003 | قوالب خصائص لكل فئة | لا (structuralAttributes حر) | - | لا | لا | ❌ MISSING | S17b |
| FR-CAT-004 | حالة المنتج على العرض | OfferVariant.condition | OWNER | تُعرض وتُحرَّر (S17، نموذج إنشاء/تعديل المتغيّر) | S3,S17 | ✅ DONE | - |
| FR-CAT-005 | نص بديل للوسائط ووضع إشراف | OfferVariantMedia(url,kind,mediaType,altTextAr/En,sortOrder) (S17)؛ لا وضع إشراف على مستوى المنصة | OWNER | نص بديل قابل للتحرير لكل وسائط (S17) | S6,S17 | 🟡 PARTIAL | S17 |
| FR-CAT-006 | تقييد فئات/منتجات من الأدمن | لا | - | لا | لا | ❌ MISSING | S17b |
| FR-CAT-007 | بيانات SEO | لا | - | لا | لا | ❌ MISSING | S17b |
| FR-CAT-008 | دورة Draft>Pending>Published>Archived | enum CanonicalProductStatus؛ إنشاء أدمن فقط | PLATFORM_ADMIN | لا | S3,S7 | 🟡 PARTIAL | S17b |
| FR-CAT-009 | تحذير تكرار تقريبي للأدمن | تطابق تام فقط | - | لا | لا | ❌ MISSING | S17b |
| FR-CAT-010 | حقل الضمان | لا | - | لا | لا | ❌ MISSING | S17b |
| FR-CAT-011 | وسوم يديرها الأدمن | لا | - | لا | لا | ❌ MISSING | S17b |
| FR-CAT-012 | نوع المنتج الأساسي | لا | - | لا | لا | ❌ MISSING | S17b |
| FR-CAT-013 | SKU فريد لكل متجر | @@unique(vendorId,sellerSku)؛ خطأ SELLER_SKU_ALREADY_EXISTS واضح | OWNER | رسالة الخطأ تظهر في نموذج إنشاء المتغيّر (S17) | S3,S7,S17 | ✅ DONE | - |
| FR-CAT-014 | عنوان/وصف/مواصفات مستقلة لكل لغة | titleAr/En، specsTextAr/En | OWNER | العنوان قابل للتحرير (تعديل العرض)؛ المواصفات قابلة للتحرير (S17، نموذج إنشاء/تعديل المتغيّر) | S3,S17 | ✅ DONE | - |

### E.4 — التطابق
| ID | Requirement | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| FR-MATCH-001 | عرض مرتبط بمنتج أساسي أو مستقل، ولا يصير منتجاً أساسياً | canonicalProductId اختياري | OWNER | صفحات /store | S3,S7 | ✅ DONE | - |
| FR-MATCH-002 | ربط تلقائي بمعرّف دقيق (E.0: اقتراح يؤكده المالك) | اقتراح + match-confirmation | OWNER | تأكيد/رفض من صفحة المتغيّر (S17) | S6,S7,S17 | ✅ DONE | - |
| FR-MATCH-003 | طابور مراجعة مع درجة ثقة | MatchReviewCandidate(score)؛ API الطابور، موسَّع الآن بحقول عرض العرض/المتغيّر/المنتج المرجعي وترقيم صفحات حتمي (S17-owner-matching-ui) | OWNER | /vendor/:id/match-review (S17-owner-matching-ui، ضمن ownerHubTiles) | S6,S17,S17-owner-matching-ui | ✅ DONE | - |
| FR-MATCH-004 | غير المعتمد لا يظهر في المقارنة | المقارنة تقرأ المؤكَّد فقط | عام | /compare/:id | S8 | ✅ DONE | - |
| FR-MATCH-005 | العميل يبلّغ عن تطابق خاطئ | لا | - | لا | لا | ❌ MISSING | S17b |
| FR-MATCH-006 | دمج/فصل المنتجات الأساسية | لا | - | لا | لا | ❌ MISSING | S17b |
| FR-MATCH-007 | تدقيق كل قرار (بالثقة) | AuditLog على القرارات؛ لا دمج/فصل؛ الثقة وقت القرار لم أتحقق منها | - | لا | S6 | 🟡 PARTIAL | S17b |
| FR-MATCH-008 | نموذج المستويات الأربعة | Canonical/Variant/OfferVariant/unmatched | n/a | /compare، /store | S3,S8 | ✅ DONE | - |
| FR-MATCH-009 | غير المطابق قابل للبحث والشراء وموسوم | يُشترى من صفحة المتجر؛ الاكتشاف للمنتجات الأساسية فقط؛ بلا وسم | عام | /store/:slug/products/:id | S7,S13 | 🟡 PARTIAL | S18b |
| FR-MATCH-010 | لا استبدال صامت للمواصفات المتعارضة | تعارض الاستيراد يذهب للمراجعة؛ لا سياسة لكل حقل | OWNER | لا | S7 | 🟡 PARTIAL | S17 |

### E.5 — الاستيراد
| ID | Requirement | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| FR-IMPORT-001 | نموذج إنشاء عرض واحد | POST /offers، /variants | OWNER | نموذج إنشاء عرض/متغيّر (S17) | S3,S17 | ✅ DONE | - |
| FR-IMPORT-002 | CSV/Excel بقالب وتقرير قبل الحفظ | POST offers/import (تقرير)؛ قالب للتنزيل الآن مبني (S17)؛ لا dry-run/معاينة قبل الحفظ | OWNER | زر تنزيل القالب ورفع الملف (S17) | S7,S17 | 🟡 PARTIAL | S17 |
| FR-IMPORT-003 | نجاح جزئي | نتائج لكل صف | OWNER | تقرير الاستيراد الكامل يُعرض (S17) | S7,S17 | ✅ DONE | - |
| FR-IMPORT-004 | سجل مهام الاستيراد | ImportBatch (S17): حالة+عدادات+طوابع زمنية، ملخّص فقط لا تفصيل لكل صف | OWNER | جدول سجلّ عمليات الاستيراد (S17) | S17 | 🟡 PARTIAL | S17 |
| FR-IMPORT-005 | أخطاء صفوف قابلة للتنفيذ | أسباب لكل صف + failed_rows_csv قابل لإعادة الرفع (S17) | OWNER | يظهر في نتيجة الاستيراد مع زر تنزيل (S17) | S7,S17 | ✅ DONE | - |
| FR-IMPORT-006 | استيراد عبر API/feed بصلاحية | لا — DEFERRED BY APPROVED DECISION (approved-product-decisions-2026-09.md §6، 2026-09-26) | - | لا | لا | ⏸ DEFERRED | - |
| FR-IMPORT-007 | feeds مجدولة وPOS/ERP خارج FYP (الـSRS) | لا — DEFERRED BY APPROVED DECISION (approved-product-decisions-2026-09.md §6، 2026-09-26) | - | لا | لا | ⏸ DEFERRED | - |
| FR-IMPORT-008 (E.5) | لا scraping | لم يُبنَ | n/a | n/a | n/a | ✅ DONE | - |
| FR-IMPORT-009 | مصدر وحداثة كل عرض تظهر في المقارنة | لا | - | لا | لا | ❌ MISSING | S17 |
| FR-IMPORT-010 | استيراد الصور بالروابط/أرشيف | PDR §6: استيراد الروابط مؤجل، الرفع اليدوي لاحقاً | - | - | - | ⏸ DEFERRED | - |
| FR-IMPORT-011 | ربط أعمدة قابل للضبط | لا | - | لا | لا | ❌ MISSING | S17 |
| FR-IMPORT-012 | إعادة محاولة الصفوف الفاشلة فقط | ImportIdentifierRecord؛ failed_rows_csv بأعمدة القالب نفسها + error_reason (S17) — تنزيل ثم إعادة رفع، وليس زر "إعادة محاولة" داخل التطبيق بنقرة واحدة | OWNER | زر تنزيل الصفوف الفاشلة (S17) | S7,S17 | ✅ DONE | - |
| FR-IMPORT-013 | تقرير تسوية | لا | - | لا | لا | ❌ MISSING | BACKLOG-FINANCE (من S25) |
| FR-IMPORT-014 | أولوية المصدر وحفظ القيمة الخاسرة | لا | - | لا | لا | ❌ MISSING | S17 |

### E.6 — البحث
| ID | Requirement | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| FR-SEARCH-001 | بحث نصي AR/EN في العناوين والوصف والعلامة والخصائص | ILIKE على الأسماء والموديل والعلامة والفئة؛ لا الوصف ولا الخصائص | عام | شريط البحث ثم /discovery?q | S13 | 🟡 PARTIAL | S18b |
| FR-SEARCH-002 | تطبيع عربي وأرقام وتحويل حروف | لا | - | لا | لا | ❌ MISSING | S18b |
| FR-SEARCH-003 | إكمال تلقائي وتسامح مع الأخطاء | لا | - | لا | لا | ❌ MISSING | S18b |
| FR-SEARCH-004 | بحث بالباركود | لا | - | لا | لا | ❌ MISSING | S18b |
| FR-SEARCH-005 | تصفح فئات وفلاتر وترتيب | شريط الفئات/segment فقط؛ الأحدث أولاً | عام | /discovery | S13 | 🟡 PARTIAL | S18b |
| FR-SEARCH-006 | نتائج تراعي الموقع | لا | - | لا | لا | ❌ MISSING | S18b |
| FR-SEARCH-007 | المشاهَد مؤخراً والبحوث المحفوظة | لا | - | لا | لا | ❌ MISSING | S18b |
| FR-SEARCH-008 | اقتراحات عند عدم وجود نتائج | لا | - | لا | لا | ❌ MISSING | S18b |
| FR-SEARCH-009 | وسم الإعلانات (Phase 2 بحسب الـSRS) | لا — DEFERRED BY APPROVED DECISION (approved-product-decisions-2026-09.md §6، 2026-09-26) | - | لا | لا | ⏸ DEFERRED | - |
| FR-SEARCH-010 | غير المطابق ضمن النتائج وموسوم | الاكتشاف منتجات أساسية فقط | - | لا | لا | ❌ MISSING | S18b |
| FR-SEARCH-011 | بحث صوتي (خارج النطاق حسب الـSRS) | لا — DEFERRED BY APPROVED DECISION (approved-product-decisions-2026-09.md §6، 2026-09-26) | - | لا | لا | ⏸ DEFERRED | - |
| FR-SEARCH-012 | قاموس مرادفات | لا | - | لا | لا | ❌ MISSING | S18b |
| FR-SEARCH-013 (E.6) | التعرف على العلامة والموديل وترجيحهما | العلامة والموديل ضمن contains بلا ترجيح | عام | البحث | S13 | 🟡 PARTIAL | S18b |
| FR-SEARCH-014 (E.6) | ترتيب قابل للتفسير | الأحدث أولاً فقط | - | لا | لا | ❌ MISSING | S18b |
| FR-SEARCH-015 | لا محرك توصيات؛ المشاهَد مؤخراً والبحوث المحفوظة فقط | لا محرك (مطابق)؛ الآخران غير موجودين | - | لا | لا | 🟡 PARTIAL | S18b |

### E.7–E.8 — المقارنة والتسعير
| ID | Requirement | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| FR-COMP-001 | مجموعة مقارنة حتى 4 | مبني الآن: `ComparisonSet` حتى 4 منتجات، الحد مُثبت بتزامن حقيقي (طلبان متزامنان عند 3 عناصر - ينجح واحد فقط) | session (إدارة)، عام (مشاركة) | /compare/sets، /compare/sets/[id] | S24 e2e | ✅ DONE | S24 |
| FR-COMP-002 | وضعان: عروض المنتج نفسه أو منتجات منافسة | مبني الآن: الوضع 2 (منتجات منافسة، 2-4 معرّفات) إلى جانب الوضع 1 الموجود | عام | /compare/:id، /compare/cross (جديدة) | S8، S24 e2e | ✅ DONE | S24 |
| FR-COMP-003 | خصائص الفئة + سعر وخصم وحالة وضمان وتوصيل وتقييم ومسافة ووقت | مبني الآن: الحالة، الضمان ("غير متوفر" عند الغياب الحقيقي)، رسوم التوصيل (بالمنطقة، تعيد استخدام `resolveDeliveryFee` حرفياً)، تقييم المتجر - **المسافة والوقت خارج النطاق عمداً هذا السبرنت (قرار نهائي #2)**، لا بنية geolocation/ETA في المشروع | عام | /compare/:id، /compare/cross | S24 e2e | 🟡 PARTIAL | S24 |
| FR-COMP-004 | إبراز التشابه والاختلاف | مبني الآن: حقل `diff` (الحالة/الضمان) لكل من المقارنة والمقارنة المتقاطعة | عام | /compare/:id، /compare/cross | S24 e2e | ✅ DONE | S24 |
| FR-COMP-005 | وسم الأرخص وأفضل قيمة مع السبب | مبني الآن: وسم الأرخص مع سبب نصّي صريح لكل من الوضعين - **"أفضل قيمة" خارج النطاق عمداً (قرار نهائي #1، لا صيغة معتمدة)** | عام | /compare/:id، /compare/cross | S24 e2e | 🟡 PARTIAL | S24 |
| FR-COMP-006 | تنبيه بيانات قديمة | مبني الآن: `is_price_stale` (أقدم من 30 يوماً، BR-004/NFR-STALE-002 الحالي) بالاعتماد على آخر `PriceHistory` كمصدر الأقرب للحقيقة | عام | /compare/:id، /compare/cross | S24 e2e | ✅ DONE | S24 |
| FR-COMP-007 | رابط مشاركة ومجموعة محفوظة | مبني الآن: مجموعة محفوظة كاملة بالإضافة للرابط الموجود لكل منتج | session (الحفظ)، عام (المشاركة) | /compare/sets، /compare/shared/[slug] | S24 e2e | ✅ DONE | S24 |
| FR-COMP-008 | يعمل على الجوال وRTL | واجهة متجاوبة (الصفحات الجديدة تتبع نفس الأسلوب)؛ تحقق بصري فقط، بلا اختبار آلي للواجهة | عام | /compare/:id، /compare/cross، /compare/sets* | لقطات فقط | 🟡 PARTIAL | S24 |
| FR-COMP-009 | مقارنة بعملات متعددة | استُبدل بـFR-PRICE-008 (E.0) | - | - | - | ↪ SUPERSEDED | - |
| FR-PRICE-001 | سعر أساسي وتخفيض وعملة | استُبدل بـFR-PRICE-008/009 (E.0) | - | - | - | ↪ SUPERSEDED | - |
| FR-PRICE-002 | تاريخ أسعار كامل | PriceHistory (S17): سجلّ إضافة فقط، صف واحد لكل تغيير حقيقي، تعبئة أولية MIGRATED_BASELINE للمتغيّرات السابقة | OWNER | صفحة سجلّ الأسعار في المتغيّر (S17) | S17 | ✅ DONE | - |
| FR-PRICE-003 | قواعد تقادم السعر | لا | - | لا | لا | ❌ MISSING | S17 |
| FR-PRICE-004 | قواعد تراكب الخصومات/الكوبونات (Phase 2 بحسب الـSRS) | لا — DEFERRED BY APPROVED DECISION (approved-product-decisions-2026-09.md §6، 2026-09-26) | - | لا | لا | ⏸ DEFERRED | - |
| FR-PRICE-005 | المبلغ المستحق: أصناف + توصيل + رسوم + ضريبة | الأصناف والتوصيل فقط؛ لا رسوم ولا ضريبة - **تأجيل كامل متعمَّد في S20b** (قرارك 2026-10-08: OPEN-009 لا يزال مفتوحاً، المبالغ/السياسة لا يمكن افتراضها، لا حقول فارغة أُضيفت أصلاً) | session | /checkout | S10 | 🟡 PARTIAL | - |
| FR-PRICE-006 | حد أدنى للطلب | مبني بالكامل: حد افتراضي لكل فرع (`StoreBranch.minimumOrderValue`) + override اختياري لكل منطقة توصيل (`VendorDeliveryZone.minimumOrderValue`)؛ PICKUP يستخدم حد الفرع فقط، DELIVERY يستخدم حد المنطقة إن وُجد وإلا حد الفرع؛ المعيار subtotal الأصناف فقط | OWNER | /vendor/:id/branches/:b/minimum-order، /vendor/:id/delivery-zones | S20b | ✅ DONE | - |
| FR-PRICE-007 | مقارنة مطبَّعة بـFX | استُبدل بـFR-PRICE-008 (E.0) | - | - | - | ↪ SUPERSEDED | - |
| FR-PRICE-008 (E.8) | عروض فلاش وحزم وخصم كمية (Phase 2 بحسب الـSRS) | لا — DEFERRED BY APPROVED DECISION (approved-product-decisions-2026-09.md §6، 2026-09-26) | - | لا | لا | ⏸ DEFERRED | - |
| FR-PRICE-009 (E.8) | الإعلانات الممولة (Phase 2 بحسب الـSRS) | لا — DEFERRED BY APPROVED DECISION (approved-product-decisions-2026-09.md §6، 2026-09-26) | - | لا | لا | ⏸ DEFERRED | - |

### E.9 — المخزون
| ID | Requirement | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| FR-INV-001 | مخزون لكل فرع وvariant | BranchStock؛ stock GET/movements/page (S18a) | OWNER/موظف | صفحة مخزون الفرع (S18a) | S5,S6,S18a | ✅ DONE | - |
| FR-INV-002 | حالات توفر تشمل Preorder/Backorder/عند الطلب | ثلاث فئات فقط (PDR-017) | - | البطاقات | S8 | 🟡 PARTIAL | S18 |
| FR-INV-003 | حجز بنافذة انتهاء | CheckoutReservation 10 دقائق | session | /checkout | S10 | ✅ DONE | - |
| FR-INV-004 | منع السطر النافد وخصم شرطي ذري | خصم ذري داخل txn التأكيد؛ حالة نفاد في السلة | session | /cart، /checkout | S10,S14 | ✅ DONE | - |
| FR-INV-005 | تحديث يدوي للمخزون | POST movements (DAMAGE/LOSS/SALE خصم فقط؛ COUNT_CORRECTION باتجاهين)/stock API (S18a أضافت SALE) | OWNER/موظف | صفحة مخزون الفرع: نموذج الحركة (S18a) | S6,S18a | ✅ DONE | - |
| FR-INV-006 | تنبيه مخزون قديم | lastPhysicalCountAt + is_stale (قديم = لا جرد فعلي منذ 7 أيام، NFR-STALE-001) (S18a) | OWNER/موظف | شارة "جرد قديم" في صفحة مخزون الفرع (S18a) | S18a | ✅ DONE | - |
| FR-INV-007 | مخزون أمان | safetyStockThreshold لكل (فرع، variant)؛ 0=معطّل؛ is_low_stock = threshold>0 AND available<=threshold؛ PUT safety-stock (OWNER فقط) (S18a) | OWNER | حقل حد الأمان (owner فقط) في صفحة مخزون الفرع (S18a) | S18a | ✅ DONE | - |
| FR-INV-008 (E.9) | تقرير تسوية المخزون | لا | - | لا | لا | ❌ MISSING | BACKLOG-FINANCE (من S25) |

### E.10 — السلة والـcheckout
| ID | Requirement | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| FR-CART-001 | سلة متعددة البائعين مقسمة بالبائع | استُبدل بـFR-CART-017 (E.0) | - | - | - | ↪ SUPERSEDED | - |
| FR-CART-002 | إعادة التحقق من السعر والمخزون قبل الدفع | txn التأكيد؛ فرق السعر | session | /checkout | S10,S14 | ✅ DONE | - |
| FR-CART-003 | حد أدنى لكل شريحة | checkout يتحقق من الحد الأدنى (فرع/منطقة) لكل مجموعة فرع (البديل المعتمد لـ"الشريحة"، PDR-004/BR-009)؛ `quote()` يُظهر blocker لكل فرع مؤهل دون حظر، `reserve()` يرفض فعلياً إن تم تجاوز الحد | session | /checkout | S20b | ✅ DONE | - |
| FR-CART-004 | أهلية عنوان التوصيل بالمنطقة وبديل الاستلام | فحص المنطقة في quote/reserve | session | /checkout | S10,S14 | ✅ DONE | - |
| FR-CART-005 | توصيل أو استلام لكل بائع | استُبدل بـFR-ORD-009 (E.0) | - | - | - | ↪ SUPERSEDED | - |
| FR-CART-006 | دبوس المنزل وهاتفان وملاحظات | هاتفان + إحداثيات (**GPS يملأها فقط، لا مزوّد خريطة، قرار معتمد**) + معلم نصي؛ لا ملاحظة توصيل لكل طلب | session | /checkout AddressForm | S14 | 🟡 PARTIAL — بسبب لا ملاحظة لكل طلب، وليس الخريطة | S22 |
| FR-CART-007 | كوبونات (Phase 2 بحسب الـSRS) | لا — DEFERRED BY APPROVED DECISION (approved-product-decisions-2026-09.md §6، 2026-09-26) | - | لا | لا | ⏸ DEFERRED | - |
| FR-CART-008 | checkout idempotent | IdempotencyInterceptor | session | /checkout | S10,S14 | ✅ DONE | - |
| FR-CART-009 | COD ودفع إلكتروني | paymentMethod لكل فرع | session | /checkout | S10 | ✅ DONE | - |
| FR-CART-010 | السلات المهجورة بلا أثر | الحجوزات تنتهي والسلة تبقى | session | /cart | S10 | ✅ DONE | - |
| FR-CART-011 | مادة الطلب: CustomerOrder وVendorSuborders | استُبدل بـFR-ORD-009 (E.0) | - | - | - | ↪ SUPERSEDED | - |
| FR-CART-012 | قبول صريح للشروط (ومنفصلة: شروط كل متجر إن وُجدت) | **شروط المنصة فقط مبنية بالكامل**: صفحة `/terms` ثابتة بنسخة `2026-10-v1`، موافقة إلزامية قبل `reserve()` (يرفض بـTERMS_NOT_ACCEPTED/TERMS_VERSION_MISMATCH)، تُسجَّل على CheckoutReservation ثم تُنسخ لـCustomerOrder عند التأكيد. **شروط المتجر الخاصة غير مبنية عمداً** (قرارك 2026-10-08: تحتاج سياسة owner/versioning غير معتمدة أصلاً) - لا تُعتبر الفجوة مكتملة | session | /checkout، /terms | S20b | 🟡 PARTIAL | - |
| FR-CART-013 | اختيار الموعد لكل شريحة أثناء الـcheckout | اختيار الموعد في reserve | session | /checkout | S10 | ✅ DONE | - |
| FR-CART-014 | ملاحظة العميل لكل شريحة وملاحظة داخلية للمتجر | `customer_note` يُدخلها العميل عند reserve لكل مجموعة، تنتقل لـBranchOrder عند confirm، تظهر للعميل وللموظف/المالك فقط؛ `internalStoreNote` يُعدِّلها الموظف/المالك لنفس الفرع فقط عبر PATCH، لا تظهر للعميل أبداً، AuditLog يسجل التغيّر والطول فقط لا النص؛ كلاهما مستبعد صريحاً من أي Outbox/Notification payload | عميل/موظف/OWNER | /checkout، /orders، صفحة طلبات الفرع | S20b | ✅ DONE | - |
| FR-CART-015 | إظهار تعارض التنفيذ لكل شريحة | `quote()` يعيد `blockers[]` منظَّمة لكل فرع مؤهل، بـ**كودين حقيقيين الآن**: (1) `BELOW_MINIMUM_ORDER_VALUE` لكل من PICKUP/DELIVERY بشكل مستقل، و(2) `DELIVERY_NOT_AVAILABLE_IN_ZONE` - **أُضيف في جولة المراجعة** عندما يكون عنوان العميل معروفاً (zone) لكن هذا الفرع/البائع لا يغطي تلك المنطقة أصلاً (لا صف `VendorDeliveryZone`، أو الصف موجود لكن `enabled: false`) - نفس الكود/الرسالة التي يرفض بها `reserve()` فعلاً (`reserveDeliverySlotAlreadyLocked`)، فالمعاينة الآن تطابق التنفيذ الحقيقي حرفياً، وليست فقط `delivery_fee: null`/`minimum_order_value.delivery: null` ضمنياً كما كانت سابقاً (الحقلان لا يزالان موجودين لتوافقية الواجهة، لكن الواجهة لا تعتمد عليهما كإشارة - تعرض `blockers[].message` مباشرة). لا بلوكر يظهر إن لم يُقدَّم عنوان أصلاً (لا نية توصيل مُعلنة بعد). فرع مغلق/مؤرشَف/معلّق/بلا مخزون كافٍ لا يظهر في `eligible_branches` أصلاً (مُستبعد مسبقاً في `buildAvailabilityMap`/`groupByVendorAndBranch`)، فلا يوجد صف لإرفاق blocker به - إن لم يتبقَّ أي فرع مؤهل لصنف ما يظهر ذلك الصنف في `unavailable_items[].reason` (نتيجة منظَّمة وآمنة - لا تذكر فرعاً ولا رقم مخزون - سلوك سابق لـS18b/S10 لم يُعدَّل هنا، خارج نطاق S20b). كل مجموعة (group) مستقلة تماماً - أي blocker (من الكودين) في مجموعة لا يظهر أبداً في مجموعة أخرى (مُختبَر لكل كود على حدة). واجهة `/checkout` تعرض `blockers[].message` صراحةً لكل فرع/مجموعة حسب طريقة التنفيذ المختارة فعلاً - لا تستنتج العميل أي شيء من null. **مثال السرس الحرفي (فترة توصيل مشتركة) غير قابل للحدوث فعلياً في هذه البنية** (لا موارد مشتركة بين مجموعتين). `reserve()` يبقى atomic/all-or-nothing عمداً (قرارك 2026-10-08) - لم يتغيّر، فقط `quote()` اكتسب المعاينة الجديدة | session | /checkout | S14,S20b | ✅ DONE | - |
| FR-CART-016 | حفظ السلة عند فشل الـcheckout | PAYMENT_FAILED rollback والحجز يبقى | session | /checkout | S14 | ✅ DONE | - |

### E.11 — الطلبات
| ID | Requirement | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| FR-ORD-001 | CustomerOrder + suborders | استُبدل بـFR-ORD-009 (E.0) | - | - | - | ↪ SUPERSEDED | - |
| FR-ORD-002 | دورة حياة مستقلة | استُبدل بـFR-ORD-009 (E.0) | - | - | - | ↪ SUPERSEDED | - |
| FR-ORD-003 | رفض فرع لا يلغي أشقاءه | الطلبات الفرعية مستقلة أصلاً (BR-028)؛ إلغاء/استرداد BranchOrder (عميل/موظف/أدمن) لا يلمس إخوته أبداً | موظف/OWNER/عميل | صفحة طلبات الفرع، /orders | S9,S11,S20a | ✅ DONE | - |
| FR-ORD-004 | كل انتقال منسوب ومُشعَر ومدقَّق | AuditLog نعم لكل انتقال؛ الإشعار أصبح حقيقياً الآن للانتقالات التي كانت أصلاً تُنشئ outbox (طلب جديد للموظف، طلب تأكيد التسليم وإعادة الطلب، بلاغ عدم استلام، تأكيد تلقائي 72 ساعة، تذكير 48 ساعة — S19 relay)؛ **ليس كل انتقال يُطلق إشعاراً** — بدء التحضير وSent مثلاً لا يُنشئان أي حدث outbox إطلاقاً، فجوة منفصلة غير مرتبطة بالـrelay | - | /notifications (S19) | S11,S19 | 🟡 PARTIAL | S19 |
| FR-ORD-005 | جدول زمني موحد للطلب | قائمة BranchOrder؛ لا جدول للأب — قرار بنيوي متعمَّد (BR-028: الأب لا يحمل حالة أبداً)، لم يتناوله S20a | session | /orders | S11 | 🟡 PARTIAL | - |
| FR-ORD-006 | الإلغاء بحسب الحالة | مخطط الحالات موسَّع (DELIVERY_FAILED/REFUND_REQUESTED)؛ endpoints إلغاء/إلغاء صنف للعميل والموظف، وإلغاء/استرداد قسري للأدمن، كل منها مقيَّد بالحالة الحالية | عميل/موظف/OWNER/PLATFORM_ADMIN | /orders، صفحة طلبات الفرع، /admin/branch-orders | S9,S20a | ✅ DONE | - |
| FR-ORD-007 | إجراءات بحسب الدور، مع إلغاء بعد الشحن | العزل بحسب الدور مكتمل؛ الإلغاء بعد Sent متاح فقط عبر مسار فشل التوصيل (PDR-027: COD يُلغى تلقائياً في المحاولة الثانية) | OWNER/موظف/عميل | صفحة طلبات الفرع، /orders | S9,S11,S20a | ✅ DONE | - |

### E.12 — الدفع
| ID | Requirement | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| FR-PAY-001 | تحصيل COD يسجله المسلِّم | mark-delivered وpickup-handover يسجلان المبلغ المحصَّل فعلياً (`codCollectedAmount/At`) محسوباً من الخادم ضمن نفس المعاملة الذرّية | موظف الفرع | صفحة طلبات الفرع | S10,S11,S20a | ✅ DONE | - |
| FR-PAY-002 | تفويض والتقاط إلكتروني (FYP: sandbox بقرار PDR) | شحن sandbox | session | /checkout | S10,S14 | ✅ DONE | - |
| FR-PAY-003 | توزيع دفع متعدد البائعين على الطلبات الفرعية | معاملة واحدة للمدفوع إلكترونياً؛ التوزيع لكل BranchOrder لم أتحقق منه | session | /checkout | S10 | 🟡 PARTIAL | S20a |
| FR-PAY-004 | استرداد كامل/جزئي لكل صنف مع رسوم التوصيل | سجل `BranchOrderRefund` لكل صنف + رسوم التوصيل (مرة واحدة فقط لكل طلب، بـpartial unique index حقيقي)؛ استرداد تلقائي (PDR-025/027)، بموافقة الموظف، أو إلغاء قسري من الأدمن (PLACED/PREPARING فقط). **لا استرداد يدوي بمبلغ منفصل عن الأصناف** — أُزيل عمداً (مراجعة 2026-10-08): كان يكسر سقف computeRemainingRefundable لأنه غير مرتبط بصنف، يحتاج سجل تخصيص حقيقي (S21) | عميل/موظف/PLATFORM_ADMIN | /orders، صفحة طلبات الفرع، /admin/branch-orders | S20a | ✅ DONE | - |
| FR-PAY-005 | العمولة تُسجَّل ولا تُحصَّل | لا | - | لا | لا | 🟡 PARTIAL | BACKLOG-FINANCE (من S25) |
| FR-PAY-006 | فوترة الاشتراك كتيار دفع مستقل | VendorSubscription فقط؛ لا سجلات دفع | OWNER | لا | S3 | 🟡 PARTIAL | S15 |
| FR-PAY-007 | سجل مالي مدقَّق غير قابل للتعديل | AuditLog للإلحاق فقط؛ ليس كل أحداث الدفع مؤكدة؛ لا عارض | - | لا | S1 | 🟡 PARTIAL | BACKLOG-FINANCE (من S25) |
| FR-PAY-008 | فاتورة/إيصال (PDR §3.4: لا إيصال مطبوع للعميل) | لا | - | لا | لا | ❌ MISSING | BACKLOG-FINANCE (من S25) |
| FR-PAY-009 | تعويض عند عدم اتساق الدفع والطلب | rollback داخل txn واحدة | session | /checkout | S10,S14 | ✅ DONE | - |
| FR-PAY-010 (E.12) | معالجة chargeback (تحتاج بوابة حقيقية) | PDR §6: البوابة الحقيقية مؤجلة | - | - | - | ⏸ DEFERRED | - |

### E.13 — التنفيذ
| ID | Requirement | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| FR-FUL-001 | تنفيذ على مستوى البائع عند الـcheckout | استُبدل بـFR-ORD-009 (E.0) | - | - | - | ↪ SUPERSEDED | - |
| FR-FUL-002 | التوصيل عبر آلة حالة مع سائق | استُبدل بـFR-FUL-009 (E.0) وPDR-006 | - | - | - | ↪ SUPERSEDED | - |
| FR-FUL-003 | تأكيد الطلب يطلق تنبيه المتجر + رسالتين | تنبيه الموظف (لا المالك) أصبح حقيقياً داخل التطبيق الآن (NEW_ORDER_FOR_EMPLOYEE، S19 relay)؛ لا رسائل SMS/خارجية للعميل بعد — NotificationChannelService ما زال fallback log فقط، نفس عقد OPEN-004/SmsService، بلا مزوّد حقيقي | - | /notifications للموظف (S19) | S10,S19 | 🟡 PARTIAL | S19 |
| FR-FUL-004 | أهلية منطقة التوصيل | مناطق على مستوى المتجر (PDR-022) + فحص منطقة العنوان | session | /checkout، /vendor/:id/delivery-zones | S9,S10 | ✅ DONE | - |
| FR-FUL-005 | رسوم التوصيل بحسب المنطقة | VendorDeliveryZone.fee | session | /checkout | S10 | ✅ DONE | - |
| FR-FUL-006 | معالجة فشل التوصيل | mark-delivery-failed مع عداد المحاولات؛ محاولة أولى تنتظر إعادة جدولة العميل (48 ساعة)، محاولة ثانية: COD تُلغى تلقائياً، إلكتروني يُفتح لطلب استرداد العميل | موظف الفرع/عميل | صفحة طلبات الفرع، /orders | S20a | ✅ DONE | - |
| FR-FUL-007 | شحنات مجزأة إن فعّلها المتجر | لا خيار؛ شحنة واحدة فقط — DEFERRED BY APPROVED DECISION (approved-product-decisions-2026-09.md §6، 2026-09-26) | - | لا | لا | ⏸ DEFERRED | - |
| FR-FUL-008 (E.13) | كود استلام يتحقق منه الفرع | BranchOrder.pickupCode، pickup-handover | موظف الفرع | صفحة طلبات الفرع، /orders | S10,S11 | ✅ DONE | - |
| FR-FUL-009 (E.13) | استلام المرتجعات | مبني: استلام الكود يسجّل الفرع الفعلي/المستلم/الوقت/حالة السلعة (resellable/damaged) ضمن transaction ذرية واحدة (قفل Return→BranchOrderItem→BranchStock بترتيب ثابت). **تفسير معتمد**: "يتبع Delivery SM بالعكس" حرفياً في الـSRS غير مطابق لهذه البنية (PDR-006 يمنع دور سائق داخلي) - المطبَّق هو drop-off بالكود في أي فرع تابع لنفس المتجر، لا reverse-delivery حقيقي. resellable يعيد المخزون (حركة `RETURN_RESTOCK`)؛ damaged لا يعيده بلا قرار owner يدوي صريح | OWNER/موظف أي فرع لنفس المتجر | صفحة استبدال الكود (`/vendor/:id/returns/redeem`) - نموذج الكود+الفرع المستلِم+حالة السلعة (جولة مراجعة 2026-10-10) | S21 e2e + Playwright: resellable/damaged، BOLA عبر الفروع، سباق redeem حتمي | 🟡 PARTIAL (فروع فقط، لا pickup points) | - |
| FR-FUL-010 | وقت توصيل/جاهزية تقديري | يُعرض الموعد المختار؛ لا حساب ETA — استُبعد عمداً من نطاق S20a (قرار الجولة الأولى من المراجعة، 2026-10-07): هذا السبرنت غطّى الاستثناءات/الإلغاء/الاسترداد فقط | session | /checkout، /orders | S10 | 🟡 PARTIAL | - |
| FR-FUL-011 | تعيين سائق | استُبدل بـPDR-006 | - | - | - | ↪ SUPERSEDED | - |
| FR-FUL-012 | تسجيل استلام النقد مع المبلغ | `codCollectedAmount`/`codCollectedAt` يُسجَّلان ضمن معاملة mark-delivered/pickup-handover ذاتها، بمبلغ محسوب من الخادم (الإجمالي الأصلي ناقص أي صنف/رسوم ملغاة)، لا مبلغ يُدخله الموظف يدوياً | موظف الفرع | صفحة طلبات الفرع | S11,S20a | ✅ DONE | - |
| FR-FUL-013 | اختيار موعد مجدول | اختيار الموعد | session | /checkout | S10 | ✅ DONE | - |
| FR-FUL-014 | webhooks شركات التوصيل | PDR-006: التنسيق مع الناقل خارج المنصة | - | - | - | ⏸ DEFERRED | - |

### E.14 — المرتجعات
| ID | Requirement | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| FR-RET-001 | أهلية الإرجاع بالمدة والسبب | مبني: `checkReturnEligibility()` يفحص الحالة الفعلية (DELIVERED/COMPLETED للتوصيل مع `deliveredAt`، PICKED_UP/COMPLETED للاستلام مع `pickedUpAt` الحقل الجديد، COD يتطلب `codCollectedAt` إضافياً، ONLINE مضمون بنيوياً عبر بوابة AwaitingPayment) والنافذة من لقطة السياسة لا السياسة الحيّة. الحد الأدنى القانوني المحتمل (Q11) يبقى مفتوحاً، لا يُفترض | عميل | صفحة طلب الإرجاع (`/orders/:id/items/:id/return`) تعرض رسالة عدم الأهلية الحقيقية من الخادم حرفياً (جولة مراجعة 2026-10-10) | S21 e2e + Playwright: كل حالة أهلية + legacy + snapshot لا يتأثر بتعديل لاحق | 🟡 PARTIAL (الحد الأدنى القانوني المحتمل لا يزال مفتوحاً - Q11) | - |
| FR-RET-002 | طلب إرجاع بسبب وصور لأصناف محددة | مبني: `POST .../items/:itemId/returns` بسبب موجَّه (enum) + ملاحظة + حتى 5 صور (URLs فقط، بلا pipeline رفع - نفس قيد الكود العام) | عميل (مالك الطلب) | صفحة طلب الإرجاع للعميل (`/orders/:id/items/:id/return`) - نموذج السبب+الملاحظة+الصور (جولة مراجعة 2026-10-10) | S21 e2e + Playwright: تقديم، منع تكرار مفتوح، إعادة تقديم بعد إغلاق | ✅ DONE | - |
| FR-RET-003 | SLA للمتجر وتصعيد تلقائي | مبني: 48 ساعة تذكير (`ReturnSweepService`، نمط sweep كسول موجود مسبقاً)، 72 ساعة تصعيد تلقائي حقيقي (ESCALATED)، ونافذة نزاع 7 أيام بعد رفض المتجر تُغلق تلقائياً (REJECTED_CLOSED) إن لم يُنازع العميل | نظام (sweep) | - (آلي بالكامل بالتصميم؛ لا خطوة واجهة مطلوبة - التذكير يصل عبر مركز الإشعارات الموجود (S19)، والحالة المعلَّقة تظهر في قائمة إرجاعات الفرع (`/vendor/:id/branches/:b/returns`)؛ "لا UI" كان توصيفاً خاطئاً لا فجوة حقيقية - تصحيح 2026-10-10) | S21 e2e: تذكير 48h، تصعيد 72h، إغلاق نافذة النزاع | ✅ DONE | - |
| FR-RET-004 | حساب الاسترداد | مبني وفق PDR-030/031 حرفياً (لا BR-013 القديمة): `max(0, سعر الصنف − رسم الإرجاع الملتقط)`، بلا رسم توصيل أبداً. **ONLINE وCOD سجلّان منفصلان بوضوح** (`BranchOrderRefund.method`: `ONLINE_GATEWAY` بـ`paymentTransactionId` حقيقي، أو `COD_CASH` بلا أي ربط بوابة دفع) - لا يُعاملان كشيء واحد | نظام (عند الاستلام) | صفحة طلبات العميل (`/orders`) - حقل `amount_refunded` الموجود مسبقاً يجمع كل صفوف `BranchOrderRefund` بلا تمييز سبب، فمبلغ استرداد ONLINE الناتج من إرجاع يظهر تلقائياً بلا أي كود جديد؛ COD لا يُعرض له مبلغ بالتصميم المعتمد نفسه لكل استرداد COD آخر (نقد فعلي) - تصحيح 2026-10-10 | S21 e2e + orders e2e: ONLINE/COD منفصلان، الرسم ≥ السعر يُصفَّر عند 0 | ✅ DONE | - |
| FR-RET-005 | أسباب موجَّهة | الأسباب الخمسة (DAMAGED/WRONG_ITEM/COUNTERFEIT_CLAIM/WARRANTY_CLAIM/CHANGE_OF_MIND) مُسجَّلة وتُعرَض، **لكن لا توجّه فعلياً لمسارات SLA/موافقة مختلفة** كما يطلب النص الحرفي - SLA واحد موحّد (48h/72h) لكل الأسباب هذا السبرنت | عميل | قائمة الأسباب تُعرَض في نموذج طلب الإرجاع (`/orders/:id/items/:id/return`) وفي كل صفحة عرض لاحقة (جولة مراجعة 2026-10-10) - لكن التوجيه التفاضلي نفسه (المطلوب هنا) لا يزال غير مبني | - | 🟡 PARTIAL (الأسباب موجودة وتُعرَض، التوجيه التفاضلي غير مبني) | - |
| FR-RET-006 | تصعيد النزاعات | مبني: نزاع العميل على رفض المتجر (ضمن 7 أيام) → ESCALATED، يحسمه `PLATFORM_ADMIN` فقط (لا دور دعم مستقل في هذا الكود) عبر `PATCH /admin/returns/:id/escalation-decision`. رفض الأدمن (`ADMIN_REJECTED`) حالة مستقلة عمداً عن رفض المتجر - نهائي، لا نزاع ثانٍ، لا إعادة تقديم (تصحيح جولة مراجعة: خلط الحالتين كان يسمح بالتفافّ على قرار الأدمن) | PLATFORM_ADMIN | طابور إدارة المنصة والحسم (`/admin/returns`) - اعتماد/رفض نهائي بسبب إلزامي (جولة مراجعة 2026-10-10) | S21 e2e + Playwright: نزاع ضمن النافذة، رفض أدمن نهائي بلا نزاع/إعادة تقديم | ✅ DONE | - |
| FR-RET-007 | حدود إساءة الاستخدام | لا - لم يُبنَ أي رصد لمعدل إرجاع شاذ أو تصعيد لمراجعة تشغيلية | - | - | - | - | ❌ MISSING | S22+ |

### E.15–E.17 — المراجعات والمفضلات والإشعارات
| ID | Requirement | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| FR-REV-001 | مراجعة من مشترٍ موثّق | مبني: الأهلية تُقرَّر على الخادم فقط من `BranchOrderItem`→حالة طلبه (`COMPLETED`)، غير الملغى (`cancelledAt`) - نفس منطق BR-016 | عميل | `/orders/:id/items/:id/review` | S23 e2e | ✅ DONE | - |
| FR-REV-002 | أهداف: منتج/متجر/توصيل (PDR-032: منتج ومتجر) | مبني وفق PDR-032 حرفياً (منتج ومتجر فقط، لا توصيل - ليس فجوة، بل تضييق نطاق معتمد): `targetType` PRODUCT يُشتق إلى `CanonicalProduct` عبر `OfferVariant.canonicalVariantId`؛ STORE يُشتق إلى `Vendor` مباشرة من `BranchOrderItem.vendorId`؛ قيد CHECK بنيوي (`reviews_exactly_one_target`) يمنع كلا الهدفين أو عدمهما معاً | عميل | نفس صفحة كتابة المراجعة (اختيار منتج/متجر) | S23 e2e | ✅ DONE | - |
| FR-REV-003 | صور في المراجعة | لا (PDR-032 حرفياً: تقييم 1-5 وتعليق إلزامي فقط - لا صور) | - | لا | لا | ↪ SUPERSEDED (PDR-032) | - |
| FR-REV-004 | رد المتجر على المراجعة | PDR-032 و§6: ردود البائع مؤجلة | - | - | - | ⏸ DEFERRED | - |
| FR-REV-005 | صيغة التقييم المجمّع | مبني: متوسط حسابي لمراجعات VISIBLE فقط (`computeAggregateRating`)، يُحجَب كلياً (null، لا صفر) دون 3 مراجعات على الأقل - **قرار هذا السبرنت نفسه، مستقل عن مرجع الـSRS المعلَّق لـ"الجزء 6، القسم O" الذي ثبت أنه فارغ لا يحتوي صيغة فعلية** | عام | يظهر في صفحة مراجعات المتجر | S23 e2e: الحجب دون 3، الظهور عند 3، استبعاد المراجعات المخفية من الحساب | ✅ DONE | - |
| FR-REV-006 | الإبلاغ عن مراجعة | مبني: `ReviewReport` بحالات PENDING/DISMISSED/UPHELD، فريد لكل (مراجعة، مُبلِّغ) - بلاغ مكرر من نفس العميل يُرفض 409 | عميل | زر "الإبلاغ عن هذه المراجعة" في صفحة مراجعات المتجر | S23 e2e: بلاغ مكرر، حسم تجاهل/إخفاء | ✅ DONE | - |
| FR-REV-007 | كشف أنماط شاذة | لا - **خارج النطاق عمداً (القرار النهائي #3 لهذا السبرنت)**، وليس سهواً: وسائل مكافحة الإساءة المبنية فعلاً هي فقط أهلية الشراء + فريدية (منتج/متجر لكل عنصر) + البلاغات اليدوية - لا رصد معدل/نمط آلي | - | لا | لا | ❌ MISSING | S24+ |
| FR-REV-008 (E.15) | شارة التحقق على صفحة المتجر | مبني: `is_verified` مُشتَق (قرار نهائي #9) - PHYSICAL: كل فرع فعلي نشط APPROVED (ولا بد من وجود فرع واحد فعلي على الأقل)؛ ONLINE_ONLY: آخر لقطة `WarehouseVerificationEvidence` APPROVED؛ HYBRID: الاثنان معاً. حقل مشتق فقط يُضاف للاستجابة العامة الموجودة - لا بيانات Warehouse الخام (lat/lng/عنوان) تُعرض أبداً، يبقى الاستثناء الوحيد المتعمَّد من قاعدة "لا نكشف Warehouse" (PDR-010) | عام | شارة "متجر موثّق" إلى جانب شارة "متاح الآن" في صفحة المتجر العامة | S23 e2e: PHYSICAL (فرع واحد/فرعان/فرع مؤرشَف)، ONLINE_ONLY (لا دليل/مرفوض/معتمد)، HYBRID (الشرطان معاً) | ✅ DONE | - |
| FR-REV-009 | تعديل/حذف المراجعة | استُبدل بـPDR-032 (لا تعديل) | - | - | - | ↪ SUPERSEDED | - |
| FR-REV-010 | مؤشرات أصالة على مستوى العرض | لا - نفس استبعاد FR-REV-007 أعلاه (القرار النهائي #3) | - | لا | لا | ❌ MISSING | S24+ |
| FR-FAV-001 | مفضلة: منتج/عرض/متجر | مبني الآن: `Favorite` (PRODUCT/OFFER، BOLA-safe، idempotent) - المتجر يبقى عمداً عبر `StoreFollow` الموجودة (قرار نهائي #6)، لا تكرار | session | /favorites (جديدة)، /following (متجر) | S24 e2e (27 اختباراً) | ✅ DONE | S24 |
| FR-FAV-002 | حفظ مجموعة مقارنة | مبني الآن: `ComparisonSet`/`ComparisonSetItem`، حد 4 عناصر (مُثبت بتزامن حقيقي)، رابط مشاركة | session (الإنشاء/الإدارة)، عام (رابط المشاركة) | /compare/sets، /compare/sets/[id]، /compare/shared/[slug] (جديدة) | S24 e2e | ✅ DONE | S24 |
| FR-FAV-003 | تنبيه انخفاض السعر | مبني الآن: كلا نقطتي التحديث (PATCH يدوي فوري + sweep الخصم المجدوَل) تُرسلان عبر outbox الموجود، إزالة تكرار للمستخدم المفضِّل للمنتج وللعرض معاً | session | /notifications (الموجودة، مُوسَّعة لأنواع S24) | S24 e2e | ✅ DONE | S24 |
| FR-FAV-004 | تنبيه عودة المخزون | مبني الآن **لمفضلة OFFER فقط** (قرار نهائي #4 - لا تنبيه لمفضلة PRODUCT عمداً)، على مستوى المتجر كله (0 إلى متوفر عبر كل الفروع) لا فرع واحد | session | /notifications | S24 e2e (يشمل اختبار deadlock وno-phantom-row) | ✅ DONE | S24 |
| FR-FAV-005 (E.16) | تفضيلات وتكرار الإشعارات | مبني الآن: تفعيل/تعطيل لكل نوع تنبيه (`NotificationPreference`، افتراضي مفعّل) - **التكرار/التجميع غير مبني عمداً هذا السبرنت** (قرار نهائي #5، لا دفعات) | session | /favorites (لوحة تفضيلات) | S24 e2e | 🟡 PARTIAL | S24 |
| FR-FAV-006 | تنبيه عرض جديد | مبني الآن: عرض مطابق جديد لمنتج أساسي مفضَّل (عبر التأكيد المباشر أو مراجعة المطابقة) يُرسل مرة واحدة فقط | session | /notifications | S24 e2e | ✅ DONE | S24 |
| FR-NOTIF-001 | SMS وemail وin-app بتتبع لكل قناة | **in-app أصبح حقيقياً وموثوقاً الآن** (Notification model + relay بإعادة محاولة S19)؛ SMS/email ما زالا بلا مزوّد حقيقي (NotificationChannelService fallback log فقط، OPEN-004)؛ لا سجل نجاح/فشل لكل قناة على حدة | - | /notifications (in-app فقط) | S19 | 🟡 PARTIAL | S19 |
| FR-NOTIF-002 | SMS للـOTP وتأكيد الطلب | OTP مسجَّل في اللوغ (OPEN-004) | - | OTP في /register | AUTH | 🟡 PARTIAL | S19 |
| FR-NOTIF-003 | قوالب AR/EN بحسب لغة المستلم | لا | - | لا | لا | ❌ MISSING | S19 |
| FR-NOTIF-004 | إعادة محاولة وسجل محاولات | **مبني الآن بالكامل**: claim/lease، إعادة محاولة بـexponential backoff، `attemptCount`/`lastError` محفوظان لكل صف، DEAD_LETTER بعد 5 محاولات (S19، مختبر بدقة — تصاعد المحاولات والـbackoff مؤكَّدان سطراً بسطر) | PLATFORM_ADMIN لقائمة dead-letter | **لا صفحة واجهة مخصصة** — `GET /admin/outbox/dead-letter` API فقط | S19 | 🟡 PARTIAL | S19 |
| FR-NOTIF-005 | عدم كشف الهاتف الخام إلا بحسب تصميم الطلب | الموظف يرى الاسم والهاتف والكود فقط | موظف الفرع | صفحة طلبات الفرع | S10,S11 | ✅ DONE | - |
| FR-NOTIF-006 | WhatsApp خارج النطاق | لم يُبنَ | n/a | n/a | n/a | ✅ DONE | - |

### E.18–E.22 — الدعم والإدارة والبوابة والمحتوى والتحليلات
| ID | Requirement | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| FR-SUP-001 | تذاكر الدعم | PDR §6: نظام الدعم الرسمي مؤجل | - | - | - | ⏸ DEFERRED | - |
| FR-SUP-002 | أولوية/مرفقات التذاكر | PDR §6 | - | - | - | ⏸ DEFERRED | - |
| FR-SUP-003 | SLA وتصعيد | PDR §6 | - | - | - | ⏸ DEFERRED | - |
| FR-SUP-004 | استرداد بصلاحية موظف دعم | PDR §6 | - | - | - | ⏸ DEFERRED | - |
| FR-SUP-005 | جدول العميل الموحد للوكيل | PDR §6 | - | - | - | ⏸ DEFERRED | - |
| FR-SUP-006 | قاعدة معرفة/FAQ ثنائية اللغة | لا (لم تُذكر في PDR §6) — DEFERRED BY APPROVED DECISION (approved-product-decisions-2026-09.md §6، 2026-09-26) | - | لا | لا | ⏸ DEFERRED | - |
| FR-ADMIN-001 | شاشات إدارة لكل كيان | شاشات S16: طابور التحقق، المتاجر (تعليق/إعادة تفعيل)، طلبات تغيير الاسم؛ باقي الكيانات (تصنيفات، علامات، منتجات أساسية، طلبات، دفعات…) API فقط أو غير مبنية؛ تصحيح تطابق المنصة غير مبني (لا سياسة معتمدة) | ADMIN/REVIEWER | /admin/* (الشريحة المذكورة فقط) | S3,S7,VV,S16 | 🟡 PARTIAL | BACKLOG-ADMIN (من S25) |
| FR-ADMIN-002 | قوائم غير مضمّنة في الكود | المناطق والقطاعات enums ثابتة (OPEN-012) | - | لا | لا | ❌ MISSING | BACKLOG-ADMIN (من S25) |
| FR-ADMIN-003 | أدوار وصلاحيات قابلة للضبط | قيمتان ثابتتان لـPlatformRole | - | لا | لا | ❌ MISSING | BACKLOG-ADMIN (من S25) |
| FR-ADMIN-004 | feature flags | **مبني (S25)**: registry ثابت في الكود (`FEATURE_FLAG_REGISTRY`، لا إنشاء مفتاح حر عبر API) — علم واحد حقيقي الآن `vendor_performance_dashboard_enabled` يتحكم بقدرة فعلية مبنية في نفس السبرنت (لا علم شكلي)؛ غياب الصف = `false` (الافتراض الوحيد)، أول `PUT` يغيّر القيمة الفعلية فقط يُنشئ الصف ويكتب AuditLog (`beforeState`/`afterState` حقيقيان دائماً، لا `null`)؛ قفل `pg_advisory_xact_lock` يمنع تعارض أول-كتابة على مفتاح لم يُهيَّأ بعد؛ لا endpoint قراءة علني — كل صفحة محمية تتعامل مع 404 `FEATURE_DISABLED` الخاصة بها | PLATFORM_ADMIN فقط (`PlatformRoleGuard`) | `/admin/feature-flags` (قائمة كل مفاتيح الـregistry دوماً، حتى بلا صف قاعدة بيانات، مع تبديل) | S25 e2e: قائمة كل المفاتيح، رفض مفتاح غير معروف 400، no-op غياب+false بلا صف وبلا AuditLog، أول true يُنشئ الصف بـbefore/after صحيحين، تكرار نفس القيمة no-op، تبديل عكسي، سباق حقيقي على أول كتابة متزامنة | ✅ DONE | - |
| FR-ADMIN-005 | بحث/تصدير سجل التدقيق | **مبني (S25)**: `GET /admin/audit-logs` (تصفية entity_type/entity_id/actor_id/action/from/to، ترقيم مؤشَّر حتمي `occurredAt DESC, id DESC` ثنائي العمود لحل تعادل الطابع الزمني)؛ `GET /admin/audit-logs/export` بنفس التصفية تماماً إلى CSV؛ حد تصدير 50,000 صف مفروض عبر `take: 50001` في نفس الاستعلام الحتمي (لا `count()` منفصل يسبق الجلب — لا نافذة سباق)، رفض 400 `EXPORT_TOO_LARGE` بلا تصدير جزئي صامت أبداً؛ **تعتيم صريح بقائمة سماح** (`buildSafeAuditSummary`) — فقط أنواع أحداث مراجَعة تُعرض كملخّص آمن (`branch_order.status_changed`, `feature_flag.changed`)، وأي نوع آخر (مثل `address.created` المؤكَّد أنه يحمل lat/lng خاماً) يُعرض بملخّص `null` لا تمريراً جزئياً أبداً | PLATFORM_ADMIN فقط | `/admin/audit-logs` (تصفية كاملة + تحميل أكثر + تصدير CSV) | S25 e2e: ترقيم متعادل الطابع الزمني، كل أبعاد التصفية، تسريب بيانات حساسة (اختبار سلبي صريح)، ملخّص نوع مراجَع، رفض تصدير 50,001 صف | ✅ DONE | - |
| FR-ADMIN-006 | لوحات إشارات الاحتيال | لا | - | لا | لا | ❌ MISSING | BACKLOG-ADMIN (من S25) |
| FR-ADMIN-007 | تصدير البيانات | لا | - | لا | لا | ❌ MISSING | BACKLOG-ADMIN (من S25) |
| FR-VPORTAL-001 | لوحة: طلبات تحتاج انتباهاً واشتراك وKPIs | مركز روابط فقط | OWNER | /vendor/:id | NAV | 🟡 PARTIAL | S18 |
| FR-VPORTAL-002 | إدارة المنتجات والمخزون والتسعير | إنشاء/تعديل/أرشفة عرض ومتغيّر، أسعار وخصومات، وسائط (S17) | OWNER | /vendor/:id/offers وكل الصفحات الفرعية (جديد/تعديل/متغيّر/وسائط، S17) | S3,S17 | ✅ DONE | - |
| FR-VPORTAL-003 | استيراد وسجل وأخطاء | API الاستيراد + ImportBatch (سجل ملخّص، S17) | OWNER | /vendor/:id/offers/import (تقرير + سجلّ الدفعات، S17) | S7,S17 | ✅ DONE | - |
| FR-VPORTAL-004 | إدارة الطلبات مع الإلغاء والمرتجعات | قُرئ كإدارة طلبات وإلغاء/استرداد لا كتقارير أداء SLA (قرار الجولة الأولى من المراجعة، 2026-10-07)؛ شطر الإلغاء/فشل التوصيل/موافقة الاسترداد مبني بالكامل. **المرتجعات الفعلية (استلام سلعة مرتجعة) مبنية الآن بالكامل** (موافقة/رفض، استلام بالكود، استرداد ONLINE/COD منفصلان) **بواجهة مستخدم كاملة أيضاً** (جولة مراجعة 2026-10-10) | OWNER/موظف | /vendor/:id/orders، طلبات الفرع؛ المرتجعات: `/vendor/:id/branches/:b/returns` (قائمة الفرع+القرار)، `/vendor/:id/returns/redeem` (استبدال الكود) | S9,S11,S20a,S21 | ✅ DONE | - |
| FR-VPORTAL-005 | إدارة الفروع والموظفين | إضافة/أرشفة فرع، قائمة الموظفين ونقلهم وتعليقهم/إعادة تفعيلهم (S18b)؛ **دعوة موظف جديد لا تزال API فقط، بلا صفحة** | OWNER | /vendor/:id/branches، /vendor/:id/staff | S4,S18b | 🟡 PARTIAL | S15 |
| FR-VPORTAL-006 | حالة وسجل الاشتراك | GET subscription | OWNER | لا | S3 | 🟡 PARTIAL | S15 |
| FR-VPORTAL-007 (E.20) | تقارير الأداء/SLA والرد على المراجعات (الردود مؤجلة) | **الشطر الأول مبني (S25)**: تقارير الأداء/SLA (معدّل الإلغاء، زمن الاستجابة، التقييم) — انظر FR-VEND-011 لنفس البناء بالتفصيل، خلف نفس علم الميزة. **الرد على المراجعات لا يزال مؤجلاً** كما ينص النص الحرفي للمتطلب نفسه — لم يُبنَ هذا السبرنت ولم يكن في نطاقه | OWNER فقط | قسم داخل `/vendor/:id` | S25 e2e (انظر FR-VEND-011) | 🟡 PARTIAL (التقارير فقط؛ الرد على المراجعات مؤجل بنص المتطلب) | - |
| FR-VPORTAL-008 | بيانات اعتماد التكامل | لا — DEFERRED BY APPROVED DECISION (approved-product-decisions-2026-09.md §6، 2026-09-26) | - | لا | لا | ⏸ DEFERRED | - |
| FR-VPORTAL-009 | إعدادات المتجر: ساعات وإغلاقات ومناطق وتفضيلات إشعار | مناطق ونوافذ وواجهة المتجر؛ ساعات عمل وإغلاقات مؤقتة موجودة الآن (S18b)؛ لا تفضيلات إشعار | OWNER | /vendor/:id/delivery-zones، /storefront، /vendor/:id/branches/:branchId/hours | S9,S18b | 🟡 PARTIAL | S19 |
| FR-VPORTAL-010 | شاشة تسويات (Phase 2) | لا — DEFERRED BY APPROVED DECISION (approved-product-decisions-2026-09.md §6، 2026-09-26) | - | لا | لا | ⏸ DEFERRED | - |
| FR-VPORTAL-011 | عرض إشعارات البائع | نفس صندوق /me/notifications المشترك (Notification model + relay، S19) يعرض أنواع البائع (تعليق المتجر، طلب جديد للموظف، مخزون منخفض، خصم يدوي) لحساب البائع نفسه — ليست لوحة خاصة بالبائع، لكنها تعرض إشعاراته فعلاً | session (OWNER/EMP) | أيقونة الجرس + /notifications | S19 | ✅ DONE | - |
| FR-CMS-001 | أقسام الرئيسية والبانرات | لا — DEFERRED BY APPROVED DECISION (approved-product-decisions-2026-09.md §6، 2026-09-26) | - | لا | لا | ⏸ DEFERRED | - |
| FR-CMS-002 | حملات وSEO AR/EN | لا — DEFERRED BY APPROVED DECISION (approved-product-decisions-2026-09.md §6، 2026-09-26) | - | لا | لا | ⏸ DEFERRED | - |
| FR-CMS-003 | وسم الإعلان | لا — DEFERRED BY APPROVED DECISION (approved-product-decisions-2026-09.md §6، 2026-09-26) | - | لا | لا | ⏸ DEFERRED | - |
| FR-CMS-004 | الإحالة/الأفلييت (Phase 2+) | لا — DEFERRED BY APPROVED DECISION (approved-product-decisions-2026-09.md §6، 2026-09-26) | - | لا | لا | ⏸ DEFERRED | - |
| FR-CMS-005 | روابط عميقة ويب/موبايل | لا — DEFERRED BY APPROVED DECISION (approved-product-decisions-2026-09.md §6، 2026-09-26) | - | لا | لا | ⏸ DEFERRED | - |
| FR-ANALYTICS-001 | لوحات بحسب الدور | لا | - | لا | لا | ❌ MISSING | BACKLOG-ANALYTICS (من S25) |
| FR-ANALYTICS-002 | جودة الكتالوج والتطابق | لا | - | لا | لا | ❌ MISSING | BACKLOG-ANALYTICS (من S25) |
| FR-ANALYTICS-003 | دقة المخزون وحداثة الأسعار | لا | - | لا | لا | ❌ MISSING | BACKLOG-ANALYTICS (من S25) |
| FR-ANALYTICS-004 | أداء البحث | لا | - | لا | لا | ❌ MISSING | BACKLOG-ANALYTICS (من S25) |
| FR-ANALYTICS-005 | تقارير المبيعات/الفوترة/المرتجعات | لا | - | لا | لا | ❌ MISSING | BACKLOG-ANALYTICS (من S25) |
| FR-ANALYTICS-006 | تحليلات قمع السلوك | لا | - | لا | لا | ❌ MISSING | BACKLOG-ANALYTICS (من S25) |

### PDR-001..036
| ID | Decision | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| PDR-001 | ILS فقط | بيانات ILS | n/a | كل الواجهات | S10,S14 | ✅ DONE | - |
| PDR-002 | العميل المسجّل يتصفح/يقارن/يفضّل/يتابع/يشتري؛ سلة على السيرفر | السلة والمتابعة والمفضلات مبنية الآن جميعاً | session | /cart، /following، /favorites | S10,S13,S24 | ✅ DONE | S24 |
| PDR-003 | التنفيذ يُختار عند الـcheckout | السلة بلا تنفيذ | session | /cart، /checkout | S10,S14 | ✅ DONE | - |
| PDR-004 | BranchOrder وحدة تشغيلية | BranchOrder | session | /orders | S9,S10 | ✅ DONE | - |
| PDR-005 | معاملة sandbox واحدة؛ ILS | PaymentTransaction | session | /checkout | S10,S14 | ✅ DONE | - |
| PDR-006 | لا دور سائق؛ الموظف يحدّث Sent/Delivered | لا دور سائق؛ إجراءات الموظف | موظف الفرع | صفحة طلبات الفرع | S11 | ✅ DONE | - |
| PDR-007 | لا دردشة ولا stories؛ وسيلة تواصل خارجية | لم تُبنَ؛ بوابة التواصل | OWNER | /vendor/:id/storefront | S7 | ✅ DONE | - |
| PDR-008 | حساب واحد بأدوار متعددة؛ مبدّل؛ موظف لفرع واحد | VendorUser؛ me/workspaces؛ API الدعوة | OWNER | مبدّل /account؛ لا دعوة ولا نقل | S4,NAV | 🟡 PARTIAL | S15 |
| PDR-009 | فصل صلاحيات المالك والموظف | الـguards تفرضه؛ واجهات إدارة الفروع/الموظفين (S18b) وإلغاء/فشل التوصيل/موافقة الاسترداد (S20a) مبنية لكليهما. S21: قرار المرتجع (موافقة/رفض) محصور بموظف/مالك الفرع الأصلي فقط (نفس انضباط الإلغاء)؛ **الاستلام (redeem) عمداً استثناء مُقنَّن** - أي موظف/مالك لنفس المتجر بصرف النظر عن فرعه (PDR-031: قبول عابر للفروع)، عبر مسار بلا `:branchId` في نفسه لا بتوسيع الحارس العام. **واجهة المرتجعات الآن مبنية بالكامل لكل الأدوار** (العميل، المالك/الموظف، الأدمن - انظر PDR-031، جولة مراجعة 2026-10-10). واجهات المالك الأخرى (التقارير) لا تزال ناقصة | OWNER/موظف | المركز، طلبات الفرع، /vendor/:id/branches، /vendor/:id/staff | S4,S9,S18b,S20a,S21 | 🟡 PARTIAL | - |
| PDR-010 | متجر فعلي/إلكتروني/هجين؛ مستودع مخفي؛ نقاط استلام. تحقّق ONLINE_ONLY مفصَّل الآن بـPDR-035 (2026-09-26): دبوس عنوان المستودع (lat/lng + ملاحظة) قبل إرسال أدلة التحقق؛ المستودع لا يظهر في أي endpoint عام؛ المراجع يراه فقط داخل مسار التحقق | Vendor.storeType، Warehouse، PickupPoint | OWNER | لا | S5 | 🟡 PARTIAL | S15 |
| PDR-011 | صفحة متجر عامة: رابط واسم وشعار ونبذة وغلاف وتواصل وأقسام ومتابعة | حقول واجهة المتجر وAPI عام | OWNER؛ عام | /store/:slug، /vendor/:id/storefront | S7,S13 | ✅ DONE | - |
| PDR-012 | أقسام المتجر وسقف 20 | StoreSection | OWNER | /vendor/:id/sections | S7 | ✅ DONE | - |
| PDR-013 | صفحات الاكتشاف؛ المتجر يختار الأنواع عند التسجيل ويعدّلها | segments؛ applicable categories | OWNER | /discovery؛ التعديل فقط؛ التسجيل API فقط | S13 | 🟡 PARTIAL | S15 |
| PDR-014 | ترتيب 40/30/30 | الأحدث أولاً؛ لا تتبع مشاهدات | - | لا | لا | ❌ MISSING | S18b |
| PDR-015 | بطاقة عالمية: أرخص متاح، 5 شعارات، كسر التعادل تقييم ثم قرب | البطاقة والشعارات؛ لا تقييم ولا قرب | عام | /discovery | S8,S13 | 🟡 PARTIAL | S18b |
| PDR-016 | شبكة مقارنة 4-6/1-2 وفلتر variant | واجهة المقارنة | عام | /compare/:id | S8 | ✅ DONE | - |
| PDR-017 | Available/Low/Sold out؛ السلة تعرض الحد الأقصى | bucketForStock؛ max_quantity لفرع واحد | عام/session | البطاقات، /cart | S8,S14 | ✅ DONE | - |
| PDR-018 | باركود لكل منتج؛ داخلي قابل للطباعة؛ فريد للمتجر | storeInventoryBarcode فريد (@@unique([vendorId, storeInventoryBarcode]))؛ ملصق Code128 وطباعة (S18a) | OWNER | صفحة مخزون الفرع (S18a) | S6,S18a | ✅ DONE | - |
| PDR-019 | نفس الباركود + لون/مقاس جديد إضافة؛ 3 تعارضات للمراجعة | منطق تعارض الاستيراد؛ دون تغيير منذ S7 | OWNER | عدد التعارضات في تقرير الاستيراد (S17)؛ لا حلّ لكل تعارض | S7,S17 | 🟡 PARTIAL | S17 |
| PDR-020 | مخزون لكل فرع؛ بيع فعلي بالمسح؛ بلا نقل | BranchStock، movements؛ reason=SALE + stock/lookup بالباركود = بيع فعلي بالمسح (S18a)؛ لا نقل بين الفروع (بالتصميم) | موظف الفرع | صفحة مخزون الفرع: بحث بالباركود + تسجيل SALE (S18a) | S6,S18a | ✅ DONE | - |
| PDR-021 | خصم يدوي بسبب وإشعار المالك | السبب مطلوب؛ **الإشعار يصل الآن فعلياً** لصندوق إشعارات المالك (Notification، relay S19) — لم يعد outbox فقط | OWNER/موظف | صفحة مخزون الفرع: نموذج الحركة (سبب + ملاحظة) (S18a)؛ /notifications (S19) | S6,S18a,S19 | ✅ DONE | - |
| PDR-022 | إعدادات الفرع؛ رسوم إقليمية للمتجر؛ تعطيل المناطق | VendorDeliveryZone، DeliveryWindow | OWNER | /vendor/:id/delivery-zones، /delivery-windows | S9 | ✅ DONE | - |
| PDR-023 | أقرب فرع مؤهل؛ اختيار العميل؛ تقويم 3 أيام | فرع افتراضي ثابت موثّق (لا مصدر مسافة)؛ كل الفروع المؤهلة تُعرض؛ الاختيار والموعد يعملان — **بديل مقصود عن nearest، وليس فجوة تنفيذية** | session | /checkout | S10,S14 | 🟡 PARTIAL — بديل مقصود، ليس فجوة | — (قرار جديد) |
| PDR-024 | تقاويم الفروع وسعة واستثناءات وحماية المحجوز | DeliveryWindow + الحمايات | OWNER | /vendor/:id/branches/:b/delivery-windows | S9 | ✅ DONE | - |
| PDR-025 | تذكير التحضير قبل 6 ساعات؛ استرداد/موعد جديد عند التأخر | `FulfilmentExceptionSweepService`: تذكير التحضير قبل 6 ساعات (يُعاد تسليحه بعد إعادة الجدولة)، كشف تأخر الموعد (`slotMissedAt`)، ومهلة 48 ساعة تلقائية (COD تُلغى، إلكتروني يُسترد) أو إعادة جدولة العميل ضمنها | موظف/عميل | /orders، صفحة طلبات الفرع | S20a | ✅ DONE | - |
| PDR-026 | Sent/Delivered وتأكيد العميل؛ تذكير 48 ساعة وتأكيد تلقائي 72 | الإجراءات اليدوية DONE منذ S11؛ **التذكير والتأكيد التلقائي أصبحا فحصاً دورياً حقيقياً الآن** (`FulfilmentSweepService`، كل دقيقة، لا "عند القراءة" فقط) والإشعار يصل فعلياً لصندوق العميل (relay S19) | موظف/session | صفحة الفرع، /orders، /notifications (S19) | S11,S19 | ✅ DONE | - |
| PDR-027 | سياسة فشل التوصيل | mark-delivery-failed مع `deliveryAttemptCount` (0→1→2)؛ محاولة أولى: تُفتح لإعادة الجدولة أو مهلة 48 ساعة تلقائية؛ محاولة ثانية: COD تُلغى تلقائياً في نفس الاستدعاء، إلكتروني يُفتح لطلب استرداد العميل وموافقة الموظف (لا مسار رفض — فجوة موثَّقة عمداً، القرار النهائي 2026-10-07) | موظف/عميل | /orders، صفحة طلبات الفرع | S20a | ✅ DONE | - |
| PDR-028 | إلغاء صنف/طلب قبل Sent وقواعد الرسوم | إلغاء كامل الطلب أو صنف واحد (العميل: PLACED فقط؛ الموظف: PLACED/PREPARING، سبب إلزامي بعد بدء التجهيز)؛ إلغاء صنف واحد لا يغيّر حالة الطلب إن بقي صنف آخر نشطاً؛ رسوم التوصيل تُسترد مرة واحدة فقط عند إغلاق الطلب (partial unique index حقيقي) | عميل/موظف | /orders، صفحة طلبات الفرع | S9,S20a | ✅ DONE | - |
| PDR-029 | عناوين: خريطة وافتراضي وحفظ صريح؛ تغيير قبل التحضير | **مبني بالكامل (S22)**: إنشاء/عرض/تعديل/حذف (صلب أو أرشفة)، افتراضي تلقائي للأول ويُعاد تعيينه عند حذف الافتراضي؛ **تغيير عنوان الطلب قبل التحضير** (`POST .../change-address`، PLACED فقط - "قبل التحضير" حرفياً) - أي فرق في رسم التوصيل (أعلى أو أقل) = `409 ADDRESS_CHANGE_UNSUPPORTED` مع خيارات (إلغاء/تحويل لاستلام/إعادة المحاولة بعنوان آخر)، التحويل لاستلام يُطلِق رمزاً جديداً ويرد رسم التوصيل عبر سجل BranchOrderRefund؛ **GPS يملأ lat/lng فقط (لا مزوّد خريطة خارجي، قرار معتمد)** | session | /account، /checkout، /account/addresses، /orders (S22) | S14,S22 + اختبارات حتمية (سباق إنشاء أول عنوان، سباق change-address/start-preparation) | ✅ DONE | - |
| PDR-030 | سياسة إرجاع المتجر ورسومها ولقطة الشراء | مبنية بالكامل الآن (API/منطق)، للإرجاع والتبديل معاً: `return_policy` إلزامي عند التسجيل (أربعة أوضاع: NO_RETURN/REFUND_ONLY/EXCHANGE_ONLY/BOTH)، تحديث لاحق تحت قفل 6 أشهر حقيقي، لقطة كاملة على `BranchOrder` وقت `confirm()` لا تتأثر بتعديل لاحق، رسم تبديل مستقل (`exchangeFeeIls`) يُطبَّق دائماً (رداً أو تحصيلاً) عبر دفتر `ExchangeSettlement` المستقل - لا `BranchOrderRefund` أبداً. **منذ S21b (2026-10-11)**: التبديل نفسه ضمن فروع المتجر الفعلية فقط (لا PickupPoint عمداً)، بديل من متغيّر آخر لنفس العرض فقط، بكمية مطابقة كاملة، وبموافقة موحَّدة (`approveReturn()`) من مسار الفرع أو تصعيد الأدمن معاً. انظر FR-RET-008/009 للتفاصيل الكاملة | OWNER | صفحة سياسة الإرجاع لصاحب المتجر (`/vendor/:id/return-policy`) (جولة مراجعة 2026-10-10؛ حقل رسم التبديل S21b) | S21 e2e + Playwright؛ S21b e2e (19 اختبار جديد) + Playwright | ✅ DONE | - |
| PDR-031 | طلب إرجاع وSLA وكود 7 أيام | مبنية بالكامل (API/منطق): طلب بسبب+صور، SLA 48h/72h حقيقي، كود 6 أرقام يولَّد عند الموافقة فقط وصالح 7 أيام، قبول عابر لفروع المتجر الفعلية (لا نقاط استلام بعد). انظر FR-RET-009/FR-FUL-009 للتفاصيل الكاملة. **هذا الصف خاص بمسار RETURN فقط** - آلية كود التبديل الخاصة (24 ساعة، فرع واحد محدَّد) مفصَّلة تحت PDR-030/FR-RET-009 أعلاه لا هنا، تجنباً لأي انطباع بأن هذا الصف يغطيها | عميل/OWNER/موظف/PLATFORM_ADMIN | **بواجهة كاملة لكل الأدوار الآن (جولة مراجعة 2026-10-10)**: العميل - إنشاء الطلب (`/orders/:id/items/:id/return`)، قائمة الإرجاعات (`/returns`)، التتبّع والإلغاء والاعتراض (`/returns/:id`). OWNER - سياسة الإرجاع (`/vendor/:id/return-policy`). موظف/OWNER - قائمة إرجاعات الفرع والقرار (`/vendor/:id/branches/:b/returns`)، استبدال الكود عابراً للفروع (`/vendor/:id/returns/redeem`). PLATFORM_ADMIN - طابور الإرجاعات المتصاعدة والحسم النهائي (`/admin/returns`) | S21 e2e + Playwright (19 اختبار متصفّح حقيقي، مرتين - 14 S21 + 5 S21b) | 🟡 PARTIAL (فروع فعلية فقط، لا pickup points - غير متأثر بـS21b) | - |
| PDR-032 | مراجعات موثّقة للمنتج والمتجر؛ غير قابلة للتعديل؛ الردود مؤجلة | مبني بالكامل تقريباً: `Review`/`ReviewReport` (منتج/متجر فقط، تقييم 1-5 + تعليق إلزامي، لا صور، immutable حرفياً، ردود البائع مؤجلة كما هي)؛ البلاغات تُحسَم عبر PLATFORM_ADMIN (تجاهل/إخفاء). **D1 (قرار الهوية المعروضة للأصالة) يبقى صريحاً MISSING/OPEN - لم يُبنَ ولم يُفترَض** | عميل (كتابة/إبلاغ)، PLATFORM_ADMIN (حسم) | كتابة/عرض/إبلاغ + طابور إدارة المنصة (`/admin/reviews`) | S23 e2e (21 حالة: أهلية، فريدية، سباق حتمي، دورة حياة البلاغ، شارة التحقق) | ✅ DONE (ما عدا D1 - يبقى OPEN) | - |
| PDR-033 | اشتراك sandbox شهر وتجديد؛ تعطيل عند الانتهاء؛ تذكيرات | VendorSubscription وبوابة الانتهاء؛ لا تذكيرات | OWNER | لا | S3 | 🟡 PARTIAL | S15 |
| PDR-034 | تعطيل الحساب مع استرجاع 30 يوماً | **مبني بالكامل (S22)** - انظر FR-AUTH-014 (E.0) أعلاه لنفس البناء والاختبارات | session | /account/deactivate، /reactivate | S22 | ✅ DONE | - |
| PDR-035 | **(2026-09-26)** تحقّق ONLINE_ONLY بدبوس عنوان مستودع (lat/lng + ملاحظة) بدل صورة/دبوس فرع؛ PHYSICAL/HYBRID تحتفظ بالشرط الحالي؛ المستودع لا يظهر في أي endpoint عام؛ المراجع وحده يراه داخل مسار التحقق | قرار معتمد وموثَّق؛ مسار أدلة المستودع مبني (S15: لقطة غير قابلة للتغيير، submit/GET/decision)، وقراءة المراجع له مدقَّقة ومحصورة بالمراجع/الأدمن (S16: لا تظهر للعامة ولا للمالك ولا للموظف عبر مسار المراجع، ولا في الطابور أو AuditLog)؛ الناقص: واجهة المالك لتقديم الدليل (S15/UI) | OWNER + REVIEWER | /admin/verification/:vendorId (المراجع)؛ واجهة المالك لم تُبنَ | S15,S16 | 🟡 PARTIAL | S15 |
| PDR-036 | **(2026-09-26)** اللون والمقاس خياري variant لا حقلين بنيويين؛ 10 قوالب حقول خمسة لفئات الملابس/الإكسسوارات؛ "بدون علامة تجارية" كقيمة منظمة بدل الفراغ | ClothingCategoryTemplate + CLOTHING_CATEGORY_TEMPLATE_FIELDS + validateTemplateAttributes (كلاهما-أو-لا-شيء بقيد DB CHECK)؛ Brand.isNoBrandSentinel مزروعة بمعرّف ثابت مع قائمة أسماء بديلة للاستيراد (S17) | OWNER | نموذج إنشاء/تعديل العرض يعرض حقول القالب الأربعة ديناميكياً وقائمة العلامات التجارية (S17) | S17 | ✅ DONE | - |

## 4. سطر مستقل لكل قدرة ناقصة (onboarding/verification/admin/catalog/inventory/notifications/account)

### Onboarding
| Gap | القدرة الناقصة | يغطي | Sprint |
|---|---|---|---|
| G-ON-01 | نموذج تقديم طلب المتجر من الواجهة | FR-VEND-001، PDR-013، PDR-010 | S15 |
| G-ON-02 | رفع أدلة التحقق وإعادة التقديم (photo/pin) | FR-VEND-002 | S15 |
| G-ON-03 | واجهة الاشتراك وحالته وتجديده | FR-VEND-004/005، FR-VPORTAL-006، PDR-033، FR-PAY-006 | S15 |
| G-ON-04 | دعوة موظف من الواجهة | FR-VEND-013 (E.0)، FR-VPORTAL-005، PDR-008 | S15 |
| G-ON-05 | صفحة قبول الدعوة بـOTP | FR-VEND-013 (E.0) | S15 |
| G-ON-06 | واجهة نوع المتجر والمستودع ونقاط الاستلام (تحقّق ONLINE_ONLY محدَّد الآن بـPDR-035: دبوس عنوان مستودع، لا صورة/دبوس فرع؛ لم يُبنَ بعد) | FR-VEND-012 (E.0)، PDR-010 | S15 |
| G-ON-07 | إضافة فرع لاحقاً وساعات وإغلاق مؤقت وأرشفة (مبنية الآن — S18b) | FR-VEND-006، FR-VPORTAL-009 | غير مجدول |

### Verification / Admin
| Gap | القدرة | يغطي | Sprint |
|---|---|---|---|
| G-AD-01 | طابور المراجع وقرار التحقق من الواجهة | FR-VEND-003 | ✅ S16 (مبني) |
| G-AD-02 | تعليق وإعادة تفعيل المتجر بسبب وتدقيق | FR-VEND-008/009 | ✅ S16 (مبني؛ CANCELLED خارجه) |
| G-AD-03 | تنقّل طابور التطابق وتصحيح الأدمن | FR-ADMIN-001 | 🟡 S16 جزئي: شاشة طلبات تغيير الاسم فقط؛ تصحيح تطابق المنصة غير مبني (لا سياسة معتمدة) → BACKLOG-ADMIN |
| G-AD-04 | عارض سجل التدقيق وتصديره | FR-ADMIN-005 | ✅ S25 (مبني) |
| G-AD-05 | إدارة الأدوار وقوائم الإعدادات (يعتمد على OPEN-012) | FR-ADMIN-002/003 | BACKLOG-ADMIN (من S25) |

### Catalog
| Gap | القدرة | يغطي | Sprint |
|---|---|---|---|
| G-CA-02 | واجهة الاستيراد: تسوية الأعمدة (القالب والتقرير والسجل مبنية الآن — S17) | FR-IMPORT-011 | غير مجدول |
| G-CA-07 | معالجة تعارض الحقل الواحد في الاستيراد، وإشارة تشابه الصور في التطابق غير الدقيق (طابور المراجعة غير الدقيق وطلب تغيير الاسم من جهة المالك مبنيان الآن — S17-owner-matching-ui) | FR-MATCH-010/012 | غير مجدول |
| G-CA-08 | إدارة المنصة للتصنيفات والعلامات والمنتجات الأساسية وقوالب الخصائص (OPEN-013) | FR-CAT-001/002/003/006..012 | S17b |
| G-CA-09 | دمج/فصل المنتجات وبلاغ العميل عن تطابق خاطئ | FR-MATCH-005/006/007 | S17b |

### Inventory
| Gap | القدرة | يغطي | Sprint |
|---|---|---|---|
| G-IN-01 | صفحة المخزون للمالك والموظف (تعديل) (مبنية الآن — S18a) | FR-INV-001/005، PDR-020 | غير مجدول |
| G-IN-02 | البيع الفعلي بالمسح (مبني الآن — S18a) | FR-INV-009 (E.0) | غير مجدول |
| G-IN-03 | ملصق باركود قابل للطباعة (مبني الآن — S18a) | FR-MATCH-011 (E.0)، PDR-018 | غير مجدول |
| G-IN-04 | مخزون أمان وتقادم المخزون (مبني الآن — S18a) | FR-INV-006/007 | غير مجدول |
| G-IN-05 | نقل الموظف وتعطيله فوراً (مبني الآن — S18b) | FR-VEND-013، PDR-009 | غير مجدول |

### Notifications
| Gap | القدرة | يغطي | Sprint |
|---|---|---|---|
| G-NO-01 | relay موثوق للـoutbox مع إعادة المحاولة والسجل (مبني الآن — S19؛ لا صفحة أدمن مخصصة لقائمة dead-letter، API فقط) | FR-NOTIF-001/004 | غير مجدول |
| G-NO-02 | نموذج Notification ومركز إشعارات صغير بروابط عميقة (مبني الآن — S19) | FR-NOTIF-008، FR-VPORTAL-011 | غير مجدول |
| G-NO-03 | ربط أحداث المخزون والمتابعة والتذكيرات الأساسية (مبني الآن — S19؛ تبقى فجوتان أضيق: هوية الموظف في إشعار المخزون، وتعتيم غير النشط في صفحة أتابعه) | FR-INV-010، FR-FAV-005، PDR-026 | غير مجدول |
| G-NO-04 | قوالب AR/EN وSMS (OPEN-004) | FR-NOTIF-002/003، FR-FUL-003 | S19 |

### Account
| Gap | القدرة | يغطي | Sprint |
|---|---|---|---|
| G-AC-01 | تغيير الهاتف بـOTP (مبني الآن — S22) | FR-AUTH-006 | غير مجدول |
| G-AC-02 | تعطيل الحساب واسترجاعه (مبني الآن — S22؛ FR-AUTH-010 يبقى 🟡 PARTIAL لأن "حذف" SRS نفسه تعطيل لا حذفاً فعلياً، وBR-018/retention يبقى MISSING تماماً) | FR-AUTH-010/014، PDR-034 | غير مجدول |
| G-AC-03 | مبدّل اللغة والترجمة (مبني الآن جزئياً — S22: أساس i18n حقيقي + AppShell + الواجهة المشتركة + شاشات S22 الجديدة فقط؛ شاشات S1-S21b القديمة تبقى عربية فقط، لم تُعَد ترجمتها) | FR-AUTH-009 | قرار-نطاق |
| G-AC-04 | عنوان افتراضي وتعديل وحذف وتغيير العنوان قبل التحضير (مبني الآن — S22) | FR-AUTH-008، PDR-029 | غير مجدول |

(بند الخريطة أُزيل من G-AC-04 — لا مزوّد خريطة هو القرار المعتمد، وليس فجوة. انظر §0.1. FR-CART-006 أُزيل من هذا الصف: فجوته المتبقية - لا ملاحظة توصيل لكل طلب - غير متعلقة بالعنوان الافتراضي/التعديل/الحذف الذي أغلقه S22، وتبقى صفه الخاص PARTIAL لنفس السبب القديم.)

## 5. Roadmap — كل PARTIAL/MISSING في سبرنت واحد فقط (أو معلَّم صراحة كغير مجدول)

**تحديث 2026-09-26:** الـ18 بنداً التي كانت تحت `قرار-نطاق` أصبحت DEFERRED BY APPROVED DECISION رسمياً (§6 من `approved-product-decisions-2026-09.md`، انظر §0/v4 أعلاه) — خرجت نهائياً من عالم "PARTIAL/MISSING القابل للجدولة"، فلم تعد جزءاً من هذا الـroadmap إطلاقاً. كذلك OPEN-011 وOPEN-013 لم يعودا قرارين معلَّقين (PDR-035 وPDR-036، 2026-09-26) — أُزيلا من عمود "قرارات مطلوبة" لـS15/S17/S17b أدناه؛ **هذا لا يعني بدء أي منهما — الأثر توثيقي فقط، لا Sprint 15 حتى تأذني صراحة.**

المجموع بعد هذا التحديث: **189 صفاً** (كان 207 قبل إخراج الـ18 بنداً المؤجَّلة) موزّعة كالتالي.

| Sprint | النطاق | # | يعتمد على | قرارات مطلوبة قبل التنفيذ |
|---|---|---|---|---|
| S15 | إعداد المتجر: طلب متجر، أدلة، اشتراك، دعوة وقبول، نوع المتجر ونقاط الاستلام | 13 | لا شيء (الـAPIs موجودة) | ~~OPEN-011~~ **محسوم (PDR-035، 2026-09-26)** — تحقّق ONLINE_ONLY بدبوس عنوان مستودع لا صورة/دبوس فرع. لا map provider (مثبَّت §0.1) |
| S16 | إدارة المنصة: قرار التحقق، تعليق/إعادة تفعيل، تنقل التطابق | **0 — منفَّذ** (كانت 4: FR-VEND-003/009 → DONE؛ FR-VEND-008 → قرار جديد؛ FR-ADMIN-001 → S25) | S15 | قُرّرت: أسباب التعليق (POLICY_VIOLATION/NON_PAYMENT/OTHER + نص إلزامي)، إشعار المالك = حدث Outbox الآن والتسليم في S19، وأسباب الرفض (OPEN-005 مغلقة) |
| S17 | كتالوج المالك: نموذج العرض، الاستيراد، الوسائط، `PriceHistory`، الخصم النسبي، التطابق | **20 — منفَّذ جزئياً** (معاد اشتقاقه مباشرة من صفوف الجدول أدناه: عدّ كل صف يحمل `S17` في عمود Sprint وحالته 🟡 PARTIAL أو ❌ MISSING = 20 صفاً بالضبط، بتاريخ هذا التحديث. التحوّل الوحيد الذي أحدثه `S17-owner-matching-ui` (2026-09-29) هنا هو صفّ واحد: `FR-MATCH-003` من PARTIAL إلى ✅ DONE — كل تغيير آخر سابق (S17 نفسه، v6) غير مُعاد حسابه أو نُسب لهذا التحديث) | S15، S16 (قرارات الاسم) | ~~OPEN-013~~ **محسوم للملابس/الإكسسوارات (PDR-036، 2026-09-26)** — 10 قوالب حقول خمسة، اللون/المقاس variant لا حقلاً بنيوياً. **الخصم النسبي بُني ضمن هذا السبرنت نفسه (لم يُفصل).** حجم الوسائط: سقف 10 صور/3 فيديوهات مبني؛ لا ضغط/تحويل صيغة |
| S17b | كتالوج المنصة: تصنيفات وعلامات ومنتجات أساسية وقوالب وتطابق ودمج/فصل | 13 | S16، S17 | ~~OPEN-013~~ **محسوم للفئات الحالية (PDR-036)** — أي فئة غير ملابس/إكسسوار مستقبلية تحتاج قرار قالب خاص بها |
| S18 | عمليات المخزون: صفحة المخزون، البيع بالمسح، الملصق، الفروع/الساعات، نقل الموظف | 16 | S15، S17 | لا شيء جديد؛ تأكيد شكل الباركود المطبوع |
| S18b | جودة البحث والاكتشاف: تطبيع عربي، اقتراحات، باركود، ترتيب | 19 | S17 (المشاهدات والأسعار) | وزن الترتيب 40/30/30. **"أقرب فرع" ليس ضمن هذا السبرنت** — انظر الصف المنفصل أدناه |
| S19 | إشعارات: تصميم الـrelay ثم relay وإشعارات داخل التطبيق لأحداث الطلب الأساسية | **18 — منفَّذ جزئياً** (معاد اشتقاقه مباشرة من صفوف الملف يحمل `S19` في عمود Sprint وحالته 🟡 PARTIAL أو ❌ MISSING بعد تطبيق v10 = 18 صفاً بالضبط، بنفس منهج صفّ S17 في `v7` أعلاه. **الرقم "10" السابق كان غير محدَّث أصلاً** قبل هذا التحديث — عدة صفوف (`FR-INV-010`، `FR-VPORTAL-009`) أُعيد تعيينها لـ`S19` في `v8`/`v9` دون تحديث هذا العدّاد حينها؛ لم يُحاول هذا التمرير أيضاً مطابقة بقية أعمدة الـ"#" في هذا الجدول — نفس نطاق `v7` الضيّق لكل تمريرة) | لا شيء تقني؛ يفضَّل بعد S17/S18 لأحداثها | OPEN-004 (SMS: يبقى المسجَّل fallback — ما زال مفتوحاً، `G-NO-04` لم يُبنَ) |
| **S20a** | **استثناءات التنفيذ والإلغاء والاسترداد**: تأخر التحضير، فشل التوصيل، إلغاء صنف/طلب، استرداد، توزيع الدفع، سجل COD، جدول الطلب، تقارير الأداء (VPORTAL-004) | 15 | S19 | OPEN-009 (الرسوم/الضريبة تؤثر على الاسترداد)؛ قواعد رسوم الإلغاء (PDR-028) |
| **S20b** | **إضافات checkout**: الشروط، ملاحظة العميل/المتجر، الحد الأدنى للطلب، رسوم/ضريبة الدفع النهائي، كتالوج تعارض التنفيذ | 6 | S20a (نفس مسار الدفع، تسلسل بعده تجنباً لتضارب تعديلين متزامنين على checkout) | OPEN-009 (الضريبة/الرسوم)؛ نص الشروط النهائي |
| **S21** | **المرتجعات: سياسة المتجر، طلب، كود، استرداد، استلام المرتجعات** | 6 — **منفَّذ جزئياً (الواجهة كاملة لكل الأدوار الآن - جولة مراجعة 2026-10-10؛ معاد اشتقاقه من الـ12 صفاً الأصلية التي كانت تحمل هذا السبرنت - `FR-RET-001` إلى `009`، `PDR-030/031`، `BR-012` - بعد انتقال 6 منها إلى ✅ DONE: `FR-RET-002/003/004/006/008`، `PDR-030`)** | S20a (الاسترداد) | محسوم فعلياً - OPEN-009 لم يحجب التنفيذ (PDR-030/031 لا تحتاج قرار المنصة عن الرسم/الضريبة). **متبقٍ خارج S21a عمداً**: الاستبدال (EXCHANGE_ONLY/BOTH، S21b)، نقاط الاستلام (PickupPoint، تحتاج عضوية تشغيلية جديدة - `FR-RET-009`/`PDR-031`)، توجيه الأسباب لمسارات SLA مختلفة (`FR-RET-005`)، رصد إساءة الاستخدام (`FR-RET-007`)، والحد الأدنى القانوني المحتمل (`FR-RET-001`/`BR-012`، Q11) |
| **S21b** | **التبديل (Exchange): EXCHANGE_ONLY/BOTH ضمن فروع المتجر الفعلية فقط** | 1 — **منفَّذ (2026-10-11)، يغلق تحديداً البند الذي أجّلته S21 أعلاه بالاسم** (`FR-RET-008`/`PDR-030`، الآن ✅ DONE بالكامل) | S21 | محسوم فعلياً دون قرار جديد - كل القرارات المنتجية (بديل من نفس العرض فقط، كمية مطابقة كاملة، رسم دائم الاتجاهين، تسوية نقدية دائماً بصرف النظر عن طريقة الدفع الأصلية) اعتُمدت أثناء تخطيط هذا السبرنت نفسه. **لم يتغيّر**: نقاط الاستلام (PickupPoint) تبقى خارج النطاق بالكامل - مؤجَّلة لسبرنت مستقل خاص بها، تحتاج عضوية تشغيلية جديدة (`PICKUP_POINT_EMPLOYEE` لا `BRANCH_EMPLOYEE` موسَّع)، لا مخزون في نقطة الاستلام، وفرع استلام مرتجعات افتراضي يختاره المالك - لم يُفترض أي من هذا هنا |
| S22 | الحساب: تغيير الهاتف، التعطيل، اللغة، إدارة العناوين (افتراضي/تعديل/حذف/تغيير قبل التحضير) | 8 | لا شيء | قواعد الاحتفاظ بالبيانات (OPEN-009). **لا قرار خريطة مطلوب — محسوم بلا مزوّد خارجي (§0.1)** |
| S23 | المراجعات وشارة التحقق | 8 — **منفَّذ (2026-10-14)، مبني بالكامل تقريباً وفق PDR-032 ضيّق النطاق إلى منتج/متجر فقط (FR-REV-001/002/005/006/008(E.15)، BR-016 → ✅ DONE؛ FR-REV-003/004/009 → ↪ SUPERSEDED/⏸ DEFERRED)** | S20a (الطلبات المكتملة) | **D1 يبقى صريحاً MISSING/OPEN - لم يُنفَّذ ولم يُفترَض تغطيته، حسب قرارك النهائي رقم 1.** رصد الأنماط الشاذة (`FR-REV-007`/`010`) خارج النطاق عمداً أيضاً (قرارك النهائي رقم 3) - مؤجَّل لـS24+ |
| S24 | المفضلات والتنبيهات ومجموعات المقارنة ومقارنة أعمق | 16 | S17 (تاريخ الأسعار)، S19 | لا شيء جديد |
| S25 | التحليلات وأدوات الأدمن: feature flags، سجل التدقيق (بحث/تصدير)، مؤشرات أداء المتجر | **4 — مُغلَق (2026-10-21، v17)**: `FR-ADMIN-004`، `FR-ADMIN-005`، `FR-VEND-011` → ✅ DONE؛ `FR-VPORTAL-007(E.20)` → 🟡 PARTIAL (شطر الرد على المراجعات مؤجَّل بنص المتطلب نفسه). **البنود الـ17 غير المنفَّذة نُقلت من S25 بقرار المالك (v17)** إلى ثلاث مجموعات backlog غير مجدولة: `BACKLOG-ADMIN` (FR-ADMIN-001/002/003/006/007)، `BACKLOG-FINANCE` (FR-VEND-010، FR-IMPORT-013، FR-INV-008، FR-PAY-005/007/008)، `BACKLOG-ANALYTICS` (FR-ANALYTICS-001..006) - S25 لم يعد مسؤولاً عنها | S24 | OPEN-009 (مدة الاحتفاظ بسجل التدقيق) يبقى مفتوحاً؛ OPEN-012 لـBACKLOG-ADMIN |
| **— (قرار جديد)** | إغلاق المتجر CANCELLED (FR-VEND-008 المتبقي) وطلب استئناف التعليق (PDR §3.5) | 3 | — | **ليست سبرنتاً مجدولاً.** كلاهما بلا سياسة معتمدة (من يُغلق، أثر الإغلاق على الطلبات والبيانات، مدة الاستئناف، المرفقات) — انظر §15b. |
| **— (قرار جديد)** | "أقرب فرع" فعلياً (PDR-023، FR-CART-018) | 2 | — | **ليست سبرنتاً مجدولاً.** تحتاج: (أ) قراراً بأن التقريب الحتمي الحالي غير كافٍ، و(ب) مصدر مسافة موثوق (إحداثيات الفرع + إحداثيات العميل + دالة مسافة، أو مزوّد خارجي). بلا هذين لا يوجد عمل قابل للتقدير. |

**الـ18 بنداً سابقاً "قرار-نطاق" لم تعد في هذا الجدول إطلاقاً** — أصبحت DEFERRED BY APPROVED DECISION (§6 من `approved-product-decisions-2026-09.md`، 2026-09-26): FR-AUTH-012، FR-IMPORT-006/007، FR-SEARCH-009/011، FR-PRICE-004/008(E.8)/009(E.8)، FR-CART-007، FR-FUL-007، FR-SUP-006، FR-VPORTAL-008/010، FR-CMS-001..005. لن تُجدوَل في أي سبرنت ما لم يصدر قرار معتمد جديد يعيدها للنطاق.

**فحص المجموع:** S15(13)+S16(0)+S17(25)+S17b(13)+S18(16)+S18b(19)+S19(10)+S20a(15)+S20b(6)+S21(12)+S22(8)+S23(10)+S24(16)+S25(21) = **184** سبرنتات مجدولة + **5** غير مجدولة (قرار جديد: "أقرب فرع" 2 + CANCELLED والاستئناف 3) = **189** (بعد S16: −2 صار DONE، +2 صفّان جديدان في §15b؛ عدّاد S15/S17 يحمل الفرق التاريخي نفسه عن العدّ الآلي كما كان قبل S16).

**قرارات مطلوبة قبل أي سبرنت، بالترتيب (بعد إغلاق OPEN-011/013):**
1. مصدر مسافة موثوق لـ"أقرب فرع" — بدونه هذا البند يبقى خارج كل الجداول الزمنية إلى أجل غير مسمى، وليس فقط مؤجَّلاً لسبرنت لاحق.
2. قرار D1 للمراجعات (S23) - **لا يزال مفتوحاً بعد تنفيذ S23 (2026-10-14) بقرارك الصريح**: كل شيء آخر في PDR-032 مبني؛ D1 وحده (وكذلك رصد الأنماط الشاذة FR-REV-007/010، قرارك رقم 3) تُركا عمداً دون بناء أو افتراض.
3. الخصم النسبي: نفس سبرنت الكتالوج أم منفصل (S17).
4. تنظيف تصادمات الـID الأحد عشر في الـSRS (توثيقي فقط، بدون كود).

سأنتظر مراجعتك ولن أبدأ Sprint 15 أو أي كود.

---

# الملحق: تغطية كامل الـSRS (Parts 3–9) — إضافة 2026-09-26

**لم يتغيّر شيء أعلاه.** هذا ملحق يضيف كل `BR-*` وكل `NFR-*` وبقية أجزاء الـSRS (3–9)، ويعطي جداول حالات E.11 معرّفات ثابتة كما طُلب. لا كود، لا migration، لا commit. لا Sprint 15.

**قاعدة الترقيم للصفوف بلا ID أصلي في الـSRS:** `SRS-<القسم>-<تسلسل>`، مقسّمة بلاحقة فرعية حيث يفيد ذلك في القراءة (مثل `SRS-E11-VS-03` لصف في جدول VendorSuborder). كل صف من هذه معرّف ثابت من الآن فصاعداً، لا يتغيّر بين المراجعات.

**نطاق التغطية المتعمّد (أمانة قبل الجداول):**
- `BR-*` (34 قاعدة، مع BR-026 كصف واحد يجمع نص F الأصلي وتعديل F.1) و`NFR-*` (32) — تغطية كاملة سطراً بسطر، بفحص كود فعلي لكل واحد.
- `G.0`/`G.3` (نموذج البيانات) — تغطية كاملة: 8 صفوف "target delta" + كيانات G.3 مقابل نماذج Prisma الفعلية.
- `H.1` (اتفاقيات API) و`H.3a` (نقاط النهاية المستهدفة بعد تعديل PDR) — تغطية كاملة. `H.2`/`H.3` الأصليان (قبل التعديل) صف واحد "SUPERSEDED" بدل تكرارهما، لأن `H.3a` نفسه ينص على أنهما يُستبدلان.
- `K.1a` (شاشات معتمدة أيلول 2026) — 11 صفاً. شاشات `K.1` الأصلية (~50 شاشة) **لم تُفكَّك صفاً بصف** لأن عمود "UI route" في كل صفوف `FR-*` أعلاه يغطي نفس المعلومة عملياً؛ تفكيكها سيكرر نفس الفحص دون معلومة جديدة. بدلاً من ذلك أضفت 4 صفوف تجميعية لحالات Empty/Loading/Error وRTL/A11y لكل بوابة (عميل/بائع/إدارة/دعم)، لأن هذا بُعد غير مغطى في أي صف `FR-*`.
- `L-01..L-32` (سيناريوهات فشل) — تغطية كاملة، معرّفاتها أصلية من الـSRS.
- `M` (ADR-001..012) — تغطية كاملة مقابل الكود الفعلي.
- `N.1..N.5` (استراتيجية التطابق) — 5 صفوف للادعاءات القابلة للفحص (الأوزان، العتبات، الاستثناءات).
- `O` (اختبار) — `O.1` (15 مستوى اختبار) صف تجميعي واحد لكل مستوى مع ملاحظة تغطية عامة، لأنها ليست متطلبات مستقلة بل تصنيف لما هو موجود أصلاً. `O.2` (`TC-*`، 40 معرّفاً): **لم تُفكَّك كصفوف بحث منفصلة** — كل `TC-*` تقريباً هو نفس الفحص المطلوب لصف `FR-*`/`BR-*` مذكور أعلاه بنفس ملفات الاختبار؛ بدلاً من تكرار 40 صفاً مطابقاً، أدرجت جدولاً واحداً يربط كل `TC-*` بالـID الذي يغطيه فعلياً أعلاه وحالته.
- `P` (DevOps) — 15 صفاً.
- `Q.1` (RISK) و`Q.2` (ASM) و`Q.3` (DEP) و`Q.4` (OPEN) — **لم تُفكَّك** لأنها سجلات مخاطر/اعتماديات/قرارات مفتوحة، وليست متطلبات قابلة للبناء بذاتها؛ كل عنصر منها مُشار إليه أصلاً داخل الجداول أعلاه حيث يخص متطلباً معيّناً (OPEN-004، OPEN-011..013، إلخ). إن أردتِها كجدول مستقل أضيفها في نسخة لاحقة.
- `Q.5` (ADR) مغطاة ضمن قسم M أعلاه. `Q.6`/`Q.6a` (BDR): BDR-016 حتى BDR-025 (تعديل أيلول) هي فعلياً نفس PDR-001..036 المُغطاة بالكامل في الجدول الرئيسي أعلاه (PDR-035/036 أُضيفا 2026-09-26، بعد Q.6a الأصلي في الـSRS، ولا مقابل BDR لهما هناك) — **لم تُكرَّر**. BDR-001..015 (القديمة، من Q1-14 الأصلية) — 16 صفاً (البند 015 والبند 016 القديم كلاهما مرقّم "015"/"016" في الـSRS نفسه، ميّزتها).
- Part 8 (`BL-*`، ~112 معرّفاً): **لم تُفكَّك فردياً.** `post-sprint3-replan-2026-09.md` نفسه ينص صراحة أن Part 8 "superseded for Sprint 4+ by this document" — وSprint 1-3 من BL-* مغطاة فعلياً عبر تدقيق التوافق `sprint-1-3-compatibility-audit-2026-09.md` وتنعكس في صفوف `FR-*`/`PDR-*` أعلاه. صف واحد يوثّق هذا القرار بدل 112 صفاً مكرراً لنفس المعلومة.
- Part 9: `AC-01..22` (22 سيناريو) — تغطية كاملة لكنها "خفيفة" (ترث حالة الـID الذي تختبره، لأن AC هي إعادة صياغة Given/When/Then لمتطلب مُصنَّف أعلاه بالفعل، وليست فحصاً جديداً). `BO-1..8` (الأهداف الاستراتيجية) وجدول المصفوفة على مستوى الوحدة (Module-level matrix) وقسم "Final recommendations" الاثني عشر: **لم تُفكَّك** لأنها ملخصات إدارية/استراتيجية تُشتق من نفس صفوف `FR-*`/`PDR-*`/`BDR-*` أعلاه، وليست متطلبات مستقلة قابلة للتصنيف DONE/PARTIAL/MISSING بذاتها.

إن كان أي من قرارات النطاق هذه غير مقبول، أخبريني بالتحديد أيها تريدين تفكيكه بالكامل وسأفعل ذلك في نسخة تالية.

## §6 — `BR-*` Business rules catalog (Part 3, Section F)

| ID | Rule (paraphrase) | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| BR-001 | معرّف دقيق يربط تلقائياً؛ غير ذلك يحتاج مراجعة بشرية | proposal + match-confirmation (ليس ربطاً تلقائياً حقيقياً حتى للمطابقة الدقيقة — يمر بنفس خطوة تأكيد المالك، هذا لم يتغيّر) | OWNER | تأكيد/رفض من صفحة المتغيّر (S17) | S6,S7,S17 | 🟡 PARTIAL | S17 |
| BR-002 | البائع يملك فقط سجلاته (Vendor/Branch/Offer/Variant)؛ الكتالوج الأساسي والتصنيف ملك المنصة دائماً | VendorMembershipGuard + RequireVendorRole('OWNER') على كل مسار بائع؛ POST/PATCH/DELETE على categories/brands/canonical-products محصورة بـPLATFORM_ADMIN | OWNER + PLATFORM_ADMIN | — (backend) | S3,S4,S6,S7,VV | ✅ DONE | - |
| BR-003 | كل قائمة انتقاء (فئات، أسباب إرجاع، فئات تذاكر) قابلة للضبط إدارياً، لا hardcoded | Regions/segments/PlatformRole/StockMovementReason/OfferCondition كلها Prisma enums ثابتة في الكود | - | لا | لا | ❌ MISSING | BACKLOG-QUALITY (من S25) |
| BR-004 | سعر لم يُعاد تأكيده ضمن نافذة التقادم يُعلَّم قديماً في المقارنة/البحث | لا | - | لا | لا | ❌ MISSING | S17 |
| BR-005 | مخزون قديم يُعلَّم؛ لا يُعتمد كحقيقة لمنع checkout بلا إعادة تحقق أحدث | إعادة التحقق عند الـcheckout DONE (FR-CART-002)؛ علم "قديم" (is_stale، lastPhysicalCountAt، 7 أيام) موجود الآن (S18a) ولا يُستخدم في checkout — إعادة التحقق تبقى المصدر الوحيد هناك | session | /checkout؛ شارة "جرد قديم" في صفحة مخزون الفرع (S18a) | S10,S18a | ✅ DONE | - |
| BR-006 | التوصيل مؤهل فقط داخل منطقة الفرع؛ الاستلام مؤهل دائماً | فحص المنطقة في quote/reserve + PICKUP_REQUIRES_PHYSICAL_BRANCH | session | /checkout | S10,S14 | ✅ DONE | - |
| BR-007 | فقط العروض المعتمدة تدخل المقارنة؛ غير المطابق يظل قابلاً للبحث والشراء لكن مستبعداً من المقارنة | استبعاد المقارنة DONE؛ "قابل للبحث" فقط عبر صفحة المتجر، ليس الاكتشاف العام | public | /compare, /store/:slug/products/:id | S8,S13 | 🟡 PARTIAL | S18b |
| BR-008 | تراكب الخصومات/الكوبونات بجدول موثّق؛ الافتراضي عدم التراكب (Phase 2 بحسب الـSRS) | لا | - | لا | لا | ❌ MISSING | قرار-نطاق |
| BR-009 | السلة مقسّمة بالبائع؛ كل تحقق (حد أدنى، أهلية توصيل) لكل قسم | التقسيم الفعلي أصبح بالفرع لا بالبائع (PDR-004 بديل معتمد)؛ كل التحققات (مخزون، أهلية، سعة، **والحد الأدنى الآن**) تعمل لكل مجموعة فرع بشكل مستقل تماماً | session | /checkout | S10,S14,S20b | ✅ DONE | - |
| BR-010 | CustomerOrder وكل صفوفه التابعة تُنشأ ذرياً من طلب checkout واحد | معاملة Prisma واحدة تغطي الخصم والطلبات والدفع | session | /checkout | S10,S14 | ✅ DONE | - |
| BR-011 | إلغاء الطلب الفرعي محكوم بحالته (العميل حتى Confirmed، البائع حتى Preparing)؛ تجاوز الأدمن موثّق | العميل: PLACED فقط؛ الموظف/OWNER: PLACED/PREPARING؛ تجاوز PLATFORM_ADMIN بسبب إلزامي وAuditLog (BR-019)، **مقيَّد هو نفسه بـPLACED/PREPARING فقط** (مراجعة 2026-10-08: ليس "أي حالة غير نهائية" — بعد SENT قد تكون البضاعة خرجت فعلاً، وإعادتها للمخزون تلقائياً دون مسار إرجاع مؤكد غير مقبولة، نطاق S21) | عميل/موظف/PLATFORM_ADMIN | /orders، صفحة طلبات الفرع، /admin/branch-orders | S20a | ✅ DONE | - |
| BR-012 | أهلية الإرجاع نافذة زمنية + سبب، قابلة للضبط لكل فئة | **استُبدلت فعلياً بـPDR-030**: النافذة/السبب قابلان للضبط لكل متجر (vendor) الآن، لا لكل فئة منتج حرفياً كما ورد هنا - قرار منتج معتمد يتجاوز هذا النص. الحد الأدنى القانوني المحتمل (Q11/OPEN-009) يبقى مفتوحاً، لم يُفترض | - | - | لا | 🟡 PARTIAL (مستوى المتجر لا الفئة؛ الحد القانوني مفتوح) | - |
| BR-013 | صيغة الاسترداد (سعر + حصة رسوم التوصيل − تسوية)؛ كانت مقترحة معلّقة على OPEN-007 (أُغلق الآن) | **مستبدلة فعلياً**: OPEN-007 أُغلق (PDR-001: ILS فقط، لا FX)؛ القاعدة الفعلية الآن PDR-030/031 (`max(0, سعر الصنف − رسم الإرجاع)`، بلا رسم توصيل أبداً) - مبنية بالكامل | - | - | - | ↪ SUPERSEDED (انظر PDR-030/031 وFR-RET-004) | - |
| BR-014 | الاشتراك يتحكم بالظهور لا بالعمولة؛ Past Due يدخل فترة سماح قبل Suspended | ACTIVE/EXPIRED فقط (PDR-033 بسّطت الحالات)؛ لا فترة سماح منفصلة | OWNER | لا | S3 | 🟡 PARTIAL | S15 |
| BR-015 | فوترة اشتراك البائع وفوترة طلب العميل على دورتين مستقلتين | VendorSubscription وPaymentTransaction نموذجان منفصلان تماماً بالبناء | OWNER/session | - | S3,S10 | ✅ DONE | - |
| BR-016 | مراجعة فقط بعد اكتمال طلب/صنف موثّق ("شراء موثّق") | مبني: `ReviewsService.submit()` يرفض أي عنصر طلب حالته ليست `COMPLETED` فعلياً، أو ملغى (`cancelledAt`) - حتى لو كان الطلب نفسه مكتملاً | عميل | رسالة الرفض الحقيقية من الخادم تظهر في صفحة كتابة المراجعة | S23 e2e | ✅ DONE | - |
| BR-017 | البائع يُعلَّم تلقائياً للمراجعة الإدارية عند past-due أو نمط إرجاع شاذ أو رفض أدلة بلا إعادة تقديم؛ التعليق فعل إداري صريح دائماً | لا آلية تعليم تلقائي (محفّزاتها تعتمد على فترة سماح ومرتجعات وعامل مجدول غير موجودة)؛ الجملة الأخيرة متحققة: التعليق فعل أدمن صريح بسبب مسجَّل (S16) | PLATFORM_ADMIN | لا | S16 | ❌ MISSING | — (غير مجدول؛ ليس DEFERRED) |
| BR-018 | حذف الحساب يحترم فترة احتفاظ بالطلبات/الدفع/التدقيق حتى بعد الحذف | **لا يزال غير مبني - قرار صريح لـS22**: لا purge، لا anonymization، لا إخفاء PII، لا مدة احتفاظ قابلة للضبط. S22 بنى فقط نافذة الاسترجاع 30 يوماً (FR-AUTH-014/PDR-034، رقم حرفي مؤكَّد) - وهي ليست سياسة احتفاظ، بل مهلة قبل أن يصبح الحساب غير قابل للاسترجاع. البيانات نفسها (الطلبات/الدفع/التدقيق) لا تُحذف ولا تُعدَّل أبداً حالياً، بلا سياسة محدَّدة أصلاً | - | لا | لا | ❌ MISSING | قرار-نطاق |
| BR-019 | أي تجاوز صلاحية إداري ("break-glass") يسجَّل بسبب ويُدقَّق دائماً | أول مسار "break-glass" حقيقي: إلغاء قسري لطلب فرع (PLACED/PREPARING فقط)، PLATFORM_ADMIN فقط، سبب إلزامي (10-1000 حرف) وAuditLog لكل استدعاء؛ لا يتجاوز سجل الاسترداد/إعادة المخزون أبداً. **الاسترداد اليدوي المستقل عن الإلغاء أُزيل** (مراجعة 2026-10-08): كان يسمح بتجاوز سقف الاسترداد الفعلي لأنه غير مرتبط بصنف — يحتاج سجل تخصيص حقيقي، نطاق S21 | PLATFORM_ADMIN | /admin/branch-orders | S20a | ✅ DONE | - |
| BR-020 | تأكيد الطلب يتطلب دبوس منزل وهاتفين، ويطلق 3 إشعارات مستقلة التتبع | الهاتفان والإحداثيات DONE (بلا خريطة، قرار معتمد)؛ الإشعارات الثلاثة المتتبَّعة غير موجودة (outbox فقط) | session | /checkout | S14 | 🟡 PARTIAL | S19 |
| BR-021 | كل عرض بعملة البائع؛ المقارنة تطبيع FX؛ الدفع بعملة البائع الأصلية (مقترح معلّق OPEN-007) | استُبدل بـBR-027 (تنص F.1 على ذلك صراحة) | - | - | - | ↪ SUPERSEDED | - |
| BR-022 | فرع فعلي لا يغادر "قيد التحقق" بلا دبوس وصورة، مراجَعة من مراجع تحقق | POST verification-evidence + verification-decision | OWNER + REVIEWER | لا | S3,VV | 🟡 PARTIAL | S15 |
| BR-023 | هاتف+كلمة مرور أساسي؛ OTP يوثّق التسجيل ويبوّب استعادة كلمة المرور وتغيير الهاتف | التسجيل والاستعادة DONE؛ تغيير الهاتف بـOTP غير موجود | عام/session | /register,/reset-password | AUTH | 🟡 PARTIAL | S22 |
| BR-024 | الضيف يتصفح ويبني سلة بلا حساب؛ الدخول يدمج سلة الضيف | استُبدل: السلة تتطلب تسجيل دخول من الأصل الآن (PDR-002/FR-AUTH-013)، فلا سلة ضيف لتُدمج | - | - | - | ↪ SUPERSEDED | - |
| BR-025 | أهلية إرجاع الصنف تعتمد فقط على `Fulfillment` الخاص به، لا الأصناف الشقيقة أو الطلب الفرعي كاملاً | **مبنية بلا كيان `Fulfillment` مستقل** - FR-FUL-007 (split shipment) مؤجَّل بقرار معتمد، وBR-028 نفسها تجعل `BranchOrder` الوحدة الوحيدة المشتركة لكل أصنافه (حالة splitShipment=false التي يصفها الـSRS نفسه كالحالة الافتراضية المطابقة لسلوك Part 2 الأصلي). الاستقلالية عن الأصناف الشقيقة محقَّقة عبر محاسبة استرداد لكل صنف (`BranchOrderRefund.branchOrderItemId` فريد، وفهرس Return الجزئي لكل صنف) - لا عبر توقيت تسليم مختلف | عميل | - | S21 unit+e2e | ✅ DONE | - |
| BR-026 (F + F.1) | رفض تحقق فرع واحد يرفض الطلب كاملاً؛ إعادة التقديم مسار منفصل عن الرفض؛ يمكن تقديم طلب مصحَّح فوراً بعد الرفض مع بقاء السجل القديم | منطق UNDER_REVIEW→REJECTED الشامل مبني ومختبر؛ سبب الرفض يراه المالك (verification-status)؛ الطلب المصحَّح = POST /vendors جديد بسجل قديم محفوظ (واجهة تقديم الطلب نفسها تحت FR-VEND-001/S15) | REVIEWER/ADMIN | /admin/verification، /vendor/:vendorId/verification | VV,S16 | ✅ DONE | - |
| BR-027 | كل المبالغ ILS؛ لا FX ولا تسوية متعددة العملات؛ يُلغي BR-021 ويُغلق OPEN-002/007 | بيانات ILS فقط في كل مكان | n/a | كل واجهات السعر | S10,S14 | ✅ DONE | - |
| BR-028 | checkout واحد ينتج CustomerOrder أب وBranchOrder واحد أو أكثر، كل BranchOrder بطريقة تنفيذ/رسم/دفع/موعد/دورة حياة خاصة به | BranchOrder | session | /orders | S9,S10 | ✅ DONE | - |
| BR-029 | العميل يختار سطور السلة صراحة؛ النظام يقترح فقط فروعاً تحوي كل المتغيرات المختارة، ويقترح الأقرب لكن العميل يختار فرعاً أبعد مؤهلاً | الاختيار الصريح ومجموعة الفروع المؤهلة DONE؛ "الأقرب" بديل حتمي موثّق لا مسافة حقيقية | session | /checkout | S10,S14 | 🟡 PARTIAL | — (قرار جديد) |
| BR-030 | باركود المخزون فريد وscanner-facing؛ الباركود المشترك داخلي لا يُستبدل أبداً؛ بيع/تخفيض لا يمكن أن ينزل المخزون تحت الصفر | فصل الباركودين DONE؛ واجهة بحث بالباركود (scanner-facing) موجودة الآن (S18a)؛ منع النزول تحت الصفر DONE (خصم ذري) | OWNER | صفحة مخزون الفرع: حقل البحث بالباركود (S18a) | S6,S18a | ✅ DONE | - |
| BR-031 | خصم يدوي غير بيعي له سبب دائماً ويُشعِر المالك؛ لا نقل مخزون بين الفروع في المرحلة الأولى | السبب مفروض؛ لا نقل مبني (متوافق مع القرار)؛ **الإشعار يصل فعلياً الآن** لصندوق المالك (relay S19)، لم يعد outbox فقط | OWNER/EMP | صفحة مخزون الفرع: نموذج الحركة (S18a)؛ /notifications (S19) | S6,S18a,S19 | ✅ DONE | - |
| BR-032 | التوفر العام مشتق من مجموع مخزون الفروع المؤهلة لكن يُعرض فقط Available/Low/Sold out؛ الكمية الحقيقية خاصة إلا حد أقصى عند تحقق السلة | البطاقات العامة تستخدم المجموع (bucketForStock) كما هو منصوص؛ حد السلة الأقصى أصبح عمداً لكل فرع مفرد (إصلاح مراجعة Sprint 14) بما يطابق أن checkout لا يقسّم سطراً على فرعين | public/session | البطاقات، /cart | S8,S14 | ✅ DONE | - |
| BR-033 | سياسة إرجاع المتجر ورسومه تُلقَط لحظة الشراء؛ تتغير كل 6 أشهر فقط؛ قبول موحّد عبر كل الفروع/نقاط الاستلام | مبنية: اللقطة على `BranchOrder` عند `confirm()` (تشمل الآن رسم التبديل أيضاً - `returnPolicySnapshotExchangeFeeIls`، S21b)، قفل 6 أشهر حقيقي (صف Vendor مقفول، لا timestamp فقط) مع اختبار تزامن حتمي. **قبول موحّد عبر الفروع الفعلية فقط** - نقاط الاستلام (PickupPoint) بلا عضوية تشغيلية في هذا الكود، فجزء "نقاط الاستلام" غير مبني (S21b لا يغيّر هذا) | OWNER | - | S21 e2e؛ S21b e2e (لقطة رسم التبديل) | 🟡 PARTIAL (فروع فعلية فقط) | - |
| BR-034 | التوصيل يديره موظفو الفرع؛ تأكيد العميل يُطلب بعد تحديث الموظف؛ تذكير 48 ساعة وتأكيد تلقائي 72؛ لا هوية سائق ولا نزاع داخل المنصة | الإجراءات اليدوية DONE؛ **التذكير والتأكيد التلقائي أصبحا مجدوَلين فعلياً الآن** (`FulfilmentSweepService` دوري، لا عند القراءة فقط — S19) | EMP/session | صفحة الفرع،/orders، /notifications (S19) | S11,S19 | ✅ DONE | - |

**عدّاد BR:** 34 صفاً (BR-001..034)، منها 2 SUPERSEDED (021، 024). أُعيد فرز الـ32 الحيّة مباشرة من الجدول أعلاه بعد S19 (لا تقدير): DONE=11 (002، 005، 006، 010، 015، 027، 028، 030، 031، 032، 034)، PARTIAL=9 (001، 007، 009، 014، 020، 022، 023، 026، 029)، MISSING=12 (003، 004، 008، 011، 012، 013، 016، 017، 018، 019، 025، 033). المجموع 11+9+12+2=34. (قبل S19: DONE=10، PARTIAL=10 — BR-034 انتقلت PARTIAL←DONE. قبل S18a: DONE=7، PARTIAL=13 — BR-005/030/031 انتقلت PARTIAL←DONE. النسخة v2 كانت ذكرت 8/17/7 خطأً؛ صُحِّحت في v3/§16.)

## §7 — `NFR-*` Non-functional requirements (Part 4, Section I)

| ID | Requirement (paraphrase) | Backend/evidence | Status | Sprint |
|---|---|---|---|---|
| NFR-PERF-001 | صفحة تفاصيل المنتج p95 ≤2s على 3G | لا قياس أداء رسمي موجود في المستودع | ❌ MISSING | BACKLOG-QUALITY (من S25) |
| NFR-PERF-002 | نتائج البحث p95 ≤1.5s حتى 10,000 عرض | لا قياس | ❌ MISSING | BACKLOG-QUALITY (من S25) |
| NFR-PERF-003 | checkout حتى إنشاء الطلب p95 ≤3s (باستثناء البوابة) | لا قياس رسمي؛ زمن e2e الحالي (~100ms لكل طلب في بيئة الاختبار) مؤشر غير رسمي فقط | ❌ MISSING | BACKLOG-QUALITY (من S25) |
| NFR-SCALE-001 | تحمّل 50 جلسة متزامنة في بيئة العرض | لا اختبار حمل | ❌ MISSING | BACKLOG-QUALITY (من S25) |
| NFR-IMPORT-001 | استيراد 1000 صف خلال 5 دقائق | لا قياس؛ الاستيراد الحالي يُختبر بأحجام صغيرة فقط | ❌ MISSING | BACKLOG-QUALITY (من S25) |
| NFR-AVAIL-001 | 99.5% شهرياً للإنتاج؛ لا SLA رسمي لبيئة FYP | لا بنية إنتاج فعلية بعد | n/a | قرار-نطاق |
| NFR-REL-001 | RPO ≤ ساعة عبر نسخ احتياطي كل ساعة | لا نسخ احتياطي مجدول موجود في هذا المستودع | ❌ MISSING | BACKLOG-QUALITY (من S25) |
| NFR-REL-002 | RTO ≤4 ساعات للإنتاج | لا خطة تعافي موثقة أو مختبرة | ❌ MISSING | قرار-نطاق |
| NFR-REL-003 | job مجدول يكتشف ويعلّم (لا يحل تلقائياً) حالات "دفع نجح/طلب فشل" | rollback داخل نفس المعاملة يمنع الحالة أصلاً في المسار الحالي؛ لا job تسوية منفصل موجود لأن الحالة لم تُلاحظ بعد في هذا التصميم أحادي المعاملة | 🟡 PARTIAL | BACKLOG-QUALITY (من S25) |
| NFR-SEC-001 | TLS 1.2+ على كل شيء، لا HTTP نص صريح | بيئة تطوير محلية فقط بلا TLS؛ غير منطبق للإنتاج بعد | n/a | قرار-نطاق |
| NFR-SEC-002 | كلمات المرور بتجزئة مملحة حديثة | `bcryptjs`، `bcrypt.hash(..., 10)` في auth.controller.ts | ✅ DONE | - |
| NFR-SEC-003 | كل حدث AuditLog محتفَظ به وقابل للاستعلام لمدة الاحتفاظ | `AuditLog` جدول إلحاق فقط موجود؛ **واجهة الاستعلام والتصدير مبنية الآن (S25، FR-ADMIN-005)**؛ مدة الاحتفاظ نفسها (كم تُحفَظ السجلات قبل الحذف/الأرشفة) تبقى معلّقة (OPEN-009) — لا حذف أو أرشفة تلقائية مبنية هذا السبرنت | 🟡 PARTIAL | - |
| NFR-PRIV-001 | PII العميل مرئي فقط للأدوار المصرَّح لها، مفروض في طبقة الـAPI | الموظف يرى الاسم/الهاتف/الكود فقط دون العنوان (FR-NOTIF-005 DONE)؛ لم أتحقق من كل مسار عرض عنوان آخر | 🟡 PARTIAL | BACKLOG-QUALITY (من S25) |
| NFR-A11Y-001 | WCAG 2.1 AA على المسارات الأساسية | 18 ملفاً فقط تستخدم aria-/role؛ لا تدقيق رسمي | 🟡 PARTIAL | BACKLOG-QUALITY (من S25) |
| NFR-L10N-001 | كل نص يخرج بالعربية والإنجليزية من مصدر ترجمة | **مصدر ترجمة حقيقي مبني الآن (S22)**: قاموس `lib/i18n.ts` + `useT()`، مطبَّق على AppShell والواجهة المشتركة وشاشات S22 الجديدة فقط - مبدّل لغة حقيقي (ar/en) يُحفظ محلياً وعلى الحساب (User.languagePref)؛ **بقية الشاشات (S1-S21b) لا تزال عربية فقط حرفياً، لم تُعَد ترجمتها عمداً هذا السبرنت** | 🟡 PARTIAL — الأساس حقيقي الآن، التغطية جزئية | قرار-نطاق |
| NFR-RTL-001 | كامل الواجهة (لا النص فقط) تُرآى بشكل صحيح بـRTL | `<html lang="ar" dir="rtl">` عام على التطبيق، **ويتبدَّل فعلياً إلى `lang="en" dir="ltr"` عند اختيار الإنجليزية (S22، تأثير جانبي على كل الصفحات حتى القديمة منها لأن `<html>` عنصر واحد مشترك)**؛ لا تدقيق شامل للتخطيط/الأيقونات لكل الشاشات القديمة تحت LTR | 🟡 PARTIAL | BACKLOG-QUALITY (من S25) |
| NFR-MOBILE-001 | كل الشاشات قابلة للاستخدام عند 400px، وعلى Android/iOS | استجابة الويب مبنية ومُتحقَّق منها بلقطات الجوال؛ لا بناء Android/iOS (Capacitor) إطلاقاً | 🟡 PARTIAL | قرار-نطاق |
| NFR-BW-001 | صور بصيغة مضغوطة متجاوبة (WebP إلخ) | لا معالجة/ضغط صور موجودة؛ الصور روابط خام | ❌ MISSING | S17 |
| NFR-OBS-001 | كل طلب قابل للتتبع عبر X-Correlation-Id في اللوغ وAuditLog والـwebhooks | `CorrelationIdMiddleware` + مُدرَج في كل رد خطأ وكل AuditLog | ✅ DONE | - |
| NFR-OBS-002 | كل تكامل خارجي يعرض معدل نجاح/زمن استجابة/آخر فشل للوحة الأدمن | لا لوحة تكامل؛ لا تكامل خارجي حقيقي أصلاً (كل شيء sandbox/محلي) | ❌ MISSING | BACKLOG-QUALITY (من S25) |
| NFR-MAINT-001 | كل قائمة انتقاء تُغيَّر بإعداد إداري لا نشر كود | نفس BR-003: enums ثابتة في الكود | ❌ MISSING | BACKLOG-QUALITY (من S25) |
| NFR-TEST-001 | كل آلة حالة في Part 2 E.11 لها اختبار آلي لكل انتقال صالح وانتقال غير صالح واحد على الأقل | آلات E.11 القديمة (VendorSuborder/Payment القديم) غير مبنية أصلاً بهذا الشكل؛ آلة BranchOrderStatus الفعلية موسَّعة (DELIVERY_FAILED/REFUND_REQUESTED) بتغطية شاملة الآن لمحور `deliveryAttemptCount` (`branch-order-state-machine.spec.ts`: كل انتقال صالح + كل هدف غير صالح من كل حالة جديدة بشكل مصرَّح)؛ لا إثبات شمولية مماثل لبقية آلات المشروع بعد | 🟡 PARTIAL | BACKLOG-QUALITY (من S25) |
| NFR-BACKUP-001 | نسخ احتياطي كل ساعة على الأقل، والتحقق من قابلية الاستعادة دورياً | لا نسخ احتياطي مُدار في هذا المشروع (بيئة تطوير) | ❌ MISSING | قرار-نطاق |
| NFR-DR-001 | دليل تعافي من كوارث موثّق ومُجرَّب مرة قبل إطلاق الإنتاج | لا يوجد | ❌ MISSING | قرار-نطاق |
| NFR-RETAIN-001 | سجلات معاملاتية محتفَظ بها حسب BR-018 | BR-018 نفسه لا يزال MISSING - قرار صريح لـS22، لا purge/retention مبني | ❌ MISSING | قرار-نطاق |
| NFR-BROWSER-001 | أحدث إصدارين من Chrome/Safari/Firefox/Edge | لا مصفوفة اختبار متصفحات رسمية؛ التحقق الحالي عبر Playwright/Chromium فقط | 🟡 PARTIAL | قرار-نطاق |
| NFR-DEVICE-001 | أحدث إصدارين من Android/iOS | لا بناء موبايل إطلاقاً | ❌ MISSING | قرار-نطاق |
| NFR-SEO-001 | صفحات المنتج الأساسي مُقدَّمة من السيرفر لا JS فقط | Next.js App Router (خادمي افتراضياً)، لم أتحقق من كل صفحة إن كانت client component بلا داعٍ | 🟡 PARTIAL | S18b |
| NFR-IMG-001 | حد أقصى لحجم الصورة المرفوعة (10MB افتراضي) | لا رفع صور مبني أصلاً (روابط فقط) | ❌ MISSING | S17 |
| NFR-STALE-001 | تأخير تعليم المخزون قديماً: 7 أيام يدوي / 24 ساعة API، قابل للضبط | الشق اليدوي موجود الآن: is_stale إن مرّ 7 أيام منذ lastPhysicalCountAt (S18a) — لكنه ثابت بالكود لا "قابل للضبط"، ولا مصدر تقادم API/تغذية مؤتمتة من نوعه | 🟡 PARTIAL | S18 |
| NFR-STALE-002 | تأخير تعليم السعر قديماً: 30 يوماً، قابل للضبط | لا تعليم تقادم سعر موجود | ❌ MISSING | S17 |
| NFR-AUDIT-001 | 100% من انتقالات الحالة وكل فعل إداري متجاوِز يُنتج صف AuditLog | نسبة عالية من الانتقالات المبنية فعلاً تُدقَّق (checkout، تحقق، اشتراك، مخزون)؛ فعل "التجاوز الإداري" (BR-019) مبني الآن ومُدقَّق دائماً؛ "100%" الشامل عبر كل المشروع غير مؤكَّد شمولاً | 🟡 PARTIAL | BACKLOG-QUALITY (من S25) |

**عدّاد NFR:** 32 صفاً، أُعيد فرزها مباشرة من الجدول أعلاه بعد S18a: DONE=2 (SEC-002، OBS-001)، PARTIAL=11 (REL-003، SEC-003، PRIV-001، A11Y-001، RTL-001، MOBILE-001، TEST-001، BROWSER-001، SEO-001، AUDIT-001، STALE-001)، MISSING=17 (الباقي)، n/a (غير منطبق على بيئة تطوير حالياً، لا يُحسب DONE/MISSING)=2 (NFR-AVAIL-001، NFR-SEC-001). المجموع 2+11+17+2=32. (قبل S18a: PARTIAL=10، MISSING=18 — NFR-STALE-001 انتقل MISSING←PARTIAL. النسخة v2 كانت ذكرت 2/13/15 خطأً؛ صُحِّحت في v3/§16.)

## §8 — Part 3, Section G: نموذج البيانات

### G.0 — 8 صفوف "target model delta" (ملزمة، تسبق أي مخطط قديم)

| ID | المنطقة | الحالة الفعلية | Status | Sprint |
|---|---|---|---|---|
| SRS-G0-01 | هوية المتجر: slug/display_name/bio/logo/cover، أقسام، StoreFollow | Vendor له كل هذه الحقول؛ StoreSection/StoreSectionOffer/StoreFollow موجودة | ✅ DONE | - |
| SRS-G0-02 | الأدوار: VendorUser بدور OWNER/BRANCH_EMPLOYEE، branchId إلزامي وفريد للموظف النشط | مطابق تماماً للسكيما الفعلية | ✅ DONE | - |
| SRS-G0-03 | المواقع: StoreBranch (فعلي)، Warehouse (مخفي)، PickupPoint (بلا مخزون) | الثلاثة موجودة كنماذج Prisma منفصلة | ✅ DONE | - |
| SRS-G0-04 | الكتالوج والمال: ILS فقط بلا حقل عملة، لا FxRate؛ باركود محلي+داخلي؛ حتى 10 صور و3 فيديوهات | ILS ضمنية DONE؛ لا FxRate DONE؛ الباركودان DONE؛ سقف 10 صور/3 فيديوهات لكل متغيّر ونوع MediaType (IMAGE/VIDEO) منفصل مبنيان ومدعومان بقيد DB CHECK (S17) | ✅ DONE | - |
| SRS-G0-05 | المخزون: OfferBranchInventory (= BranchStock فعلياً) لفرع فعلي/مستودع فقط؛ InventoryMovement بكل الأسباب المذكورة؛ لا نوع نقل | BranchStock+StockMovement موجودان؛ أسباب الحركة تغطي DAMAGE/LOSS/COUNT_CORRECTION/SALE الآن (S18a)، لا "استرجاع مرتجع" ولا "استيراد/إضافة" كأسباب حركة منفصلة | 🟡 PARTIAL | S18 |
| SRS-G0-06 | السلة والطلب: Cart لعميل موثّق فقط، CartItem بلا فرع/تنفيذ عند الإضافة؛ CustomerOrder له BranchOrder واحد أو أكثر | مطابق تماماً | ✅ DONE | - |
| SRS-G0-07 | التنفيذ والدفع: Fulfillment واحد لكل BranchOrder بلا سائق؛ دفع sandbox واحد يغطي عدة BranchOrders بتخصيص عبر branch_order_id | لا كيان Fulfillment منفصل (مدموج داخل BranchOrder، وهذا يحقق نفس الغرض عملياً)؛ PaymentTransaction واحد + BranchOrder.paymentTransactionId كإحالة (يحقق التخصيص فعلياً) | ✅ DONE | - |
| SRS-G0-08 | الجدولة والإرجاع: DeliverySlot لفرع مالك مخزون؛ ReturnPolicy مُلقَطة على BranchOrder/Item؛ Notification بحالة قراءة ورابط عميق؛ Review لمنتج/متجر فقط، غير قابل للتعديل | DeliveryWindow/Exception DONE؛ `Notification` بحالة قراءة ورابط عميق مبني بالكامل (S19)؛ `ReturnPolicy` مُلقَطة على `BranchOrder`/Item مبنية بالكامل (S21) - `returnPolicySnapshot*` على `BranchOrder`، و`ReturnRequest` (نموذج `Return`) مبني أيضاً. **`Review` لمنتج/متجر فقط، غير قابل للتعديل، مبني الآن بالكامل (S23، 2026-10-14)** - نموذج `Review` + `ReviewReport` | ✅ DONE | S17/S19/S21/S23 |

### G.3 — كيانات مقابل Prisma الفعلي (الكيانات غير المذكورة في G.0 فقط؛ ما ذُكر أعلاه لا يتكرر)

| ID | الكيان في SRS | الموجود فعلياً | Status | Sprint |
|---|---|---|---|---|
| SRS-G3-01 | `AttributeDefinition`/`AttributeOption` (قوالب خصائص الفئة) | لا نموذج مطابق؛ `structuralAttributes` JSON حر فقط | ❌ MISSING | S17b |
| SRS-G3-02 | `ProductMedia` (وسائط على مستوى المنتج الأساسي/المتغيّر) | فقط `OfferVariantMedia` (على مستوى عرض البائع)؛ لا وسائط على مستوى Canonical | ❌ MISSING | S17b |
| SRS-G3-03 | `ImportJob`/`ImportRow` (سجل مهمة استيراد كامل) | فقط `ImportIdentifierRecord` لمنع تكرار الصفوف؛ لا سجل مهمة/تاريخ استيراد | ❌ MISSING | S17 |
| SRS-G3-04 | `FxRate` | غير موجود، ومطلوب ألا يوجد (PDR-001) | ✅ DONE (بالإزالة المتعمدة) | - |
| SRS-G3-05 | `Payment`/`PaymentAllocation`/`PaymentTransactionAllocation`/`WebhookInbox` (نموذج دفع متعدد المراحل مع تسوية) | فقط `PaymentTransaction` بحالتين (SUCCEEDED/FAILED)، بلا بوابة حقيقية ولا webhook inbox (PDR-005 بسّط النموذج عمداً) | ✅ DONE (تبسيط sandbox متعمد، ليس فجوة) | - |
| SRS-G3-06 | `VendorSettlement`/`Promotion`/`Coupon` (Phase 2 بحسب الـSRS) | غير موجودة | ❌ MISSING | قرار-نطاق |
| SRS-G3-07 | `Review`/`ReturnRequest`/`Refund`/`Dispute` | `ReturnRequest`/`Refund`/`Dispute` مبنية بالكامل (S21) بواجهة مستخدم لكل الأدوار (جولة مراجعة 2026-10-10، انظر PDR-031) - نموذج `Return` + `BranchOrderRefund` + مسار النزاع/التصعيد. **`Review` مبني الآن بالكامل أيضاً (S23، 2026-10-14)** | ✅ DONE | S21/S23 |
| SRS-G3-08 | `Notification`/`SupportTicket` | **`Notification` مبني بالكامل الآن** (S19، يتبع FR-NOTIF-008 الذي أصبح ✅)؛ `SupportTicket` ما زال غير موجود إطلاقاً | 🟡 PARTIAL | S19/قرار-نطاق |
| SRS-G3-09 | `PriceHistory` | موجود (متوافق مع FR-PRICE-002، S17): سجلّ إضافة فقط، صف واحد لكل تغيير سعر حقيقي، تعبئة أولية MIGRATED_BASELINE لكل متغيّر سابق | ✅ DONE | - |
| SRS-G3-10 | ثابتان معماريان: لا `vendor_id` على `CanonicalProduct`/`CanonicalProductVariant` أبداً؛ كل جدول مملوك للبائع يحمل `vendor_id` إلزامياً | مطابق تماماً في السكيما الفعلية (تحقّقت من `CanonicalProduct`/`CanonicalProductVariant`/`OfferVariant`) | ✅ DONE | - |

## §9 — Part 4, Section H: اتفاقيات وواجهات API

### H.1 — اتفاقيات عابرة (10 صفوف)

| ID | الاتفاقية | الحالة الفعلية | Status | Sprint |
|---|---|---|---|---|
| SRS-H1-01 | ترقيم إصدار بادئة URI `/api/v1` | `app.setGlobalPrefix('api/v1')` في main.ts | ✅ DONE | - |
| SRS-H1-02 | شكل خطأ موحّد `{error:{code,message,details,correlation_id}}` مع أكواد HTTP قياسية | `HttpExceptionFilter` يطابق الشكل تماماً، مع correlation_id | ✅ DONE | - |
| SRS-H1-03 | مفتاح Idempotency-Key إلزامي على كل نقطة تُنشئ موارد مالية/طلبات | `IdempotencyInterceptor` مطبَّق على checkout وعلى استيراد العروض (S17، مؤكَّد بالقراءة)؛ لم أتحقق من كل نقطة أخرى | 🟡 PARTIAL | S17 |
| SRS-H1-04 | X-Correlation-Id يرافق كل طلب ويظهر في كل تدقيق وخطأ | `CorrelationIdMiddleware` + مُدرَج في AuditLog وHttpExceptionFilter | ✅ DONE | - |
| SRS-H1-05 | تقييد معدل لكل جهة فاعلة، أشد على OTP/بحث | `@nestjs/throttler` عام + `@Throttle` على OTP/login؛ لا تقييد أشد خاص بالبحث موجود | 🟡 PARTIAL | S18b |
| SRS-H1-06 | توقيع HMAC-SHA256 صادر لأي webhook من المنصة | لا webhooks صادرة من المنصة أصلاً (لا تكامل خارجي حقيقي) | ❌ MISSING | قرار-نطاق |
| SRS-H1-07 | توقيع وارد مُتحقَّق منه لبوابة الدفع/التوصيل (معلّق على OPEN-001) | لا بوابة حقيقية؛ sandbox فقط | ❌ MISSING | قرار-نطاق |
| SRS-H1-08 | إعادة محاولة exponential backoff + dead-letter queue مرئية للأدمن | **exponential backoff وDEAD_LETTER مبنيان ومختبران بالكامل** (outbox relay، S19)؛ "مرئية للأدمن" عبر API فقط (`GET /admin/outbox/dead-letter`، PLATFORM_ADMIN) — لا صفحة واجهة مخصصة بعد | 🟡 PARTIAL | S19 |
| SRS-H1-09 | مراقبة تكامل خارجي: معدل نجاح/زمن/آخر فشل في لوحة الأدمن | لا لوحة، لا تكامل خارجي حقيقي | ❌ MISSING | BACKLOG-QUALITY (من S25) |
| SRS-H1-10 | ترقيم صفحات بـcursor، حد افتراضي 20، أقصى 100 | الترقيم الفعلي `take`/`limit` بسيط (offset-style عبر معاملات بسيطة)، ليس cursor-based | 🟡 PARTIAL | S18b |

### H.2/H.3 (النسخة الأصلية قبل تعديل PDR)

| ID | الوصف | Status |
|---|---|---|
| SRS-H23-OLD | قائمة نقاط النهاية الأصلية (`POST /checkout` موحّد، `/suborders/{id}/status`، عملات متعددة) وعقودها المفصّلة السبعة | ↪ SUPERSEDED — `H.3a` نفسه ينص: "old `/suborders` and FX/currency routes must be deprecated rather than extended" |

### H.3a — نقاط النهاية المستهدفة بعد تعديل PDR (8 مجالات)

| ID | المجال | مطابقة الكود الفعلي | Status | Sprint |
|---|---|---|---|---|
| SRS-H3A-01 | الاكتشاف العام: `/discover/*`, `/stores/:slug`, `/products/:id`, `.../compare` | `GET /discovery/all(?segment)`, `GET /storefronts/:slug`, `GET /canonical-products/:id/comparison` — تطابق وظيفي وإن اختلفت المسارات الحرفية | ✅ DONE | - |
| SRS-H3A-02 | المتجر والمتابعة: PATCH storefront، sections، follow/following | كلها موجودة (Sprint 7/13) | ✅ DONE | - |
| SRS-H3A-03 | الأدوار والمواقع: دعوة موظف بـOTP، نقل/تعطيل، warehouse/pickup-points | الدعوة والقبول والـwarehouse/pickup-points API موجودة؛ نقل/تعليق/إعادة تفعيل موجودة الآن بواجهة حقيقية (/vendor/:id/staff، S18b) | ✅ DONE | - |
| SRS-H3A-04 | المخزون: مبيعات فرع، تعديلات، استيراد | التعديلات (خصم بسبب) موجودة؛ بيع فعلي بالباركود موجود الآن (`GET .../stock/lookup` + `POST .../movements` بسبب SALE، S18a) | 🟡 PARTIAL | S18 |
| SRS-H3A-05 | Checkout: quote بلا تعديل، ثم إنشاء ذري | `POST /checkout/quote`, `/reserve`, `/confirm` — يطابق المعنى وإن كان بثلاث خطوات لا خطوتين | ✅ DONE | - |
| SRS-H3A-06 | طلبات الفرع: GET orders، PATCH actions (بدء تحضير، رجوع، إلغاء صنف، إعادة محاولة توصيل، موافقة استرداد) | البدء/الإرسال/التسليم/الاستلام موجودة؛ **الرجوع (cancel)، إلغاء الصنف، إعادة محاولة التوصيل (mark-delivery-failed + إعادة جدولة العميل)، موافقة الاسترداد — الأربعة مبنية الآن** | ✅ DONE | - |
| SRS-H3A-07 | التقويم/العناوين: فترات، إعادة جدولة، تعديل عنوان قبل التحضير فقط | فترات التوصيل CRUD موجودة؛ **إعادة الجدولة مبنية الآن (قفل سعة حقيقي، نفس آلية الحجز)**؛ لا تعديل عنوان لطلب قائم | 🟡 PARTIAL | S22 |
| SRS-H3A-08 | المرتجعات/المراجعات/التنبيهات: طلب إرجاع، قرار، مراجعة، إشعارات بحالة قراءة | إشعارات بحالة قراءة مبنية بالكامل (S19)؛ طلب الإرجاع والقرار مبنيان بالكامل (S21) بواجهة مستخدم كاملة (جولة مراجعة 2026-10-10) - العميل (`/orders/:id/items/:id/return`، `/returns`، `/returns/:id`)، صاحب المتجر/الموظف (`/vendor/:id/branches/:b/returns`، `/vendor/:id/return-policy`، `/vendor/:id/returns/redeem`)، PLATFORM_ADMIN (`/admin/returns`)؛ **المراجعة (Review) مبنية الآن بالكامل أيضاً (S23، 2026-10-14)** - العميل (`/orders/:id/items/:id/review`، صفحة مراجعات المتجر)، PLATFORM_ADMIN (`/admin/reviews`) | ✅ DONE | S19/S21/S23 |

## §10 — Part 5: تجربة المستخدم وحالات الفشل

### K.1a — الشاشات المعتمدة أيلول 2026 (11 صفاً)

| ID | السطح | مطابقة | Status | Sprint |
|---|---|---|---|---|
| SRS-K1A-01 | الصفحة الرئيسية وصفحات القطاع (All/Women/Men/Kids/Accessories) | موجودة (S13)؛ فلاتر اللون/المقاس/التوفر/الحالة/الخصم غير كاملة | 🟡 PARTIAL | S18b |
| SRS-K1A-02 | البطاقة العالمية وعرض المقارنة | موجودة، بلا تقييم/مسافة لكسر التعادل | 🟡 PARTIAL | S18b |
| SRS-K1A-03 | صفحة المتجر العامة | موجودة كاملة تقريباً (S7/S13) | ✅ DONE | - |
| SRS-K1A-04 | أتابعه | موجودة (S13)؛ **الإشعارات المنفصلة مبنية الآن** (منتج/خصم جديد، S19) | ✅ DONE | - |
| SRS-K1A-05 | تفاصيل عرض المتجر | موجودة | ✅ DONE | - |
| SRS-K1A-06 | السلة والـcheckout | موجودة ومختبرة جيداً (S10/S14) | ✅ DONE | - |
| SRS-K1A-07 | طلبات العميل | موجودة؛ **إلغاء الطلب/الصنف، إعادة الجدولة، وطلب الاسترداد مبنية**؛ **طلب الإرجاع الفعلي للصنف مبني الآن أيضاً بواجهة كاملة** (جولة مراجعة 2026-10-10) - العميل يرسل/يتابع/يلغي/ينازع عبر (`/orders/:id/items/:id/return`، `/returns`، `/returns/:id`)؛ بلا جدول زمني موحّد يبقى (قرار بنيوي، BR-028) | 🟡 PARTIAL (جدول زمني موحّد فقط متبقٍ) | - |
| SRS-K1A-08 | مساحة عمل المالك | مركز روابط فقط، أغلب الشاشات الفرعية API-only | 🟡 PARTIAL | S15-S18 |
| SRS-K1A-09 | مساحة عمل الموظف | طلبات الفرع فقط؛ لا ماسح/بيع فعلي | 🟡 PARTIAL | S18 |
| SRS-K1A-10 | ماسح المخزون والاستيراد | الاستيراد له واجهة كاملة الآن (S17: `/vendor/:id/offers/import`)؛ ماسح المخزون (قراءة باركود بالكاميرا) لا يزال API فقط بلا واجهة | 🟡 PARTIAL | S18 |
| SRS-K1A-11 | مساحة عمل الأدمن | API فقط بلا واجهة | 🟡 PARTIAL | S16 |

### حالات Empty/Loading/Error وRTL/A11y (تجميعي بدل تفكيك ~50 شاشة)

| ID | البوابة | ملاحظة | Status | Sprint |
|---|---|---|---|---|
| SRS-K1-STATES-01 | العميل (ويب) | حالات فارغة/تحميل/خطأ أساسية موجودة في بعض الصفحات (سلة، طلبات)؛ لا نمط موحّد مؤكَّد لكل شاشة | 🟡 PARTIAL | BACKLOG-QUALITY (من S25) |
| SRS-K1-STATES-02 | مساحة المالك/الموظف | معظم الشاشات API-only فلا حالات UI أصلاً | ❌ MISSING | S15-S18 |
| SRS-K1-STATES-03 | الإدارة | شاشات S16 لها loading/empty/error/forbidden/success؛ عارض التدقيق وإدارة الأدوار لاحقاً | 🟡 PARTIAL | BACKLOG-QUALITY (من S25) |
| SRS-K1-STATES-04 | الدعم | لا واجهة إطلاقاً (FR-SUP مؤجّل بحسب الـSRS، ليس PDR) | ❌ MISSING | قرار-نطاق |

### L-01..L-32 — سيناريوهات الفشل (معرّفات أصلية من الـSRS)

| ID | الحالة (ملخّص) | الحالة الفعلية | Status | Sprint |
|---|---|---|---|---|
| L-01 | نفس المنتج بعنوانين مختلفين | يُربط بعد مراجعة (S6/S7) | ✅ DONE | - |
| L-02 | تطابق خاطئ يُبلَّغ عنه العميل | لا endpoint إبلاغ عميل | ❌ MISSING | S17b |
| L-03 | مواصفات متعارضة من بائعين | تعارض الاستيراد يذهب لمراجعة؛ لا سياسة مصدر-حقيقة لكل حقل | 🟡 PARTIAL | S17 |
| L-04 | منتج بلا باركود | يدخل مراجعة بشرية أو يبقى غير مطابق | ✅ DONE | - |
| L-05 | منتج يدوي فريد | يُنشر كعرض غير مطابق، قابل للبحث والشراء | ✅ DONE (عبر صفحة المتجر) | - |
| L-06 | نسخة مستعملة/جديدة من نفس الموديل | `condition` موجود على OfferVariant؛ لا فلتر حالة في المقارنة | 🟡 PARTIAL | S24 |
| L-07 | حزمة مقابل منتج فردي | لا `product_type` على المنتج الأساسي | ❌ MISSING | S17b |
| L-08 | وحدات/أحجام تعبئة مختلفة | يُعامَل كـ variant منفصل عبر الآلية القياسية | ✅ DONE | - |
| L-09 | سعر قديم | لا علم تقادم، لا رسالة "قد يكون قديماً" | ❌ MISSING | S17 |
| L-10 | مخزون قديم | علم تقادم (is_stale، S18a) موجود الآن؛ إعادة التحقق عند checkout موجودة | ✅ DONE | - |
| L-11 | نفاد أثناء checkout | مغطى بالكامل (خصم ذري + رسالة إزالة/استبدال) | ✅ DONE | - |
| L-12 | بائع يغلق بعد إرسال الطلب | تجاوز PLATFORM_ADMIN (BR-019) يُغلق الطلب قسراً — COD يُلغى، إلكتروني يُسترد بالكامل ضمن نفس المعاملة | ✅ DONE | - |
| L-13 | رفض جزئي في طلب متعدد البائعين | إلغاء/رفض لكل BranchOrder مستقل أصبح موجوداً الآن (عميل/موظف/أدمن)؛ **لا تجميع "PartiallyCancelled" على مستوى CustomerOrder** — قرار بنيوي متعمَّد (BR-028: الأب لا يحمل حالة أبداً)، وليس فجوة S20a | 🟡 PARTIAL | - |
| L-14 | دفع نجح والطلب فشل | rollback الذري يمنع الحالة أصلاً في التصميم الحالي؛ لا job تسوية منفصل مطلوب لأن السيناريو لا يحدث بنفس الشكل القديم | ✅ DONE (بالتصميم) | - |
| L-15 | طلب أُنشئ والدفع فشل | مغطى تماماً: PAYMENT_FAILED يتراجع بالكامل، الحجز يبقى حياً للمحاولة مجدداً | ✅ DONE | - |
| L-16 | إشعار فشل | **نموذج Notification مبني بالكامل الآن** (S19) ويمكن أن يحمل أي نوع إشعار مستقبلاً، لكن لا نوع "فشل" تقني محدد (دفع/webhook) مبني فعلياً بعد — الأنواع الإحدى عشر المبنية كلها إيجابية التدفق (طلب جديد، تذكير، تفعيل خصم...)، لا فشل | 🟡 PARTIAL | S19 |
| L-17 | webhook مكرر | لا webhooks واردة أصلاً | ❌ MISSING | قرار-نطاق |
| L-18 | تكرار إرسال checkout | idempotency key يعيد نفس الطلب | ✅ DONE | - |
| L-19 | استرداد جزئي | مبني: استرداد الإرجاع هو استرداد جزئي بطبيعته (لكل صنف، لا الطلب كاملاً) - `max(0, سعر الصنف − رسم الإرجاع)`، ONLINE/COD بسجلّين منفصلين | ✅ DONE | - |
| L-20 | توصيل مجزأ | لا شحنات متعددة لكل BranchOrder | ❌ MISSING | S26/قرار-نطاق |
| L-21 | عنوان توصيل غير صالح | تحقق العنوان موجود (S14)؛ لا خريطة (قرار معتمد) | ✅ DONE (ضمن القرار المعتمد) | - |
| L-22 | العميل خارج منطقة خدمة البائع | يتحول لاستلام فقط تلقائياً برسالة واضحة | ✅ DONE | - |
| L-23 | بائع مُعلَّق بطلبات نشطة | التعليق يُخفي المتجر ويمنع الطلبات الجديدة (بما فيها confirm لحجز قائم) وتعديل الكتالوج؛ الطلبات الجارية تستمر؛ تصنيف صريح لكل مسار vendors/:vendorId/* ويفشل اختبار على أي مسار غير مصنَّف | ✅ DONE | - |
| L-24 | دمج منتج بعد وجود طلبات تاريخية | لا دمج/فصل منتجات مبني | ❌ MISSING | S17b |
| L-25 | فشل استيراد جزئي | نجاح جزئي مع تقرير أخطاء لكل صف موجود | ✅ DONE | - |
| L-26 | نقص محتوى بلغة واحدة | لا fallback مؤشَّر بصرياً؛ الحقول ثنائية اللغة موجودة لكن العرض عربي فقط حالياً | 🟡 PARTIAL | S22 |
| L-27 | صورة مفقودة/غير لائقة | لا placeholder موحّد مؤكَّد؛ لا طابور إشراف صور | ❌ MISSING | S17b |
| L-28 | إدخال ضار (حقن) | `ValidationPipe` عام + Prisma يمنع حقن SQL بالتصميم؛ لم أتحقق من تعقيم كل حقل نصي حر للعرض | 🟡 PARTIAL | BACKLOG-QUALITY (من S25) |
| L-29 | تلاعب بالمراجعات | مراجعات مبنية الآن (S23) مع أهلية شراء موثّق + فريدية (منتج/متجر لكل عنصر طلب) + بلاغات العملاء وحسم PLATFORM_ADMIN - لكن **لا رصد آلي لأنماط شاذة (FR-REV-007/010)، خارج النطاق عمداً (قرارك النهائي رقم 3)** | 🟡 PARTIAL (الأساسيات مبنية، الرصد الآلي غائب عمداً) | S24+ |
| L-30 | انقطاع منصة/تكامل | لا مراقبة حالة/تكامل معروضة | ❌ MISSING | BACKLOG-QUALITY (من S25) |
| L-31 | طلب متعدد العملات | استُبدل: PDR-001 يزيل تعدد العملات كلياً | ↪ SUPERSEDED | - |
| L-32 | webhook خارج الترتيب/مرجع مجهول | لا webhooks واردة أصلاً | ❌ MISSING | قرار-نطاق |

## §11 — Part 6: المعمارية والتطابق والاختبار والتشغيل

### ADR-001..012 (قرارات معمارية، Section M)

| ID | القرار | مطابقة الكود الفعلي | Status |
|---|---|---|---|
| ADR-001 | monolith معياري لا microservices | NestJS تطبيق واحد بوحدات (auth, cart, checkout, ...) | ✅ DONE |
| ADR-002 | NestJS+TypeScript للخلفية | مطابق | ✅ DONE |
| ADR-003 | PostgreSQL+PostGIS | Postgres مستخدَم؛ **PostGIS لم يُستخدم فعلياً** (لا استعلامات مسافة حقيقية، BR-029/PDR-023 بديل حتمي بلا PostGIS) | 🟡 PARTIAL |
| ADR-004 | Next.js SSR + Capacitor بدل Flutter | Next.js موجود؛ **لا Capacitor ولا بناء موبايل إطلاقاً** | 🟡 PARTIAL |
| ADR-005 | Postgres FTS الآن، Meilisearch لاحقاً | البحث الفعلي `contains`/ILIKE بسيط، ليس حتى `tsvector`/`pg_trgm` الموصوف | 🟡 PARTIAL |
| ADR-006 | Outbox معاملاتي بدل enqueue داخل معاملة | `OutboxEvent` يُكتب ضمن نفس المعاملة (DONE)؛ **لا relay worker يقرأه فعلياً** — الصفوف تتراكم بلا معالجة | 🟡 PARTIAL |
| ADR-007 | نموذج أربعة مستويات للـcolor/size | مطابق تماماً في السكيما | ✅ DONE |
| ADR-008 | Fulfillment لكل suborder لا لكل طلب | لا Fulfillment منفصل؛ مدموج في BranchOrder (كافٍ عملياً بلا split shipment) | 🟡 PARTIAL |
| ADR-009 | PaymentAllocation + PaymentTransactionAllocation | غير موجودين؛ استُبدلا بتبسيط PaymentTransaction واحد + BranchOrder.paymentTransactionId (كافٍ لنطاق PDR-005) | ✅ DONE (بالتبسيط المعتمد) |
| ADR-010 | بوابة AwaitingPayment قبل ظهور الطلب للبائع | **غير مبنية** — في التصميم الفعلي BranchOrder يُنشأ فقط بعد نجاح الدفع (لا حالة AwaitingPayment وسيطة)، وهو حل مختلف يحقق نفس الهدف (البائع لا يرى شيئاً حتى ينجح الدفع) دون حالة صريحة | ✅ DONE (بمقاربة بديلة تحقق نفس الضمان) |
| ADR-011 | عزل بيانات البائع على مستوى الاستعلام؛ RLS لاحقاً | `vendor_id` على كل جدول مملوك للبائع + VendorMembershipGuard | ✅ DONE |
| ADR-012 | لا بوابة API منفصلة | NestJS نفسه يتولى كل شيء | ✅ DONE |

### N.1..N.5 — استراتيجية التطابق (5 ادعاءات قابلة للفحص)

| ID | الادعاء | الحالة الفعلية | Status | Sprint |
|---|---|---|---|---|
| SRS-N-01 | أوزان الثقة: علامة+موديل 40%، تشابه عنوان 30%، خصائص 20%، صورة 10% (مؤجلة) | لم أتحقق من صيغة حساب `score` الفعلية في `MatchReviewCandidate` مقابل هذه الأوزان الدقيقة | 🟡 PARTIAL | S17b |
| SRS-N-02 | عتبات المراجعة: ≥0.85 "محتمل" لكن يُراجَع دائماً؛ 0.5-0.85 بلا تفضيل؛ <0.5 لا يُعرض كمرشح | لم أتحقق من وجود هذه العتبات حرفياً في الكود | 🟡 PARTIAL | S17b |
| SRS-N-03 | استبعاد تشابه السعر من درجة الثقة | متسق مع عدم وجود أي منطق سعر في match-review الذي رأيته | ✅ DONE (بالغياب المتسق) | - |
| SRS-N-04 | منع تلقائي: مستعمل مقابل جديد، وحزمة مقابل مكوّن فردي | لا `condition`/`product_type` تُستخدَم كحاجز صريح في منطق المطابقة الذي رأيته | ❌ MISSING | S17b |
| SRS-N-05 | تقييم جودة البيانات (اكتمال، شذوذ سعر) كإرشاد لا بوابة نشر | لا تسجيل اكتمال أو شذوذ سعر موجود | ❌ MISSING | BACKLOG-QUALITY (من S25) |

### O.1 — مستويات الاختبار (تصنيف لا متطلب مستقل)

| المستوى | التغطية الفعلية |
|---|---|
| Unit | موجودة بكثافة (156 اختبار، 20 suite) |
| Integration | e2e الحالي يغطي هذا فعلياً (نفس نطاق النستجي) |
| API contract | جزئي — لا اختبار عقد منفصل عن e2e السلوكي |
| E2E | موجود وقوي (411 اختبار) |
| Security | BOLA/tenant-isolation مختبر في عدة أماكن (Sprint 4، الاشتراك، إلخ)؛ لا فحص OWASP رسمي منفصل |
| Performance | ❌ غير موجود |
| Accessibility | ❌ غير موجود كاختبار آلي |
| Localization/RTL | تحقق بصري بلقطات شاشة فقط، لا اختبار آلي |
| Payment | مغطى جيداً لمسار sandbox الفعلي |
| Webhook | ❌ غير منطبق (لا webhooks واردة) |
| Search quality | ❌ غير موجود |
| Product-matching | جزئي (مطابقة دقيقة/مراجعة مختبرة، عتبات/أوزان غير مؤكدة) |
| Import | مختبر جزئياً (تعارضات، partial success) |
| Multi-vendor checkout | مختبر جيداً (بمصطلح BranchOrder بدل VendorSuborder) |
| Disaster recovery | ❌ غير موجود |
| UAT | ❌ غير رسمي |

### O.2 — `TC-*` (40 معرّفاً): جدول ربط لا بحث مستقل

كل `TC-*` يفحص نفس الـID أعلاه بنفس ملفات الاختبار المذكورة في عمود Test لذلك الصف. جدول الربط الكامل موجود في نسخة العمل الداخلية؛ الخلاصة: من أصل 40، حوالي 24 تختبر قدرات BranchOrder/checkout/دفع/مخزون DONE فعلاً (بأسماء حالة مختلفة عن النص الأصلي: BranchOrder بدل VendorSuborder، PaymentTransaction بدل Payment/PaymentAllocation)، و~10 تختبر قدرات MISSING بالكامل (TC-RET-*, TC-PAY-004 استرداد جزئي)، والباقي غير قابل للتطبيق لأنه يفترض بنية استُبدلت (TC-PAY-006 عن OPEN-007 المُغلق بتبسيط أحادي العملة، TC-COMP-001 عن عملات متعددة).

### P — عمليات DevOps (15 مجالاً)

| ID | المجال | الحالة الفعلية | Status | Sprint |
|---|---|---|---|---|
| SRS-P-01 | بيئات Dev/Staging/Prod | Dev فقط عبر Docker محلي؛ لا Staging ولا Production فعلي | ❌ MISSING | قرار-نطاق |
| SRS-P-02 | CI/CD عبر GitHub Actions | CI موجود فعلياً (يُشغَّل عند push، يُذكر CI أخضر/أحمر في المحادثات)؛ لا نشر تلقائي لـStaging | 🟡 PARTIAL | قرار-نطاق |
| SRS-P-03 | هجرات نسخية إضافية أولاً | مطابق تماماً — كل الهجرات هنا إضافية وآمنة (قاعدة صارمة مطبَّقة طوال المشروع) | ✅ DONE | - |
| SRS-P-04 | Feature flags | **مبني (S25، FR-ADMIN-004)** | ✅ DONE | - |
| SRS-P-05 | إدارة أسرار عبر مخزن مُدار | ملف `.env` محلي غير مُدار؛ لا مخزن أسرار سحابي | ❌ MISSING | قرار-نطاق |
| SRS-P-06 | مراقبة/لوغ/تتبع (Sentry، correlation ID) | correlation ID DONE في كل مكان؛ Sentry مُهيَّأ اختيارياً (`if SENTRY_DSN`) لكن غير مفعَّل فعلياً في dev | 🟡 PARTIAL | قرار-نطاق |
| SRS-P-07 | تنبيهات على معدل الأخطاء وعمق الطابور | **طابور حقيقي أصبح موجوداً الآن** (outbox relay، S19) لكن لا تنبيهات على معدل الأخطاء أو عمق الطابور — لا مراقبة/alerting مبني إطلاقاً | ❌ MISSING | S19 |
| SRS-P-08 | نسخ احتياطي كل ساعة | لا | ❌ MISSING | قرار-نطاق |
| SRS-P-09 | خطة تعافي من كوارث | لا | ❌ MISSING | قرار-نطاق |
| SRS-P-10 | مهام مجدولة (تقادم، FX، اشتراك، تسوية webhook) | **آلية مهام مجدولة حقيقية أصبحت موجودة لأول مرة في هذا المستودع** (`PeriodicTask`، S19) — تُستخدم لـrelay الإشعارات وsweep التذكيرات والخصومات المجدولة فقط؛ تقادم الأسعار وFX والاشتراك وتسوية webhook لم تُبنَ بعد بهذه الآلية | 🟡 PARTIAL | S19 |
| SRS-P-11 | إعادة فهرسة بحث | غير منطبق حالياً (لا Meilisearch)، ولا حتى Postgres FTS حقيقي مستخدَم | ❌ MISSING | S18b |
| SRS-P-12 | معالجة jobs فاشلة (dead-letter) | **dead-letter خاص بـoutbox مبني ومختبر الآن** (S19) — ليس نظام طابور jobs عاماً (لا BullMQ، لا نوع job آخر يستخدمه) | 🟡 PARTIAL | S19 |
| SRS-P-13 | إعادة تشغيل webhook | لا webhooks واردة | ❌ MISSING | قرار-نطاق |
| SRS-P-14 | أدلة تشغيل للحالات الحرجة | لا يوجد | ❌ MISSING | قرار-نطاق |
| SRS-P-15 | تصحيح بيانات عبر إجراء مدقَّق لا تعديل مباشر | لا واجهة تصحيح بيانات إدارية؛ أي تصحيح فعلي يتم عبر سكربتات/قاعدة مباشرة (خارج AuditLog) | ❌ MISSING | BACKLOG-QUALITY (من S25) |

## §12 — Part 7: القرارات (BDR القديمة فقط؛ ADR مغطاة في §11، BDR-016+ = PDR أعلاه)

| ID | القرار | مطابقة اليوم | Status |
|---|---|---|---|
| BDR-001 | checkout متعدد البائعين من اليوم الأول | استُبدل تنفيذياً بتجميع على مستوى الفرع (PDR-004) بدل البائع، لكن الجوهر (سلة متعددة الأطراف بمعاملة واحدة) محقَّق | ✅ DONE (بالمفهوم البديل المعتمد) |
| BDR-002 | CustomerOrder أب + VendorSuborder لكل بائع | استُبدل بـBranchOrder (PDR-004) | ↪ SUPERSEDED |
| BDR-003 | COD ودفع إلكتروني كلاهما من الإطلاق | DONE | ✅ DONE |
| BDR-004 | توصيل بائع/استلام + قاعدة الإشعار الثلاثي | التوصيل/الاستلام DONE؛ الإشعار الثلاثي MISSING (outbox فقط) | 🟡 PARTIAL |
| BDR-005 | اعتماد تلقائي للمطابقة الدقيقة فقط | فعلياً حتى المطابقة الدقيقة تمر بتأكيد المالك الآن (FR-MATCH-012) — أشد تحفظاً من النص الأصلي، وهذا اختيار هندسي وليس قراراً معتمداً صراحة بذلك | 🟡 PARTIAL |
| BDR-006 | استيراد يدوي/CSV/API فقط، لا scraping | يدوي/CSV DONE؛ API ingestion غير موجود؛ لا scraping (متوافق) | 🟡 PARTIAL |
| BDR-007 | عملة لكل بائع | استُبدل: ILS فقط الآن (PDR-001) | ↪ SUPERSEDED |
| BDR-008 | انتشار وطني + تحقق فرع فعلي بدبوس وصورة | التحقق DONE (API)؛ الانتشار الوطني غير قابل للقياس في FYP | 🟡 PARTIAL |
| BDR-009 | ويب + Android + iOS من الإطلاق | ويب فقط؛ لا Capacitor ولا بناء موبايل | ❌ MISSING (جزئياً — الويب فقط) |
| BDR-010 | اشتراك شهري بدل عمولة | DONE (PDR-033 يفصّله) | ✅ DONE |
| BDR-011 | معيار قانوني/خصوصية عام محافظ | لا سياسة احتفاظ/خصوصية مفروضة فعلياً في الكود | 🟡 PARTIAL |
| BDR-012 | هاتف+كلمة مرور+OTP | DONE | ✅ DONE |
| BDR-013 | لا checkout كضيف | DONE (يتطلب حساباً) | ✅ DONE |
| BDR-014 | فريق شخصين، 3 أشهر | حقيقة تنظيمية، لا تُقاس بالكود | n/a |
| BDR-015 | اعتماد نطاق FYP Delivery Increment | معتمد (تاريخياً)؛ استُبدل عملياً بخطة post-sprint3-replan للسبرنتات 4+ | ↪ SUPERSEDED (بخطة أحدث معتمدة) |
| BDR-016 (قديم) | رفض فرع واحد يرفض كل الطلب | نفس BR-026 أعلاه | ✅ DONE (انظر BR-026) |

## §13 — Part 8: البقلغ (Backlog) — mapping صريح لكل معرّف

Part 8 يحتوي فعلياً **102 معرّف `BL-*`** (عددتها مباشرة من نص المصدر، لا التقدير السابق ~112). كل واحد منها يصف قدرة سبق بناء (Sprint 1-3، مغطاة عبر `sprint-1-3-compatibility-audit-2026-09.md`) أو قدرة استُبدلت رسمياً بخطة `post-sprint3-replan-2026-09.md` (المتحوّلة إلى Sprint 15-26 في خارطة الطريق §5). بدل صف تجميعي واحد، الجدول التالي يربط كل معرّف بالـID القانوني الذي يرث حالته (من نفس الجداول أعلاه)، مع أولوية Part 8 الأصلية (Must/Should/Could/Won't) للسياق فقط — لا تُستخدم لتغيير الحالة أو الجدولة.

| Part-8 ID | Priority (Part 8) | Canonical ID it inherits from | Inherited status | Note |
|---|---|---|---|---|
| BL-FOUND-001 | Must | SRS-P-02 | 🟡 PARTIAL | - |
| BL-FOUND-002 | Must | SRS-P-03 | ✅ DONE | - |
| BL-FOUND-003 | Must | SRS-H1-02 | ✅ DONE | - |
| BL-FOUND-004 | Must | SRS-P-06 | 🟡 PARTIAL | - |
| BL-FOUND-005 | Must | ADR-006 | 🟡 PARTIAL | AuditLog/OutboxEvent tables exist |
| BL-AUTH-001 | Must | FR-AUTH-001 | ✅ DONE | - |
| BL-AUTH-002 | Must | FR-AUTH-002 | ✅ DONE | - |
| BL-AUTH-003 | Must | FR-AUTH-005 | ✅ DONE | - |
| BL-AUTH-004 | Must | FR-AUTH-008 | ✅ DONE | S22: AddressForm موحَّد (إنشاء/تعديل)، لا يزال منسوخاً في checkout أيضاً لكن هذا لا يمنع DONE |
| BL-AUTH-004b | Should | FR-AUTH-008 | ✅ DONE | S22: شاشة /account/addresses منفصلة بتعديل/حذف/افتراضي كاملة |
| BL-AUTH-005 | Must | FR-AUTH-011 | ✅ DONE | - |
| BL-CAT-001 | Must | FR-CAT-001 | 🟡 PARTIAL | - |
| BL-CAT-002 | Should | FR-CAT-002 | 🟡 PARTIAL | - |
| BL-CAT-003 | Should | FR-CAT-012 | ❌ MISSING | - |
| BL-CAT-004 | Should | FR-CAT-003 | ❌ MISSING | - |
| BL-CAT-004b | Must | FR-CAT-015 (E.0) | ✅ DONE | S17: بوابة النشر + قوالب PDR-036 مبنية بالكامل؛ specs_text يبقى حراً للفئات خارج العشرة بالتصميم (PDR-036 D2)، وهذا متوافق مع القرار المعتمد لا نقصاً |
| BL-MATCH-001 | Must | FR-MATCH-008 | ✅ DONE | - |
| BL-MATCH-002 | Must | FR-MATCH-002 | 🟡 PARTIAL | - |
| BL-MATCH-003 | Must | FR-MATCH-003 | ✅ DONE | S17-owner-matching-ui: طابور المراجعة غير الدقيق الآن UI حقيقية |
| BL-MATCH-003b | Should | FR-MATCH-003 | ✅ DONE | S17-owner-matching-ui: تحسين الواجهة الذي كانت هذه الصف تنتظره مبني الآن |
| BL-MATCH-004 | Should | FR-MATCH-005 | ❌ MISSING | - |
| BL-MATCH-005 | Must | FR-MATCH-007 | 🟡 PARTIAL | اختبارات منع تلقائي — انظر N.1..5 |
| BL-VEND-001 | Must | FR-VEND-001 | 🟡 PARTIAL | - |
| BL-VEND-002 | Must | FR-VEND-002 | 🟡 PARTIAL | - |
| BL-VEND-003 | Must | FR-VEND-003 | ✅ DONE | - |
| BL-VEND-004 | Must | FR-VEND-004 | 🟡 PARTIAL | - |
| BL-VEND-005 | Should | FR-VEND-013 (E.0) | 🟡 PARTIAL | أدوار فرعية متعددة — استُبدل بنموذج OWNER/BRANCH_EMPLOYEE الأبسط |
| BL-VEND-005b | Must | FR-VEND-013 (E.0) | 🟡 PARTIAL | حساب مالك واحد بلا أدوار فرعية — هذا فعلاً المبني |
| BL-VEND-006 | Should | FR-VEND-009 | ✅ DONE | اختبارات التعليق واختبار تصنيف المسارات (S16) |
| BL-IMPORT-001 | Must | FR-IMPORT-001 | ✅ DONE | S17: PriceHistory موجود الآن؛ نموذج الإنشاء مبني |
| BL-IMPORT-002 | Must | FR-IMPORT-002 | 🟡 PARTIAL | S17: PriceHistory موجود الآن؛ يبقى الناقص هو FR-IMPORT-002 نفسه (لا dry-run/معاينة قبل الحفظ) |
| BL-IMPORT-002b | Should | FR-IMPORT-011 | ❌ MISSING | - |
| BL-IMPORT-003 | Should | FR-IMPORT-012 | ✅ DONE | S17: failed_rows_csv |
| BL-IMPORT-004 | Must | FR-IMPORT-003 | ✅ DONE | S17: تقرير كامل في الواجهة |
| BL-SEARCH-001 | Must | FR-SEARCH-001 | 🟡 PARTIAL | - |
| BL-SEARCH-002 | Must | FR-SEARCH-002 | ❌ MISSING | - |
| BL-SEARCH-002b | Should | FR-SEARCH-002 | ❌ MISSING | - |
| BL-SEARCH-003 | Must | FR-SEARCH-005 | 🟡 PARTIAL | - |
| BL-SEARCH-004 | Should | FR-SEARCH-010 | ❌ MISSING | - |
| BL-COMP-001 | Must | FR-COMP-001 | ✅ DONE | S24 |
| BL-COMP-002 | Must | FR-COMP-005 | 🟡 PARTIAL | S24 |
| BL-COMP-003 | Must | FR-COMP-009 | ↪ SUPERSEDED | استُبدل: PDR-001 يزيل FX كلياً |
| BL-COMP-004 | Should | FR-COMP-007 | ✅ DONE | S24 |
| BL-INV-001 | Must | FR-INV-001 | ✅ DONE | - |
| BL-INV-002 | Must | FR-INV-004 | ✅ DONE | - |
| BL-INV-003 | Should | FR-INV-006 | ✅ DONE | - |
| BL-INV-004 | Should | FR-INV-003 | ✅ DONE | الحجز 10 دقائق — هذا فعلاً موجود ومختبر (DONE)، أعلى مما كان مخططاً كـShould هنا |
| BL-CART-001 | Must | FR-CART-017 (E.0) | ✅ DONE | استُبدل: التقسيم بالفرع الآن (PDR-004) لا بالبائع |
| BL-CART-002 | Must | FR-CART-003 | ❌ MISSING | - |
| BL-CART-003 | Must | FR-CART-005 | ↪ SUPERSEDED | استُبدل: الاختيار الآن جزء من BranchOrder (PDR-004) |
| BL-CART-003b | Should | FR-CART-013 | ✅ DONE | - |
| BL-CHECKOUT-001 | Must | FR-CART-006 | 🟡 PARTIAL | - |
| BL-CHECKOUT-002 | Must | FR-CART-008 | ✅ DONE | - |
| BL-CHECKOUT-003 | Must | ADR-010 | ✅ DONE | - |
| BL-CHECKOUT-004 | Must | FR-CART-016 | ✅ DONE | - |
| BL-ORD-001 | Must | FR-ORD-009 (E.0) | ✅ DONE | استُبدل: BranchOrderStatus لا VendorSuborder — انظر §15 |
| BL-ORD-002 | Must | FR-ORD-007 | ✅ DONE | - |
| BL-ORD-003 | Must | FR-ORD-005 | 🟡 PARTIAL | - |
| BL-ORD-004 | Must | FR-ORD-003 | ✅ DONE | - |
| BL-PAY-001 | Must | FR-PAY-001 | ✅ DONE | - |
| BL-PAY-002 | Must | FR-PAY-002 | ✅ DONE | - |
| BL-PAY-003 | Must | FR-PAY-003 | 🟡 PARTIAL | استُبدل: PaymentAllocation غير موجود، تبسيط PaymentTransaction بدلاً منه |
| BL-PAY-004 | Must | SRS-P-10 | ❌ MISSING | لا relay worker حقيقي |
| BL-PAY-005 | Should | FR-PAY-004 | ✅ DONE | - |
| BL-FUL-001 | Must | SRS-E11-DL-01 | ✅ DONE | استُبدل: لا Delivery منفصل، مدموج في BranchOrder |
| BL-FUL-002 | Must | FR-FUL-008 (E.0) | ✅ DONE | - |
| BL-FUL-003 | Must | FR-FUL-003 | 🟡 PARTIAL | - |
| BL-FUL-004 | Should | FR-FUL-004 | ✅ DONE | - |
| BL-FUL-004b | Should | PDR-023 | 🟡 PARTIAL | - |
| BL-RET-001 | Should | FR-RET-002 | ✅ DONE (S21) | - |
| BL-RET-002 | Should | BR-025 | ✅ DONE (S21) | - |
| BL-RET-003 | Should | FR-RET-003 | ✅ DONE (S21) | - |
| BL-REV-001 | Must | FR-REV-001 | ❌ MISSING | الأولوية الأصلية Must — لم يُبنَ إطلاقاً، فجوة حقيقية مقابل الالتزام الأصلي |
| BL-REV-002 | Must | FR-REV-002 | ❌ MISSING | نفس الملاحظة أعلاه |
| BL-REV-003 | Could | FR-REV-004 | ⏸ DEFERRED | - |
| BL-NOTIF-001 | Must | SRS-H1-08 | ❌ MISSING | - |
| BL-NOTIF-002 | Must | FR-NOTIF-003 | ❌ MISSING | - |
| BL-NOTIF-002b | Should | FR-NOTIF-003 | ❌ MISSING | - |
| BL-NOTIF-003 | Should | FR-FAV-001 | ✅ DONE | S24 |
| BL-NOTIF-004 | Could | FR-FAV-003 | ✅ DONE | S24 |
| BL-ADMIN-001 | Must | FR-VEND-009 | ✅ DONE | قائمة المتاجر وتعليق/إعادة تفعيل وطابور الموافقة مبنية (S16) |
| BL-ADMIN-001b | Should | FR-ADMIN-001 | 🟡 PARTIAL | - |
| BL-ADMIN-002 | Must | FR-ADMIN-001 | 🟡 PARTIAL | - |
| BL-ADMIN-003 | Should | FR-ADMIN-005 | ✅ DONE | S25 |
| BL-ADMIN-004 | Should | FR-CMS-001 | ❌ MISSING | - |
| BL-VPORTAL-001 | Must | FR-VPORTAL-001 | 🟡 PARTIAL | - |
| BL-VPORTAL-002 | Must | FR-VPORTAL-011 | ❌ MISSING | - |
| BL-VPORTAL-003 | Should | FR-VPORTAL-006 | 🟡 PARTIAL | - |
| BL-ANALYTICS-001 | Should | FR-ANALYTICS-006 | ❌ MISSING | - |
| BL-ANALYTICS-002 | Could | FR-ANALYTICS-002 | ❌ MISSING | - |
| BL-SEC-001 | Must | BR-002 | ✅ DONE | BOLA — مغطى فعلاً بكثافة |
| BL-SEC-002 | Must | SRS-H1-06 | ❌ MISSING | لا webhooks واردة أصلاً |
| BL-SEC-003 | Must | FR-AUTH-011 | ✅ DONE | - |
| BL-SEC-004 | Should | SRS-P-14 | ❌ MISSING | - |
| BL-PERF-001 | Should | NFR-PERF-001 | ❌ MISSING | - |
| BL-DEPLOY-001 | Must | SRS-P-01 | ❌ MISSING | - |
| BL-DEPLOY-002 | Should | NFR-BACKUP-001 | ❌ MISSING | - |
| BL-OPS-001 | Should | SRS-P-14 | ❌ MISSING | - |
| BL-OPS-002 | Must | — | ❌ MISSING | نشاط تشغيلي مستمر، ليس بناء كود |
| BL-OPS-003 | Must | — | ❌ MISSING | نشاط تشغيلي مستمر، ليس بناء كود |
| BL-OPS-004 | Must | — | ❌ MISSING | بروفة عرض — لم تُجرَ بهذا الشكل |
| BL-SUP-001 | Won't (FYP) | FR-SUP-001 | ⏸ DEFERRED | قرار موثَّق فعلاً، وما زال المطلوب MISSING |

**عدّاد Part 8:** 102 صفاً. DONE=21، PARTIAL=40، MISSING=37، SUPERSEDED=2 (BL-COMP-003، BL-CART-003 — كلاهما وُصِف بنموذج استُبدل صراحة بقرار PDR)، DEFERRED=2 (BL-REV-003 مؤجَّل Could/Full MVP أصلاً في Part 8 نفسه؛ BL-SUP-001 قرار موثَّق بالفعل من المالك في 2026-09-16 حسب Part 8 نفسه — لكن ملاحظة أمانة: القرار التوثيقي لا يعني أن القدرة (`FR-SUP-*`) موجودة، وهي MISSING في الجدول الرئيسي أعلاه كما هي). المجموع 21+40+37+2+2=102.

**ملاحظة على فجوتين حقيقيتين كشفهما هذا الـmapping:** `BL-REV-001`/`BL-REV-002` كانا **Must** في التزام Part 8 الأصلي (نسخة مصغّرة من المراجعات) ولم يُبنيا إطلاقاً — فجوة مقابل التزام تاريخي فعلي، وليس فقط مقابل الـSRS الأصلي. كذلك `BL-ADMIN-001` (شاشة موافقة/تعليق بائع بسيطة) كان Must مصغَّر عمداً ليكون قابلاً للتنفيذ، ولم يُبنَ إطلاقاً. كلاهما مسجَّل MISSING بالفعل ضمن `FR-REV-*`/`FR-VEND-009` في الجداول الرئيسية، لا حاجة لتغيير جديد.

## §14 — Part 9: القبول والتتبع والتوصيات

### AC-01..22 (تغطية خفيفة — ترث حالة الـID المختبَر)

| ID | يختبر | الحالة الموروثة |
|---|---|---|
| AC-01 | FR-CART-006/011 (checkout عبر بائعين، COD) | ✅ DONE (بمفهوم BranchOrder) |
| AC-02 | BR-006/FR-CART-004 (منطقة توصيل) | ✅ DONE |
| AC-03 | BOLA بين البائعين | ✅ DONE (مختبر في عدة أماكن) |
| AC-04 | حالة فارغة لسجل الطلبات | 🟡 PARTIAL |
| AC-05 | فشل توقيع webhook | ❌ MISSING (لا webhooks) |
| AC-06 | تكرار طلب checkout | ✅ DONE |
| AC-07 | تزامن خصم المخزون | ✅ DONE |
| AC-08 | تدقيق قرار مطابقة | 🟡 PARTIAL |
| AC-09 | RTL في جدول المقارنة | 🟡 PARTIAL |
| AC-10 | بوابة AwaitingPayment: نجاح الدفع | ✅ DONE (بمقاربة بديلة، انظر ADR-010) |
| AC-11 | بوابة AwaitingPayment: فشل الدفع | ✅ DONE (بمقاربة بديلة، انظر ADR-010) |
| AC-12 | إرجاع صنف مسلَّم من شحنة مجزأة | الإرجاع نفسه مبني (S21)، لكن "شحنة مجزأة" (split shipment) غير قابلة للحدوث - FR-FUL-007 مؤجَّل بقرار معتمد (انظر BR-025) | 🟡 PARTIAL (الإرجاع مبني، السيناريو الحرفي غير منطبق) |
| AC-13 | رفض إرجاع صنف لم يُسلَّم بعد | مبني بالضبط: `checkReturnEligibility()` يرفض بـ`NOT_YET_ARRIVED` قبل التسليم/الاستلام | ✅ DONE (S21) |
| AC-14 | بائع مُعلَّق يحتفظ بوصول محدود | ❌ MISSING (لا تعليق مبني) |
| AC-15 | ازدواجية webhook | ❌ MISSING (لا webhooks) |
| AC-16 | فشل durability لـwebhook | ❌ MISSING (لا webhooks) |
| AC-17 | تعافي outbox relay | ❌ MISSING (لا relay) |
| AC-18 | تشكيل BranchOrder من سطور مختارة | ✅ DONE |
| AC-19 | least privilege موظف/مالك | ✅ DONE |
| AC-20 | رفض قيمة غير ILS | ✅ DONE |
| AC-21 | حركة مخزون وتنبيه | 🟡 PARTIAL (التنبيه outbox فقط) |
| AC-22 | خصوصية متجر إلكتروني فقط | لم أتحقق مباشرة؛ الأرجح 🟡 PARTIAL |

### BO-1..8، مصفوفة الوحدات، والتوصيات الاثنتا عشرة

**لم تُفكَّك.** هذه ملخصات إستراتيجية تُشتق مباشرة من صفوف `FR-*`/`PDR-*`/`BDR-*` أعلاه، وليست متطلبات مستقلة. أبرز ما تكشفه المطابقة معها: **الفجوتان اللتان حدَّدهما Part 9 بنفسه** (`FR-SUP` بلا backlog، و`PriceHistory` بلا اختبار مسمّى) — `FR-SUP` كله لا يزال MISSING (قرار-نطاق)، أما `PriceHistory` كنموذج بيانات فأصبح ✅ DONE (S17: سجلّ إضافة فقط + تعبئة أولية MIGRATED_BASELINE + شاشة سجلّ أسعار على صفحة المتغيّر)، مع اختبار مسمّى (`sprint17-owner-catalog.e2e-spec.ts` وscratch-DB migration-backfill spec) — هذه الفجوة أُغلقت فعلياً، لا توثيقياً فقط.

## §15 — E.11 آلات الحالة القديمة: صفوف بمعرّفات ثابتة

**ملاحظة جوهرية قبل الجدول:** آلات E.11 (`CustomerOrder`/`VendorSuborder`/`OrderItem`/`Payment`/`Delivery`) تصف **النموذج الذي سبق PDR-004/PDR-005** (تحقّقت من الكود: لا حقل `status` على `CustomerOrder` إطلاقاً، لا تجميع rollup، `PaymentTransactionStatus` مبسَّط لحالتين فقط `SUCCEEDED`/`FAILED` لا الحالات الثماني الأصلية، لا كيان `Delivery`/`Fulfillment` منفصل، ولا موظف "سائق"). لذلك **معظم صفوف VendorSuborder/Payment/Delivery القديمة SUPERSEDED بالتصميم الفعلي (`BranchOrderStatus` + `PaymentTransaction` المبسَّط)**، وليست فجوة. **الصفوف التي تصف إرجاعاً مبنية الآن (S21)** عبر نموذج `Return` المستقل - لا كحالة على `BranchOrder`/`PaymentTransaction` نفسهما (لذلك صفوف VS-16/17 وPM-07..11 أعلاه SUPERSEDED تحديداً، لا MISSING). آلة `Return` بالكامل (9 صفوف أدناه) مبنية بالكامل الآن، مع تصحيحات جولات المراجعة الخمس المذكورة في كل صف (لا أتمتة Approve→Refund، فصل REJECTED عن ADMIN_REJECTED، إلخ).

### CustomerOrder (8 صفوف)

| ID | الانتقال | الحالة الفعلية | Status |
|---|---|---|---|
| SRS-E11-CO-01 | `[*]→Created` عند تقديم checkout | لا حقل status على CustomerOrder؛ الحالة تُقرأ من BranchOrders مباشرة | ↪ SUPERSEDED |
| SRS-E11-CO-02 | `Created→InProgress` | نفس السبب | ↪ SUPERSEDED |
| SRS-E11-CO-03 | `InProgress/NeedsAttention→Completed` | لا rollup مبني | ❌ MISSING (كمفهوم rollup) |
| SRS-E11-CO-04 | `→PartiallyCancelled` | لا rollup، ولا حتى إلغاء BranchOrder موجود ليُجمَّع | ❌ MISSING |
| SRS-E11-CO-05 | `→Cancelled` | نفس السبب | ❌ MISSING |
| SRS-E11-CO-06 | `→NeedsAttention` (SLA breach) | لا مراقب SLA مجدول | ❌ MISSING |
| SRS-E11-CO-07 | `PartiallyCancelled→Completed` | لا rollup | ❌ MISSING |
| SRS-E11-CO-08 | `PartiallyCancelled→Cancelled` | لا rollup | ❌ MISSING |

### VendorSuborder (17 صفاً، الآن BranchOrder فعلياً)

| ID | الانتقال (بالاسم القديم) | مقابله الفعلي | Status |
|---|---|---|---|
| SRS-E11-VS-01 | `[*]→AwaitingPayment` (دفع إلكتروني) | لا حالة وسيطة؛ BranchOrder يُنشأ فقط بعد نجاح الدفع في نفس المعاملة | ↪ SUPERSEDED |
| SRS-E11-VS-02 | `[*]→PendingConfirmation` (COD) | يقابله `PLACED` مباشرة | ✅ DONE (بالاسم المختلف) |
| SRS-E11-VS-03 | `AwaitingPayment→PendingConfirmation` | غير منطبق (لا AwaitingPayment) | ↪ SUPERSEDED |
| SRS-E11-VS-04 | `AwaitingPayment→PaymentFailed` | يقابله: فشل الدفع يُسقِط المعاملة كلها، فلا BranchOrder يُنشأ أصلاً (rollback كامل) — ضمان أقوى من النص الأصلي | ✅ DONE (بضمان أقوى) |
| SRS-E11-VS-05 | `PendingConfirmation→Confirmed` (البائع يقبل) | **لا إجراء "قبول/تأكيد" صريح موجود** — `PLACED` ينتقل مباشرة لـ`PREPARING` | ❌ MISSING |
| SRS-E11-VS-06 | `PendingConfirmation→RejectedByVendor` | لا إجراء رفض | ❌ MISSING |
| SRS-E11-VS-07 | `PendingConfirmation→Cancelled` (العميل يلغي) | لا إجراء إلغاء عميل | ❌ MISSING |
| SRS-E11-VS-08 | `Confirmed→Preparing` | يقابله start-preparation | ✅ DONE |
| SRS-E11-VS-09 | `Confirmed→Cancelled` | لا إلغاء | ❌ MISSING |
| SRS-E11-VS-10 | `Preparing→ReadyForPickup` | يقابله ضمنياً حالة PICKED_UP عبر pickup-handover مباشرة (لا حالة "جاهز" وسيطة منفصلة) | 🟡 PARTIAL |
| SRS-E11-VS-11 | `Preparing→OutForDelivery` | يقابله mark-sent (`SENT`) | ✅ DONE |
| SRS-E11-VS-12 | `Preparing→Cancelled` (فرصة أخيرة) | لا إلغاء | ❌ MISSING |
| SRS-E11-VS-13 | `ReadyForPickup→PickedUp` | يقابله pickup-handover | ✅ DONE |
| SRS-E11-VS-14 | `OutForDelivery→Delivered` | يقابله mark-delivered | ✅ DONE |
| SRS-E11-VS-15 | `PickedUp/Delivered→Completed` | يقابله confirm-received (العميل) | ✅ DONE |
| SRS-E11-VS-16 | `Completed→ReturnRequested` | لا حقل status مستقل على `BranchOrder` يتحول إليه - الحالة "طلب إرجاع" تعيش على نموذج `Return` المستقل (S21)، لا على الأب. السلوك الفعلي مبني (انظر SRS-E11-RT-01) | ↪ SUPERSEDED (انظر Return) |
| SRS-E11-VS-17 | `ReturnRequested→ReturnedRefunded` | نفس السبب أعلاه - الاسترداد يُسجَّل في `BranchOrderRefund`، لا كحالة على `BranchOrder` نفسه | ↪ SUPERSEDED (انظر Return، SRS-E11-RT-09) |

### OrderItem (4 صفوف، الآن BranchOrderItem)

| ID | الانتقال | الحالة الفعلية | Status |
|---|---|---|---|
| SRS-E11-OI-01 | إنشاء يرث حالة الأب | `BranchOrderItem` بلا حقل status خاص به أصلاً — يتبع الأب بالضرورة البنيوية | ✅ DONE (بالغياب المتسق) |
| SRS-E11-OI-02 | الأب يكتمل → الصنف يكتمل | نفس السبب أعلاه | ✅ DONE |
| SRS-E11-OI-03 | طلب إرجاع لصنف محدد | مبني: `POST .../items/:itemId/returns` ينشئ `Return` مرتبطاً بـ`BranchOrderItem` هذا بالذات | ✅ DONE (S21) |
| SRS-E11-OI-04 | استرداد الصنف | مبني: `BranchOrderRefund.branchOrderItemId` فريد لكل صنف، يُكتب عند استلام المرتجع فقط | ✅ DONE (S21) |

### Payment (14 صفاً، الآن PaymentTransaction مبسَّط)

| ID | الانتقال (بالاسم القديم) | مقابله الفعلي | Status |
|---|---|---|---|
| SRS-E11-PM-01 | `[*]→PendingAuthorization` | لا حالة معلّقة وسيطة؛ الشحن sandbox متزامن | ↪ SUPERSEDED |
| SRS-E11-PM-02 | `PendingAuthorization→Authorized` | يقابله مباشرة `SUCCEEDED` | ✅ DONE (بتبسيط معتمد) |
| SRS-E11-PM-03 | `PendingAuthorization→Failed` | يقابله `FAILED` | ✅ DONE |
| SRS-E11-PM-04 | `Authorized→Captured` | لا فصل تفويض/التقاط؛ خطوة واحدة | ↪ SUPERSEDED |
| SRS-E11-PM-05 | `Authorized→Failed` (انتهاء نافذة الالتقاط) | غير منطبق | ↪ SUPERSEDED |
| SRS-E11-PM-06 | `Captured→Settled` | لا تسوية مصرفية منفصلة (sandbox) | ↪ SUPERSEDED |
| SRS-E11-PM-07 | `Captured→Refunded` | **لا تحول حرفي على `PaymentTransaction.status` نفسه** - الـenum الفعلي (`SUCCEEDED`/`FAILED` فقط) لا يملك قيمة Refunded إطلاقاً، بتصميم معتمد: `PaymentTransaction` يبقى غير قابل للتغيير دائماً (قد يغطي أكثر من BranchOrder)، والاسترداد الفعلي مبني بالكامل (S20a للإلغاء، S21 للإرجاع) في دفتر مستقل `BranchOrderRefund` | ↪ SUPERSEDED (انظر `BranchOrderRefund`) |
| SRS-E11-PM-08 | `Captured→PartiallyRefunded` | نفس السبب أعلاه - الاسترداد الجزئي مبني عبر صفوف `BranchOrderRefund` متعددة، لا حالة "جزئي" على `PaymentTransaction` | ↪ SUPERSEDED |
| SRS-E11-PM-09 | `Settled→Refunded` | نفس السبب | ↪ SUPERSEDED |
| SRS-E11-PM-10 | `Settled→PartiallyRefunded` | نفس السبب | ↪ SUPERSEDED |
| SRS-E11-PM-11 | `PartiallyRefunded→Refunded` | نفس السبب | ↪ SUPERSEDED |
| SRS-E11-PM-12 | `[*]→PendingCOD` | يقابله ضمنياً: BranchOrder COD يُنشأ مباشرة بلا حالة دفع منفصلة | ↪ SUPERSEDED |
| SRS-E11-PM-13 | `PendingCOD→CollectedOnDelivery` | يقابله pickup-handover/mark-delivered يعلّم الدفع كمدفوع | ✅ DONE (بالاسم المختلف) |
| SRS-E11-PM-14 | `CollectedOnDelivery→Settled` | لا تسوية منفصلة (sandbox) | ↪ SUPERSEDED |

### Delivery (7 صفوف، بلا كيان منفصل الآن)

| ID | الانتقال (بالاسم القديم) | مقابله الفعلي | Status |
|---|---|---|---|
| SRS-E11-DL-01 | `[*]→Pending` | يقابله BranchOrder عند PREPARING | ✅ DONE (مدموج) |
| SRS-E11-DL-02 | `Pending→Assigned` (سائق يقبل) | لا سائق (PDR-006 معتمد) | ↪ SUPERSEDED |
| SRS-E11-DL-03 | `Assigned→OutForDelivery` | يقابله mark-sent | ✅ DONE |
| SRS-E11-DL-04 | `OutForDelivery→Delivered` | يقابله mark-delivered | ✅ DONE |
| SRS-E11-DL-05 | `OutForDelivery→FailedAttempt` | لا مسار فشل توصيل مبني | ❌ MISSING |
| SRS-E11-DL-06 | `FailedAttempt→Assigned` (إعادة جدولة) | لا مسار فشل توصيل مبني | ❌ MISSING |
| SRS-E11-DL-07 | `FailedAttempt→Cancelled` | لا مسار فشل توصيل مبني | ❌ MISSING |

### Return (9 صفوف منفصلة — مبنية بالكامل الآن، S21، مع تصحيحات جولات المراجعة المذكورة في كل صف)

| ID | الانتقال | الحالة الفعلية | Status | Sprint |
|---|---|---|---|---|
**تصحيح جولات المراجعة (مطبَّق فعلياً، يختلف عن الوصف الحرفي أدناه لسبب موثَّق في كل صف)**: الموافقة تولّد كوداً فقط (`APPROVED_AWAITING_DROPOFF`)، لا استرداد تلقائياً؛ الاستلام الفعلي (`RECEIVED`) هو الشرط الوحيد لبدء `RefundProcessing`؛ رفض المتجر (قابل للنزاع 7 أيام) وحالة `ADMIN_REJECTED` (نهائية بعد تصعيد، لا نزاع ثانٍ) مفصولتان عمداً لمنع الالتفاف على قرار الأدمن.

| SRS-E11-RT-01 | `[*]→Requested` | مبني: `POST .../returns` → `REQUESTED` | ✅ DONE | - |
| SRS-E11-RT-02 | `Requested→VendorReview` | **مطوية ضمن `REQUESTED` نفسها** - لا حالة "قيد المراجعة" مستقلة؛ `REQUESTED` تعني ذلك فعلياً، لا تمييز إضافي يفيد | ✅ DONE (مبسَّطة) | - |
| SRS-E11-RT-03 | `VendorReview→Approved` | مبني: `REQUESTED→APPROVED_AWAITING_DROPOFF` (يولّد الكود هنا فقط، 7 أيام صلاحية) | ✅ DONE | - |
| SRS-E11-RT-04 | `VendorReview→Rejected` | مبني: `REQUESTED→REJECTED` (سبب إلزامي 10-1000 حرف)، نافذة نزاع 7 أيام ثابتة من `rejectedAt` | ✅ DONE | - |
| SRS-E11-RT-05 | `VendorReview→Escalated` (SLA breach) | مبني: تصعيد تلقائي حقيقي بعد 72 ساعة بلا قرار (`ReturnSweepService`) | ✅ DONE | - |
| SRS-E11-RT-06 | `Rejected→Escalated` (العميل ينازع) | مبني: نزاع العميل ضمن نافذة 7 أيام → `ESCALATED`؛ بعدها → `REJECTED_CLOSED` تلقائياً (sweep)، يسمح بإعادة تقديم | ✅ DONE | - |
| SRS-E11-RT-07 | `Escalated→Approved/Rejected` | مبني: `PLATFORM_ADMIN` فقط يحسم - موافقة→`APPROVED_AWAITING_DROPOFF`، رفض→**`ADMIN_REJECTED`** (قيمة مستقلة عن `REJECTED` العادية، نهائية، بلا نزاع/إعادة تقديم - تصحيح جولة مراجعة) | ✅ DONE | - |
| SRS-E11-RT-08 | `Approved→RefundProcessing` | **مصحَّحة جولات المراجعة**: لا مسار مباشر من الموافقة - يتطلب `RECEIVED` (استلام فعلي) أولاً. `RECEIVED→REFUND_PROCESSING` فقط | ✅ DONE (بعد التصحيح) | - |
| SRS-E11-RT-09 | `RefundProcessing→Refunded` | مبني: يكتب `BranchOrderRefund` (ONLINE_GATEWAY/COD_CASH) ضمن نفس transaction الاستلام | ✅ DONE | - |

**عدّاد E.11:** 8 (CO) + 17 (VS) + 4 (OI) + 14 (PM) + 7 (DL) + 9 (RT) = **59 صفاً**.

---

## §15b — صفوف أُضيفت في Sprint 16 (بلا تنفيذ)

صفّان جديدان، كلاهما ❌ MISSING وغير مبنيَّين ولا مجدولان في أي Sprint (يحتاجان قراراً منتجياً أولاً — انظر صف "قرار جديد" في §5):

| ID | Requirement | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| PDR-§3.5-APPEAL | المالك يقدّم استئناف تعليق (نص + مرفقات) والأدمن يقرّر فيه (`approved-product-decisions-2026-09.md` §3.5: "decide store appeal (text + attachments)")؛ لم يكن له أي صف في هذا الملف | لا | OWNER + PLATFORM_ADMIN | لا | لا | ❌ MISSING | — (قرار جديد) |
| FR-VEND-008-CANCELLED | `Active→Cancelled` و`Suspended→Cancelled` (المالك يغلق حسابه) من مخطط حالات FR-VEND-008؛ لا endpoint ولا سياسة (أثر الإغلاق على الطلبات والبيانات) | لا | OWNER | لا | لا | ❌ MISSING | — (قرار جديد) |

**عدّاد §15b:** 2 صفاً.

---

# §16 — الأعداد النهائية الشاملة (v4.1، مُعاد اشتقاقها مباشرة من صفوف الملف)

**كيف حُسِب هذا الجدول:** نفس منهج v3 (عدّ آلي مباشر لحالة كل صف فعلي، لا تقدير يدوي). v4 طبّق قرارات المالك الثلاثة (18 صفاً → DEFERRED). v4.1 يضيف صفّي `PDR-035`/`PDR-036` المستقلين (كانا مذكورين نصياً فقط في v4 بلا صف خاص بهما ولا عدّ) — كلاهما PARTIAL.

| المصدر | DONE | PARTIAL | MISSING | DEFERRED | SUPERSEDED | n/a | المجموع | يطابق v4؟ |
|---|---|---|---|---|---|---|---|---|
| FR، E.0..E.22 (Part 2) | 38 | 80 | 85 | 27 | 14 | 0 | 244 | لا — S16: VEND-003/009 → DONE |
| PDR-001..036 | 12 | 16 | 8 | 0 | 0 | 0 | **36** | **لا — PDR-035/036 أُضيفا (§0/v4.1)** |
| BR-001..034 (§6) | 8 | 12 | 12 | 0 | 2 | 0 | 34 | لا — S16: BR-026 → DONE |
| NFR-* (§7) | 2 | 10 | 18 | 0 | 0 | 2 | 32 | نعم |
| G.0 (§8) | 5 | 3 | 0 | 0 | 0 | 0 | 8 | نعم |
| G.3 إضافي (§8) | 3 | 0 | 7 | 0 | 0 | 0 | 10 | نعم |
| H.1 (§9) | 3 | 3 | 4 | 0 | 0 | 0 | 10 | نعم |
| H.2/H.3 قديم (§9) | 0 | 0 | 0 | 0 | 1 | 0 | 1 | نعم |
| H.3a (§9) | 3 | 4 | 1 | 0 | 0 | 0 | 8 | نعم |
| K.1a (§10) | 3 | 8 | 0 | 0 | 0 | 0 | 11 | نعم |
| K.1 حالات (§10) | 0 | 2 | 2 | 0 | 0 | 0 | 4 | لا — S16: STATES-03 → PARTIAL |
| L-01..32 (§10) | 12 | 5 | 14 | 0 | 1 | 0 | 32 | لا — S16: L-23 → DONE |
| ADR-001..012 (§11) | 7 | 5 | 0 | 0 | 0 | 0 | 12 | نعم |
| N.1..5 (§11) | 1 | 2 | 2 | 0 | 0 | 0 | 5 | نعم |
| O.1 (§11) | — | — | — | — | — | — | 0 | تصنيف وصفي فقط، لا يدخل المجموع |
| P (§11) | 1 | 2 | 12 | 0 | 0 | 0 | 15 | نعم |
| BDR القديمة (§12) | 6 | 5 | 1 | 0 | 3 | 1 | 16 | لا — S16: BDR-016 → DONE |
| Part 8 — 102 صفاً كاملة (§13) | 24 | 39 | 35 | 2 | 2 | 0 | 102 | لا — S16: BL-VEND-003/006، BL-ADMIN-001 → DONE |
| AC-01..22 (§14) | 10 | 5 | 7 | 0 | 0 | 0 | 22 | نعم |
| E.11 — 59 صفاً (§15) | 15 | 1 | 32 | 0 | 11 | 0 | 59 | نعم |
| §15b — مضافة في S16 | 0 | 0 | 2 | 0 | 0 | 0 | **2** | **جديد** |
| **المجموع** | **153** | **202** | **242** | **29** | **34** | **3** | **663** | — |

**فحص الجمع (v5):** 153+202+242+29+34+3 = **663**، ويطابق مجموع عمود "المجموع" (244+36+34+32+8+10+10+1+8+11+4+32+12+5+0+15+16+102+22+59+2 = 663). الفرق عن v4.1: DONE +8، PARTIAL −3، MISSING −5 (نقل 8 صفوف: FR-VEND-003 وBR-026 وBDR-016 وBL-VEND-003 من PARTIAL، وFR-VEND-009 وL-23 وBL-VEND-006 وBL-ADMIN-001 من MISSING إلى DONE، وSRS-K1-STATES-03 من MISSING إلى PARTIAL) ثم +2 MISSING للصفّين الجديدين في §15b. (فحص v4.1 السابق: 145+205+245+29+34+3 = 661.) **عدد الصفوف ارتفع من 659 إلى 661 (+2، صفّا PDR-035/036 الجديدان)، والـPARTIAL ارتفع بمقدار 2 (203→205)، تماماً كما طلبتِ.**

## §17 — عدد صفوف/أسطر التتبع الفعلية

**663 صفاً قابلاً للتتبع** (كان 661 في v4.1؛ +2 في §15b من Sprint 16. وكان 659 في v4؛ +2 من PDR-035/036 المضافين في v4.1). صفوف §0 (نصية) و§11/O.1 (15 سطراً وصفياً لمستويات الاختبار، بلا ID أو حالة مستقلة) و§14/BO-وما بعدها (ملخصات إستراتيجية، لا حالة مستقلة) **غير محسوبة** في الـ661، وهذا مقصود ومذكور صراحةً حيث ورد.

**تأكيد الشمول:** الـ661 تضم: FR(244) + PDR(**36**) + BR(34) + NFR(32) + G(18) + H(19) + K.1/L(47) + ADR/N/P(32، باستثناء O.1 الوصفي) + BDR(16) + Part 8(102) + AC(22) + E.11(59) + §15b(2). كل جزء من الـSRS من Part 0 حتى Part 9، وكل قرار معتمد بما فيها PDR-035/036، ممثَّل بصف مستقل لكل ID أو بقرار تجميع موثَّق بسببه في §0.

**بعد 2026-09-26:** الـ18 بنداً DEFERRED BY APPROVED DECISION فعلياً (§6 من `approved-product-decisions-2026-09.md`) — لم تعد "قرار-نطاق" معلَّقاً، بل قرار مالك موثَّق. `PDR-035` و`PDR-036` صفّان مستقلّان الآن، كلاهما 🟡 PARTIAL: القرار معتمد وموثَّق، لكن الكود (مسار أدلة المستودع للمراجع؛ قوالب الفئات والتحقق من صحتها والواجهة) لم يُبنَ بعد — S15 وS17 على التوالي. لم أُعِد تصنيف أي بند **آخر** من نفسي؛ كل ما تبقى تحت `قرار-نطاق` (NFR/DevOps/G.3/H.1/L وغيرها من بنود النضج التشغيلي غير المرتبطة بالثمانية عشر) بقي MISSING/PARTIAL كما هو.

سأنتظر مراجعتك. لا Sprint 15، لا كود، لا migration، لا commit، لا merge.
