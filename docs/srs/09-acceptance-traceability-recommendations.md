# SRS — Part 9: Acceptance Criteria, Traceability Matrix, and Final Recommendations

The final part of this SRS. Builds on every prior part and closes the master prompt's required structure: Section 8 (acceptance criteria), Section 9 (traceability), and Section 10 (final recommendations).

> **September 2026 change-control notice:** The original acceptance set/traceability matrix predates the approved [product-decision baseline](../approved-product-decisions-2026-09.md). Historical scenarios using vendor-only suborders, guest carts or FX are superseded where they conflict with the amendment scenarios below. The full matrix must be regenerated after Part 8 is re-estimated; it must not be represented as complete in the meantime.

---

## Acceptance criteria (Given/When/Then)

### September 2026 amendment scenarios

| # | Category | Scenario (Given/When/Then) | Tags |
|---|---|---|---|
| AC-18 | Branch-order formation | **Given** a signed-in customer selects two cart lines that Branch Nablus can both fulfil and one line only Branch Ramallah can fulfil, **when** they request a checkout quote, **then** the platform proposes one Nablus BranchOrder and one Ramallah BranchOrder; the unselected cart line remains in cart. | FR-CART-017/018, FR-ORD-009, `TC-CHECKOUT-004` |
| AC-19 | Least privilege | **Given** an account with a customer and branch-employee grant, **when** it opens employee workspace, **then** it can process only its assigned branch’s orders/stock and receives `403` for price, analytics or another branch; switching to customer workspace retains only its own customer data. | FR-VEND-013, FR-VPORTAL-007, `TC-ROLE-001` |
| AC-20 | ILS-only validation | **Given** an owner edits an offer/import row, **when** it provides a non-ILS currency or FX value, **then** validation rejects it; a valid ILS price appears unchanged in global comparison and checkout. | FR-PRICE-008, BR-027, `TC-ILS-001` |
| AC-21 | Stock movement and alert | **Given** a branch employee records a one-unit damage correction, **when** it submits a mandatory reason, **then** branch stock changes atomically, an audit movement is retained and owner notification is created regardless of quantity. | FR-INV-010, BR-031, `TC-STOCK-002` |
| AC-22 | Online-only privacy | **Given** an online-only store with a hidden warehouse and two public pickup points, **when** a customer views its store and checks out using pickup, **then** both pickup points may be shown/selected but warehouse address and stock location are never returned. | FR-VEND-012, `TC-ONLINE-001` |

Per the master prompt, this is a **representative set**, not exhaustive coverage of every `FR-*` — consistent with how Part 4 treated the API endpoint inventory and Part 6 treated test scenarios. Each scenario below is chosen to cover one of the required categories (happy path, validation failure, permission failure, empty state, integration failure, duplicate request, concurrency, audit record, Arabic/RTL) against the platform's highest-risk mechanics, and is tagged to its `TC-*` test (Part 6, O.2) and `FR-*`/`BR-*` IDs.

| # | Category | Scenario (Given/When/Then) | Tags |
|---|---|---|---|
| AC-01 | Happy path | **Given** a customer has items from two vendors in their cart, **when** they complete checkout with a valid address, two phone numbers, and COD selected for both vendors, **then** the platform creates one `CustomerOrder` with two `VendorSuborder`s, both starting in `PendingConfirmation`, and both vendors receive their BR-DELIVERY-CONFIRM triple notification (in-app + 2 SMS legs, or the FYP logged fallback). | FR-CART-006/011, BR-020, `TC-CART-001` |
| AC-02 | Validation failure | **Given** a customer's cart contains an item from a vendor whose delivery zone doesn't cover the customer's address, **when** the customer attempts checkout without switching that vendor's partition to pickup, **then** checkout is blocked for that partition only (the rest of the cart remains checkout-eligible) and the UI shows "Delivery unavailable here — pickup only" (Part 5, L-22). | BR-006, FR-CART-004 |
| AC-03 | Permission failure | **Given** Vendor A is authenticated in the vendor portal, **when** Vendor A requests `GET /vendors/{vendorId}/offers` substituting Vendor B's `vendorId`, **then** the API returns `403`/`404`, never Vendor B's data, regardless of the URL parameter supplied. | Part 1 §C, Part 6 M.5, `TC-SEC-001` |
| AC-04 | Empty state | **Given** a newly registered customer with no past orders, **when** they open Order History, **then** the screen shows "no orders yet" with a browse call-to-action, never a blank page or an error. | Part 5, K.1 (Order history) |
| AC-05 | Integration failure | **Given** the payment gateway sends a webhook event, **when** its signature fails verification, **then** the event is rejected with `401` before any `WebhookInbox` row is written — no unverified event is ever durably recorded. | Part 4 H.3, `TC-PAY-005` |
| AC-06 | Duplicate request | **Given** a customer's checkout request times out client-side after the server already processed it, **when** the client retries with the same `Idempotency-Key`, **then** the response returns the original order unchanged — no second `CustomerOrder` is created. | FR-CART-008, `TC-CHECKOUT-003` |
| AC-07 | Concurrency | **Given** an offer has exactly one unit in stock and two customers have it in their carts simultaneously, **when** both submit checkout at effectively the same moment, **then** the atomic conditional stock decrement (FR-INV-004 — a row-locked `UPDATE ... WHERE quantity >= 1` inside the same transaction as order creation, not a plain read-then-write check) allows exactly one to complete; the second sees "this item just sold out — remove or replace it" with the rest of their cart preserved. Plain checkout-time *revalidation* alone (a read followed by a separate write) is explicitly insufficient here, since both concurrent reads could pass before either write commits. | FR-INV-004, FR-CART-016, `TC-INV-001` (concurrent case) |
| AC-08 | Audit record | **Given** a product-matching reviewer approves a queued match, **when** the decision is submitted via `POST /product-matches/{id}/decision`, **then** `OfferVariant.canonical_variant_id` is set, `VendorOffer.canonical_product_id` is re-derived from it in the same transaction, and an `AuditLog` row records the reviewer, timestamp, and before/after state. | FR-MATCH-003, Part 4 H.3, `TC-MATCHAPI-001` |
| AC-09 | Arabic/RTL | **Given** a customer has set their language to Arabic, **when** they view a product comparison table, **then** the table mirrors fully in RTL (column order, sticky-column side, icon direction), all category-specific attribute labels render in Arabic, and no UI element silently falls back to English layout direction. | NFR-RTL-001, Part 5 K.1 (Comparison view) |
| AC-10 | Happy path (payment-gating) | **Given** a customer checks out with online payment, **when** the sandbox gateway authorizes the charge, **then** the affected `VendorSuborder`(s) transition `AwaitingPayment → PendingConfirmation` and the vendor's BR-DELIVERY-CONFIRM notification fires **only now**, not at checkout submission. | ADR-010, Part 2 E.11, `TC-CHECKOUT-001` |
| AC-11 | Integration failure (negative payment path) | **Given** the same checkout, **when** the sandbox gateway instead declines the charge, **then** the affected `VendorSuborder`(s) transition `AwaitingPayment → PaymentFailed`, the vendor is never notified and never sees the suborder in their portal, and the customer sees "payment failed, please retry." | ADR-010, Part 5 L-15, `TC-CHECKOUT-002` |
| AC-12 | Happy path (partial return) | **Given** a two-item suborder shipped as two separate `Fulfillment`s (split shipment) and one item has been marked `Delivered` while the other is still `OutForDelivery`, **when** the customer requests a return on the delivered item, **then** the return is accepted (BR-025) without needing the second item to have arrived. | BR-025, `TC-RET-001` |
| AC-13 | Validation failure (return) | **Given** the same suborder, **when** the customer requests a return on the item still `OutForDelivery`, **then** the API returns `422 ITEM_NOT_YET_DELIVERED`. | BR-025, `TC-RET-002` |
| AC-14 | Permission / lifecycle | **Given** a vendor has been suspended by a platform admin, **when** that vendor's staff logs into the vendor portal, **then** they can still view and act on already-active suborders (Orders queue, Order detail, Returns queue) but cannot create new offers or see their storefront marked visible to customers. | BR-019, Part 5 L-23, `TC-VEND-002` |
| AC-15 | Duplicate request (webhook) | **Given** a payment gateway redelivers the same webhook event (same `provider` + `event_id`) after not receiving a fast-enough acknowledgment, **when** the event arrives a second time, **then** the platform returns `200` without reprocessing, using the `WebhookInbox(provider, event_id)` uniqueness constraint to detect the duplicate. | Part 3 G.3, Part 4 H.3, `TC-PAY-001` |
| AC-16 | Integration failure (durability) | **Given** the database is briefly unreachable at the exact moment a webhook event arrives, **when** the `WebhookInbox` insert itself fails, **then** the platform returns `5xx` (not `200`), so the gateway retries an event that was never durably captured. | Part 4 H.3 (webhook durability fix), `TC-PAY-002` |
| AC-17 | Concurrency (outbox recovery) | **Given** a checkout transaction commits successfully and writes a `Pending` `OutboxEvent`, **when** the relay worker's first publish attempt to BullMQ fails (simulated Redis outage), **then** the event remains `Pending` and is delivered on a later poll, with the downstream job's effect (e.g., a notification) occurring exactly once from the customer's perspective, never zero or duplicated. | ADR-006, Part 3 G.3, `TC-OUTBOX-001` |

---

## Traceability matrix

### Business objectives (anchors, from Part 1 §B)

| ID | Objective |
|---|---|
| BO-1 | Customers can find a product regardless of which store sells it (discovery) |
| BO-2 | Customers can trust that "cheapest"/"best offer" comparisons are fair and accurate |
| BO-3 | Customers can buy from multiple vendors in one checkout |
| BO-4 | Vendors get discovered without building their own storefront |
| BO-5 | Vendors keep control of their own price, stock, and fulfillment |
| BO-6 | The platform operates on low-friction onboarding and predictable subscription cost |
| BO-7 | The platform maintains catalog quality with a lean team |
| BO-8 | The platform maintains trust, safety, and tenant isolation |

### Module-level matrix

`FYP` = built and demoed within the 3-month window; `Should (FYP stretch)` = attempted if a sprint finishes under budget (Part 8, Q.0); `Full MVP` = specified in full here, deferred past the FYP window.

| FR Module | Primary BO(s) | Key BR(s) | Backlog Epic (Part 8) | API Domain (Part 4) | Representative `TC-*` (Part 6) | Release Phase |
|---|---|---|---|---|---|---|
| FR-AUTH | BO-1, BO-8 | BR-023, BR-024 | EPIC-AUTH | Authentication | TC-AUTH-001/002 | FYP |
| FR-VEND | BO-4, BO-6 | BR-014, BR-022 | EPIC-VEND | Vendors, Branches | TC-VEND-001/002 | FYP |
| FR-CAT | BO-1, BO-7 | BR-003 | EPIC-CAT | Catalog | — | FYP (core), Should (attribute templates) |
| FR-MATCH | BO-2, BO-7 | BR-001, BR-002, BR-007, BR-010 | EPIC-MATCH | Catalog (match endpoints) | TC-MATCH-001/002, TC-MATCHAPI-001 | FYP |
| FR-IMPORT | BO-4, BO-6 | — | EPIC-IMPORT | Imports | TC-IMPORT-001/002 | FYP (core), Should (field-mapping) |
| FR-SEARCH | BO-1 | — | EPIC-SEARCH | Search | TC-SEARCH-001 | FYP (core), Should (deep NLP) |
| FR-COMP | BO-2 | BR-007, BR-021 | EPIC-COMP | Comparison | TC-COMP-001 | FYP |
| FR-PRICE | BO-2, BO-5 | BR-004, BR-021 | Offer price fields ship as part of `BL-IMPORT-001`/`BL-CAT-004b`; FX-normalized display ships as `BL-COMP-003`; `PriceHistory` writes are now an explicit, tested part of `BL-IMPORT-001`/`BL-IMPORT-002`'s definition of done (resolved by this part's review, see gap note) | Pricing | `TC-PRICE-001` | FYP |
| FR-INV | BO-3, BO-5 | BR-005 | EPIC-INV | Inventory | TC-INV-001 | FYP (revalidation), Should (reservation, staleness sweep) |
| FR-CART | BO-3 | BR-009 | EPIC-CART | Cart | TC-CART-001 | FYP |
| (checkout portion of FR-CART) | BO-3 | BR-010, BR-020 | EPIC-CHECKOUT | Checkout | TC-CHECKOUT-001/002/003 | FYP |
| FR-ORD | BO-3, BO-8 | BR-011 | EPIC-ORD | Orders | TC-ORD-001 | FYP |
| FR-PAY | BO-3, BO-6 | BR-013, BR-014, BR-021 | EPIC-PAY | Payments | TC-PAY-001–006 | FYP |
| FR-FUL | BO-3, BO-5 | BR-006, BR-020 | EPIC-FUL | Delivery | — | FYP |
| FR-RET | BO-2, BO-8 | BR-012, BR-025 | EPIC-RET | Returns | TC-RET-001/002 | **Should (Full MVP)** |
| FR-REV | BO-2, BO-8 | BR-016 | EPIC-REV | Reviews | — | FYP (minimal) |
| FR-FAV | BO-1, BO-2 | — | EPIC-NOTIF (folded) | Favorites & alerts | — | Should/Could (Full MVP) |
| FR-NOTIF | BO-3, BO-8 | BR-020 | EPIC-NOTIF | Notifications | TC-PAY-002/003/005-adjacent | FYP (BR-DELIVERY-CONFIRM only) |
| FR-SUP | BO-8 | — | EPIC-SUP (`BL-SUP-001`, added by this review) | Support | — | Full MVP — no build in the FYP window; informal channel substitutes (see gap note) |
| FR-ADMIN | BO-7, BO-8 | BR-003, BR-019 | EPIC-ADMIN | Administration | TC-SEC-001-adjacent | FYP (minimum), Should (full coverage) |
| FR-VPORTAL | BO-4, BO-5 | — | EPIC-VPORTAL | (vendor-scoped, cross-domain) | — | FYP |
| FR-CMS | BO-6 | — | EPIC-ADMIN (folded) | CMS & marketing | — | Should (Full MVP) |
| FR-ANALYTICS | BO-7 | — | EPIC-ANALYTICS | (admin-scoped, cross-domain) | — | Should (Full MVP) |

### Gap analysis (per the master prompt's requirement to identify unimplemented requirements)

Building this matrix surfaced two real gaps, neither caught in the Part 8 review cycle because the master prompt's own implementation-order list (which Part 8's epics were built to mirror) never names them as standalone items either — the same category of omission that Favorites/Alerts and CMS/Marketing fell into, which were explicitly folded elsewhere at the time. These two were missed:

1. **FR-SUP (Customer support, Section E.18) had no backlog epic at all.** Not folded, not demoted — simply absent from Part 8. **Resolution (applied):** Part 8 now carries an explicit `EPIC-SUP`/`BL-SUP-001` entry recording the decision as a first-class backlog item, not a footnote — FR-SUP is deferred to Full MVP, with an informal channel (a shared inbox the 2-person team monitors directly) substituting during the FYP window at pilot scale (3–6 vendors, a small closed beta). The backlog, not this traceability note, is now the source of truth for that decision.
2. **FR-PRICE (Pricing, Section E.8) had no dedicated backlog epic**, and while its core requirements always rode along inside other items (base/sale price fields as part of the offer-editor work, `BL-IMPORT-001`/`BL-CAT-004b`; FX-normalized comparison pricing, `BL-COMP-003`), `PriceHistory` (FR-PRICE-002) was only implementation *guidance* — easy to silently omit. **Resolution (applied):** `BL-IMPORT-001` and `BL-IMPORT-002`'s acceptance criteria now explicitly require the `PriceHistory` write as part of their own definition of done, and `TC-PRICE-001` (Part 6) makes it a checkable, named test rather than an inferred side effect.

No other `FR-*` module was found without at least one backlog item (Must, Should, or Could) tracing to it.

---

## Final recommendations

Per the master prompt's Section 10, addressing all 12 required items — every recommendation below is a synthesis of a decision already made and justified earlier in this SRS, not a new one introduced here.

### 1. Best MVP business model
Comparison-and-discovery as the core value proposition, monetized via a **flat monthly vendor subscription** (BDR-010) rather than per-transaction commission — confirmed because it keeps vendor economics predictable and doesn't require checkout volume to exist before the platform earns anything. See Part 1 §B, Part 3 BR-014.

### 2. Single-vendor or multi-vendor checkout initially
**Full multi-vendor checkout from day one** (BDR-001) — the product owner's explicit, confirmed choice, accepted as the target design despite being the platform's single riskiest mechanic (Part 1 §D.2), precisely because retrofitting it later would be far more expensive than building it correctly now. The FYP Delivery Increment narrows *breadth* around this mechanic, never the mechanic itself (Part 1 §D.4).

### 3. How canonical products and vendor offers should be modeled
The **four-level model** — `CanonicalProduct` (model/family, platform-owned, no `vendor_id`) → `CanonicalProductVariant` (manufacturer-distinct structural options) → `VendorOffer`/`OfferVariant` (vendor-owned, always carries `vendor_id`) → unmatched/unique listings (never force-linked) — per FR-MATCH-008, ADR-007, and Part 3 §G.1's structural enforcement that a vendor offer can never *become* a canonical product, only reference one.

### 4. How vendors should initially submit data
**Manual entry and CSV/Excel import only** (BDR-006, Q6) — no assumption of vendor API/POS/ERP capability, matching the explicit master-prompt caution against assuming reliable vendor integration. Vendor-authorized API ingestion remains available opportunistically; web scraping is explicitly out of scope (Q15).

### 5. Which inventory promises are safe to show customers
**Checkout-time enforcement via an atomic conditional stock decrement is the only inventory promise the FYP makes** — an item shown "in stock" is reconfirmed, and its stock row locked and decremented, in the same transaction that creates the order (FR-CART-002/FR-INV-004), which is genuinely concurrency-safe on its own, not merely stale-data-safe (a plain read-then-write revalidation would not be). True *reservation* (a temporary hold from cart-add, FR-INV-003) is deferred to Full MVP (`BL-INV-004`) — safe to defer because, given the atomic decrement already guarantees correctness at checkout, reservation only improves the pre-checkout browsing experience (showing accurate availability earlier), not the core oversell risk.

### 6. How product matching should be governed
**Exact-identifier matches auto-link; everything else requires human review** — no fuzzy match is ever auto-approved (BR-001, Q5), with explicit categories that must *never* auto-match regardless of confidence score (used-vs-new, bundles, Part 6 §N.2). This is the platform's core trust mechanism and the one place accuracy was never traded for build speed anywhere in this SRS.

### 7. Which features should be postponed
Per Part 8, Q.0's capacity-driven re-scope: **Returns and Analytics** (full epics, demoted to Should/Full MVP); full attribute-template systems, multi-staff vendor roles, configurable CSV field-mapping, PostGIS-based distance search, full admin coverage of every entity, CMS/banner management, inventory reservation, and vendor-response/moderation on reviews (all individually demoted, still fully specified). **Customer support (FR-SUP)** is now also explicitly postponed, recorded as its own `EPIC-SUP`/`BL-SUP-001` entry in Part 8 (this part's gap analysis caught the omission; Part 8 itself now carries the decision, not just this note).

### 8. Recommended architecture
A **modular monolith** (NestJS/TypeScript + PostgreSQL/PostGIS), explicitly justified against microservices per the master prompt's caution (Part 6 §M.1, ADR-001) — team size and traffic don't warrant service decomposition. Client: **Next.js (server-rendered) wrapped via Capacitor** for Android/iOS, chosen specifically to avoid the SEO risk a client-only-rendered framework like Flutter Web would have left open (ADR-004). A transactional outbox (`OutboxEvent`, ADR-006) — not a direct queue enqueue inside a database transaction — is what makes the checkout→notification/payment pipeline durable.

### 9. Minimum operational team
**2 people** (Q14) — confirmed as the real constraint the entire delivery plan (Part 8) is built around, not a simplifying assumption. RISK-011 (Part 7) names this explicitly as the platform's most structural ongoing risk, present in both the FYP build and any early post-launch operation.

### 10. Main reasons this platform could fail, and how to reduce those risks
From Part 7's risk register, the five most load-bearing: **(1) vendor adoption fails to reach critical mass** (RISK-001) — mitigated by low-friction manual onboarding and a white-glove pilot cohort; **(2) an incorrect product match undermines the core "cheapest offer" trust claim** (RISK-003) — mitigated by never auto-approving fuzzy matches; **(3) the 2-person team cannot sustain catalog review, support, and engineering simultaneously as volume grows** (RISK-011) — mitigated by pausing new-vendor onboarding rather than letting quality degrade; **(4) unresolved legal/tax/consumer-protection uncertainty forces late rework** (RISK-013) — mitigated by flagging every such rule as provisional rather than asserting compliance; **(5) scope creep against the fixed 3-month FYP window** (RISK-016) — mitigated by the capacity-verified backlog in Part 8 and its explicit Should/Full-MVP deferral list (item 7, above).

### 11. First 30 actionable tasks
The first 30 backlog items in build order, directly from Part 8's verified Sprint 1–4 schedule (Release Gate 1) — no new list invented here, just extracted:

`BL-FOUND-001` → `BL-FOUND-002` → `BL-FOUND-003` → `BL-FOUND-004` → `BL-FOUND-005` → `BL-AUTH-001` → `BL-AUTH-002` → `BL-AUTH-003` → `BL-AUTH-004` → `BL-AUTH-005` → `BL-VEND-001` → `BL-CAT-001` → `BL-CAT-004b` → `BL-MATCH-001` → `BL-MATCH-002` → `BL-VEND-002` → `BL-VEND-003` → `BL-VEND-004` → `BL-MATCH-003` → `BL-MATCH-005` → `BL-VEND-005b` → `BL-IMPORT-001` → `BL-IMPORT-002` → `BL-IMPORT-004` → `BL-ORD-001` → `BL-PAY-002` → `BL-INV-001` → `BL-INV-002` → `BL-PAY-001` → `BL-PAY-003`

(Items 1–24 correspond to Sprints 1–4, ending at Release Gate 1; items 25–30 are the start of Sprint 5–6's core infrastructure. Full detail — dependencies, acceptance criteria, estimates — is in Part 8.)

### 12. Decisions the product owner must approve before implementation begins
In priority order:
1. **OPEN-006** — formal sign-off on the FYP Delivery Increment itself (Part 1 §D.4, Part 7). Everything in Parts 2–9 is built against this proposal; it has proceeded without objection through nine rounds of review but has never been explicitly, formally accepted, and BDR-015 (Part 7) is named accordingly.
2. **OPEN-001** — the online-payment gateway (blocks real online payment; FYP uses a sandbox regardless of when this resolves).
3. **OPEN-004** — the SMS/OTP provider (blocks real OTP and real BR-DELIVERY-CONFIRM SMS; FYP uses a logged fallback regardless).
4. **OPEN-003** — subscription price tiers and grace-period policy (blocks real vendor billing; FYP simulates it regardless).
5. **OPEN-002, OPEN-005, OPEN-007, OPEN-008, OPEN-009** — FX-rate source, verification-reviewer assignment, mixed-currency settlement mechanics, uncollected-pickup policy, and specific legal/retention parameters (Part 7 §Q.4) — none block the FYP build, but all block calling the *full* confirmed scope (BDR-001–013) production-ready.
6. **The two gaps this part's traceability review found and Part 8 now records explicitly** (`EPIC-SUP`/`BL-SUP-001`; `PriceHistory` in `BL-IMPORT-001`/`002`'s acceptance criteria): the backlog entries exist — what still needs product-owner sign-off is the underlying judgment call that informal support is an acceptable substitute for a real ticketing system during the FYP pilot.

---

This closes the SRS. Nine parts, delivered per the master prompt's working method: Phase 0 clarification and confirmed answers (Part 0), full functional/business-rule/data-model specification (Parts 2–3), API/NFR contract (Part 4), UX and failure-mode coverage (Part 5), architecture/matching/testing/DevOps strategy (Part 6), consolidated risk and decision registers (Part 7), a capacity-verified backlog and sprint plan (Part 8), and this closing traceability and recommendations part — every provisional item still carrying its `⚠ OPEN-00X` tag, every confirmed decision still traceable to the product owner's original Q1–Q15 answers (Part 0) or a subsequently-logged BDR/ADR (Part 7).
