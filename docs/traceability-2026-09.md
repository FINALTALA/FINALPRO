# FINALPRO — Requirement Traceability, September 2026

**Date:** 2026-09-26 (v4, three new product-owner decisions applied — see "v4 decisions applied" below; v3 was the arithmetic/coverage correction pass)
**Author:** Developer, for product-owner/Codex review.
**Status:** Read-only audit. No code, no migration, no commit/push is authorised by this record. No Sprint 15+ work is authorised by this record.
**Source:** `origin/main` @ `f92bf17` (Sprint 14 merged). Local tree matches it exactly.
**Scope:** the full SRS, Parts 0–9. Every `FR-*` ID in [SRS Part 2](srs/02-functional-requirements.md) (244 rows, including the E.0 September amendment), every `PDR-*` ID in [`approved-product-decisions-2026-09.md`](approved-product-decisions-2026-09.md) (36 rows, including the 2026-09-26 PDR-035/036 amendment), every `BR-*` (34) and `NFR-*` (32) in Part 3/4, and every remaining requirement, decision, screen, failure scenario, backlog item and state-machine transition in Parts 0, 1, and 3–9 — covered in the appendix starting at §6, with each ID-range explicitly expanded (no row stands for more than one ID; see §0 for the two narrow, explicitly-justified exceptions — the `O.1`/`O.2` test-level classification and the `BO`/module-matrix/recommendations rollup — neither of which carries an independent DONE/PARTIAL/MISSING status of its own).
**Update rule:** this file is reviewed again after every sprint. Each review edits it in place under a new dated version note, rather than creating a new file, so it stays the one living record.

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
| FR-AUTH-013 (E.0) | ضيف يتصفح فقط؛ السلة/المتابعة/checkout بحساب؛ المفضلات/المراجعات/التنبيهات بحساب | session guard؛ CartItem على السيرفر | session | /login, /cart | S10,S14,AUTH | 🟡 PARTIAL | S24 |
| FR-AUTH-014 (E.0) | تعطيل الحساب واسترجاعه 30 يوماً | لا شيء | - | لا | لا | ❌ MISSING | S22 |
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
| FR-RET-008 (E.0) | سياسة إرجاع، لقطة عند الشراء، تغيير كل 6 أشهر | لا | - | لا | لا | ❌ MISSING | S21 |
| FR-RET-009 (E.0) | كود 6 أرقام صالح 7 أيام؛ كل الفروع تقبل | لا | - | لا | لا | ❌ MISSING | S21 |
| FR-REV-008 (E.0) | مراجعات منتج ومتجر لمشترٍ موثّق، غير قابلة للتعديل | لا | - | لا | لا | ❌ MISSING | S23 |
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
| FR-AUTH-006 | OTP لاستعادة كلمة المرور **ولتغيير الهاتف** | الاستعادة موجودة؛ لا endpoint لتغيير الهاتف | session | /reset-password فقط | AUTH | 🟡 PARTIAL | S22 |
| FR-AUTH-007 | دمج سلة الضيف | استُبدل بـFR-AUTH-013 (E.0) | - | - | - | ↪ SUPERSEDED | - |
| FR-AUTH-008 | عناوين متعددة بدبوس خريطة وملاحظة وهاتفين | Address؛ POST/GET addresses؛ **GPS يملأ lat/lng فقط (لا مزوّد خريطة خارجي، قرار معتمد)؛ العميل يكتب المنطقة/المعلم يدوياً** | session | /account، /checkout | S14,WCH | 🟡 PARTIAL — بسبب لا default/تعديل/حذف، وليس الخريطة | S22 |
| FR-AUTH-009 | لغة عربية افتراضية وإنجليزية، محفوظة للحساب | عمود User.languagePref فقط | - | لا (عربي فقط) | لا | 🟡 PARTIAL | S22 |
| FR-AUTH-010 | حذف الحساب | لا (انظر FR-AUTH-014) | - | لا | لا | ❌ MISSING | S22 |
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
| FR-VEND-010 | معلومات الدفع/التسوية | لا | - | لا | لا | ❌ MISSING | S25 |
| FR-VEND-011 | مؤشرات أداء المتجر | لا | - | لا | لا | ❌ MISSING | S25 |

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
| FR-IMPORT-013 | تقرير تسوية | لا | - | لا | لا | ❌ MISSING | S25 |
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
| FR-COMP-001 | مجموعة مقارنة حتى 4 | لا (المقارنة لكل منتج أساسي) | - | لا | لا | ❌ MISSING | S24 |
| FR-COMP-002 | وضعان: عروض المنتج نفسه أو منتجات منافسة | وضع المنتج الواحد فقط | عام | /compare/:id | S8 | 🟡 PARTIAL | S24 |
| FR-COMP-003 | خصائص الفئة + سعر وخصم وحالة وضمان وتوصيل وتقييم ومسافة ووقت | السعر والتوفر واللون/المقاس فقط | عام | /compare/:id | S8 | 🟡 PARTIAL | S24 |
| FR-COMP-004 | إبراز التشابه والاختلاف | لا | - | لا | لا | ❌ MISSING | S24 |
| FR-COMP-005 | وسم الأرخص وأفضل قيمة مع السبب | ترتيب تصاعدي بلا وسم ولا سبب | عام | /compare/:id | S8 | 🟡 PARTIAL | S24 |
| FR-COMP-006 | تنبيه بيانات قديمة | لا | - | لا | لا | ❌ MISSING | S24 |
| FR-COMP-007 | رابط مشاركة ومجموعة محفوظة | الرابط يعمل؛ لا حفظ في الحساب | عام | /compare/:id | S8 | 🟡 PARTIAL | S24 |
| FR-COMP-008 | يعمل على الجوال وRTL | واجهة متجاوبة؛ تحقق بصري فقط، بلا اختبار آلي | عام | /compare/:id | لقطات فقط | 🟡 PARTIAL | S24 |
| FR-COMP-009 | مقارنة بعملات متعددة | استُبدل بـFR-PRICE-008 (E.0) | - | - | - | ↪ SUPERSEDED | - |
| FR-PRICE-001 | سعر أساسي وتخفيض وعملة | استُبدل بـFR-PRICE-008/009 (E.0) | - | - | - | ↪ SUPERSEDED | - |
| FR-PRICE-002 | تاريخ أسعار كامل | PriceHistory (S17): سجلّ إضافة فقط، صف واحد لكل تغيير حقيقي، تعبئة أولية MIGRATED_BASELINE للمتغيّرات السابقة | OWNER | صفحة سجلّ الأسعار في المتغيّر (S17) | S17 | ✅ DONE | - |
| FR-PRICE-003 | قواعد تقادم السعر | لا | - | لا | لا | ❌ MISSING | S17 |
| FR-PRICE-004 | قواعد تراكب الخصومات/الكوبونات (Phase 2 بحسب الـSRS) | لا — DEFERRED BY APPROVED DECISION (approved-product-decisions-2026-09.md §6، 2026-09-26) | - | لا | لا | ⏸ DEFERRED | - |
| FR-PRICE-005 | المبلغ المستحق: أصناف + توصيل + رسوم + ضريبة | الأصناف والتوصيل؛ لا رسوم ولا ضريبة (OPEN-009) | session | /checkout | S10 | 🟡 PARTIAL | S20b |
| FR-PRICE-006 | حد أدنى للطلب | لا | - | لا | لا | ❌ MISSING | S20b |
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
| FR-INV-008 (E.9) | تقرير تسوية المخزون | لا | - | لا | لا | ❌ MISSING | S25 |

### E.10 — السلة والـcheckout
| ID | Requirement | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| FR-CART-001 | سلة متعددة البائعين مقسمة بالبائع | استُبدل بـFR-CART-017 (E.0) | - | - | - | ↪ SUPERSEDED | - |
| FR-CART-002 | إعادة التحقق من السعر والمخزون قبل الدفع | txn التأكيد؛ فرق السعر | session | /checkout | S10,S14 | ✅ DONE | - |
| FR-CART-003 | حد أدنى لكل شريحة | لا | - | لا | لا | ❌ MISSING | S20b |
| FR-CART-004 | أهلية عنوان التوصيل بالمنطقة وبديل الاستلام | فحص المنطقة في quote/reserve | session | /checkout | S10,S14 | ✅ DONE | - |
| FR-CART-005 | توصيل أو استلام لكل بائع | استُبدل بـFR-ORD-009 (E.0) | - | - | - | ↪ SUPERSEDED | - |
| FR-CART-006 | دبوس المنزل وهاتفان وملاحظات | هاتفان + إحداثيات (**GPS يملأها فقط، لا مزوّد خريطة، قرار معتمد**) + معلم نصي؛ لا ملاحظة توصيل لكل طلب | session | /checkout AddressForm | S14 | 🟡 PARTIAL — بسبب لا ملاحظة لكل طلب، وليس الخريطة | S22 |
| FR-CART-007 | كوبونات (Phase 2 بحسب الـSRS) | لا — DEFERRED BY APPROVED DECISION (approved-product-decisions-2026-09.md §6، 2026-09-26) | - | لا | لا | ⏸ DEFERRED | - |
| FR-CART-008 | checkout idempotent | IdempotencyInterceptor | session | /checkout | S10,S14 | ✅ DONE | - |
| FR-CART-009 | COD ودفع إلكتروني | paymentMethod لكل فرع | session | /checkout | S10 | ✅ DONE | - |
| FR-CART-010 | السلات المهجورة بلا أثر | الحجوزات تنتهي والسلة تبقى | session | /cart | S10 | ✅ DONE | - |
| FR-CART-011 | مادة الطلب: CustomerOrder وVendorSuborders | استُبدل بـFR-ORD-009 (E.0) | - | - | - | ↪ SUPERSEDED | - |
| FR-CART-012 | قبول صريح للشروط | لا | - | لا | لا | ❌ MISSING | S20b |
| FR-CART-013 | اختيار الموعد لكل شريحة أثناء الـcheckout | اختيار الموعد في reserve | session | /checkout | S10 | ✅ DONE | - |
| FR-CART-014 | ملاحظة العميل لكل شريحة وملاحظة داخلية للمتجر | لا | - | لا | لا | ❌ MISSING | S20b |
| FR-CART-015 | إظهار تعارض التنفيذ لكل شريحة | رسائل مستوى المجموعة/عدم وجود طريقة؛ لا كتالوج التعارضات الكامل | session | /checkout | S14 | 🟡 PARTIAL | S20b |
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
| FR-PAY-004 | استرداد كامل/جزئي لكل صنف مع رسوم التوصيل | سجل `BranchOrderRefund` لكل صنف + رسوم التوصيل (مرة واحدة فقط لكل طلب، بـpartial unique index حقيقي)؛ استرداد تلقائي (PDR-025/027) أو بموافقة الموظف أو تجاوز الأدمن | عميل/موظف/PLATFORM_ADMIN | /orders، صفحة طلبات الفرع، /admin/branch-orders | S20a | ✅ DONE | - |
| FR-PAY-005 | العمولة تُسجَّل ولا تُحصَّل | لا | - | لا | لا | 🟡 PARTIAL | S25 |
| FR-PAY-006 | فوترة الاشتراك كتيار دفع مستقل | VendorSubscription فقط؛ لا سجلات دفع | OWNER | لا | S3 | 🟡 PARTIAL | S15 |
| FR-PAY-007 | سجل مالي مدقَّق غير قابل للتعديل | AuditLog للإلحاق فقط؛ ليس كل أحداث الدفع مؤكدة؛ لا عارض | - | لا | S1 | 🟡 PARTIAL | S25 |
| FR-PAY-008 | فاتورة/إيصال (PDR §3.4: لا إيصال مطبوع للعميل) | لا | - | لا | لا | ❌ MISSING | S25 |
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
| FR-FUL-009 (E.13) | استلام المرتجعات | لا | - | لا | لا | ❌ MISSING | S21 |
| FR-FUL-010 | وقت توصيل/جاهزية تقديري | يُعرض الموعد المختار؛ لا حساب ETA — استُبعد عمداً من نطاق S20a (قرار الجولة الأولى من المراجعة، 2026-10-07): هذا السبرنت غطّى الاستثناءات/الإلغاء/الاسترداد فقط | session | /checkout، /orders | S10 | 🟡 PARTIAL | - |
| FR-FUL-011 | تعيين سائق | استُبدل بـPDR-006 | - | - | - | ↪ SUPERSEDED | - |
| FR-FUL-012 | تسجيل استلام النقد مع المبلغ | `codCollectedAmount`/`codCollectedAt` يُسجَّلان ضمن معاملة mark-delivered/pickup-handover ذاتها، بمبلغ محسوب من الخادم (الإجمالي الأصلي ناقص أي صنف/رسوم ملغاة)، لا مبلغ يُدخله الموظف يدوياً | موظف الفرع | صفحة طلبات الفرع | S11,S20a | ✅ DONE | - |
| FR-FUL-013 | اختيار موعد مجدول | اختيار الموعد | session | /checkout | S10 | ✅ DONE | - |
| FR-FUL-014 | webhooks شركات التوصيل | PDR-006: التنسيق مع الناقل خارج المنصة | - | - | - | ⏸ DEFERRED | - |

### E.14 — المرتجعات
| ID | Requirement | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| FR-RET-001 | أهلية الإرجاع بالمدة والسبب | لا | - | لا | لا | ❌ MISSING | S21 |
| FR-RET-002 | طلب إرجاع بسبب وصور لأصناف محددة | لا | - | لا | لا | ❌ MISSING | S21 |
| FR-RET-003 | SLA للمتجر وتصعيد تلقائي | لا | - | لا | لا | ❌ MISSING | S21 |
| FR-RET-004 | حساب الاسترداد | لا | - | لا | لا | ❌ MISSING | S21 |
| FR-RET-005 | أسباب موجَّهة | لا | - | لا | لا | ❌ MISSING | S21 |
| FR-RET-006 | تصعيد النزاعات | لا | - | لا | لا | ❌ MISSING | S21 |
| FR-RET-007 | حدود إساءة الاستخدام | لا | - | لا | لا | ❌ MISSING | S21 |

### E.15–E.17 — المراجعات والمفضلات والإشعارات
| ID | Requirement | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| FR-REV-001 | مراجعة من مشترٍ موثّق | لا | - | لا | لا | ❌ MISSING | S23 |
| FR-REV-002 | أهداف: منتج/متجر/توصيل (PDR-032: منتج ومتجر) | لا | - | لا | لا | ❌ MISSING | S23 |
| FR-REV-003 | صور في المراجعة | لا (PDR-032: تقييم وتعليق) | - | لا | لا | ❌ MISSING | S23 |
| FR-REV-004 | رد المتجر على المراجعة | PDR-032 و§6: ردود البائع مؤجلة | - | - | - | ⏸ DEFERRED | - |
| FR-REV-005 | صيغة التقييم المجمّع | لا | - | لا | لا | ❌ MISSING | S23 |
| FR-REV-006 | الإبلاغ عن مراجعة | لا | - | لا | لا | ❌ MISSING | S23 |
| FR-REV-007 | كشف أنماط شاذة | لا | - | لا | لا | ❌ MISSING | S23 |
| FR-REV-008 (E.15) | شارة التحقق على صفحة المتجر | verificationStatus موجود؛ لا يُعرض | عام | لا | لا | ❌ MISSING | S23 |
| FR-REV-009 | تعديل/حذف المراجعة | استُبدل بـPDR-032 (لا تعديل) | - | - | - | ↪ SUPERSEDED | - |
| FR-REV-010 | مؤشرات أصالة على مستوى العرض | لا | - | لا | لا | ❌ MISSING | S23 |
| FR-FAV-001 | مفضلة: منتج/عرض/متجر | متابعة المتجر فقط | session | /following (متجر فقط) | S13 | 🟡 PARTIAL | S24 |
| FR-FAV-002 | حفظ مجموعة مقارنة | لا | - | لا | لا | ❌ MISSING | S24 |
| FR-FAV-003 | تنبيه انخفاض السعر | لا | - | لا | لا | ❌ MISSING | S24 |
| FR-FAV-004 | تنبيه عودة المخزون | لا | - | لا | لا | ❌ MISSING | S24 |
| FR-FAV-005 (E.16) | تفضيلات وتكرار الإشعارات | لا | - | لا | لا | ❌ MISSING | S24 |
| FR-FAV-006 | تنبيه عرض جديد | لا | - | لا | لا | ❌ MISSING | S24 |
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
| FR-ADMIN-001 | شاشات إدارة لكل كيان | شاشات S16: طابور التحقق، المتاجر (تعليق/إعادة تفعيل)، طلبات تغيير الاسم؛ باقي الكيانات (تصنيفات، علامات، منتجات أساسية، طلبات، دفعات…) API فقط أو غير مبنية؛ تصحيح تطابق المنصة غير مبني (لا سياسة معتمدة) | ADMIN/REVIEWER | /admin/* (الشريحة المذكورة فقط) | S3,S7,VV,S16 | 🟡 PARTIAL | S25 |
| FR-ADMIN-002 | قوائم غير مضمّنة في الكود | المناطق والقطاعات enums ثابتة (OPEN-012) | - | لا | لا | ❌ MISSING | S25 |
| FR-ADMIN-003 | أدوار وصلاحيات قابلة للضبط | قيمتان ثابتتان لـPlatformRole | - | لا | لا | ❌ MISSING | S25 |
| FR-ADMIN-004 | feature flags | لا | - | لا | لا | ❌ MISSING | S25 |
| FR-ADMIN-005 | بحث/تصدير سجل التدقيق | جدول AuditLog بلا API قراءة | - | لا | لا | ❌ MISSING | S25 |
| FR-ADMIN-006 | لوحات إشارات الاحتيال | لا | - | لا | لا | ❌ MISSING | S25 |
| FR-ADMIN-007 | تصدير البيانات | لا | - | لا | لا | ❌ MISSING | S25 |
| FR-VPORTAL-001 | لوحة: طلبات تحتاج انتباهاً واشتراك وKPIs | مركز روابط فقط | OWNER | /vendor/:id | NAV | 🟡 PARTIAL | S18 |
| FR-VPORTAL-002 | إدارة المنتجات والمخزون والتسعير | إنشاء/تعديل/أرشفة عرض ومتغيّر، أسعار وخصومات، وسائط (S17) | OWNER | /vendor/:id/offers وكل الصفحات الفرعية (جديد/تعديل/متغيّر/وسائط، S17) | S3,S17 | ✅ DONE | - |
| FR-VPORTAL-003 | استيراد وسجل وأخطاء | API الاستيراد + ImportBatch (سجل ملخّص، S17) | OWNER | /vendor/:id/offers/import (تقرير + سجلّ الدفعات، S17) | S7,S17 | ✅ DONE | - |
| FR-VPORTAL-004 | إدارة الطلبات مع الإلغاء والمرتجعات | قُرئ كإدارة طلبات وإلغاء/استرداد لا كتقارير أداء SLA (قرار الجولة الأولى من المراجعة، 2026-10-07)؛ شطر الإلغاء/فشل التوصيل/موافقة الاسترداد مبني بالكامل الآن. **المرتجعات الفعلية (استلام سلعة مرتجعة) لا تزال غير موجودة** | OWNER/موظف | /vendor/:id/orders، طلبات الفرع | S9,S11,S20a | 🟡 PARTIAL | S21 |
| FR-VPORTAL-005 | إدارة الفروع والموظفين | إضافة/أرشفة فرع، قائمة الموظفين ونقلهم وتعليقهم/إعادة تفعيلهم (S18b)؛ **دعوة موظف جديد لا تزال API فقط، بلا صفحة** | OWNER | /vendor/:id/branches، /vendor/:id/staff | S4,S18b | 🟡 PARTIAL | S15 |
| FR-VPORTAL-006 | حالة وسجل الاشتراك | GET subscription | OWNER | لا | S3 | 🟡 PARTIAL | S15 |
| FR-VPORTAL-007 (E.20) | تقارير الأداء/SLA والرد على المراجعات (الردود مؤجلة) | لا | - | لا | لا | ❌ MISSING | S25 |
| FR-VPORTAL-008 | بيانات اعتماد التكامل | لا — DEFERRED BY APPROVED DECISION (approved-product-decisions-2026-09.md §6، 2026-09-26) | - | لا | لا | ⏸ DEFERRED | - |
| FR-VPORTAL-009 | إعدادات المتجر: ساعات وإغلاقات ومناطق وتفضيلات إشعار | مناطق ونوافذ وواجهة المتجر؛ ساعات عمل وإغلاقات مؤقتة موجودة الآن (S18b)؛ لا تفضيلات إشعار | OWNER | /vendor/:id/delivery-zones، /storefront، /vendor/:id/branches/:branchId/hours | S9,S18b | 🟡 PARTIAL | S19 |
| FR-VPORTAL-010 | شاشة تسويات (Phase 2) | لا — DEFERRED BY APPROVED DECISION (approved-product-decisions-2026-09.md §6، 2026-09-26) | - | لا | لا | ⏸ DEFERRED | - |
| FR-VPORTAL-011 | عرض إشعارات البائع | نفس صندوق /me/notifications المشترك (Notification model + relay، S19) يعرض أنواع البائع (تعليق المتجر، طلب جديد للموظف، مخزون منخفض، خصم يدوي) لحساب البائع نفسه — ليست لوحة خاصة بالبائع، لكنها تعرض إشعاراته فعلاً | session (OWNER/EMP) | أيقونة الجرس + /notifications | S19 | ✅ DONE | - |
| FR-CMS-001 | أقسام الرئيسية والبانرات | لا — DEFERRED BY APPROVED DECISION (approved-product-decisions-2026-09.md §6، 2026-09-26) | - | لا | لا | ⏸ DEFERRED | - |
| FR-CMS-002 | حملات وSEO AR/EN | لا — DEFERRED BY APPROVED DECISION (approved-product-decisions-2026-09.md §6، 2026-09-26) | - | لا | لا | ⏸ DEFERRED | - |
| FR-CMS-003 | وسم الإعلان | لا — DEFERRED BY APPROVED DECISION (approved-product-decisions-2026-09.md §6، 2026-09-26) | - | لا | لا | ⏸ DEFERRED | - |
| FR-CMS-004 | الإحالة/الأفلييت (Phase 2+) | لا — DEFERRED BY APPROVED DECISION (approved-product-decisions-2026-09.md §6، 2026-09-26) | - | لا | لا | ⏸ DEFERRED | - |
| FR-CMS-005 | روابط عميقة ويب/موبايل | لا — DEFERRED BY APPROVED DECISION (approved-product-decisions-2026-09.md §6، 2026-09-26) | - | لا | لا | ⏸ DEFERRED | - |
| FR-ANALYTICS-001 | لوحات بحسب الدور | لا | - | لا | لا | ❌ MISSING | S25 |
| FR-ANALYTICS-002 | جودة الكتالوج والتطابق | لا | - | لا | لا | ❌ MISSING | S25 |
| FR-ANALYTICS-003 | دقة المخزون وحداثة الأسعار | لا | - | لا | لا | ❌ MISSING | S25 |
| FR-ANALYTICS-004 | أداء البحث | لا | - | لا | لا | ❌ MISSING | S25 |
| FR-ANALYTICS-005 | تقارير المبيعات/الفوترة/المرتجعات | لا | - | لا | لا | ❌ MISSING | S25 |
| FR-ANALYTICS-006 | تحليلات قمع السلوك | لا | - | لا | لا | ❌ MISSING | S25 |

### PDR-001..036
| ID | Decision | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| PDR-001 | ILS فقط | بيانات ILS | n/a | كل الواجهات | S10,S14 | ✅ DONE | - |
| PDR-002 | العميل المسجّل يتصفح/يقارن/يفضّل/يتابع/يشتري؛ سلة على السيرفر | السلة والمتابعة؛ لا مفضلات | session | /cart، /following | S10,S13 | 🟡 PARTIAL | S24 |
| PDR-003 | التنفيذ يُختار عند الـcheckout | السلة بلا تنفيذ | session | /cart، /checkout | S10,S14 | ✅ DONE | - |
| PDR-004 | BranchOrder وحدة تشغيلية | BranchOrder | session | /orders | S9,S10 | ✅ DONE | - |
| PDR-005 | معاملة sandbox واحدة؛ ILS | PaymentTransaction | session | /checkout | S10,S14 | ✅ DONE | - |
| PDR-006 | لا دور سائق؛ الموظف يحدّث Sent/Delivered | لا دور سائق؛ إجراءات الموظف | موظف الفرع | صفحة طلبات الفرع | S11 | ✅ DONE | - |
| PDR-007 | لا دردشة ولا stories؛ وسيلة تواصل خارجية | لم تُبنَ؛ بوابة التواصل | OWNER | /vendor/:id/storefront | S7 | ✅ DONE | - |
| PDR-008 | حساب واحد بأدوار متعددة؛ مبدّل؛ موظف لفرع واحد | VendorUser؛ me/workspaces؛ API الدعوة | OWNER | مبدّل /account؛ لا دعوة ولا نقل | S4,NAV | 🟡 PARTIAL | S15 |
| PDR-009 | فصل صلاحيات المالك والموظف | الـguards تفرضه؛ واجهات إدارة الفروع/الموظفين (S18b) وإلغاء/فشل التوصيل/موافقة الاسترداد (S20a) الآن مبنية لكليهما؛ واجهات المالك الأخرى (مثل المرتجعات والتقارير) لا تزال ناقصة | OWNER/موظف | المركز، طلبات الفرع، /vendor/:id/branches، /vendor/:id/staff | S4,S9,S18b,S20a | 🟡 PARTIAL | S21 |
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
| PDR-029 | عناوين: خريطة وافتراضي وحفظ صريح؛ تغيير قبل التحضير | إنشاء/عرض فقط؛ **GPS يملأ lat/lng فقط (لا مزوّد خريطة خارجي، قرار معتمد)**، لا default، لا تعديل/حذف، لا تغيير العنوان قبل التحضير | session | /account، /checkout | S14 | 🟡 PARTIAL — بسبب default/تعديل/حذف/تغيير قبل التحضير، وليس الخريطة | S22 |
| PDR-030 | سياسة إرجاع المتجر ورسومها ولقطة الشراء | لا | - | لا | لا | ❌ MISSING | S21 |
| PDR-031 | طلب إرجاع وSLA وكود 7 أيام | لا | - | لا | لا | ❌ MISSING | S21 |
| PDR-032 | مراجعات موثّقة للمنتج والمتجر؛ غير قابلة للتعديل؛ الردود مؤجلة | لا | - | لا | لا | ❌ MISSING | S23 |
| PDR-033 | اشتراك sandbox شهر وتجديد؛ تعطيل عند الانتهاء؛ تذكيرات | VendorSubscription وبوابة الانتهاء؛ لا تذكيرات | OWNER | لا | S3 | 🟡 PARTIAL | S15 |
| PDR-034 | تعطيل الحساب مع استرجاع 30 يوماً | لا | - | لا | لا | ❌ MISSING | S22 |
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
| G-AD-03 | تنقّل طابور التطابق وتصحيح الأدمن | FR-ADMIN-001 | 🟡 S16 جزئي: شاشة طلبات تغيير الاسم فقط؛ تصحيح تطابق المنصة غير مبني (لا سياسة معتمدة) → S25 |
| G-AD-04 | عارض سجل التدقيق وتصديره | FR-ADMIN-005 | S25 |
| G-AD-05 | إدارة الأدوار وقوائم الإعدادات (يعتمد على OPEN-012) | FR-ADMIN-002/003 | S25 |

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
| G-AC-01 | تغيير الهاتف بـOTP | FR-AUTH-006 | S22 |
| G-AC-02 | تعطيل الحساب واسترجاعه | FR-AUTH-010/014، PDR-034 | S22 |
| G-AC-03 | مبدّل اللغة والترجمة | FR-AUTH-009 | S22 |
| G-AC-04 | عنوان افتراضي وتعديل وحذف وتغيير العنوان قبل التحضير | FR-AUTH-008، FR-CART-006، PDR-029 | S22 |

(بند الخريطة أُزيل من G-AC-04 — لا مزوّد خريطة هو القرار المعتمد، وليس فجوة. انظر §0.1.)

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
| S21 | المرتجعات: سياسة المتجر، طلب، كود، استرداد، استلام المرتجعات | 12 | S20a (الاسترداد) | OPEN-009 |
| S22 | الحساب: تغيير الهاتف، التعطيل، اللغة، إدارة العناوين (افتراضي/تعديل/حذف/تغيير قبل التحضير) | 8 | لا شيء | قواعد الاحتفاظ بالبيانات (OPEN-009). **لا قرار خريطة مطلوب — محسوم بلا مزوّد خارجي (§0.1)** |
| S23 | المراجعات وشارة التحقق | 10 | S20a (الطلبات المكتملة) | قرار D1 (مؤجَّل من قِبلك رغم أن PDR-032 معتمد) |
| S24 | المفضلات والتنبيهات ومجموعات المقارنة ومقارنة أعمق | 16 | S17 (تاريخ الأسعار)، S19 | لا شيء جديد |
| S25 | التحليلات وأدوات الأدمن (سجل التدقيق، الأدوار، التصدير) وتقارير الفوترة والتسوية | 21 (+1: FR-ADMIN-001 المتبقي) | معظم ما سبق | OPEN-012 (مصدر حدود المناطق) |
| **— (قرار جديد)** | إغلاق المتجر CANCELLED (FR-VEND-008 المتبقي) وطلب استئناف التعليق (PDR §3.5) | 3 | — | **ليست سبرنتاً مجدولاً.** كلاهما بلا سياسة معتمدة (من يُغلق، أثر الإغلاق على الطلبات والبيانات، مدة الاستئناف، المرفقات) — انظر §15b. |
| **— (قرار جديد)** | "أقرب فرع" فعلياً (PDR-023، FR-CART-018) | 2 | — | **ليست سبرنتاً مجدولاً.** تحتاج: (أ) قراراً بأن التقريب الحتمي الحالي غير كافٍ، و(ب) مصدر مسافة موثوق (إحداثيات الفرع + إحداثيات العميل + دالة مسافة، أو مزوّد خارجي). بلا هذين لا يوجد عمل قابل للتقدير. |

**الـ18 بنداً سابقاً "قرار-نطاق" لم تعد في هذا الجدول إطلاقاً** — أصبحت DEFERRED BY APPROVED DECISION (§6 من `approved-product-decisions-2026-09.md`، 2026-09-26): FR-AUTH-012، FR-IMPORT-006/007، FR-SEARCH-009/011، FR-PRICE-004/008(E.8)/009(E.8)، FR-CART-007، FR-FUL-007، FR-SUP-006، FR-VPORTAL-008/010، FR-CMS-001..005. لن تُجدوَل في أي سبرنت ما لم يصدر قرار معتمد جديد يعيدها للنطاق.

**فحص المجموع:** S15(13)+S16(0)+S17(25)+S17b(13)+S18(16)+S18b(19)+S19(10)+S20a(15)+S20b(6)+S21(12)+S22(8)+S23(10)+S24(16)+S25(21) = **184** سبرنتات مجدولة + **5** غير مجدولة (قرار جديد: "أقرب فرع" 2 + CANCELLED والاستئناف 3) = **189** (بعد S16: −2 صار DONE، +2 صفّان جديدان في §15b؛ عدّاد S15/S17 يحمل الفرق التاريخي نفسه عن العدّ الآلي كما كان قبل S16).

**قرارات مطلوبة قبل أي سبرنت، بالترتيب (بعد إغلاق OPEN-011/013):**
1. مصدر مسافة موثوق لـ"أقرب فرع" — بدونه هذا البند يبقى خارج كل الجداول الزمنية إلى أجل غير مسمى، وليس فقط مؤجَّلاً لسبرنت لاحق.
2. قرار D1 للمراجعات (S23).
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
| BR-003 | كل قائمة انتقاء (فئات، أسباب إرجاع، فئات تذاكر) قابلة للضبط إدارياً، لا hardcoded | Regions/segments/PlatformRole/StockMovementReason/OfferCondition كلها Prisma enums ثابتة في الكود | - | لا | لا | ❌ MISSING | S25 |
| BR-004 | سعر لم يُعاد تأكيده ضمن نافذة التقادم يُعلَّم قديماً في المقارنة/البحث | لا | - | لا | لا | ❌ MISSING | S17 |
| BR-005 | مخزون قديم يُعلَّم؛ لا يُعتمد كحقيقة لمنع checkout بلا إعادة تحقق أحدث | إعادة التحقق عند الـcheckout DONE (FR-CART-002)؛ علم "قديم" (is_stale، lastPhysicalCountAt، 7 أيام) موجود الآن (S18a) ولا يُستخدم في checkout — إعادة التحقق تبقى المصدر الوحيد هناك | session | /checkout؛ شارة "جرد قديم" في صفحة مخزون الفرع (S18a) | S10,S18a | ✅ DONE | - |
| BR-006 | التوصيل مؤهل فقط داخل منطقة الفرع؛ الاستلام مؤهل دائماً | فحص المنطقة في quote/reserve + PICKUP_REQUIRES_PHYSICAL_BRANCH | session | /checkout | S10,S14 | ✅ DONE | - |
| BR-007 | فقط العروض المعتمدة تدخل المقارنة؛ غير المطابق يظل قابلاً للبحث والشراء لكن مستبعداً من المقارنة | استبعاد المقارنة DONE؛ "قابل للبحث" فقط عبر صفحة المتجر، ليس الاكتشاف العام | public | /compare, /store/:slug/products/:id | S8,S13 | 🟡 PARTIAL | S18b |
| BR-008 | تراكب الخصومات/الكوبونات بجدول موثّق؛ الافتراضي عدم التراكب (Phase 2 بحسب الـSRS) | لا | - | لا | لا | ❌ MISSING | قرار-نطاق |
| BR-009 | السلة مقسّمة بالبائع؛ كل تحقق (حد أدنى، أهلية توصيل) لكل قسم | التقسيم الفعلي أصبح بالفرع لا بالبائع (PDR-004 بديل معتمد)؛ التحقق لكل مجموعة فرع يعمل لمعظم القواعد؛ الحد الأدنى للطلب لكل قسم غير موجود | session | /checkout | S10,S14 | 🟡 PARTIAL | S20b |
| BR-010 | CustomerOrder وكل صفوفه التابعة تُنشأ ذرياً من طلب checkout واحد | معاملة Prisma واحدة تغطي الخصم والطلبات والدفع | session | /checkout | S10,S14 | ✅ DONE | - |
| BR-011 | إلغاء الطلب الفرعي محكوم بحالته (العميل حتى Confirmed، البائع حتى Preparing)؛ تجاوز الأدمن موثّق | العميل: PLACED فقط؛ الموظف/OWNER: PLACED/PREPARING؛ تجاوز PLATFORM_ADMIN لأي حالة غير نهائية، بسبب إلزامي وAuditLog (BR-019) | عميل/موظف/PLATFORM_ADMIN | /orders، صفحة طلبات الفرع، /admin/branch-orders | S20a | ✅ DONE | - |
| BR-012 | أهلية الإرجاع نافذة زمنية + سبب، قابلة للضبط لكل فئة | لا | - | لا | لا | ❌ MISSING | S21 |
| BR-013 | صيغة الاسترداد (سعر + حصة رسوم التوصيل − تسوية)؛ كانت مقترحة معلّقة على OPEN-007 (أُغلق الآن) | OPEN-007 أُغلق، لكن الاسترداد نفسه غير مبني؛ القاعدة الفعلية الآن PDR-030/031 لا BR-013 | - | لا | لا | ❌ MISSING | S21 |
| BR-014 | الاشتراك يتحكم بالظهور لا بالعمولة؛ Past Due يدخل فترة سماح قبل Suspended | ACTIVE/EXPIRED فقط (PDR-033 بسّطت الحالات)؛ لا فترة سماح منفصلة | OWNER | لا | S3 | 🟡 PARTIAL | S15 |
| BR-015 | فوترة اشتراك البائع وفوترة طلب العميل على دورتين مستقلتين | VendorSubscription وPaymentTransaction نموذجان منفصلان تماماً بالبناء | OWNER/session | - | S3,S10 | ✅ DONE | - |
| BR-016 | مراجعة فقط بعد اكتمال طلب/صنف موثّق ("شراء موثّق") | لا مراجعات مبنية إطلاقاً | - | لا | لا | ❌ MISSING | S23 |
| BR-017 | البائع يُعلَّم تلقائياً للمراجعة الإدارية عند past-due أو نمط إرجاع شاذ أو رفض أدلة بلا إعادة تقديم؛ التعليق فعل إداري صريح دائماً | لا آلية تعليم تلقائي (محفّزاتها تعتمد على فترة سماح ومرتجعات وعامل مجدول غير موجودة)؛ الجملة الأخيرة متحققة: التعليق فعل أدمن صريح بسبب مسجَّل (S16) | PLATFORM_ADMIN | لا | S16 | ❌ MISSING | — (غير مجدول؛ ليس DEFERRED) |
| BR-018 | حذف الحساب يحترم فترة احتفاظ بالطلبات/الدفع/التدقيق حتى بعد الحذف | لا | - | لا | لا | ❌ MISSING | S22 |
| BR-019 | أي تجاوز صلاحية إداري ("break-glass") يسجَّل بسبب ويُدقَّق دائماً | أول مسار "break-glass" حقيقي: إلغاء قسري/استرداد يدوي لطلب فرع، PLATFORM_ADMIN فقط، سبب إلزامي (10-1000 حرف) وAuditLog لكل استدعاء؛ لا يتجاوز سجل الاسترداد/إعادة المخزون أبداً | PLATFORM_ADMIN | /admin/branch-orders | S20a | ✅ DONE | - |
| BR-020 | تأكيد الطلب يتطلب دبوس منزل وهاتفين، ويطلق 3 إشعارات مستقلة التتبع | الهاتفان والإحداثيات DONE (بلا خريطة، قرار معتمد)؛ الإشعارات الثلاثة المتتبَّعة غير موجودة (outbox فقط) | session | /checkout | S14 | 🟡 PARTIAL | S19 |
| BR-021 | كل عرض بعملة البائع؛ المقارنة تطبيع FX؛ الدفع بعملة البائع الأصلية (مقترح معلّق OPEN-007) | استُبدل بـBR-027 (تنص F.1 على ذلك صراحة) | - | - | - | ↪ SUPERSEDED | - |
| BR-022 | فرع فعلي لا يغادر "قيد التحقق" بلا دبوس وصورة، مراجَعة من مراجع تحقق | POST verification-evidence + verification-decision | OWNER + REVIEWER | لا | S3,VV | 🟡 PARTIAL | S15 |
| BR-023 | هاتف+كلمة مرور أساسي؛ OTP يوثّق التسجيل ويبوّب استعادة كلمة المرور وتغيير الهاتف | التسجيل والاستعادة DONE؛ تغيير الهاتف بـOTP غير موجود | عام/session | /register,/reset-password | AUTH | 🟡 PARTIAL | S22 |
| BR-024 | الضيف يتصفح ويبني سلة بلا حساب؛ الدخول يدمج سلة الضيف | استُبدل: السلة تتطلب تسجيل دخول من الأصل الآن (PDR-002/FR-AUTH-013)، فلا سلة ضيف لتُدمج | - | - | - | ↪ SUPERSEDED | - |
| BR-025 | أهلية إرجاع الصنف تعتمد فقط على `Fulfillment` الخاص به، لا الأصناف الشقيقة أو الطلب الفرعي كاملاً | لا كيان Fulfillment منفصل، ولا إرجاع مبني إطلاقاً | - | لا | لا | ❌ MISSING | S21 |
| BR-026 (F + F.1) | رفض تحقق فرع واحد يرفض الطلب كاملاً؛ إعادة التقديم مسار منفصل عن الرفض؛ يمكن تقديم طلب مصحَّح فوراً بعد الرفض مع بقاء السجل القديم | منطق UNDER_REVIEW→REJECTED الشامل مبني ومختبر؛ سبب الرفض يراه المالك (verification-status)؛ الطلب المصحَّح = POST /vendors جديد بسجل قديم محفوظ (واجهة تقديم الطلب نفسها تحت FR-VEND-001/S15) | REVIEWER/ADMIN | /admin/verification، /vendor/:vendorId/verification | VV,S16 | ✅ DONE | - |
| BR-027 | كل المبالغ ILS؛ لا FX ولا تسوية متعددة العملات؛ يُلغي BR-021 ويُغلق OPEN-002/007 | بيانات ILS فقط في كل مكان | n/a | كل واجهات السعر | S10,S14 | ✅ DONE | - |
| BR-028 | checkout واحد ينتج CustomerOrder أب وBranchOrder واحد أو أكثر، كل BranchOrder بطريقة تنفيذ/رسم/دفع/موعد/دورة حياة خاصة به | BranchOrder | session | /orders | S9,S10 | ✅ DONE | - |
| BR-029 | العميل يختار سطور السلة صراحة؛ النظام يقترح فقط فروعاً تحوي كل المتغيرات المختارة، ويقترح الأقرب لكن العميل يختار فرعاً أبعد مؤهلاً | الاختيار الصريح ومجموعة الفروع المؤهلة DONE؛ "الأقرب" بديل حتمي موثّق لا مسافة حقيقية | session | /checkout | S10,S14 | 🟡 PARTIAL | — (قرار جديد) |
| BR-030 | باركود المخزون فريد وscanner-facing؛ الباركود المشترك داخلي لا يُستبدل أبداً؛ بيع/تخفيض لا يمكن أن ينزل المخزون تحت الصفر | فصل الباركودين DONE؛ واجهة بحث بالباركود (scanner-facing) موجودة الآن (S18a)؛ منع النزول تحت الصفر DONE (خصم ذري) | OWNER | صفحة مخزون الفرع: حقل البحث بالباركود (S18a) | S6,S18a | ✅ DONE | - |
| BR-031 | خصم يدوي غير بيعي له سبب دائماً ويُشعِر المالك؛ لا نقل مخزون بين الفروع في المرحلة الأولى | السبب مفروض؛ لا نقل مبني (متوافق مع القرار)؛ **الإشعار يصل فعلياً الآن** لصندوق المالك (relay S19)، لم يعد outbox فقط | OWNER/EMP | صفحة مخزون الفرع: نموذج الحركة (S18a)؛ /notifications (S19) | S6,S18a,S19 | ✅ DONE | - |
| BR-032 | التوفر العام مشتق من مجموع مخزون الفروع المؤهلة لكن يُعرض فقط Available/Low/Sold out؛ الكمية الحقيقية خاصة إلا حد أقصى عند تحقق السلة | البطاقات العامة تستخدم المجموع (bucketForStock) كما هو منصوص؛ حد السلة الأقصى أصبح عمداً لكل فرع مفرد (إصلاح مراجعة Sprint 14) بما يطابق أن checkout لا يقسّم سطراً على فرعين | public/session | البطاقات، /cart | S8,S14 | ✅ DONE | - |
| BR-033 | سياسة إرجاع المتجر ورسومه تُلقَط لحظة الشراء؛ تتغير كل 6 أشهر فقط؛ قبول موحّد عبر كل الفروع/نقاط الاستلام | لا | - | لا | لا | ❌ MISSING | S21 |
| BR-034 | التوصيل يديره موظفو الفرع؛ تأكيد العميل يُطلب بعد تحديث الموظف؛ تذكير 48 ساعة وتأكيد تلقائي 72؛ لا هوية سائق ولا نزاع داخل المنصة | الإجراءات اليدوية DONE؛ **التذكير والتأكيد التلقائي أصبحا مجدوَلين فعلياً الآن** (`FulfilmentSweepService` دوري، لا عند القراءة فقط — S19) | EMP/session | صفحة الفرع،/orders، /notifications (S19) | S11,S19 | ✅ DONE | - |

**عدّاد BR:** 34 صفاً (BR-001..034)، منها 2 SUPERSEDED (021، 024). أُعيد فرز الـ32 الحيّة مباشرة من الجدول أعلاه بعد S19 (لا تقدير): DONE=11 (002، 005، 006، 010، 015، 027، 028، 030، 031، 032، 034)، PARTIAL=9 (001، 007، 009، 014، 020، 022، 023، 026، 029)، MISSING=12 (003، 004، 008، 011، 012، 013، 016، 017، 018، 019، 025، 033). المجموع 11+9+12+2=34. (قبل S19: DONE=10، PARTIAL=10 — BR-034 انتقلت PARTIAL←DONE. قبل S18a: DONE=7، PARTIAL=13 — BR-005/030/031 انتقلت PARTIAL←DONE. النسخة v2 كانت ذكرت 8/17/7 خطأً؛ صُحِّحت في v3/§16.)

## §7 — `NFR-*` Non-functional requirements (Part 4, Section I)

| ID | Requirement (paraphrase) | Backend/evidence | Status | Sprint |
|---|---|---|---|---|
| NFR-PERF-001 | صفحة تفاصيل المنتج p95 ≤2s على 3G | لا قياس أداء رسمي موجود في المستودع | ❌ MISSING | S25 |
| NFR-PERF-002 | نتائج البحث p95 ≤1.5s حتى 10,000 عرض | لا قياس | ❌ MISSING | S25 |
| NFR-PERF-003 | checkout حتى إنشاء الطلب p95 ≤3s (باستثناء البوابة) | لا قياس رسمي؛ زمن e2e الحالي (~100ms لكل طلب في بيئة الاختبار) مؤشر غير رسمي فقط | ❌ MISSING | S25 |
| NFR-SCALE-001 | تحمّل 50 جلسة متزامنة في بيئة العرض | لا اختبار حمل | ❌ MISSING | S25 |
| NFR-IMPORT-001 | استيراد 1000 صف خلال 5 دقائق | لا قياس؛ الاستيراد الحالي يُختبر بأحجام صغيرة فقط | ❌ MISSING | S25 |
| NFR-AVAIL-001 | 99.5% شهرياً للإنتاج؛ لا SLA رسمي لبيئة FYP | لا بنية إنتاج فعلية بعد | n/a | قرار-نطاق |
| NFR-REL-001 | RPO ≤ ساعة عبر نسخ احتياطي كل ساعة | لا نسخ احتياطي مجدول موجود في هذا المستودع | ❌ MISSING | S25 |
| NFR-REL-002 | RTO ≤4 ساعات للإنتاج | لا خطة تعافي موثقة أو مختبرة | ❌ MISSING | قرار-نطاق |
| NFR-REL-003 | job مجدول يكتشف ويعلّم (لا يحل تلقائياً) حالات "دفع نجح/طلب فشل" | rollback داخل نفس المعاملة يمنع الحالة أصلاً في المسار الحالي؛ لا job تسوية منفصل موجود لأن الحالة لم تُلاحظ بعد في هذا التصميم أحادي المعاملة | 🟡 PARTIAL | S25 |
| NFR-SEC-001 | TLS 1.2+ على كل شيء، لا HTTP نص صريح | بيئة تطوير محلية فقط بلا TLS؛ غير منطبق للإنتاج بعد | n/a | قرار-نطاق |
| NFR-SEC-002 | كلمات المرور بتجزئة مملحة حديثة | `bcryptjs`، `bcrypt.hash(..., 10)` في auth.controller.ts | ✅ DONE | - |
| NFR-SEC-003 | كل حدث AuditLog محتفَظ به وقابل للاستعلام لمدة الاحتفاظ | `AuditLog` جدول إلحاق فقط موجود؛ لا واجهة استعلام (FR-ADMIN-005)؛ مدة الاحتفاظ نفسها معلّقة (OPEN-009) | 🟡 PARTIAL | S25 |
| NFR-PRIV-001 | PII العميل مرئي فقط للأدوار المصرَّح لها، مفروض في طبقة الـAPI | الموظف يرى الاسم/الهاتف/الكود فقط دون العنوان (FR-NOTIF-005 DONE)؛ لم أتحقق من كل مسار عرض عنوان آخر | 🟡 PARTIAL | S25 |
| NFR-A11Y-001 | WCAG 2.1 AA على المسارات الأساسية | 18 ملفاً فقط تستخدم aria-/role؛ لا تدقيق رسمي | 🟡 PARTIAL | S25 |
| NFR-L10N-001 | كل نص يخرج بالعربية والإنجليزية من مصدر ترجمة | الواجهة عربية فقط حالياً (FR-AUTH-009 MISSING)، لا مصدر ترجمة | ❌ MISSING | S22 |
| NFR-RTL-001 | كامل الواجهة (لا النص فقط) تُرآى بشكل صحيح بـRTL | `<html lang="ar" dir="rtl">` عام على التطبيق؛ لا تدقيق شامل للتخطيط/الأيقونات | 🟡 PARTIAL | S25 |
| NFR-MOBILE-001 | كل الشاشات قابلة للاستخدام عند 400px، وعلى Android/iOS | استجابة الويب مبنية ومُتحقَّق منها بلقطات الجوال؛ لا بناء Android/iOS (Capacitor) إطلاقاً | 🟡 PARTIAL | قرار-نطاق |
| NFR-BW-001 | صور بصيغة مضغوطة متجاوبة (WebP إلخ) | لا معالجة/ضغط صور موجودة؛ الصور روابط خام | ❌ MISSING | S17 |
| NFR-OBS-001 | كل طلب قابل للتتبع عبر X-Correlation-Id في اللوغ وAuditLog والـwebhooks | `CorrelationIdMiddleware` + مُدرَج في كل رد خطأ وكل AuditLog | ✅ DONE | - |
| NFR-OBS-002 | كل تكامل خارجي يعرض معدل نجاح/زمن استجابة/آخر فشل للوحة الأدمن | لا لوحة تكامل؛ لا تكامل خارجي حقيقي أصلاً (كل شيء sandbox/محلي) | ❌ MISSING | S25 |
| NFR-MAINT-001 | كل قائمة انتقاء تُغيَّر بإعداد إداري لا نشر كود | نفس BR-003: enums ثابتة في الكود | ❌ MISSING | S25 |
| NFR-TEST-001 | كل آلة حالة في Part 2 E.11 لها اختبار آلي لكل انتقال صالح وانتقال غير صالح واحد على الأقل | آلات E.11 القديمة (VendorSuborder/Payment القديم) غير مبنية أصلاً بهذا الشكل؛ آلة BranchOrderStatus الفعلية موسَّعة (DELIVERY_FAILED/REFUND_REQUESTED) بتغطية شاملة الآن لمحور `deliveryAttemptCount` (`branch-order-state-machine.spec.ts`: كل انتقال صالح + كل هدف غير صالح من كل حالة جديدة بشكل مصرَّح)؛ لا إثبات شمولية مماثل لبقية آلات المشروع بعد | 🟡 PARTIAL | S25 |
| NFR-BACKUP-001 | نسخ احتياطي كل ساعة على الأقل، والتحقق من قابلية الاستعادة دورياً | لا نسخ احتياطي مُدار في هذا المشروع (بيئة تطوير) | ❌ MISSING | قرار-نطاق |
| NFR-DR-001 | دليل تعافي من كوارث موثّق ومُجرَّب مرة قبل إطلاق الإنتاج | لا يوجد | ❌ MISSING | قرار-نطاق |
| NFR-RETAIN-001 | سجلات معاملاتية محتفَظ بها حسب BR-018 | BR-018 نفسه MISSING | ❌ MISSING | S22 |
| NFR-BROWSER-001 | أحدث إصدارين من Chrome/Safari/Firefox/Edge | لا مصفوفة اختبار متصفحات رسمية؛ التحقق الحالي عبر Playwright/Chromium فقط | 🟡 PARTIAL | قرار-نطاق |
| NFR-DEVICE-001 | أحدث إصدارين من Android/iOS | لا بناء موبايل إطلاقاً | ❌ MISSING | قرار-نطاق |
| NFR-SEO-001 | صفحات المنتج الأساسي مُقدَّمة من السيرفر لا JS فقط | Next.js App Router (خادمي افتراضياً)، لم أتحقق من كل صفحة إن كانت client component بلا داعٍ | 🟡 PARTIAL | S18b |
| NFR-IMG-001 | حد أقصى لحجم الصورة المرفوعة (10MB افتراضي) | لا رفع صور مبني أصلاً (روابط فقط) | ❌ MISSING | S17 |
| NFR-STALE-001 | تأخير تعليم المخزون قديماً: 7 أيام يدوي / 24 ساعة API، قابل للضبط | الشق اليدوي موجود الآن: is_stale إن مرّ 7 أيام منذ lastPhysicalCountAt (S18a) — لكنه ثابت بالكود لا "قابل للضبط"، ولا مصدر تقادم API/تغذية مؤتمتة من نوعه | 🟡 PARTIAL | S18 |
| NFR-STALE-002 | تأخير تعليم السعر قديماً: 30 يوماً، قابل للضبط | لا تعليم تقادم سعر موجود | ❌ MISSING | S17 |
| NFR-AUDIT-001 | 100% من انتقالات الحالة وكل فعل إداري متجاوِز يُنتج صف AuditLog | نسبة عالية من الانتقالات المبنية فعلاً تُدقَّق (checkout، تحقق، اشتراك، مخزون)؛ فعل "التجاوز الإداري" (BR-019) مبني الآن ومُدقَّق دائماً؛ "100%" الشامل عبر كل المشروع غير مؤكَّد شمولاً | 🟡 PARTIAL | S25 |

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
| SRS-G0-08 | الجدولة والإرجاع: DeliverySlot لفرع مالك مخزون؛ ReturnPolicy مُلقَطة على BranchOrder/Item؛ Notification بحالة قراءة ورابط عميق؛ Review لمنتج/متجر فقط، غير قابل للتعديل | DeliveryWindow/Exception DONE؛ **`Notification` بحالة قراءة ورابط عميق مبني الآن بالكامل (S19)**؛ ReturnPolicy/ReturnRequest/Review ما زالت غير موجودة إطلاقاً | 🟡 PARTIAL (ثلاثة أرباعه DONE الآن، ReturnPolicy/ReturnRequest/Review فقط ما زال MISSING بالكامل) | S17/S19/S21/S23 |

### G.3 — كيانات مقابل Prisma الفعلي (الكيانات غير المذكورة في G.0 فقط؛ ما ذُكر أعلاه لا يتكرر)

| ID | الكيان في SRS | الموجود فعلياً | Status | Sprint |
|---|---|---|---|---|
| SRS-G3-01 | `AttributeDefinition`/`AttributeOption` (قوالب خصائص الفئة) | لا نموذج مطابق؛ `structuralAttributes` JSON حر فقط | ❌ MISSING | S17b |
| SRS-G3-02 | `ProductMedia` (وسائط على مستوى المنتج الأساسي/المتغيّر) | فقط `OfferVariantMedia` (على مستوى عرض البائع)؛ لا وسائط على مستوى Canonical | ❌ MISSING | S17b |
| SRS-G3-03 | `ImportJob`/`ImportRow` (سجل مهمة استيراد كامل) | فقط `ImportIdentifierRecord` لمنع تكرار الصفوف؛ لا سجل مهمة/تاريخ استيراد | ❌ MISSING | S17 |
| SRS-G3-04 | `FxRate` | غير موجود، ومطلوب ألا يوجد (PDR-001) | ✅ DONE (بالإزالة المتعمدة) | - |
| SRS-G3-05 | `Payment`/`PaymentAllocation`/`PaymentTransactionAllocation`/`WebhookInbox` (نموذج دفع متعدد المراحل مع تسوية) | فقط `PaymentTransaction` بحالتين (SUCCEEDED/FAILED)، بلا بوابة حقيقية ولا webhook inbox (PDR-005 بسّط النموذج عمداً) | ✅ DONE (تبسيط sandbox متعمد، ليس فجوة) | - |
| SRS-G3-06 | `VendorSettlement`/`Promotion`/`Coupon` (Phase 2 بحسب الـSRS) | غير موجودة | ❌ MISSING | قرار-نطاق |
| SRS-G3-07 | `Review`/`ReturnRequest`/`Refund`/`Dispute` | غير موجودة (متوافق مع FR-REV-*/FR-RET-* MISSING أعلاه) | ❌ MISSING | S21/S23 |
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
| SRS-H1-09 | مراقبة تكامل خارجي: معدل نجاح/زمن/آخر فشل في لوحة الأدمن | لا لوحة، لا تكامل خارجي حقيقي | ❌ MISSING | S25 |
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
| SRS-H3A-08 | المرتجعات/المراجعات/التنبيهات: طلب إرجاع، قرار، مراجعة، إشعارات بحالة قراءة | **إشعارات بحالة قراءة مبنية الآن بالكامل** (S19)؛ طلب الإرجاع والقرار والمراجعة ما زالت غير موجودة إطلاقاً | 🟡 PARTIAL (ربعه عن الإشعارات DONE، الباقي MISSING بالكامل) | S19/S21/S23 |

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
| SRS-K1A-07 | طلبات العميل | موجودة؛ **إلغاء الطلب/الصنف، إعادة الجدولة، وطلب الاسترداد مبنية الآن**؛ بلا جدول زمني موحّد (قرار بنيوي، BR-028) وبلا إرجاع فعلي | 🟡 PARTIAL | S21 |
| SRS-K1A-08 | مساحة عمل المالك | مركز روابط فقط، أغلب الشاشات الفرعية API-only | 🟡 PARTIAL | S15-S18 |
| SRS-K1A-09 | مساحة عمل الموظف | طلبات الفرع فقط؛ لا ماسح/بيع فعلي | 🟡 PARTIAL | S18 |
| SRS-K1A-10 | ماسح المخزون والاستيراد | الاستيراد له واجهة كاملة الآن (S17: `/vendor/:id/offers/import`)؛ ماسح المخزون (قراءة باركود بالكاميرا) لا يزال API فقط بلا واجهة | 🟡 PARTIAL | S18 |
| SRS-K1A-11 | مساحة عمل الأدمن | API فقط بلا واجهة | 🟡 PARTIAL | S16 |

### حالات Empty/Loading/Error وRTL/A11y (تجميعي بدل تفكيك ~50 شاشة)

| ID | البوابة | ملاحظة | Status | Sprint |
|---|---|---|---|---|
| SRS-K1-STATES-01 | العميل (ويب) | حالات فارغة/تحميل/خطأ أساسية موجودة في بعض الصفحات (سلة، طلبات)؛ لا نمط موحّد مؤكَّد لكل شاشة | 🟡 PARTIAL | S25 |
| SRS-K1-STATES-02 | مساحة المالك/الموظف | معظم الشاشات API-only فلا حالات UI أصلاً | ❌ MISSING | S15-S18 |
| SRS-K1-STATES-03 | الإدارة | شاشات S16 لها loading/empty/error/forbidden/success؛ عارض التدقيق وإدارة الأدوار لاحقاً | 🟡 PARTIAL | S25 |
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
| L-19 | استرداد جزئي | لا استرداد مبني | ❌ MISSING | S21 |
| L-20 | توصيل مجزأ | لا شحنات متعددة لكل BranchOrder | ❌ MISSING | S26/قرار-نطاق |
| L-21 | عنوان توصيل غير صالح | تحقق العنوان موجود (S14)؛ لا خريطة (قرار معتمد) | ✅ DONE (ضمن القرار المعتمد) | - |
| L-22 | العميل خارج منطقة خدمة البائع | يتحول لاستلام فقط تلقائياً برسالة واضحة | ✅ DONE | - |
| L-23 | بائع مُعلَّق بطلبات نشطة | التعليق يُخفي المتجر ويمنع الطلبات الجديدة (بما فيها confirm لحجز قائم) وتعديل الكتالوج؛ الطلبات الجارية تستمر؛ تصنيف صريح لكل مسار vendors/:vendorId/* ويفشل اختبار على أي مسار غير مصنَّف | ✅ DONE | - |
| L-24 | دمج منتج بعد وجود طلبات تاريخية | لا دمج/فصل منتجات مبني | ❌ MISSING | S17b |
| L-25 | فشل استيراد جزئي | نجاح جزئي مع تقرير أخطاء لكل صف موجود | ✅ DONE | - |
| L-26 | نقص محتوى بلغة واحدة | لا fallback مؤشَّر بصرياً؛ الحقول ثنائية اللغة موجودة لكن العرض عربي فقط حالياً | 🟡 PARTIAL | S22 |
| L-27 | صورة مفقودة/غير لائقة | لا placeholder موحّد مؤكَّد؛ لا طابور إشراف صور | ❌ MISSING | S17b |
| L-28 | إدخال ضار (حقن) | `ValidationPipe` عام + Prisma يمنع حقن SQL بالتصميم؛ لم أتحقق من تعقيم كل حقل نصي حر للعرض | 🟡 PARTIAL | S25 |
| L-29 | تلاعب بالمراجعات | لا مراجعات مبنية أصلاً | ❌ MISSING | S23 |
| L-30 | انقطاع منصة/تكامل | لا مراقبة حالة/تكامل معروضة | ❌ MISSING | S25 |
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
| SRS-N-05 | تقييم جودة البيانات (اكتمال، شذوذ سعر) كإرشاد لا بوابة نشر | لا تسجيل اكتمال أو شذوذ سعر موجود | ❌ MISSING | S25 |

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
| SRS-P-04 | Feature flags | لا يوجد (FR-ADMIN-004 MISSING) | ❌ MISSING | S25 |
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
| SRS-P-15 | تصحيح بيانات عبر إجراء مدقَّق لا تعديل مباشر | لا واجهة تصحيح بيانات إدارية؛ أي تصحيح فعلي يتم عبر سكربتات/قاعدة مباشرة (خارج AuditLog) | ❌ MISSING | S25 |

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
| BL-AUTH-004 | Must | FR-AUTH-008 | 🟡 PARTIAL | منسوخ اليوم داخل checkout AddressForm |
| BL-AUTH-004b | Should | FR-AUTH-008 | 🟡 PARTIAL | شاشة عناوين منفصلة — لا تعديل/حذف/افتراضي |
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
| BL-COMP-001 | Must | FR-COMP-001 | ❌ MISSING | - |
| BL-COMP-002 | Must | FR-COMP-005 | 🟡 PARTIAL | - |
| BL-COMP-003 | Must | FR-COMP-009 | ↪ SUPERSEDED | استُبدل: PDR-001 يزيل FX كلياً |
| BL-COMP-004 | Should | FR-COMP-007 | 🟡 PARTIAL | - |
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
| BL-RET-001 | Should | FR-RET-002 | ❌ MISSING | - |
| BL-RET-002 | Should | BR-025 | ❌ MISSING | - |
| BL-RET-003 | Should | FR-RET-003 | ❌ MISSING | - |
| BL-REV-001 | Must | FR-REV-001 | ❌ MISSING | الأولوية الأصلية Must — لم يُبنَ إطلاقاً، فجوة حقيقية مقابل الالتزام الأصلي |
| BL-REV-002 | Must | FR-REV-002 | ❌ MISSING | نفس الملاحظة أعلاه |
| BL-REV-003 | Could | FR-REV-004 | ⏸ DEFERRED | - |
| BL-NOTIF-001 | Must | SRS-H1-08 | ❌ MISSING | - |
| BL-NOTIF-002 | Must | FR-NOTIF-003 | ❌ MISSING | - |
| BL-NOTIF-002b | Should | FR-NOTIF-003 | ❌ MISSING | - |
| BL-NOTIF-003 | Should | FR-FAV-001 | 🟡 PARTIAL | - |
| BL-NOTIF-004 | Could | FR-FAV-003 | ❌ MISSING | - |
| BL-ADMIN-001 | Must | FR-VEND-009 | ✅ DONE | قائمة المتاجر وتعليق/إعادة تفعيل وطابور الموافقة مبنية (S16) |
| BL-ADMIN-001b | Should | FR-ADMIN-001 | 🟡 PARTIAL | - |
| BL-ADMIN-002 | Must | FR-ADMIN-001 | 🟡 PARTIAL | - |
| BL-ADMIN-003 | Should | FR-ADMIN-005 | ❌ MISSING | - |
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
| AC-12 | إرجاع صنف مسلَّم من شحنة مجزأة | ❌ MISSING |
| AC-13 | رفض إرجاع صنف لم يُسلَّم بعد | ❌ MISSING |
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

**ملاحظة جوهرية قبل الجدول:** آلات E.11 (`CustomerOrder`/`VendorSuborder`/`OrderItem`/`Payment`/`Delivery`) تصف **النموذج الذي سبق PDR-004/PDR-005** (تحقّقت من الكود: لا حقل `status` على `CustomerOrder` إطلاقاً، لا تجميع rollup، `PaymentTransactionStatus` مبسَّط لحالتين فقط `SUCCEEDED`/`FAILED` لا الحالات الثماني الأصلية، لا كيان `Delivery`/`Fulfillment` منفصل، ولا موظف "سائق"). لذلك **معظم صفوف VendorSuborder/Payment/Delivery القديمة SUPERSEDED بالتصميم الفعلي (`BranchOrderStatus` + `PaymentTransaction` المبسَّط)**، وليست فجوة. الصفوف التي تصف **إرجاعاً** تبقى MISSING فعلياً (الإرجاع غير مبني بأي نموذج، قديم أو جديد). آلة `Return` بالكامل (9 صفوف) تُدرَج مرة واحدة كمجموعة لأن كل صفوفها MISSING بنفس السبب.

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
| SRS-E11-VS-16 | `Completed→ReturnRequested` | لا إرجاع مبني | ❌ MISSING |
| SRS-E11-VS-17 | `ReturnRequested→ReturnedRefunded` | لا إرجاع مبني | ❌ MISSING |

### OrderItem (4 صفوف، الآن BranchOrderItem)

| ID | الانتقال | الحالة الفعلية | Status |
|---|---|---|---|
| SRS-E11-OI-01 | إنشاء يرث حالة الأب | `BranchOrderItem` بلا حقل status خاص به أصلاً — يتبع الأب بالضرورة البنيوية | ✅ DONE (بالغياب المتسق) |
| SRS-E11-OI-02 | الأب يكتمل → الصنف يكتمل | نفس السبب أعلاه | ✅ DONE |
| SRS-E11-OI-03 | طلب إرجاع لصنف محدد | لا إرجاع مبني | ❌ MISSING |
| SRS-E11-OI-04 | استرداد الصنف | لا إرجاع مبني | ❌ MISSING |

### Payment (14 صفاً، الآن PaymentTransaction مبسَّط)

| ID | الانتقال (بالاسم القديم) | مقابله الفعلي | Status |
|---|---|---|---|
| SRS-E11-PM-01 | `[*]→PendingAuthorization` | لا حالة معلّقة وسيطة؛ الشحن sandbox متزامن | ↪ SUPERSEDED |
| SRS-E11-PM-02 | `PendingAuthorization→Authorized` | يقابله مباشرة `SUCCEEDED` | ✅ DONE (بتبسيط معتمد) |
| SRS-E11-PM-03 | `PendingAuthorization→Failed` | يقابله `FAILED` | ✅ DONE |
| SRS-E11-PM-04 | `Authorized→Captured` | لا فصل تفويض/التقاط؛ خطوة واحدة | ↪ SUPERSEDED |
| SRS-E11-PM-05 | `Authorized→Failed` (انتهاء نافذة الالتقاط) | غير منطبق | ↪ SUPERSEDED |
| SRS-E11-PM-06 | `Captured→Settled` | لا تسوية مصرفية منفصلة (sandbox) | ↪ SUPERSEDED |
| SRS-E11-PM-07 | `Captured→Refunded` | لا استرداد مبني | ❌ MISSING |
| SRS-E11-PM-08 | `Captured→PartiallyRefunded` | لا استرداد مبني | ❌ MISSING |
| SRS-E11-PM-09 | `Settled→Refunded` | لا استرداد مبني | ❌ MISSING |
| SRS-E11-PM-10 | `Settled→PartiallyRefunded` | لا استرداد مبني | ❌ MISSING |
| SRS-E11-PM-11 | `PartiallyRefunded→Refunded` | لا استرداد مبني | ❌ MISSING |
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

### Return (9 صفوف منفصلة — كلها MISSING لنفس السبب: لا نموذج إرجاع من أي نوع مبني في الكود)

| ID | الانتقال | الحالة الفعلية | Status | Sprint |
|---|---|---|---|---|
| SRS-E11-RT-01 | `[*]→Requested` | لا نموذج إرجاع مبني | ❌ MISSING | S21 |
| SRS-E11-RT-02 | `Requested→VendorReview` | لا نموذج إرجاع مبني | ❌ MISSING | S21 |
| SRS-E11-RT-03 | `VendorReview→Approved` | لا نموذج إرجاع مبني | ❌ MISSING | S21 |
| SRS-E11-RT-04 | `VendorReview→Rejected` | لا نموذج إرجاع مبني | ❌ MISSING | S21 |
| SRS-E11-RT-05 | `VendorReview→Escalated` (SLA breach) | لا نموذج إرجاع مبني | ❌ MISSING | S21 |
| SRS-E11-RT-06 | `Rejected→Escalated` (العميل ينازع) | لا نموذج إرجاع مبني | ❌ MISSING | S21 |
| SRS-E11-RT-07 | `Escalated→Approved/Rejected` | لا نموذج إرجاع مبني | ❌ MISSING | S21 |
| SRS-E11-RT-08 | `Approved→RefundProcessing` | لا نموذج إرجاع مبني | ❌ MISSING | S21 |
| SRS-E11-RT-09 | `RefundProcessing→Refunded` | لا نموذج إرجاع مبني | ❌ MISSING | S21 |

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
