# FINALPRO — Post-Sprint-3 Replan (September 2026)

**Date:** 2026-09-19
**Author:** Developer, for product-owner/Codex review.
**Status:** Draft — proposed backlog re-plan, not yet approved. Nothing here authorizes starting Sprint 4.
**Authority:** This document does not create or change any product decision. Every requirement it plans against is already decided in [`approved-product-decisions-2026-09.md`](approved-product-decisions-2026-09.md) (PDR-001–034) or already-shipped Sprint 1–3 code, audited in [`sprint-1-3-compatibility-audit-2026-09.md`](sprint-1-3-compatibility-audit-2026-09.md). Where this document proposes an estimate, a sprint order, or a scope cut, that is engineering planning — explicitly flagged as **PROPOSED**, not decided — and remains subject to product-owner/Codex review, per the approved baseline's own §7 change-control rule.
**Reason this document exists:** `docs/srs/08-backlog-sprint-plan.md` (Part 8) already carries a "September 2026 replan gate" note stating its 65-item/18.6-person-week plan is not an authorized Sprint 4+ commitment. This document is that required replan.

---

## 1. What Sprints 1–3 actually delivered, and what's left

This section summarizes the [compatibility audit](sprint-1-3-compatibility-audit-2026-09.md); it does not re-litigate it. Read that document for the full finding-by-finding detail.

### 1.1 Delivered and compatible (retain, extend — do not rebuild)

- **Foundation** (Sprint 1): API error/correlation-ID conventions, idempotency-claim/completion atomicity, `AuditLog`/`OutboxEvent` infrastructure, Postgres/Redis/CI. No product-decision conflict.
- **Identity** (Sprint 2): phone/password/OTP auth, session-version invalidation, password-reset atomicity, customer profile/address baseline.
- **Catalog/matching/verification/subscription** (Sprint 3, as merged after remediation): category tree, brand normalization, the four-level `CanonicalProduct`/`CanonicalProductVariant`/`VendorOffer`/`OfferVariant` schema, exact-identifier match **proposal** (never auto-link — vendor confirms, FR-MATCH-012), vendor physical-branch verification evidence/decision workflow with concurrency-safe locking, reapplication after rejection (PDR-010), and the unified one-month sandbox subscription (PDR-033, ILS-only, no Basic/Pro).
- A genuine, reusable **durability pattern**: every mutating endpoint above uses transactional idempotency completion, row-level or advisory locks under concurrency, and atomic audit writes. This pattern is not in the old Part 8 estimate at all — it is extra, paid-for infrastructure that every feature below reuses at no additional listed cost, the same way the compatibility audit's §3.3 calls it out as a strength to preserve.

### 1.2 Explicitly not built yet (real gaps, not silent omissions)

Per the compatibility audit's §3.2 (S3-M01–M07): no employee role/branch assignment, no online-only/hybrid store model (only a physical-branch `isPhysical` boolean), no storefront/public-discovery model, no barcode split (store-inventory vs platform-shared), no media/import/non-exact-matching-review-queue, no bilingual source/translation semantics beyond the existing `titleAr`/`titleEn` fields, and — separately, found during Sprint 3 remediation review — no canonical-name-adoption/rename-approval flow (§3.2 of the approved baseline, tracked in code as a documented, deliberately-not-built gap).

None of this is a defect in Sprint 1–3; it is exactly the scope that PDR-001–034 either newly requires or substantially redesigns. §2 below plans it.

---

## 2. New work, decomposed into buildable features

Each feature below lists sub-items with a **T-shirt estimate** (same convention as the historical Part 8: S ≈ 0.2 person-weeks/1 day, M ≈ 0.5 pw/2.5 days, L ≈ 1.0 pw/1 week, for the 2-person team), its **dependencies**, and a **Must/Should** tag against the FYP Delivery Increment (§4 explains the cut). Item IDs use a new `RB-*` (replan-backlog) prefix so they're never confused with the historical `BL-*` IDs in Part 8, which this document does not renumber or delete.

### 2.1 Owner/employee roles and permissions (PDR-008/009)

Build first — every other area's authorization model depends on it.

| ID | Item | Est. | Priority |
|---|---|---|---|
| RB-ROLE-001 | Extend `VendorUserRole` (`OWNER`, `BRANCH_EMPLOYEE`); add a nullable `branchId` on `VendorUser`, required exactly when role is `BRANCH_EMPLOYEE` | S | Must |
| RB-ROLE-002 | OTP-based staff invite: owner invites a phone number to a specific branch; invitee sets a password via OTP, same pattern as signup | M | Must |
| RB-ROLE-003 | Transfer/disable an employee (reassign `branchId`; disable revokes sessions immediately, audit retained per PDR-009) | S | Should |
| RB-ROLE-004 | Least-privilege authorization guard: an employee's every request is scoped to their own branch's orders/stock; an owner is scoped to the whole vendor. No employee action can touch prices, media, descriptions, store configuration, analytics, or another branch (PDR-009) | M | Must |
| RB-ROLE-005 | Role/workspace switcher UI: one account moves between its customer session and any vendor workspace it holds a role in (PDR-008) | M | Must |
| RB-ROLE-006 | Negative-permission regression tests (employee blocked from every owner-only action; employee blocked from a branch it isn't assigned to) | S | Must |

**Subtotal:** Must 1.9 pw, Should 0.2 pw.

### 2.2 Physical / online-only / hybrid stores, warehouse, pickup points (PDR-010, PDR-022)

Depends on: none new (extends the existing `Vendor`/`StoreBranch` schema).

| ID | Item | Est. | Priority |
|---|---|---|---|
| RB-STORE-001 | Schema: store type (physical / online-only / hybrid), one hidden warehouse execution location per online-only/hybrid store, `PickupPoint` entity (address/map/hours/slots, explicitly holds no stock) | M | Must |
| RB-STORE-002 | Store-wide delivery-zone config (West Bank / Jerusalem / Inside, each independently disableable, PDR-022) — uses a **placeholder static zone list** pending ⚠ OPEN-012's real boundary source | S | Must |
| RB-STORE-003 | Branch/pickup-point lifecycle: temporarily close (visible, unavailable for new work, existing work finishes) vs permanently archive/reactivate; never hard-delete | S | Should |
| RB-STORE-004 | Online-only verification policy UI (identity/business material, external contact, product media) | M | Should — blocked on ⚠ OPEN-011; build the evidence-capture schema flexibly now, finalize required-document specifics once OPEN-011 resolves |

**Subtotal:** Must 0.7 pw, Should 0.7 pw.

**FYP demo scope note (review-round finding):** RB-STORE-001 is the data model only — a store can be *flagged* online-only/hybrid, have a warehouse row, and have pickup points, and every downstream feature (inventory, checkout, storefront) can be built and demoed against that data. It does **not** include a working online-only/hybrid *verification* path — that is RB-STORE-004, Should, blocked on ⚠ OPEN-011 regardless of engineering effort (the required evidence documents themselves aren't decided yet). The FYP demo therefore seeds an online-only/hybrid store directly (admin-created or fixture data, the same way Sprint 1–3 seeds test data today), the same way it always could for a physical store before BL-VEND-003 existed — it does **not** claim a customer-facing self-service online-only application/verification flow. That claim will only be true once RB-STORE-004 ships, which is explicitly Should, not scheduled in §5.

### 2.3 Barcode, branch inventory, inventory movements, scanner (PDR-018–021)

Depends on: 2.2 (branch/warehouse structure), 2.1 (employee-scoped stock actions).

| ID | Item | Est. | Priority |
|---|---|---|---|
| RB-INV-001 | Split `store_inventory_barcode` (required, unique per store, scanner-facing) from internal `platform_product_barcode` (auto-generated if no manufacturer code exists, stable, never shown to customers, survives the first offer being archived/deleted/unmatched) | M | Must |
| RB-INV-002 | Branch-level stock table (stock is per branch/variant, no cross-branch transfer in phase 1) | M | Must |
| RB-INV-003 | Manual non-sale stock-adjustment flow: mandatory reason, immediate owner notification regardless of amount (PDR-021), full movement/audit log | S | Must |
| RB-INV-004 | Physical-sale scanner flow: scan barcode → select colour/size → quantity → confirm → atomic branch-level decrement, recording only the stock movement (no receipt/payment capture, PDR-020) | M | Should — a manual stock-edit screen (already in RB-INV-002/003) demonstrates the same "branch stock drives public availability" mechanic for the FYP demo; the scan-first UX is real but not exit-criteria-blocking |
| RB-INV-005 | Concurrency tests: atomic decrement never takes stock below zero under concurrent sales/checkout (reuse the advisory-lock/atomic-decrement pattern already proven in Sprint 3) | S | Must |

**Subtotal:** Must 1.4 pw, Should 0.5 pw.

### 2.4 Media, import, matching review queue, canonical naming (§3.2 of the approved baseline)

Depends on: none new (extends existing `OfferVariant`/matching schema); can run in parallel with 2.2/2.3.

| ID | Item | Est. | Priority |
|---|---|---|---|
| RB-MATCH-001 | Basic media: a primary image plus additional images per offer variant (full 10-image/3-video-×-60s breadth is Should) | S | Must |
| RB-MATCH-001b | Full media breadth (up to 10 images, 3 videos ≤60s, reorder/replace, every item a matching signal, re-run matching on edit) | S | Should |
| RB-MATCH-002 | Non-exact match review queue: structured-attribute + text-similarity ranking, human approve/reject/re-search UI (image-similarity scoring is Should) | M | Must |
| RB-MATCH-002b | Image-similarity ranking added to the review queue | M | Should |
| RB-MATCH-003 | Canonical-name adoption on confirm (first confirmed offer supplies the provisional name; a later matching vendor adopts it) + admin approve/reject queue for a vendor-requested rename — the gap explicitly flagged, not built, during Sprint 3 remediation | M | Must |
| RB-MATCH-004 | CSV/Excel import extended for the new required publish fields (barcode, condition, five category-specific fields) — Sprint 3 never built an import pipeline at all (compatibility audit S3-M05) | M | Must |

**Subtotal:** Must 1.7 pw, Should 0.7 pw.

### 2.5 Storefront, sections, follow, public discovery, comparison (PDR-011–017)

Depends on: 2.4 (comparison needs a stable canonical name/matched offers), 2.1 (owner-only editing rights).

| ID | Item | Est. | Priority |
|---|---|---|---|
| RB-STOREF-001 | Public storefront page: stable slug, display name, logo, bio, cover image/colour, contacts (Instagram/Facebook/WhatsApp — at least one required, PDR-007) | M | Must |
| RB-STOREF-002 | Store sections: fixed **All**, automatic **New arrivals**/**Discounts**, up to 20 custom sections (CRUD, reorder, a product in several sections, delete removes only the grouping) | M | Must |
| RB-STOREF-003 | Follow + the external Following page (per-event notification, not aggregated; inactive-store fading) | M | Should — a real engagement feature, not required to demonstrate the core comparison mechanic |
| RB-STOREF-004 | Public discovery: the **All** page only for the FYP (Women/Men/Kids/Accessories segment pages are Should) | S | Must |
| RB-STOREF-004b | The four segment discovery pages | S | Should |
| RB-COMP-001 | Global comparison card (lowest available ILS price, up to 5 clickable store logos) + comparison list (variant-filtered, 4–6/1–2 grid, tie-break by rating then proximity) | L | Must — this is the platform's stated core differentiator; it stays Must the same way the historical EPIC-COMP did |
| RB-COMP-002 | Ranking algorithm: store hero 40/30/30 (views/newness/rating), product feed 40/30/30 (views/newness/discount), deterministic ties/cold-start | S | Should — a simple newest-first fallback is enough to demo comparison itself; the weighted formula is refinement |

**Subtotal:** Must 2.2 pw, Should 0.9 pw.

### 2.6 BranchOrder, checkout, and payment (PDR-002–005, PDR-023, PDR-029)

Depends on: 2.1 (who may act on a BranchOrder), 2.2 (branch/pickup eligibility), 2.3 (stock to decrement). This is the largest single area and the platform's riskiest mechanic, exactly as it was in the historical plan — kept almost entirely Must here too.

| ID | Item | Est. | Priority |
|---|---|---|---|
| RB-ORD-001 | `BranchOrder` data model + state machine: the operational unit is the branch, not the vendor; one fulfilment method/fee/status/payment choice per BranchOrder; a checkout with items no single branch can fully cover creates separate BranchOrders | L | Must |
| RB-ORD-002 | Checkout redesign: explicit item selection at checkout (not at add-to-cart), fulfilment-group formation by eligible branch, 10-minute stock reservation + **reserving a slot on RB-FUL-001's calendar** (which must already exist — see §2.7's binding order), price-change disclosure within the same quote window | L | Must |
| RB-ORD-003 | ILS-only payment allocation: one sandbox electronic transaction covers every online-paid BranchOrder in a checkout; COD/pay-at-pickup collected per branch; no FX/mixed-currency logic (PDR-001/005 — simpler than the old FX-aware design) | M | Must |
| RB-ORD-004 | Pay-at-pickup six-digit code; staff view limited to name/phone/code (no address) | S | Must |
| RB-ORD-005 | Orders UI: BranchOrder cards grouped by branch even within the same store; one cross-store Orders experience for the customer | M | Must |

**Subtotal:** Must 3.2 pw, Should 0 pw.

### 2.7 Calendar, delivery, returns, notifications (PDR-024–031)

Depends on: **split within this area, review-round correction.** RB-FUL-001 (calendar/slot *definition*) only needs a branch to exist (2.2) and, per the binding order below, lands right after RB-ORD-001's `BranchOrder` schema — it does **not** wait for checkout. Everything else in 2.7 — delivery *execution* (RB-FUL-002 onward) and returns — genuinely needs a real `BranchOrder` *instance* to act on, i.e., RB-ORD-002's checkout complete. **Binding internal order (review-round finding):** `RB-ORD-001` (BranchOrder schema) → `RB-FUL-001` (calendar/slot setup) → `RB-ORD-002` (checkout, which is what actually reserves a slot for 10 minutes) — checkout cannot reserve a slot that doesn't exist yet, and slot setup has no reason to wait for checkout since it only configures a branch's own hours/capacity.

| ID | Item | Est. | Priority |
|---|---|---|---|
| RB-FUL-001 | Branch delivery-slot calendar **setup** (configurable non-overlapping hours, capacity, exceptions) — the customer's next-3-days slot *picker* is part of RB-ORD-002's checkout, which consumes this | M | Must — must land after `RB-ORD-001`, before `RB-ORD-002` (see binding order above); checkout (PDR-023) cannot reserve a slot that doesn't exist |
| RB-FUL-002 | Sent → Delivered → customer-confirm flow (48h reminder, 72h auto-confirm; "not received" redirects to external store contact, no in-platform dispute) — the BR-DELIVERY-CONFIRM successor and the FYP's core trust-loop notification | S | Must |
| RB-FUL-003 | Notification dispatch for the Sent/Delivered/confirm loop only (full notification-centre UI — unread state, deep links, every event type — is Should) | S | Must |
| RB-FUL-003b | Full notification centre UI | S | Should |
| RB-FUL-004 | Delayed-preparation handling: 6h-before reminder; unprepared-at-slot triggers online refund or COD re-slot within 48h | M | Should — an edge-case policy layer on top of RB-FUL-001, not required for a clean happy-path demo |
| RB-FUL-005 | Failed-delivery policy (first failure → re-slot within 2 days; COD cancels on second failure; online continues, refund on request) | S | Should |
| RB-FUL-006 | Address-change-before-preparation logic (unsupported-address fallback: cancel, convert to pickup, or another address) | S | Should |
| RB-FUL-007 | Item/order cancellation rules across the before-prep / after-prep-before-sent / after-sent states | S | Should |
| RB-RET-001 | Store return-policy snapshot at purchase; return/exchange request flow (48h/72h SLA, six-digit code, branch-wide acceptance) | M | Should — mirrors the historical EPIC-RET's demotion; valuable, not exit-criteria-blocking |

**Subtotal:** Must 0.9 pw, Should 1.8 pw.

### 2.8 Full-scope total

| Area | Must (pw) | Should (pw) |
|---|---|---|
| 2.1 Roles | 1.9 | 0.2 |
| 2.2 Store model | 0.7 | 0.7 |
| 2.3 Barcode/inventory | 1.4 | 0.5 |
| 2.4 Media/import/matching | 1.7 | 0.7 |
| 2.5 Storefront/discovery/comparison | 2.2 | 0.9 |
| 2.6 BranchOrder/checkout/payment | 3.2 | 0 |
| 2.7 Calendar/delivery/returns/notif | 0.9 | 1.8 |
| **Total** | **12.0** | **4.8** |

Full scope (Must + Should) is **16.8 person-weeks** of genuinely new work — before even counting the already-consumed Sprint 1–3 capacity. §3 shows this against real remaining capacity.

---

## 3. Capacity math (≥20% reserve, per the required floor)

**Constraint, unchanged from the FYP charter:** 2 people, 3 months, 12 weekly sprints, **24 gross person-weeks**.

**Sprints 1–3 consumed:** the audited Sprint 1–3 scope (§1.1) corresponds to roughly the historical Part 8's Sprints 1–3 (Foundation, Identity, and the catalog/matching/verification/subscription slice) — **≈5.7 pw** by that plan's own item-level sizing — plus real, unplanned extra investment in the concurrency/idempotency/durability hardening described in §1.1, which the historical estimate never itemized at all. Rounding generously for that extra hardening, **Sprints 1–3 consumed ≈6 gross person-weeks (3 of the 12 sprint-slots).**

**Remaining gross capacity:** 24 − 6 = **18 person-weeks (9 sprint-slots, Sprint 4–12).**

**Required reserve:** at least 20% of the remaining total must sit unallocated to integration, bug-fixing against real pilot/beta data, and planning overhead — the same standard the historical Part 8 used (it ended up at ≈23%). 20% of 18 pw = 3.6 pw minimum reserve, meaning **committed work must not exceed 14.4 pw.**

**§2.8's Must-only total is 12.0 pw** — under the 14.4 pw ceiling, leaving **6.0 pw (≈33%) actually reserved.** This is deliberately more than the 20% floor: RB-ROLE, RB-STORE, RB-INV, and RB-ORD are largely new architecture (no Sprint 1–3 precedent to estimate from, unlike e.g. a search or comparison feature that only extends an existing schema), so estimation risk is higher than on incremental work. The extra ≈13 points of reserve above the floor is a deliberate hedge against that risk, not slack left on the table by mistake.

**Should-priority items (4.8 pw) are not committed** inside this window. They remain fully specified in §2 and are picked up only if a sprint finishes under budget — exactly the historical Part 8's own convention, carried forward rather than reinvented.

---

## 4. FYP Delivery Increment: what's in the demo, what's deferred

**In the demo (Must, §2, 12.0 pw):** an owner/employee account with correctly scoped permissions; a store correctly typed physical/online-only/hybrid, with branch or warehouse+pickup-point *data model* in place (**not** a working online-only/hybrid self-service verification flow — that's RB-STORE-004, Should, blocked on OPEN-011 regardless of effort; the demo's online-only/hybrid store is seeded, not applied-and-verified through the UI, the same way Sprint 1–3's own physical-store data was seeded before BL-VEND-003 existed — see §2.2's demo-scope note); branch-level inventory with a real barcode and audited manual stock adjustments; vendor-confirmed exact matches plus a working non-exact review queue, both feeding a real shared canonical product name; a public storefront with sections; the global comparison card/list (the platform's core mechanic); a BranchOrder-based checkout with ILS sandbox payment and pickup codes; a branch delivery calendar; the Sent→Delivered→confirm notification loop. This is a complete, honest, end-to-end path — not a subset that skips the platform's own differentiator.

**Explicitly deferred, not deleted (Should, §2, 4.8 pw):** employee transfer/disable UI, the full online-only verification-document UI (blocked on OPEN-011 regardless), branch/pickup archive UI, the barcode-scanner UX (manual stock edit substitutes), image-similarity match ranking, full 10-image/3-video media breadth, follow/Following page, the four discovery segment pages beyond All, the weighted ranking formula (a simple newest-first fallback substitutes), delayed-preparation/failed-delivery/address-change/cancellation edge-case policies, the full notification-centre UI, and the entire returns/exchange flow — mirroring the historical EPIC-RET's own demotion for the same reason (valuable, not exit-criteria-blocking).

Every deferred item above is specified in §2 with its own estimate and stays in this backlog as `Should`/`Full MVP`, per the approved baseline's own instruction (§1: "not a silent scope cut").

---

## 5. Correct execution order (avoids the old plan's circular-dependency trap)

The historical Part 8 had to fix, in review, a first draft where checkout was scheduled before the order/payment/notification infrastructure it actually needed. The same class of trap exists here — so the order below is fixed at authoring time, not left for a review round to catch, and includes one internal correction found during review of this document's first draft: calendar/slot *setup* does not need to wait for checkout, only checkout's slot *reservation* does.

**2.1 Roles → 2.2 Store model → 2.3 Inventory/barcode → (parallel) 2.4 Media/import/matching-naming → 2.5 Storefront/comparison → `RB-ORD-001` (BranchOrder schema) → `RB-FUL-001` (calendar/slot setup) → `RB-ORD-002` (checkout, which reserves a slot) → the rest of 2.6 → the rest of 2.7 (delivery execution/returns, which need a real BranchOrder instance).**

2.4 has no hard dependency on 2.2/2.3 and can run alongside them if the team splits work (mirrors the historical plan's parallel-workstream note). **Correction from this document's first review round:** 2.7 is not a single monolithic block that "cannot start until 2.6 produces a BranchOrder" — only its *delivery-execution* half (RB-FUL-002 onward) and returns (RB-RET-001) genuinely need a real BranchOrder instance, i.e., checkout (`RB-ORD-002`) complete. Its calendar/slot-*definition* half (`RB-FUL-001`) only needs a branch (2.2) and, per the binding order above, is scheduled right after `RB-ORD-001`'s schema lands and *before* `RB-ORD-002`'s checkout — checkout is what actually reserves a slot, so a slot has to already exist for it to reserve.

### Proposed sprint sequencing (Sprint 4–11, PROPOSED not decided)

**Review-round correction:** the first draft packed Sprints 4–9 to 1.9–2.0 pw each and left almost all reserve sitting in Sprints 10–12 — exactly the failure mode the historical Part 8 had to fix once already (problems surface in the risky *build* sprints, not just at the end). Re-spread below across one more sprint (4–11, not 4–10) so every sprint — especially 4–6 (new roles/store/inventory architecture) and 9–10 (BranchOrder/checkout, the riskiest mechanic) — carries its own visible slack, not just a number at or near the 2.0 pw ceiling.

| Sprint | Must load (pw) | In-sprint slack | Scheduled Must items | Goal |
|---|---|---|---|---|
| 4 | 1.7 | 0.3 (15%) | RB-ROLE-001, 002, 004, 005 | Owner/employee roles functional, least-privilege enforced |
| 5 | 1.4 | 0.6 (30%) | RB-ROLE-006; RB-STORE-001, 002; RB-INV-001 | Roles tested; store types + warehouse/pickup points; barcode split starts |
| 6 | 1.6 | 0.4 (20%) | RB-INV-002, 003, 005; RB-MATCH-001, 002 | Branch inventory complete with audited adjustments, concurrency proven; media + non-exact review queue start |
| 7 | 1.5 | 0.5 (25%) | RB-MATCH-003, 004; RB-STOREF-001 | Canonical naming + import pipeline done; storefront page starts — **Replan gate 1** |
| 8 | 1.7 | 0.3 (15%) | RB-STOREF-002, 004; RB-COMP-001 | Store sections + discovery All page; global comparison live — **Replan gate 2** |
| 9 | 1.5 | 0.5 (25%) | RB-ORD-001; RB-FUL-001 | BranchOrder schema/state machine; delivery calendar setup (binding order: before checkout) |
| 10 | 1.7 | 0.3 (15%) | RB-ORD-002, 003, 004 | Checkout redesign complete (reserves calendar slots); ILS payment allocation; pickup code — **Replan gate 3 (core commerce restored)** |
| 11 | 0.9 | 1.1 (55%) | RB-ORD-005; RB-FUL-002, 003 | Orders UI; Sent/Delivered/confirm loop + its notification dispatch live — **Replan gate 4**; customer beta may start |
| 12 | 0 | 2.0 (100%) | — | Hardening, demo rehearsal, pilot/beta bug-fixing — **Replan gate 5 (FYP exit criteria)** |

Total scheduled Must: 1.7+1.4+1.6+1.5+1.7+1.5+1.7+0.9 = **12.0 pw**, matching §3 exactly. Total reserve: 0.3+0.6+0.4+0.5+0.3+0.5+0.3+1.1+2.0 = **6.0 pw (≈33%)**, matching §3 exactly — but now genuinely distributed: every sprint from 4 through 11 carries visible in-sprint slack (15–55%), not just the two sprints at the very end. Sprint 12 remains fully open, the same dedicated stabilization role the historical Part 8 gave its own final sprint.

---

## 6. Release gates (proposed)

1. **End of Sprint 7:** roles, store typing, branch inventory, and matching/naming all functional — a vendor can run a correctly-typed store with scoped staff and correctly-matched, named, in-stock offers.
2. **End of Sprint 8:** public storefront + comparison live — the customer-facing discovery/comparison path is real, not a stub.
3. **End of Sprint 10:** BranchOrder checkout/payment/calendar-reservation functional end-to-end — core commerce is restored under the new model.
4. **End of Sprint 11:** the full order-to-delivery-confirmation loop is live (Orders UI, Sent/Delivered/confirm, its notifications) — the *entire* customer journey, not just checkout, is real.
5. **End of Sprint 12:** FYP Delivery Increment exit criteria met, demo-ready (mirrors the historical Part 8's own Release gate 3).

**Vendor pilot** can begin once gate 1 is met (Sprint 7), the same point in the sequence the historical plan used (vendor-side functionality ready). **Customer beta** starts once gate 4 is met (Sprint 11) — **not** gate 3 (Sprint 10): starting beta once checkout works but before Sent/Delivered/confirm exists would put real customers through an order they can never actually see through to completion, the same reasoning the historical plan already applied to its own beta-start date (it waited for the *entire* loop, not just the riskiest single piece of it).

---

## 7. Open questions carried into this plan

No new open items are introduced here. These already-registered items directly gate specific §2 work and are called out at the item level above; nothing in this plan invents a fix for them:

| ID | Affects | Placeholder used for this plan |
|---|---|---|
| ⚠ OPEN-011 | RB-STORE-004 (online-only verification evidence) | Evidence schema built flexibly now; exact required documents finalized once decided — item stays Should until then regardless |
| ⚠ OPEN-012 | RB-STORE-002 (delivery-zone boundaries) | Static placeholder zone list (West Bank/Jerusalem/Inside as named regions, no precise geographic boundary) |
| ⚠ OPEN-013 | RB-MATCH-004 / the existing `BL-CAT-004b` fallback | The current single free-text specs field continues as the FYP fallback for the five-required-field rule until a taxonomy workshop defines per-category fields |
| ⚠ OPEN-001, OPEN-004, OPEN-009 | Unchanged from the approved baseline — production payment/SMS providers and legal/tax parameters | No FYP-window impact; sandbox/logged-fallback/flagged behavior continues as already decided |

---

## 8. Proposed edit to the historical Part 8 (flagged, not applied)

`docs/srs/08-backlog-sprint-plan.md` already carries a replan-gate note pointing forward to "the new BranchOrder, storefront, role, inventory, online-store, delivery, return and ILS-only backlog items" being decomposed and scheduled. **Proposed, single-sentence addition** to that existing note once this document is reviewed and approved — not applied in this PR:

> "This replan is provided in [`post-sprint3-replan-2026-09.md`](../post-sprint3-replan-2026-09.md)."

No other change to Part 8 is proposed here. Its historical `BL-*` item tables, sprint plan, and capacity notes remain as a record of what Sprints 1–3 were originally planned against; they are superseded for Sprint 4+ by this document, not deleted or rewritten.
