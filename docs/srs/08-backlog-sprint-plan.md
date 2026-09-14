# SRS — Part 8: Development Backlog & Sprint/Release Plan

Builds directly on the FYP Delivery Increment (Part 1, D.4 — proposed, tracked as OPEN-006/BDR-015 pending formal sign-off) and the full confirmed scope (BDR-001–013) as its post-FYP roadmap. Organized in **implementation order**, per the master prompt's explicit sequence — not merely by FR module.

**Backlog conventions (read this before the tables):** to keep ~70+ items tractable, each **Epic** carries the fields that are genuinely epic-level once — Phase, business value, common Definition of Done, and relevant risks (cited by `RISK-*` ID from Part 7 rather than restated) — and its child backlog items inherit them, adding only what varies per item: ID, title/user story, FR/BR coverage, dependencies, acceptance criteria, priority, and estimate. This is not an exhaustive task breakdown (each sprint's planning session produces that); it's a representative decomposition sufficient to plan and estimate against, consistent with how Part 4 handled the API endpoint inventory. Priority uses MoSCoW **against the FYP Delivery Increment**, not the full confirmed scope — a `Won't` item is still fully specified in Parts 1–7, just not built in the 3-month window. Estimates are T-shirt sizes calibrated to the 2-person team's 1-week sprints (S ≤ 1 day, M = 2–3 days, L ≈ 1 week).

---

## Epics, in implementation order

| # | Epic ID | Title | FR/Section coverage | FYP priority | Definition of Done (epic-level) |
|---|---|---|---|---|---|
| 1 | EPIC-FOUND | Foundation | Part 6 (M, P) | Must | Repo, CI/CD, staging environment, DB migrations, base auth/error/logging conventions (Part 4, H.1) all working end-to-end on a trivial route |
| 2 | EPIC-AUTH | Identity and access | FR-AUTH | Must | A customer can register, verify (OTP or logged fallback), log in, and manage saved addresses |
| 3 | EPIC-CAT | Catalog and taxonomy | FR-CAT | Must | Catalog admin can manage categories/brands/attributes with duplicate-detection working |
| 4 | EPIC-MATCH | Canonical-product model | FR-MATCH, Part 6 §N | Must | Exact-match auto-link and the human-review queue both function against real seeded data |
| 5 | EPIC-VEND | Vendor onboarding | FR-VEND | Must | A vendor can apply, submit branch verification evidence, get approved, and select a subscription plan |
| 6 | EPIC-IMPORT | Offer creation and imports | FR-IMPORT | Must | A vendor can create an offer manually or via CSV import with a validation report |
| 7 | EPIC-SEARCH | Search | FR-SEARCH | Must | Arabic/English search with normalization and filters returns correct results against seeded data |
| 8 | EPIC-COMP | Comparison | FR-COMP | Must | A customer can compare offers across vendors, including cross-currency, with the "why best" explainer |
| 9 | EPIC-INV | Inventory | FR-INV | Must | Branch-level stock updates and staleness flagging work |
| 10 | EPIC-CART | Cart | FR-CART (cart) | Must | A cart holds items from multiple vendors, correctly partitioned |
| 11 | EPIC-CHECKOUT | Checkout | FR-CART (checkout) | Must | End-to-end multi-vendor checkout completes per BR-009/010, including the AwaitingPayment gate (ADR-010) |
| 12 | EPIC-ORD | Orders | FR-ORD | Must | The full `CustomerOrder`/`VendorSuborder`/`OrderItem` state machines (Part 2, E.11) work with correct notifications and audit records |
| 13 | EPIC-PAY | Payments | FR-PAY | Must | COD works fully; online payment works against a sandbox gateway; `PaymentAllocation`/`OutboxEvent` reconcile correctly |
| 14 | EPIC-FUL | Delivery | FR-FUL | Must | Vendor delivery and pickup fulfillment both work, including BR-DELIVERY-CONFIRM's three notifications |
| 15 | EPIC-RET | Returns | FR-RET | Should | Item-level return (BR-025) works for both split- and non-split-shipment suborders |
| 16 | EPIC-REV | Reviews | FR-REV | Must (basic only, per Part 1 D.4) | A customer can submit a verified-purchase review; it displays on the offer/store page |
| 17 | EPIC-NOTIF | Notifications | FR-NOTIF, FR-FAV (folded in — see note) | Must | BR-DELIVERY-CONFIRM's channels work (real or logged fallback per ⚠ OPEN-004); favorites/price-drop/back-in-stock alerts work at a basic level |
| 18 | EPIC-ADMIN | Administration | FR-ADMIN, FR-CMS (folded in — see note) | Must (minimum viable admin) | Platform admin can manage vendors, review matches, view the audit log; basic content/banner management works |
| 19 | EPIC-VPORTAL | Vendor portal | FR-VPORTAL | Must | A vendor can run their store end-to-end through the portal without developer intervention |
| 20 | EPIC-ANALYTICS | Analytics | FR-ANALYTICS | Should (basic funnel only, per FR-ANALYTICS-006) | The search→compare→cart→checkout funnel is visible, enough to evaluate the exit-criteria demo |
| 21 | EPIC-SEC | Security hardening | Part 6 §O (security tests), future Section J | Must (baseline), Should (dedicated pass) | `TC-SEC-001` (tenant isolation) and webhook-signature tests (`TC-PAY-005`) pass; a focused hardening pass runs before the pilot |
| 22 | EPIC-PERF | Performance | NFR-PERF-*, NFR-SCALE-001 | Should | FYP-scale targets (Part 4, Section I) met under a basic load test |
| 23 | EPIC-DEPLOY | Deployment | Part 6 §P | Must | Staging and production-equivalent environments both deployable via the CI/CD pipeline |
| 24 | EPIC-OPS | Operational readiness | Part 6 §P, Part 5 K.2 journeys | Must | Runbooks exist for the highest-risk scenarios; the vendor pilot and a small customer beta both run successfully against the FYP exit criteria (Part 1, D.3) |

**Note on folded modules:** the master prompt's own implementation-order list (Section 6) does not name Favorites/Alerts or CMS/Marketing as separate epics — they're folded here into the epic they're most operationally similar to (Favorites/Alerts → Notifications, since both are alert-delivery mechanics; CMS/Marketing → Administration, since content management is admin-portal work) rather than silently dropped. Both retain their own `FR-FAV-*`/`FR-CMS-*` IDs from Part 2 for traceability.

---

## Backlog items by epic

### 1. EPIC-FOUND — Foundation

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Estimate |
|---|---|---|---|---|---|---|
| BL-FOUND-001 (DevOps) | Stand up the repo, GitHub Actions CI (test-on-PR), and a staging deploy target (Railway/Render/Fly.io, Part 6 M.2) | Part 6 §M/P | None | A trivial PR triggers tests and a staging deploy automatically | Must | M |
| BL-FOUND-002 (Tech) | Set up PostgreSQL + PostGIS with the initial migration framework | Part 3, G.3 | BL-FOUND-001 | A migration can be written, applied, and rolled back locally and in staging | Must | S |
| BL-FOUND-003 (Tech) | Implement H.1's cross-cutting API conventions (error format, correlation IDs, idempotency-key middleware, rate limiting) | Part 4, H.1 | BL-FOUND-002 | A sample endpoint demonstrates every convention; covered by `TC-*` scaffolding | Must | M |
| BL-FOUND-004 (DevOps) | Wire up Sentry error tracking and structured logging | Part 6 §P | BL-FOUND-001 | A deliberately thrown error in staging appears in Sentry with its correlation ID | Must | S |
| BL-FOUND-005 (Data) | Implement `AuditLog` and `OutboxEvent` as shared infrastructure tables with their write helpers | Part 3, G.3; ADR-006 | BL-FOUND-002 | A test write produces an `AuditLog` row; a test `OutboxEvent` is picked up by a stub relay worker | Must | M |

### 2. EPIC-AUTH — Identity and access

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Estimate |
|---|---|---|---|---|---|---|
| BL-AUTH-001 (Story) | As a guest, I can browse/search/compare without an account | FR-AUTH-001 | EPIC-SEARCH (can stub initially) | Guest session hits no auth wall on read-only routes | Must | S |
| BL-AUTH-002 (Story) | As a new user, I can register with phone + password and verify via OTP (or the FYP logged fallback) | FR-AUTH-002/003, ⚠ OPEN-004 | BL-FOUND-003 | `TC-AUTH-001` passes | Must | M |
| BL-AUTH-003 (Story) | As a returning user, I can log in and reset my password via OTP | FR-AUTH-005/006 | BL-AUTH-002 | Login + reset flows both work; sensitive actions gated by OTP | Must | M |
| BL-AUTH-004 (Story) | As a customer, I can save/manage multiple addresses with a manually-placed map pin | FR-AUTH-008; Part 7, DEP-009 | BL-AUTH-002, Part 6 Maps row | Address form captures pin + landmark + phone numbers | Must | M |
| BL-AUTH-005 (QA) | Retry-idempotency test for OTP verify | FR-AUTH-003 | BL-AUTH-002 | `TC-AUTH-002` passes | Must | S |

### 3. EPIC-CAT — Catalog and taxonomy

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Estimate |
|---|---|---|---|---|---|---|
| BL-CAT-001 (Story) | As a catalog admin, I can manage the category tree (AR/EN) | FR-CAT-001 | EPIC-FOUND | Categories CRUD works with both locales required | Must | M |
| BL-CAT-002 (Story) | As a catalog admin, I can manage brands with duplicate-name detection | FR-CAT-002/009 | BL-CAT-001 | Creating a near-duplicate brand triggers a warning, not a silent second row | Must | S |
| BL-CAT-003 (Story) | As a catalog admin, I can define per-category attribute templates | FR-CAT-003 | BL-CAT-001 | A category's attribute template drives the offer-editor form fields later (EPIC-IMPORT) | Must | M |
| BL-CAT-004 (Tech) | Implement `CanonicalProduct.product_type` and warranty/tags/SKU-uniqueness fields | FR-CAT-004/010–013 | BL-CAT-001 | Schema matches Part 3, G.3 exactly | Must | S |

### 4. EPIC-MATCH — Canonical-product model

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Estimate |
|---|---|---|---|---|---|---|
| BL-MATCH-001 (Tech) | Implement the four-level `CanonicalProduct`/`CanonicalProductVariant`/`VendorOffer`/`OfferVariant` schema | FR-MATCH-001/008, Part 3, G.1 | EPIC-CAT | `TC-MATCH-*` schema-level assertions pass; no `vendor_id` on canonical tables | Must | L |
| BL-MATCH-002 (Story) | As the system, I auto-link an offer with an exact identifier match | FR-MATCH-002, BR-001 | BL-MATCH-001 | `TC-MATCH-001` passes | Must | M |
| BL-MATCH-003 (Story) | As a product-matching reviewer, I can review and decide queued matches | FR-MATCH-003/004, Part 4 `POST /product-matches/{id}/decision` | BL-MATCH-002 | `TC-MATCHAPI-001` passes; confidence scoring per Part 6, N.1 | Must | L |
| BL-MATCH-004 (Story) | As a customer, I can report an incorrect match | FR-MATCH-005 | BL-MATCH-003 | Reported match re-enters the queue with a flag | Should | S |
| BL-MATCH-005 (QA) | Never-auto-match negative tests (used-vs-new, bundle) | Part 6, N.2 | BL-MATCH-002 | `TC-MATCH-002` passes | Must | S |

### 5. EPIC-VEND — Vendor onboarding

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Estimate |
|---|---|---|---|---|---|---|
| BL-VEND-001 (Story) | As a prospective vendor, I can apply with store profile and branch info | FR-VEND-001 | EPIC-FOUND | Application form + at least one branch required to submit | Must | M |
| BL-VEND-002 (Story) | As a vendor, I can submit branch verification evidence (map pin + photo) | FR-VEND-002, BR-022 | BL-VEND-001, Maps row | `TC-VEND-001` passes | Must | M |
| BL-VEND-003 (Story) | As a vendor-verification reviewer, I can approve/reject/request-resubmission | FR-VEND-003 | BL-VEND-002 | Decision writes an audit record; ⚠ OPEN-005 reviewer-assignment rules applied once resolved | Must | M |
| BL-VEND-004 (Story) | As an approved vendor, I select a subscription plan before publishing | FR-VEND-004/005, ⚠ OPEN-003 | BL-VEND-003 | Vendor status gates offer visibility (BR-014) | Must | M |
| BL-VEND-005 (Story) | As a vendor owner, I can manage branches and staff accounts | FR-VEND-006/007 | BL-VEND-001 | Role-scoped staff permissions match Part 1, Section C | Must | M |
| BL-VEND-006 (QA) | Suspended-vendor restricted-access test | FR-VEND-009, Part 5 L-23 | BL-VEND-004 | `TC-VEND-002` passes | Must | S |

### 6. EPIC-IMPORT — Offer creation and imports

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Estimate |
|---|---|---|---|---|---|---|
| BL-IMPORT-001 (Story) | As a vendor catalog employee, I can create/edit an offer manually | FR-IMPORT-001 | EPIC-MATCH, EPIC-CAT | Form respects the category's attribute template | Must | M |
| BL-IMPORT-002 (Story) | As a vendor, I can bulk-import offers via CSV with field mapping | FR-IMPORT-002/011 | BL-IMPORT-001 | Validation report generated; partial success supported | Must | L |
| BL-IMPORT-003 (Story) | As a vendor, I can retry only the failed rows of an import | FR-IMPORT-012 | BL-IMPORT-002 | `TC-IMPORT-002` passes | Must | M |
| BL-IMPORT-004 (QA) | Partial-success import test | FR-IMPORT-003 | BL-IMPORT-002 | `TC-IMPORT-001` passes | Must | S |

### 7. EPIC-SEARCH — Search

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Estimate |
|---|---|---|---|---|---|---|
| BL-SEARCH-001 (Tech) | Set up Postgres FTS (`tsvector`/`tsquery` + `pg_trgm`) on offers/canonical products | FR-SEARCH-001, Part 6 M.2 | EPIC-MATCH | Basic query returns relevant results | Must | M |
| BL-SEARCH-002 (Tech) | Arabic normalization, transliteration, synonym list | FR-SEARCH-002/012 | BL-SEARCH-001 | `TC-SEARCH-001` passes | Must | M |
| BL-SEARCH-003 (Story) | As a customer, I can filter/sort search results | FR-SEARCH-005 | BL-SEARCH-001 | Filters combine correctly (AND semantics) | Must | M |
| BL-SEARCH-004 (Story) | As a customer, unmatched/unique listings appear labeled in results | FR-SEARCH-010, FR-MATCH-009 | BL-SEARCH-001 | Visual distinction confirmed in UI review | Must | S |

### 8. EPIC-COMP — Comparison

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Estimate |
|---|---|---|---|---|---|---|
| BL-COMP-001 (Story) | As a customer, I can add/remove items to a comparison set | FR-COMP-001 | EPIC-SEARCH | Max-4 enforced | Must | S |
| BL-COMP-002 (Story) | As a customer, I see the cheapest/best-value offer with an explanation | FR-COMP-005 | BL-COMP-001 | "Why best" text renders correctly | Must | M |
| BL-COMP-003 (Tech) | FX-normalized comparison price with rate/date disclosure | FR-COMP-009, BR-021, ⚠ OPEN-002 | BL-COMP-001 | `TC-COMP-001` passes | Must | M |
| BL-COMP-004 (Story) | As a customer, I can share/save a comparison | FR-COMP-007 | BL-COMP-001 | Share link resolves to the same comparison set | Should | S |

### 9. EPIC-INV — Inventory

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Estimate |
|---|---|---|---|---|---|---|
| BL-INV-001 (Story) | As vendor staff, I can update stock per branch | FR-INV-001/005 | EPIC-VEND, EPIC-IMPORT | Stock updates reflected immediately in the catalog | Must | M |
| BL-INV-002 (Tech) | Staleness sweep + flagging per channel | FR-INV-006, BR-005 | BL-INV-001 | Scheduled job flags stale rows per NFR-STALE-001 | Must | M |
| BL-INV-003 (Story) | Reservation + checkout-time revalidation | FR-INV-003/004 | EPIC-CART | `TC-INV-001` passes | Must | M |

### 10. EPIC-CART — Cart

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Estimate |
|---|---|---|---|---|---|---|
| BL-CART-001 (Story) | As a customer, my cart partitions items by vendor automatically | FR-CART-001, BR-009 | EPIC-INV | `TC-CART-001` passes | Must | M |
| BL-CART-002 (Story) | Per-vendor minimum order + delivery-zone eligibility checks | FR-CART-003/004 | BL-CART-001 | Ineligible vendor partition surfaces pickup-only messaging (L-22) | Must | M |
| BL-CART-003 (Story) | Per-vendor fulfillment choice, notes, terms acceptance | FR-CART-005/012/014 | BL-CART-001 | Each vendor partition independently configurable | Must | M |

### 11. EPIC-CHECKOUT — Checkout

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Estimate |
|---|---|---|---|---|---|---|
| BL-CHECKOUT-001 (Story) | As a customer, I complete checkout with address + two phone numbers | FR-CART-006, BR-020 | EPIC-CART, EPIC-AUTH | Order confirmation fires BR-DELIVERY-CONFIRM | Must | L |
| BL-CHECKOUT-002 (Tech) | Idempotent checkout submission | FR-CART-008, Part 4 | BL-CHECKOUT-001 | `TC-CHECKOUT-003` passes | Must | M |
| BL-CHECKOUT-003 (Tech) | `AwaitingPayment` gate for online payment | ADR-010, Part 2 E.11 | BL-CHECKOUT-001, EPIC-PAY | `TC-CHECKOUT-001`/`002` pass | Must | L |
| BL-CHECKOUT-004 (QA) | Checkout-failure cart preservation | FR-CART-016 | BL-CHECKOUT-001 | Failed checkout leaves cart intact for resubmission | Must | S |

### 12. EPIC-ORD — Orders

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Estimate |
|---|---|---|---|---|---|---|
| BL-ORD-001 (Tech) | Implement `CustomerOrder`/`VendorSuborder`/`OrderItem` state machines | Part 2, E.11 | EPIC-CHECKOUT | Every valid/invalid transition in Part 2 covered by `TC-*` | Must | L |
| BL-ORD-002 (Story) | As a vendor, I can confirm/reject/dispatch a suborder | FR-ORD-007, Part 4 `PATCH /suborders/{id}/status` | BL-ORD-001 | Role-scoped per Part 1, Section C | Must | M |
| BL-ORD-003 (Story) | As a customer, I see a consolidated order timeline | FR-ORD-005 | BL-ORD-001 | Parent + per-suborder status both visible | Must | M |
| BL-ORD-004 (QA) | Partial-rejection independence test | FR-ORD-003, Part 5 L-13 | BL-ORD-001 | `TC-ORD-001` passes | Must | S |

### 13. EPIC-PAY — Payments

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Estimate |
|---|---|---|---|---|---|---|
| BL-PAY-001 (Story) | As a customer, I can pay cash on delivery | FR-PAY-001 | EPIC-ORD | COD path through the Payment state machine works | Must | M |
| BL-PAY-002 (Tech) | Sandbox online payment integration | FR-PAY-002, ⚠ OPEN-001 | BL-PAY-001 | Simulated authorize/capture/fail paths all work | Must | L |
| BL-PAY-003 (Tech) | `PaymentAllocation`/`PaymentTransactionAllocation` implementation | FR-PAY-003, Part 3 | BL-PAY-002 | `TC-PAY-006` passes for both OPEN-007 resolutions | Must | L |
| BL-PAY-004 (Tech) | `WebhookInbox` + `OutboxEvent` relay worker | Part 3, Part 6 M.4, ADR-006 | BL-PAY-002, BL-FOUND-005 | `TC-PAY-002/003/005`, `TC-OUTBOX-001` all pass | Must | L |
| BL-PAY-005 (Story) | Partial/full refund flow | FR-PAY-004, BR-013 | BL-PAY-003, EPIC-RET | `TC-PAY-004` passes | Should | M |

### 14. EPIC-FUL — Delivery

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Estimate |
|---|---|---|---|---|---|---|
| BL-FUL-001 (Tech) | Delivery state machine (Part 2, E.11) | FR-FUL-002 | EPIC-ORD | Assigned→OutForDelivery→Delivered/FailedAttempt all covered | Must | L |
| BL-FUL-002 (Story) | Pickup flow with pickup code | FR-FUL-008 | BL-FUL-001 | Branch staff can redeem a code | Must | M |
| BL-FUL-003 (Tech) | BR-DELIVERY-CONFIRM's three notifications | FR-FUL-003, ⚠ OPEN-004 | BL-PAY-004 (outbox), EPIC-NOTIF | Real SMS if OPEN-004 resolves in time, else logged/visible fallback per Part 1, D.4 | Must | M |
| BL-FUL-004 (Story) | Delivery-zone eligibility per branch | FR-FUL-004 | EPIC-VEND | Matches BR-006 | Must | M |

### 15. EPIC-RET — Returns

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Estimate |
|---|---|---|---|---|---|---|
| BL-RET-001 (Tech) | Return state machine (Part 2, E.11/E.14) | FR-RET-002/003 | EPIC-FUL | Requested→VendorReview→Approved/Rejected→Refund all covered | Should | L |
| BL-RET-002 (Story) | Item-level return independent of sibling items | BR-025 | BL-RET-001, split-shipment `Fulfillment` (EPIC-FUL) | `TC-RET-001`/`002` pass | Should | M |
| BL-RET-003 (Story) | As a vendor, I approve/reject returns within SLA | FR-RET-003 | BL-RET-001 | Auto-escalation on SLA breach | Should | M |

### 16. EPIC-REV — Reviews

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Estimate |
|---|---|---|---|---|---|---|
| BL-REV-001 (Story) | As a customer, I can submit a verified-purchase review | FR-REV-001 | EPIC-ORD | BR-016 verification enforced | Must | M |
| BL-REV-002 (Story) | Reviews display on offer/store pages with aggregate rating | FR-REV-002/005 | BL-REV-001 | Rating formula matches Part 6, O | Must | S |
| BL-REV-003 (Story) | Vendor can respond to a review | FR-REV-004 | BL-REV-001 | One response per review | Could | S |

### 17. EPIC-NOTIF — Notifications (incl. Favorites/Alerts)

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Estimate |
|---|---|---|---|---|---|---|
| BL-NOTIF-001 (Tech) | Notification dispatch service (SMS/email/in-app), retry-tracked | FR-NOTIF-001/004 | EPIC-FOUND (outbox) | Every notification instance independently tracked | Must | L |
| BL-NOTIF-002 (Tech) | Bilingual templates | FR-NOTIF-003 | BL-NOTIF-001 | Every customer-facing template exists in AR + EN | Must | M |
| BL-NOTIF-003 (Story) | As a customer, I can favorite products and set alert preferences | FR-FAV-001/005 | EPIC-COMP | — | Should | M |
| BL-NOTIF-004 (Story) | Price-drop and back-in-stock alerts | FR-FAV-003/004 | BL-NOTIF-003, EPIC-INV | Triggered off `PriceHistory`/stock-state changes | Could | M |

### 18. EPIC-ADMIN — Administration (incl. CMS)

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Estimate |
|---|---|---|---|---|---|---|
| BL-ADMIN-001 (Story) | As platform admin, I manage vendors/branches/catalog centrally | FR-ADMIN-001 | Every prior epic | Covers the Part 5, K.1 admin screen set at minimum viable depth | Must | L |
| BL-ADMIN-002 (Story) | Centrally configurable business lists | FR-ADMIN-002 | BL-ADMIN-001 | No hardcoded selectable list remains (BR-003) | Must | M |
| BL-ADMIN-003 (Story) | Role/permission management, audit-log viewer | FR-ADMIN-003/005 | BL-ADMIN-001 | Matches Part 1, Section C's role set | Must | M |
| BL-ADMIN-004 (Story) | Basic content/banner management | FR-CMS-001 | BL-ADMIN-001 | Draft/preview/publish workflow works | Should | M |

### 19. EPIC-VPORTAL — Vendor portal

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Estimate |
|---|---|---|---|---|---|---|
| BL-VPORTAL-001 (Story) | Vendor dashboard (orders needing attention, subscription status, KPIs) | FR-VPORTAL-001 | EPIC-VEND, EPIC-ORD | Matches Part 5, K.1 | Must | M |
| BL-VPORTAL-002 (Story) | Consolidated vendor notifications view | FR-VPORTAL-011 | BL-NOTIF-001 | BR-DELIVERY-CONFIRM alerts appear here | Must | S |
| BL-VPORTAL-003 (Story) | Subscription/billing status view | FR-VPORTAL-006, ⚠ OPEN-003 | EPIC-VEND | Reflects simulated billing per Part 1, D.4 | Must | M |

### 20. EPIC-ANALYTICS — Analytics

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Estimate |
|---|---|---|---|---|---|---|
| BL-ANALYTICS-001 (Story) | Search→compare→cart→checkout funnel dashboard | FR-ANALYTICS-006 | Every core epic | Used to evaluate the FYP exit-criteria demo (Part 1, D.3) | Should | M |
| BL-ANALYTICS-002 (Story) | Catalog/match-quality reporting | FR-ANALYTICS-002 | EPIC-MATCH | Auto-match rate, reviewer throughput visible (Part 6, N.4) | Could | M |

### 21. EPIC-SEC — Security hardening

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Estimate |
|---|---|---|---|---|---|---|
| BL-SEC-001 (QA) | Tenant isolation / BOLA test suite | Part 6, M.5 | EPIC-VEND, EPIC-ADMIN | `TC-SEC-001` passes across every vendor-scoped endpoint | Must | M |
| BL-SEC-002 (QA) | Webhook signature/durability test suite | Part 4, H.3 | EPIC-PAY | `TC-PAY-005`, `TC-OUTBOX-001` pass | Must | M |
| BL-SEC-003 (Tech) | Rate-limiting + OTP abuse protection | FR-AUTH-011 | EPIC-AUTH | Repeated-failure lockout verified | Must | S |
| BL-SEC-004 (Tech) | Dedicated pre-pilot hardening pass (injection/XSS sweep, dependency audit) | Part 5, L-28 | All prior | No critical findings open at pilot start | Should | M |

### 22. EPIC-PERF — Performance

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Estimate |
|---|---|---|---|---|---|---|
| BL-PERF-001 (QA) | Load test against NFR-PERF-001/002/003 at FYP scale | Part 4, Section I | Core epics complete | Targets met under a 50-concurrent-session simulated load (NFR-SCALE-001) | Should | M |

### 23. EPIC-DEPLOY — Deployment

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Estimate |
|---|---|---|---|---|---|---|
| BL-DEPLOY-001 (DevOps) | Production-equivalent environment provisioned | Part 6 §P | EPIC-FOUND | Deployable via the same pipeline as staging | Must | M |
| BL-DEPLOY-002 (DevOps) | Backup/restore drill | NFR-BACKUP-001 | BL-DEPLOY-001 | `TC-DR-001` passes | Should | S |

### 24. EPIC-OPS — Operational readiness

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Estimate |
|---|---|---|---|---|---|---|
| BL-OPS-001 (Ops) | Runbooks for highest-risk scenarios | Part 6 §P | Relevant epics complete | Payment-webhook backlog, stuck import, verification-queue backlog runbooks all exist | Must | M |
| BL-OPS-002 (Ops) | Vendor pilot onboarding (3–6 vendors, per Part 1 D.4) | Part 1, D.4 | EPIC-VEND, EPIC-IMPORT | Pilot vendors listing real offers | Must | L |
| BL-OPS-003 (Ops) | Small customer beta | Part 1, D.3 exit criteria | EPIC-CHECKOUT, EPIC-ORD | End-to-end demo flow completes with real beta users | Must | M |
| BL-OPS-004 (Ops) | FYP exit-criteria demo rehearsal | Part 1, D.3 | Every Must item above | Full demo script (search→compare→multi-vendor cart→checkout→vendor confirm→delivery/pickup) runs clean | Must | S |

---

## Sprint & release plan

### Team composition (small-team scenario — the actual FYP team)

2 people, both generalist full-stack given the size, with a light specialization split to reduce collision: **Engineer A** leans backend/data (schema, state machines, payments, matching); **Engineer B** leans frontend/vendor-portal (Next.js client, vendor/admin portals, UX per Part 5). Both share QA, DevOps, and operational-readiness work — there's no one else to hand it to. This matches RISK-011's structural constraint head-on rather than pretending a bigger team exists.

### Sprint length and cadence

**1-week sprints, 12 sprints total**, matching the confirmed 3-month window (Q14). Short sprints suit a 2-person team: fast feedback, low planning overhead, and an easy point to re-scope if RISK-016 (scope creep) starts to bite.

### Sprint-by-sprint goals (small-team scenario)

| Sprint | Weeks | Primary epics | Sprint goal |
|---|---|---|---|
| 1 | 1 | EPIC-FOUND | Deployable skeleton with CI/CD, DB, API conventions, error tracking |
| 2 | 2 | EPIC-AUTH, EPIC-VEND (start) | A customer can register/verify/log in; a vendor can apply |
| 3 | 3 | EPIC-CAT, EPIC-MATCH (start) | Catalog admin functional; exact-match auto-linking works |
| 4 | 4 | EPIC-MATCH (finish), EPIC-VEND (finish) | Match-review queue functional; vendor onboarding complete end-to-end — **Release gate 1** |
| 5 | 5 | EPIC-IMPORT | Manual + CSV offer creation, with validation reporting |
| 6 | 6 | EPIC-SEARCH | Arabic/English search with filters over seeded data |
| 7 | 7 | EPIC-COMP, EPIC-INV | Comparison (incl. cross-currency) and inventory staleness/reservation |
| 8 | 8 | EPIC-CART, EPIC-CHECKOUT (start) | Multi-vendor cart partitioning; checkout submission begins |
| 9 | 9 | EPIC-CHECKOUT (finish), EPIC-ORD | End-to-end multi-vendor checkout with AwaitingPayment gate and full order state machine — **Release gate 2 (core commerce)** |
| 10 | 10 | EPIC-PAY, EPIC-FUL | Sandbox payments, `OutboxEvent`/`WebhookInbox` reconciliation, delivery/pickup with BR-DELIVERY-CONFIRM |
| 11 | 11 | EPIC-RET, EPIC-REV, EPIC-NOTIF, EPIC-ADMIN, EPIC-VPORTAL (polish) | Returns, reviews, notifications, and both portals reach minimum-viable depth |
| 12 | 12 | EPIC-SEC, EPIC-PERF, EPIC-ANALYTICS, EPIC-OPS | Hardening pass, load test, funnel analytics, vendor pilot + beta, demo rehearsal — **Release gate 3 (FYP exit criteria, Part 1 D.3)** |

Parallel workstreams within each sprint: Engineer A and Engineer B work adjacent epics in the same sprint wherever the dependency table above allows it (e.g., Sprint 2's auth work and vendor-application-form work can run in parallel; Sprint 9's checkout and order-state-machine work cannot, since checkout produces the orders the state machine acts on — sequential within that sprint). Sequential dependencies that cannot be parallelized regardless of team size: EPIC-MATCH before EPIC-IMPORT (offers need something to match against), EPIC-ORD before EPIC-PAY/EPIC-FUL (both act on suborders), EPIC-CHECKOUT before EPIC-RET (nothing to return before something ships).

### Release gates

1. **End of Sprint 4:** vendor onboarding + matching pipeline functional — the platform can hold real vendor data.
2. **End of Sprint 9:** core commerce (multi-vendor checkout → orders) functional end-to-end — the platform's defining mechanic works.
3. **End of Sprint 12:** FYP Delivery Increment exit criteria met (Part 1, D.3) — demo-ready.

### Testing and stabilization

Given the 1-week-sprint cadence, stabilization is continuous (tests run on every PR, per EPIC-FOUND) rather than a separate phase — except **Sprint 12**, which is deliberately reserved for hardening, load testing, and rehearsal rather than new feature work, functioning as the stabilization period the master prompt asks for.

### Vendor pilot and customer beta

**Vendor pilot** (BL-OPS-002) begins as soon as EPIC-VEND + EPIC-IMPORT are functional (end of Sprint 5) and runs continuously through Sprint 12 — real pilot vendors (3–6, per Part 1, D.4) list real offers throughout, rather than being a one-time event, so match-quality and data-quality issues surface early. **Customer beta** (BL-OPS-003) starts once checkout/orders are functional (Sprint 9) with a small closed group, expanding through Sprint 12's rehearsal.

### Production rollout and post-launch monitoring

Explicitly **out of the FYP window**: production rollout is a post-FYP activity, gated on resolving ⚠ OPEN-001 (payment gateway) and ⚠ OPEN-004 (SMS/OTP) for real, plus a decision on OPEN-006 (formal FYP-increment sign-off) and the additional scope in BDR-001–013 not yet built. Post-launch monitoring reuses everything built in EPIC-FOUND/EPIC-DEPLOY/EPIC-OPS (Sentry, admin dashboards, runbooks) — no new tooling is needed, only sustained ownership, which is itself the subject of RISK-011.

### Medium-team scenario (reference only — for the full confirmed scope, post-FYP)

A 6–8 person team (indicatively: 2 backend, 2 frontend/mobile, 1 QA, 1 DevOps/platform, 1 catalog/support operations, 1 product/PM) could parallelize the same backlog across genuinely independent workstreams — e.g., Payments/Delivery and Reviews/Analytics proceeding simultaneously rather than sequentially — compressing the remaining full-scope work (live payment gateway integration, live courier, full nationwide vendor density, ads/sponsored placement, POS/ERP integrations, advanced analytics — everything marked `Won't`/Phase 2 above and in Part 1, D.3) into a meaningfully shorter calendar span than doing it serially with 2 people. **No specific calendar date is given for this**, consistent with the master prompt's instruction not to invent delivery dates without real team size and velocity data — this scenario exists to show the parallelization *structure* available once the team grows, not a committed timeline.

---

**Next:** Part 9 will cover acceptance criteria (Given/When/Then per requirement), the full requirement-to-test-to-release traceability matrix, and the final recommendations required by the master prompt's Section 10 — the last part of this SRS.
