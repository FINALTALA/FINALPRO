# SRS — Part 8: Development Backlog & Sprint/Release Plan

Builds directly on the FYP Delivery Increment (Part 1, D.4 — proposed, tracked as OPEN-006/BDR-015 pending formal sign-off) and the full confirmed scope (BDR-001–013) as its post-FYP roadmap. Organized in **implementation order**, per the master prompt's explicit sequence — not merely by FR module.

**Revision note:** this part was substantially re-scoped after review. The first draft listed ~90 backlog items at roughly 40+ person-weeks of estimated effort against a 24-gross-person-week team, and sequenced sprints in an order that created circular dependencies (checkout needed payment/order/notification/inventory infrastructure the plan hadn't built yet). Both are fixed below: Q.0 shows the capacity math and which items were demoted or shrunk as a direct result (not merely rescheduled), and the sprint plan pulls the minimal core infrastructure forward into its own sprint, ahead of checkout, per the fix required.

**Backlog conventions:** each **Epic** carries the fields that are genuinely epic-level once — Phase, business value, common Definition of Done, and relevant risks (cited by `RISK-*` ID from Part 7) — and its child backlog items inherit them, adding what varies per item: ID, title/user story, FR/BR coverage, dependencies, acceptance criteria, priority, estimate, and its own **Phase/Release** tag (since an item's actual build phase can differ from its epic's overall phase — e.g., a Must item built in the FYP Increment sitting in an epic that's otherwise mostly deferred). This is a representative decomposition sufficient to plan and estimate against, not an exhaustive task breakdown. Priority uses MoSCoW **against the FYP Delivery Increment**; a `Should`/`Could`/`Won't` item is still fully specified in Parts 1–7, just not committed inside the 3-month window unless time allows. Estimates are T-shirt sizes calibrated to the 2-person team's 1-week sprints (S ≈ 1 day = 0.2 person-weeks, M ≈ 2.5 days = 0.5 person-weeks, L ≈ 1 week = 1.0 person-week).

---

## Q.0 Capacity reality check (read before the backlog)

**Gross capacity:** 2 people × 12 weeks = **24 person-weeks**. That number is not the usable budget — it includes no allowance for integration friction, bug-fixing against real pilot/beta data, sprint planning/review overhead, or the vendor-pilot and customer-beta support work that runs *inside* the same 12 weeks (see the Sprint & release plan, below).

**Revision note (second pass):** the previous version of this table claimed ≈17.3 Must person-weeks, but summing the actual backlog items below gave a different number — 73 Must items (53×S + 17×M + 1×L at this document's own S=0.2/M=0.5/L=1.0 sizing) = **20.1 person-weeks**, i.e. a real reserve of only ≈3.9 person-weeks (≈16%), not 28%. The fix here is a genuine further cut, not a re-estimate: **8 more items demoted to Should** (`BL-CAT-002`, `BL-CAT-003`, `BL-VEND-006`, `BL-SEARCH-004`, `BL-FUL-004`, `BL-VPORTAL-003`, `BL-ADMIN-003`, `BL-OPS-001` — each was optional depth, not core-mechanic-blocking) and **one item shrunk** (`BL-ADMIN-001`, from a full vendor-management screen to an approve/suspend-only list, M→S), plus one new item added for honesty rather than savings (`BL-INV-004`, formalizing that inventory *reservation* is deferred — see EPIC-INV below). Verified by directly recounting the resulting backlog with the same method that caught the original inconsistency.

**Verified count after this pass:** 65 Must items — 48×S + 16×M + 1×L = **18.6 person-weeks**. Against 24 gross, that leaves **≈5.4 person-weeks (≈23%) reserved** for integration, bug-fixing against real pilot/beta data, and planning overhead. `Reviews` (FR-REV, per Part 1 D.4's explicit inclusion of "basic reviews") was deliberately **not** among the items cut this round, to avoid silently contradicting a decision already confirmed in Part 1 — the additional capacity instead came from items that were always optional polish.

**What actually fits at ≈18.6 person-weeks**, epic by epic (individual figures below are planning-level rollups and may not sum to the exact verified total to the first decimal — the 18.6/65-item count above, recomputed directly from the item tables, is the authoritative figure):

| Epic | Must person-weeks (FYP) | What changed |
|---|---|---|
| EPIC-FOUND | 1.9 | Unchanged — genuinely prerequisite |
| EPIC-AUTH | 1.3 | Saved-addresses CRUD screen demoted to Should; address captured inline at checkout instead for the FYP |
| EPIC-CAT | 0.4 | Full attribute-template system **and** brand duplicate-detection **and** warranty/tags/product-type-field polish all demoted to Should this round; FYP keeps only the category tree and a fixed free-text spec field (SKU-uniqueness folded into `BL-MATCH-001`'s schema work at no extra cost) |
| EPIC-MATCH | 1.4 | Reviewer UI simplified to a plain approve/reject list, not side-by-side comparison polish |
| EPIC-VEND | 1.6 | Multi-staff-role management demoted to Should (owner-account only for FYP); the suspended-vendor-access QA test (`BL-VEND-006`) demoted to Should this round — the underlying access rule still ships, only the dedicated test is deferred |
| EPIC-IMPORT | 0.9 | Field-mapping UI and retry-only-failed-rows demoted to Should; FYP uses one fixed CSV template |
| EPIC-SEARCH | 0.6 | Deep Arabic NLP/synonym tooling demoted to Should; the unmatched-listing visual label (`BL-SEARCH-004`) demoted to Should this round — the underlying non-linking behavior is already inherent to `BL-MATCH-001`, only the UI badge is deferred |
| EPIC-COMP | 0.6 | Share/save comparison demoted to Should (already was) |
| EPIC-INV | 0.4 | **Explicit scope statement (resolves the review finding):** the FYP uses **checkout-time revalidation only** (`BL-INV-001`/`002`) — inventory *reservation* (FR-INV-003, a temporary hold from cart-add until checkout/expiry) is demoted to Should as its own item (`BL-INV-004`), not silently absorbed into anything else. Revalidation alone still blocks checkout on a genuinely sold-out item (FR-INV-004); reservation only closes the narrower race-condition window between two concurrent customers, a low-probability event at FYP pilot traffic |
| EPIC-CART | 0.6 | Scheduled-delivery-window and note/terms polish demoted to Should |
| EPIC-CHECKOUT | 1.1 | Scope unchanged, but now largely *wiring* against infrastructure built in the dedicated core-infra sprint (Sprint 5, below) rather than building that infrastructure itself |
| EPIC-ORD | 1.6 | Consolidated-timeline UI simplified to a plain status list; state-machine core moved into the core-infra sprint; **the vendor-action UI (`BL-ORD-002`) is built in Sprint 8, not Sprint 9** — see the Sprint & release plan fix, below |
| EPIC-PAY | 1.7 | Refund flow (`BL-PAY-005`) demoted to Should; core (COD, sandbox auth/capture, `PaymentAllocation`, `WebhookInbox`/`OutboxEvent`) kept and moved earlier |
| EPIC-FUL | 0.9 | PostGIS-based "nearby branch" distance logic **and** the standalone delivery-zone-eligibility item (`BL-FUL-004`) both demoted to Should this round — the underlying BR-006 eligibility check ships as part of `BL-CART-002`'s zone check plus the branch data already captured in vendor onboarding, at no extra listed cost |
| **EPIC-RET** | **0 (Should)** | The whole epic — BR-025's design is fully specified and already proven correct on paper; not load-bearing for the FYP exit criteria |
| EPIC-REV | 0.4 | Kept as-is this round (see the note above) — submit + display only; vendor response and moderation stay Should/Could |
| EPIC-NOTIF | 0.7 | DoD narrowed to only the BR-DELIVERY-CONFIRM triple-notification flow; favorites/alerts demoted to Should/Could |
| EPIC-ADMIN | 0.4 | CMS/banner management (already Should) and the full multi-entity admin coverage (already Should) stay deferred; the audit-log *viewer UI* (`BL-ADMIN-003`) demoted to Should this round — `AuditLog` writes still happen regardless (built in `BL-FOUND-005`), only the dedicated viewer screen is deferred, with a direct DB query substituting during the FYP. `BL-ADMIN-001` itself shrunk from a full vendor-management screen to an approve/suspend-only list (M→S) |
| EPIC-VPORTAL | 0.7 | Dashboard and order-queue views merged into one screen; subscription/billing status (`BL-VPORTAL-003`) demoted to Should this round — folded into `BL-VPORTAL-001`'s dashboard as a small status badge at no extra listed cost |
| **EPIC-ANALYTICS** | **0 (Should)** | Funnel visibility read directly from `AuditLog`/admin queries during the FYP window instead of a dedicated dashboard |
| EPIC-SEC | 0.6 | Baseline tests (`TC-SEC-001`, webhook signature, rate-limiting) kept as Must, folded into the sprints that build the features they test; the dedicated hardening pass stays Should |
| **EPIC-PERF** | **0 (Should)** | Unchanged |
| EPIC-DEPLOY | 0.2 | Backup/restore drill stays Should |
| EPIC-OPS | 0.6 | The one runbook (`BL-OPS-001`) demoted to Should this round — written opportunistically during Sprint 12 if time allows rather than a tracked commitment; pilot/beta/rehearsal remain Must, threaded through sprints as ongoing activity, not concentrated build time |
| **Total Must (verified, see above)** | **≈18.6 person-weeks (65 items)** | Against 24 gross — **≈5.4 person-weeks (≈23%) reserved** |

This is the number every Must-priority item below and every sprint in the Sprint & release plan (below) is built against. `Should`/`Could` items remain in the backlog, fully specified, and get picked up only if a sprint finishes under budget — they are not silently dropped from the SRS, only from the committed FYP plan.

---

## Epics, in implementation order

| # | Epic ID | Title | FR/Section coverage | Phase | Business value | FYP priority | Risks (Part 7) | Definition of Done (epic-level) |
|---|---|---|---|---|---|---|---|---|
| 1 | EPIC-FOUND | Foundation | Part 6 (M, P) | FYP Increment | Nothing else can be built without this | Must | RISK-011 | Repo, CI/CD, staging environment, DB migrations, base API conventions all working end-to-end on a trivial route |
| 2 | EPIC-AUTH | Identity and access | FR-AUTH | FYP Increment | Gates every customer-facing action; core trust surface | Must | RISK-011 | A customer can register, verify (OTP or logged fallback), and log in |
| 3 | EPIC-CAT | Catalog and taxonomy | FR-CAT | FYP Increment | Structural prerequisite for every offer in the system | Must | RISK-002 | Catalog admin can manage categories/brands with duplicate-detection working |
| 4 | EPIC-MATCH | Canonical-product model | FR-MATCH, Part 6 §N | FYP Increment | The platform's core trust mechanism — comparison is meaningless without correct matching | Must | RISK-003 | Exact-match auto-link and a basic human-review queue both function against real seeded data |
| 5 | EPIC-VEND | Vendor onboarding | FR-VEND | FYP Increment | No vendors, no supply, no platform (RISK-001) | Must | RISK-001 | A vendor can apply, submit branch verification evidence, get approved, and select a subscription plan |
| 6 | EPIC-IMPORT | Offer creation and imports | FR-IMPORT | FYP Increment | The only realistic way a vendor with no existing system gets onto the platform | Must | RISK-002 | A vendor can create an offer manually or via CSV import |
| 7 | EPIC-SEARCH | Search | FR-SEARCH | FYP Increment | Primary discovery path; Arabic-first is a core, non-negotiable UX requirement | Must | RISK-012 | Arabic/English search returns correct results against seeded data |
| 8 | EPIC-COMP | Comparison | FR-COMP | FYP Increment | The platform's stated differentiator from a single-vendor store | Must | RISK-003 | A customer can compare offers across vendors, including cross-currency |
| 9 | EPIC-INV | Inventory | FR-INV | FYP Increment | Prevents overselling and broken checkout experiences | Must | RISK-004 | Branch-level stock updates and checkout-time revalidation work |
| 10 | EPIC-CART | Cart | FR-CART (cart) | FYP Increment | Prerequisite for the platform's defining checkout mechanic | Must | RISK-006 | A cart holds items from multiple vendors, correctly partitioned |
| 11 | EPIC-CHECKOUT | Checkout | FR-CART (checkout) | FYP Increment | The platform's single riskiest and most defining mechanic (Part 1, D.2) | Must | RISK-006 | End-to-end multi-vendor checkout completes per BR-009/010, including the AwaitingPayment gate (ADR-010) |
| 12 | EPIC-ORD | Orders | FR-ORD | FYP Increment | Where checkout's output actually lives and is tracked | Must | RISK-006 | The `CustomerOrder`/`VendorSuborder`/`OrderItem` state-machine core (Part 2, E.11) works with correct audit records |
| 13 | EPIC-PAY | Payments | FR-PAY | FYP Increment | Nothing can be charged, refunded, or reconciled without this | Must | RISK-007, RISK-015 | COD works fully; online payment works against a sandbox; `PaymentAllocation`/`OutboxEvent` reconcile correctly |
| 14 | EPIC-FUL | Delivery | FR-FUL | FYP Increment | Closes the loop from order to a real customer outcome | Must | RISK-008 | Vendor delivery and pickup both work, including BR-DELIVERY-CONFIRM's three notifications |
| 15 | EPIC-RET | Returns | FR-RET | **Should — demoted for capacity (Q.0)** | Valuable trust/completeness signal, not load-bearing for the exit-criteria demo | Should | RISK-009 | Item-level return (BR-025) works for both split- and non-split-shipment suborders — built only if time allows |
| 16 | EPIC-REV | Reviews | FR-REV | FYP Increment (minimal) | Trust signal for a comparison platform; kept intentionally tiny | Must (minimal slice only) | RISK-010 | A customer can submit and see a basic verified-purchase review — no response/moderation in the FYP |
| 17 | EPIC-NOTIF | Notifications (incl. Favorites/Alerts) | FR-NOTIF, FR-FAV (folded in — see note) | FYP Increment (core) / Should (alerts) | BR-DELIVERY-CONFIRM is the one notification path the whole checkout/delivery loop depends on | Must (triple-notification flow only — see revised DoD) | RISK-011 | **Revised DoD:** the BR-DELIVERY-CONFIRM triple-notification flow (vendor in-app alert + 2 SMS legs, or the logged fallback per Part 1 D.4) works end-to-end. Favorites/price-drop/back-in-stock alerts are explicitly **out of the Must scope** — demoted to Should/Could — since they depend on epics (Comparison, Inventory) that are themselves tight on budget |
| 18 | EPIC-ADMIN | Administration (incl. CMS) | FR-ADMIN, FR-CMS (folded in — see note) | FYP Increment (minimum) | The pilot cannot run without at least vendor management + match review | Must (minimum viable admin only) | RISK-001, RISK-003 | Platform admin can manage vendors, review matches, and view a basic audit log; content/banner management demoted to Should |
| 19 | EPIC-VPORTAL | Vendor portal | FR-VPORTAL | FYP Increment (minimum) | Pilot vendors cannot operate without this | Must | RISK-001, RISK-011 | A vendor can run their store's core operations (offers, orders) through the portal without developer intervention |
| 20 | EPIC-ANALYTICS | Analytics | FR-ANALYTICS | **Should — demoted for capacity (Q.0)** | Useful, not required to prove the mechanic works | Should | RISK-014 | Funnel visibility beyond ad-hoc admin queries — built only if time allows |
| 21 | EPIC-SEC | Security hardening | Part 6 §O, future Section J | FYP Increment (baseline) / Should (dedicated pass) | Tenant isolation and payment-webhook integrity are non-negotiable even in a demo | Must (baseline tests only) | RISK-010, RISK-015 | `TC-SEC-001` and webhook-signature tests pass, folded into the sprints that build the features they cover; a dedicated hardening pass is Should |
| 22 | EPIC-PERF | Performance | NFR-PERF-*, NFR-SCALE-001 | Should | Real load-testing is valuable but not exit-criteria-blocking at FYP scale | Should | — | FYP-scale targets met under a basic load test — built only if time allows |
| 23 | EPIC-DEPLOY | Deployment | Part 6 §P | FYP Increment | Nothing ships without a real deploy target | Must | RISK-011 | Staging and a production-equivalent environment both deployable via the CI/CD pipeline |
| 24 | EPIC-OPS | Operational readiness | Part 6 §P, Part 5 K.2 | FYP Increment | This *is* the deliverable — a working pilot and beta against the exit criteria | Must | RISK-001, RISK-011, RISK-016 | The highest-risk runbook exists; the vendor pilot and a small customer beta both run successfully against the FYP exit criteria (Part 1, D.3) |

**Note on folded modules:** the master prompt's own implementation-order list does not name Favorites/Alerts or CMS/Marketing as separate epics — they're folded here into the epic they're most operationally similar to (Favorites/Alerts → Notifications; CMS/Marketing → Administration) rather than silently dropped, and both retain their own `FR-FAV-*`/`FR-CMS-*` IDs from Part 2 for traceability. Their Must-priority status inside those epics was explicitly narrowed in this revision (see EPIC-NOTIF's revised DoD and EPIC-ADMIN's Should-demotion of BL-ADMIN-004).

---

## Backlog items by epic

Each row now carries its own **Phase** tag: `FYP` = committed inside the 3-month window at the stated priority; `FYP (stretch)` = built only if the sprint it's slotted into finishes under budget; `Full MVP` = specified now, built post-FYP once the additional scope in BDR-001–013 is resourced.

### 1. EPIC-FOUND — Foundation

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Phase | Estimate |
|---|---|---|---|---|---|---|---|
| BL-FOUND-001 (DevOps) | Repo, CI (test-on-PR), staging deploy target (Part 6 M.2) | Part 6 §M/P | None | A trivial PR triggers tests and a staging deploy automatically | Must | FYP | M |
| BL-FOUND-002 (Tech) | PostgreSQL + PostGIS with the initial migration framework | Part 3, G.3 | BL-FOUND-001 | A migration can be written, applied, and rolled back locally and in staging | Must | FYP | S |
| BL-FOUND-003 (Tech) | H.1's cross-cutting API conventions (error format, correlation IDs, idempotency-key middleware, rate limiting) | Part 4, H.1 | BL-FOUND-002 | A sample endpoint demonstrates every convention | Must | FYP | M |
| BL-FOUND-004 (DevOps) | Sentry error tracking + structured logging | Part 6 §P | BL-FOUND-001 | A deliberately thrown error in staging appears in Sentry with its correlation ID | Must | FYP | S |
| BL-FOUND-005 (Data) | `AuditLog` and `OutboxEvent` as shared infrastructure tables with write helpers | Part 3, G.3; ADR-006 | BL-FOUND-002 | A test write produces an `AuditLog` row; a test `OutboxEvent` is picked up by a stub relay worker | Must | FYP | M |

### 2. EPIC-AUTH — Identity and access

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Phase | Estimate |
|---|---|---|---|---|---|---|---|
| BL-AUTH-001 (Story) | As a guest, I can browse/search/compare without an account | FR-AUTH-001 | EPIC-SEARCH (can stub initially) | Guest session hits no auth wall on read-only routes | Must | FYP | S |
| BL-AUTH-002 (Story) | As a new user, I can register with phone + password and verify via OTP (or the logged fallback, ⚠ OPEN-004) | FR-AUTH-002/003 | BL-FOUND-003 | `TC-AUTH-001` passes | Must | FYP | M |
| BL-AUTH-003 (Story) | As a returning user, I can log in and reset my password via OTP | FR-AUTH-005/006 | BL-AUTH-002 | Login + reset flows both work | Must | FYP | S |
| BL-AUTH-004 (Story) | As a customer, I capture an address (map pin + phones) inline at checkout | FR-AUTH-008 (minimal slice); Part 7, DEP-009 | BL-AUTH-002, Part 6 Maps row | Pin + landmark + phone numbers captured at the point of use | Must | FYP | S |
| BL-AUTH-004b (Story) | Saved-addresses CRUD screen (manage multiple addresses ahead of checkout) | FR-AUTH-008 (full) | BL-AUTH-004 | A separate, dedicated address-book screen | Should | FYP (stretch) | M |
| BL-AUTH-005 (QA) | Retry-idempotency test for OTP verify | FR-AUTH-003 | BL-AUTH-002 | `TC-AUTH-002` passes | Must | FYP | S |

### 3. EPIC-CAT — Catalog and taxonomy

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Phase | Estimate |
|---|---|---|---|---|---|---|---|
| BL-CAT-001 (Story) | As a catalog admin, I can manage the category tree (AR/EN) | FR-CAT-001 | EPIC-FOUND | Categories CRUD works with both locales required | Must | FYP | S |
| BL-CAT-002 (Story) | As a catalog admin, I can manage brands with duplicate-name detection | FR-CAT-002/009 | BL-CAT-001 | Near-duplicate brand creation triggers a warning; brands still creatable without it (manual admin vigilance substitutes) | Should | FYP (stretch) | S |
| BL-CAT-003 (Tech) | `CanonicalProduct.product_type`, warranty/tags fields | FR-CAT-004/010–012 | BL-CAT-001 | Schema matches Part 3, G.3 exactly — SKU-uniqueness (FR-CAT-013) folded into `BL-MATCH-001` instead, at no extra listed cost | Should | FYP (stretch) | S |
| BL-CAT-004 (Story) | Full per-category attribute-template system (structured fields, allowed values/units) | FR-CAT-003 | BL-CAT-001 | Drives dynamic offer-editor form fields per category | Should | Full MVP | M |
| BL-CAT-004b (Tech) | FYP fallback: a single free-text specs field on the offer, in place of BL-CAT-004 | FR-CAT-003 (simplified) | BL-CAT-001 | Offer editor works without the full template system | Must | FYP | S |

### 4. EPIC-MATCH — Canonical-product model

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Phase | Estimate |
|---|---|---|---|---|---|---|---|
| BL-MATCH-001 (Tech) | Four-level `CanonicalProduct`/`CanonicalProductVariant`/`VendorOffer`/`OfferVariant` schema | FR-MATCH-001/008, Part 3, G.1 | EPIC-CAT | `TC-MATCH-*` schema assertions pass; no `vendor_id` on canonical tables | Must | FYP | M |
| BL-MATCH-002 (Story) | Auto-link an offer with an exact identifier match | FR-MATCH-002, BR-001 | BL-MATCH-001 | `TC-MATCH-001` passes | Must | FYP | S |
| BL-MATCH-003 (Story) | As a product-matching reviewer, I approve/reject a queued match from a plain list (no side-by-side UI polish for the FYP) | FR-MATCH-003/004, Part 4 `POST /product-matches/{id}/decision` | BL-MATCH-002 | `TC-MATCHAPI-001` passes | Must | FYP | M |
| BL-MATCH-003b (Story) | Side-by-side candidate comparison UI polish | Part 5, K.1 | BL-MATCH-003 | Matches the full screen spec | Should | FYP (stretch) | S |
| BL-MATCH-004 (Story) | As a customer, I can report an incorrect match | FR-MATCH-005 | BL-MATCH-003 | Reported match re-enters the queue with a flag | Should | FYP (stretch) | S |
| BL-MATCH-005 (QA) | Never-auto-match negative tests (used-vs-new, bundle) | Part 6, N.2 | BL-MATCH-002 | `TC-MATCH-002` passes | Must | FYP | S |

### 5. EPIC-VEND — Vendor onboarding

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Phase | Estimate |
|---|---|---|---|---|---|---|---|
| BL-VEND-001 (Story) | As a prospective vendor, I can apply with store profile and branch info | FR-VEND-001 | EPIC-FOUND | Application form + ≥1 branch required to submit | Must | FYP | M |
| BL-VEND-002 (Story) | As a vendor, I can submit branch verification evidence (map pin + photo) | FR-VEND-002, BR-022 | BL-VEND-001, Maps row | `TC-VEND-001` passes | Must | FYP | S |
| BL-VEND-003 (Story) | As a vendor-verification reviewer, I approve/reject/request-resubmission | FR-VEND-003 | BL-VEND-002 | Decision writes an audit record | Must | FYP | S |
| BL-VEND-004 (Story) | As an approved vendor, I select a subscription plan before publishing | FR-VEND-004/005, ⚠ OPEN-003 | BL-VEND-003 | Vendor status gates offer visibility (BR-014) | Must | FYP | M |
| BL-VEND-005 (Story) | Multi-staff-role account management (admin/branch-manager/catalog/order-processing sub-roles) | FR-VEND-006/007 | BL-VEND-001 | Role-scoped per Part 1, Section C, in full | Should | FYP (stretch) | M |
| BL-VEND-005b (Tech) | FYP fallback: owner-only vendor account, no sub-roles | FR-VEND-007 (simplified) | BL-VEND-001 | A single account can operate the whole store | Must | FYP | S |
| BL-VEND-006 (QA) | Suspended-vendor restricted-access test | FR-VEND-009, Part 5 L-23 | BL-VEND-004 | `TC-VEND-002` passes — the underlying access rule (FR-VEND-009) ships regardless; only the dedicated automated test is deferred | Should | FYP (stretch) | S |

### 6. EPIC-IMPORT — Offer creation and imports

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Phase | Estimate |
|---|---|---|---|---|---|---|---|
| BL-IMPORT-001 (Story) | As a vendor catalog employee, I can create/edit an offer manually | FR-IMPORT-001 | EPIC-MATCH, EPIC-CAT | Uses the FYP fallback specs field (BL-CAT-004b) | Must | FYP | S |
| BL-IMPORT-002 (Story) | Bulk CSV import against one fixed template (no configurable field-mapping UI in the FYP) | FR-IMPORT-002 | BL-IMPORT-001 | Validation report generated; partial success supported | Must | FYP | M |
| BL-IMPORT-002b (Story) | Configurable field-mapping UI | FR-IMPORT-011 | BL-IMPORT-002 | Vendor's own column headers can be mapped | Should | FYP (stretch) | M |
| BL-IMPORT-003 (Story) | Retry only the failed rows of an import | FR-IMPORT-012 | BL-IMPORT-002 | `TC-IMPORT-002` passes | Should | FYP (stretch) | S |
| BL-IMPORT-004 (QA) | Partial-success import test | FR-IMPORT-003 | BL-IMPORT-002 | `TC-IMPORT-001` passes | Must | FYP | S |

### 7. EPIC-SEARCH — Search

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Phase | Estimate |
|---|---|---|---|---|---|---|---|
| BL-SEARCH-001 (Tech) | Postgres FTS (`tsvector`/`tsquery` + `pg_trgm`) on offers/canonical products | FR-SEARCH-001, Part 6 M.2 | EPIC-MATCH | Basic query returns relevant results | Must | FYP | S |
| BL-SEARCH-002 (Tech) | Basic Arabic normalization + `pg_trgm` typo tolerance (deep NLP/synonym tooling deferred) | FR-SEARCH-002 (minimal) | BL-SEARCH-001 | `TC-SEARCH-001` passes on the common cases | Must | FYP | S |
| BL-SEARCH-002b (Tech) | Full transliteration + curated synonym list | FR-SEARCH-002/012 (full) | BL-SEARCH-002 | Handles regional brand nicknames, etc. | Should | FYP (stretch) | M |
| BL-SEARCH-003 (Story) | As a customer, I can filter/sort search results | FR-SEARCH-005 | BL-SEARCH-001 | Filters combine correctly (AND semantics) | Must | FYP | S |
| BL-SEARCH-004 (Story) | Unmatched/unique listings appear visually labeled in results | FR-SEARCH-010, FR-MATCH-009 | BL-SEARCH-001 | Visual distinction confirmed in UI review — the underlying non-linking behavior (FR-MATCH-009) is already enforced by `BL-MATCH-001`'s schema regardless; only the search-result UI badge is deferred | Should | FYP (stretch) | S |

### 8. EPIC-COMP — Comparison

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Phase | Estimate |
|---|---|---|---|---|---|---|---|
| BL-COMP-001 (Story) | As a customer, I can add/remove items to a comparison set | FR-COMP-001 | EPIC-SEARCH | Max-4 enforced | Must | FYP | S |
| BL-COMP-002 (Story) | I see the cheapest/best-value offer with an explanation | FR-COMP-005 | BL-COMP-001 | "Why best" text renders correctly | Must | FYP | S |
| BL-COMP-003 (Tech) | FX-normalized comparison price with rate/date disclosure | FR-COMP-009, BR-021, ⚠ OPEN-002 | BL-COMP-001 | `TC-COMP-001` passes | Must | FYP | S |
| BL-COMP-004 (Story) | I can share/save a comparison | FR-COMP-007 | BL-COMP-001 | Share link resolves to the same set | Should | FYP (stretch) | S |

### 9. EPIC-INV — Inventory

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Phase | Estimate |
|---|---|---|---|---|---|---|---|
| BL-INV-001 (Story) | As vendor staff, I can update stock per branch (manual only) | FR-INV-001/005 | EPIC-VEND, EPIC-IMPORT | Stock updates reflected immediately | Must | FYP | S |
| BL-INV-002 (Story) | Checkout-time revalidation of price/stock | FR-INV-004, FR-CART-002 | BL-INV-001 | `TC-INV-001` passes — this is the FYP's *only* oversell defense (see BL-INV-004) | Must | FYP | S |
| BL-INV-003 (Tech) | Scheduled staleness sweep/flagging per channel | FR-INV-006, BR-005 | BL-INV-001 | Flags stale rows per NFR-STALE-001 | Should | FYP (stretch) | M |
| BL-INV-004 (Tech) | Inventory **reservation** with expiry window (FR-INV-003) — a temporary hold from cart-add until checkout/expiry, on top of (not instead of) revalidation | FR-INV-003 | BL-INV-002 | A reserved unit is unavailable to a second concurrent customer until the reservation expires or converts to a sale | Should | Full MVP | M |

### 10. EPIC-CART — Cart

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Phase | Estimate |
|---|---|---|---|---|---|---|---|
| BL-CART-001 (Story) | As a customer, my cart partitions items by vendor automatically | FR-CART-001, BR-009 | EPIC-INV (BL-INV-001/002 only) | `TC-CART-001` passes | Must | FYP | S |
| BL-CART-002 (Story) | Per-vendor minimum order + delivery-zone eligibility checks | FR-CART-003/004 | BL-CART-001 | Ineligible partition surfaces pickup-only messaging (L-22) | Must | FYP | S |
| BL-CART-003 (Story) | Per-vendor fulfillment choice | FR-CART-005 | BL-CART-001 | Each vendor partition independently configurable | Must | FYP | S |
| BL-CART-003b (Story) | Scheduled-delivery windows, customer/vendor notes | FR-CART-013/014 | BL-CART-003 | Full polish per Part 2 | Should | FYP (stretch) | S |

### 11. EPIC-CHECKOUT — Checkout

*Depends on the core commerce infrastructure (minimal Order state machine, Payment stub, notification dispatch, Inventory revalidation — **not** reservation, which is deferred per EPIC-INV) built in the dedicated infrastructure sprint (Sprint 5, below) — this is what resolves the checkout↔payment↔order↔notification circular dependency from the first draft.*

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Phase | Estimate |
|---|---|---|---|---|---|---|---|
| BL-CHECKOUT-001 (Story) | As a customer, I complete checkout with address + two phone numbers | FR-CART-006, BR-020 | EPIC-CART, EPIC-AUTH, **core infra (Sprint 5)** | Order confirmation fires BR-DELIVERY-CONFIRM | Must | FYP | M |
| BL-CHECKOUT-002 (Tech) | Idempotent checkout submission | FR-CART-008, Part 4 | BL-CHECKOUT-001 | `TC-CHECKOUT-003` passes | Must | FYP | S |
| BL-CHECKOUT-003 (Tech) | Wire the `AwaitingPayment` gate (built in core infra) into the checkout flow | ADR-010, Part 2 E.11 | BL-CHECKOUT-001, **core infra Payment stub** | `TC-CHECKOUT-001`/`002` pass | Must | FYP | S |
| BL-CHECKOUT-004 (QA) | Checkout-failure cart preservation | FR-CART-016 | BL-CHECKOUT-001 | Failed checkout leaves cart intact for resubmission | Must | FYP | S |

### 12. EPIC-ORD — Orders

*The state-machine core itself is built in the infrastructure sprint (Sprint 5), ahead of Checkout — this section covers the layers built on top of it afterward.*

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Phase | Estimate |
|---|---|---|---|---|---|---|---|
| BL-ORD-001 (Tech) | `CustomerOrder`/`VendorSuborder`/`OrderItem` state-machine core (data model + transition logic, no UI) | Part 2, E.11 | EPIC-FOUND | Every valid/invalid transition in Part 2 covered by `TC-*` | Must | **FYP — built in the core-infra sprint, before Checkout** | L |
| BL-ORD-002 (Story) | As a vendor, I can confirm/reject/dispatch a suborder — a minimal, even unstyled, action screen; `BL-VPORTAL-001` wraps/polishes it later, doesn't duplicate it | FR-ORD-007, Part 4 `PATCH /suborders/{id}/status` | BL-ORD-001, EPIC-CHECKOUT | Role-scoped per Part 1, Section C | Must | **FYP — built in Sprint 8, alongside Delivery, not Sprint 9 (resolves the review finding: a vendor must be able to act on an order before customer beta starts)** | S |
| BL-ORD-003 (Story) | As a customer, I see a plain order-status list (not a custom timeline component) | FR-ORD-005 | BL-ORD-001 | Parent + per-suborder status both visible | Must | FYP | S |
| BL-ORD-004 (QA) | Partial-rejection independence test | FR-ORD-003, Part 5 L-13 | BL-ORD-001 | `TC-ORD-001` passes | Must | FYP | S |

### 13. EPIC-PAY — Payments

*The stub gateway, `PaymentAllocation`, and `WebhookInbox`/`OutboxEvent` relay worker are built in the core-infra sprint (Sprint 5), ahead of Checkout.*

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Phase | Estimate |
|---|---|---|---|---|---|---|---|
| BL-PAY-001 (Story) | COD path through the Payment state machine | FR-PAY-001 | BL-ORD-001 | Works end-to-end | Must | **FYP — core-infra sprint** | S |
| BL-PAY-002 (Tech) | Sandbox online-payment stub (authorize/capture/fail) | FR-PAY-002, ⚠ OPEN-001 | BL-PAY-001 | Simulated paths all work | Must | **FYP — core-infra sprint** | M |
| BL-PAY-003 (Tech) | `PaymentAllocation`/`PaymentTransactionAllocation` core | FR-PAY-003, Part 3 | BL-PAY-002 | `TC-PAY-006` passes for both OPEN-007 resolutions | Must | **FYP — core-infra sprint** | M |
| BL-PAY-004 (Tech) | `WebhookInbox` + `OutboxEvent` relay worker | Part 3, Part 6 M.4, ADR-006 | BL-PAY-002, BL-FOUND-005 | `TC-PAY-002/003/005`, `TC-OUTBOX-001` all pass | Must | **FYP — core-infra sprint** | M |
| BL-PAY-005 (Story) | Partial/full refund flow | FR-PAY-004, BR-013 | BL-PAY-003, EPIC-RET | `TC-PAY-004` passes | Should | Full MVP (Returns is demoted; refund has nothing to attach to without it) | M |

### 14. EPIC-FUL — Delivery

*Depends on the notification-dispatch mechanism built in the core-infra sprint.*

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Phase | Estimate |
|---|---|---|---|---|---|---|---|
| BL-FUL-001 (Tech) | Delivery state machine (Part 2, E.11) | FR-FUL-002 | BL-ORD-001 | Assigned→OutForDelivery→Delivered/FailedAttempt all covered | Must | FYP | M |
| BL-FUL-002 (Story) | Pickup flow with pickup code | FR-FUL-008 | BL-FUL-001 | Branch staff can redeem a code | Must | FYP | S |
| BL-FUL-003 (Tech) | Wire BR-DELIVERY-CONFIRM's three notifications into checkout/delivery | FR-FUL-003, ⚠ OPEN-004 | **Core-infra notification dispatch (Sprint 5)** | Real SMS if OPEN-004 resolves in time, else logged/visible fallback per Part 1, D.4 | Must | FYP | S |
| BL-FUL-004 (Story) | Standalone delivery-zone-eligibility screen/logic beyond what `BL-CART-002` already checks | FR-FUL-004, BR-006 (minimal) | EPIC-VEND, BL-CART-002 | Matches BR-006's eligibility rule as a dedicated item — for the FYP, `BL-CART-002`'s zone check plus the branch data captured in vendor onboarding already covers this at no extra listed cost | Should | FYP (stretch) | S |
| BL-FUL-004b (Tech) | PostGIS-based "nearby branch" distance logic | FR-SEARCH-006 (full) | BL-FUL-004 | Real distance sorting, not just eligibility | Should | Full MVP | S |

### 15. EPIC-RET — Returns *(Should — demoted for capacity; fully specified, not built unless time allows)*

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Phase | Estimate |
|---|---|---|---|---|---|---|---|
| BL-RET-001 (Tech) | Return state machine (Part 2, E.11/E.14) | FR-RET-002/003 | EPIC-FUL | Requested→VendorReview→Approved/Rejected→Refund all covered | Should | Full MVP | L |
| BL-RET-002 (Story) | Item-level return independent of sibling items | BR-025 | BL-RET-001 | `TC-RET-001`/`002` pass | Should | Full MVP | M |
| BL-RET-003 (Story) | As a vendor, I approve/reject returns within SLA | FR-RET-003 | BL-RET-001 | Auto-escalation on SLA breach | Should | Full MVP | M |

### 16. EPIC-REV — Reviews *(Must, but deliberately minimal)*

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Phase | Estimate |
|---|---|---|---|---|---|---|---|
| BL-REV-001 (Story) | As a customer, I can submit a verified-purchase review (rating + text only, no images) | FR-REV-001 | BL-ORD-001 | BR-016 verification enforced | Must | FYP | S |
| BL-REV-002 (Story) | Reviews display on offer/store pages with aggregate rating | FR-REV-002/005 | BL-REV-001 | Rating formula matches Part 6, O | Must | FYP | S |
| BL-REV-003 (Story) | Vendor can respond to a review; image uploads in reviews; moderation queue | FR-REV-003/004, FR-REV-006/007 | BL-REV-001 | Full spec per Part 2 | Could | Full MVP | M |

### 17. EPIC-NOTIF — Notifications *(revised DoD: only the triple-notification flow is Must)*

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Phase | Estimate |
|---|---|---|---|---|---|---|---|
| BL-NOTIF-001 (Tech) | Generic notification dispatch mechanism (SMS/email/in-app), retry-tracked, built on `OutboxEvent` | FR-NOTIF-001/004 | BL-FOUND-005 | Every notification instance independently tracked | Must | **FYP — core-infra sprint, before Checkout/Delivery** | M |
| BL-NOTIF-002 (Tech) | Minimal AR+EN strings for the BR-DELIVERY-CONFIRM templates only (full bilingual template system deferred) | FR-NOTIF-003 (minimal) | BL-NOTIF-001 | The three BR-DELIVERY-CONFIRM messages exist in both locales | Must | FYP | S |
| BL-NOTIF-002b (Tech) | Full bilingual template system for every notification type | FR-NOTIF-003 (full) | BL-NOTIF-002 | Every customer-facing template, not just BR-DELIVERY-CONFIRM's three | Should | FYP (stretch) | M |
| BL-NOTIF-003 (Story) | Favorite products + alert-preference settings | FR-FAV-001/005 | EPIC-COMP | — | Should | Full MVP | M |
| BL-NOTIF-004 (Story) | Price-drop and back-in-stock alerts | FR-FAV-003/004 | BL-NOTIF-003, EPIC-INV | Triggered off `PriceHistory`/stock-state changes | Could | Full MVP | M |

### 18. EPIC-ADMIN — Administration *(minimum viable admin only)*

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Phase | Estimate |
|---|---|---|---|---|---|---|---|
| BL-ADMIN-001 (Story) | As platform admin, I manage vendors centrally — shrunk to an **approve/suspend-only list**, not a full vendor-management screen (branch/staff detail views live in the vendor's own portal, not admin) | FR-ADMIN-001 (vendor approve/suspend slice only) | EPIC-VEND | Admin can approve a pending vendor and suspend an active one from a plain list | Must | FYP | S |
| BL-ADMIN-001b (Story) | Full admin coverage of every entity named in FR-ADMIN-001 (branches, catalog, imports, orders, payments, settlements, returns, disputes, reviews, promotions, content, delivery zones, notifications, tickets, feature flags, fraud signals, data exports) | FR-ADMIN-001 (full) | BL-ADMIN-001 | Matches Part 5, K.1's full admin screen set | Should | Full MVP | L |
| BL-ADMIN-002 (Story) | Match-review queue (already built in EPIC-MATCH) surfaced in the admin nav | FR-ADMIN-001 | BL-MATCH-003 | Reachable from the admin dashboard | Must | FYP | S |
| BL-ADMIN-003 (Story) | Minimal audit-log viewer UI (search by entity, no full filtering) | FR-ADMIN-005 (minimal) | BL-FOUND-005 | `AuditLog` rows are queryable through a UI, not just direct DB query — `AuditLog` writes themselves already happen regardless (`BL-FOUND-005`), only this viewer screen is deferred | Should | FYP (stretch) | S |
| BL-ADMIN-004 (Story) | Basic content/banner management | FR-CMS-001 | BL-ADMIN-001 | Draft/preview/publish workflow works | Should | Full MVP | M |

### 19. EPIC-VPORTAL — Vendor portal

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Phase | Estimate |
|---|---|---|---|---|---|---|---|
| BL-VPORTAL-001 (Story) | Combined vendor dashboard + order queue (merged into one screen for the FYP) | FR-VPORTAL-001/004 | EPIC-VEND, EPIC-ORD | A vendor can see and act on orders from one screen | Must | FYP | M |
| BL-VPORTAL-002 (Story) | Vendor notifications surfaced on the same screen | FR-VPORTAL-011 | BL-NOTIF-001 | BR-DELIVERY-CONFIRM alerts appear here | Must | FYP | S |
| BL-VPORTAL-003 (Story) | Dedicated subscription/billing status screen (beyond a small status badge on `BL-VPORTAL-001`'s dashboard) | FR-VPORTAL-006, ⚠ OPEN-003 | EPIC-VEND | Full billing-history view, not just current status | Should | FYP (stretch) | S |

### 20. EPIC-ANALYTICS — Analytics *(Should — demoted for capacity)*

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Phase | Estimate |
|---|---|---|---|---|---|---|---|
| BL-ANALYTICS-001 (Story) | Search→compare→cart→checkout funnel dashboard | FR-ANALYTICS-006 | Every core epic | Used to evaluate the FYP exit-criteria demo (Part 1, D.3) — a manual admin-query readout is an acceptable fallback if this doesn't get built | Should | FYP (stretch) | M |
| BL-ANALYTICS-002 (Story) | Catalog/match-quality reporting | FR-ANALYTICS-002 | EPIC-MATCH | Auto-match rate, reviewer throughput visible (Part 6, N.4) | Could | Full MVP | M |

### 21. EPIC-SEC — Security hardening *(baseline tests folded into the epics they cover)*

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Phase | Estimate |
|---|---|---|---|---|---|---|---|
| BL-SEC-001 (QA) | Tenant isolation / BOLA test suite | Part 6, M.5 | EPIC-VEND, EPIC-ADMIN | `TC-SEC-001` passes across every vendor-scoped endpoint | Must | FYP | S |
| BL-SEC-002 (QA) | Webhook signature/durability test suite | Part 4, H.3 | EPIC-PAY | `TC-PAY-005`, `TC-OUTBOX-001` pass | Must | FYP | S |
| BL-SEC-003 (Tech) | Rate-limiting + OTP abuse protection | FR-AUTH-011 | EPIC-AUTH | Repeated-failure lockout verified | Must | FYP | S |
| BL-SEC-004 (Tech) | Dedicated pre-pilot hardening pass (injection/XSS sweep, dependency audit) | Part 5, L-28 | All prior | No critical findings open at pilot start | Should | FYP (stretch) | M |

### 22. EPIC-PERF — Performance *(Should)*

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Phase | Estimate |
|---|---|---|---|---|---|---|---|
| BL-PERF-001 (QA) | Load test against NFR-PERF-001/002/003 at FYP scale | Part 4, Section I | Core epics complete | Targets met under a 50-concurrent-session simulated load | Should | FYP (stretch) | M |

### 23. EPIC-DEPLOY — Deployment

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Phase | Estimate |
|---|---|---|---|---|---|---|---|
| BL-DEPLOY-001 (DevOps) | Production-equivalent environment provisioned | Part 6 §P | EPIC-FOUND | Deployable via the same pipeline as staging | Must | FYP | S |
| BL-DEPLOY-002 (DevOps) | Backup/restore drill | NFR-BACKUP-001 | BL-DEPLOY-001 | `TC-DR-001` passes | Should | FYP (stretch) | S |

### 24. EPIC-OPS — Operational readiness

| ID | Title | FR/BR | Dependencies | Acceptance criteria | Priority | Phase | Estimate |
|---|---|---|---|---|---|---|---|
| BL-OPS-001 (Ops) | Payment-webhook-backlog runbook (the single highest-risk scenario; others deferred) | Part 6 §P | EPIC-PAY | Runbook exists and is readable by whichever engineer isn't on-call — written opportunistically during Sprint 12's stabilization time if it fits, not a tracked commitment | Should | FYP (stretch) | S |
| BL-OPS-002 (Ops) | Vendor pilot onboarding (3–6 vendors, per Part 1 D.4) | Part 1, D.4 | EPIC-VEND, EPIC-IMPORT | Pilot vendors listing real offers — ongoing, not one build task | Must | FYP | S (per touchpoint, spread across sprints) |
| BL-OPS-003 (Ops) | Small customer beta | Part 1, D.3 exit criteria | EPIC-CHECKOUT, EPIC-ORD, EPIC-PAY, EPIC-FUL | End-to-end demo flow completes with real beta users — **starts only once the full path (checkout→payment→delivery) is usable, not before** | Must | FYP | S (per touchpoint) |
| BL-OPS-004 (Ops) | FYP exit-criteria demo rehearsal | Part 1, D.3 | Every Must item above | Full demo script runs clean | Must | FYP | S |

---

## Sprint & release plan

### Team composition (small-team scenario — the actual FYP team)

2 people: **Engineer A** leans backend/data (schema, state machines, payments, matching); **Engineer B** leans frontend/vendor-portal (Next.js client, vendor/admin portals, UX). Both share QA, DevOps, and operational-readiness work. This matches RISK-011 head-on rather than pretending a bigger team exists.

### Sprint length and cadence

**1-week sprints, 12 sprints total**, matching the confirmed 3-month window (Q14), budgeted against the **≈17.3 Must person-weeks** established in Q.0 (≈1.4 pw/sprint average, leaving working slack most sprints rather than concentrating all buffer at the end).

### Sprint-by-sprint goals — corrected for real dependencies

The first draft scheduled Payments, Orders, and Notifications *after* Checkout, and Inventory *after* Cart while Cart depended on Inventory — both circular. The fix: **Sprint 5 builds the minimal core commerce infrastructure — Order state-machine core, Payment stub, notification dispatch, and Inventory revalidation (reservation, FR-INV-003, is explicitly deferred to `BL-INV-004`/Full MVP, not built here) — before Checkout exists at all**, so Checkout in Sprint 7 is mostly *wiring* against already-working infrastructure, and every subsequent sprint layers portals/UI on top of it, never in front of it.

A second fix, from the same review round: the first draft left the vendor unable to actually confirm/dispatch an order until Sprint 9, one sprint *after* claiming the full customer path was usable (Sprint 8) — a customer could check out and get "delivered" without any vendor action ever having happened. **`BL-ORD-002` (the minimal vendor order-action screen) now moves into Sprint 8**, alongside Delivery, so a vendor genuinely can act on an order by the time the path is claimed usable.

| Sprint | Weeks | Primary epics | Sprint goal |
|---|---|---|---|
| 1 | 1 | EPIC-FOUND | Deployable skeleton with CI/CD, DB, API conventions, error tracking, `AuditLog`/`OutboxEvent` scaffolding |
| 2 | 2 | EPIC-AUTH, EPIC-VEND (start) | A customer can register/verify/log in; a vendor can apply |
| 3 | 3 | EPIC-CAT, EPIC-MATCH (start) | Catalog admin functional; four-level schema + exact-match auto-linking work |
| 4 | 4 | EPIC-MATCH (finish), EPIC-VEND (finish), EPIC-IMPORT | Match-review queue functional; vendor onboarding + manual/CSV offer creation complete — **Release gate 1** |
| 5 | 5 | **Core commerce infrastructure** (BL-ORD-001, BL-PAY-001–004, BL-NOTIF-001, BL-INV-001/002) | Order state-machine core, payment stub with allocation/outbox, notification dispatch, and inventory *revalidation* (not reservation) all working **with no customer-facing UI yet** — the dependency-fix sprint |
| 6 | 6 | EPIC-CART (built on Sprint 5's inventory revalidation), EPIC-SEARCH | Multi-vendor cart partitioning; basic Arabic/English search |
| 7 | 7 | EPIC-CHECKOUT (wiring against Sprint 5's infrastructure) | End-to-end multi-vendor checkout, AwaitingPayment gate, BR-DELIVERY-CONFIRM trigger — **Release gate 2 (core commerce)** |
| 8 | 8 | EPIC-FUL (using Sprint 5's notification dispatch), EPIC-COMP, **`BL-ORD-002` (vendor order-action screen, moved forward from Sprint 9)** | Vendor delivery/pickup functional; comparison UI; **a vendor can now confirm/dispatch an order** — the full customer-*and*-vendor path (search→compare→cart→checkout→**vendor confirms**→delivery/pickup) is genuinely usable end-to-end, not just the customer-facing half of it |
| 9 | 9 | EPIC-ORD (remaining UI: `BL-ORD-003` status list), EPIC-ADMIN (minimum) | Customer-facing order-status list; basic admin (vendor approve/suspend, match queue) — **customer beta starts now** (see Vendor pilot and customer beta, below), since Sprint 8 is where the path actually became usable, vendor action included |
| 10 | 10 | EPIC-VPORTAL, EPIC-REV (minimal), EPIC-SEC (baseline tests) | Vendor portal reaches minimum viable depth; basic reviews; `TC-SEC-001`/`TC-PAY-005`/`TC-OUTBOX-001` pass |
| 11 | 11 | EPIC-DEPLOY, beta-feedback bug-fixing | Production-equivalent environment live; issues surfaced by the running beta and pilot get fixed |
| 12 | 12 | Stabilization, EPIC-OPS (rehearsal) | Hardening/bugfix buffer, demo rehearsal, FYP exit-criteria check — **Release gate 3** |

Parallel workstreams: Engineer A and Engineer B work adjacent epics in the same sprint wherever the dependency table allows it (e.g., Sprint 2's auth and vendor-application work; Sprint 5's order/payment work on Engineer A and notification/inventory work on Engineer B, run in parallel since none of the four core-infra pieces block each other internally — only Checkout in Sprint 7 needs all of them finished). Sequential dependencies that cannot be parallelized regardless of team size: EPIC-MATCH before EPIC-IMPORT; the Sprint-5 core infrastructure before EPIC-CHECKOUT; EPIC-CHECKOUT before EPIC-FUL (nothing to deliver before something is ordered); EPIC-ORD/EPIC-PAY/EPIC-FUL before EPIC-RET (Should, Full MVP — nothing to return before something ships and is paid for).

### Release gates

1. **End of Sprint 4:** vendor onboarding + matching + import pipeline functional.
2. **End of Sprint 7:** core commerce (multi-vendor checkout, with the infrastructure it depends on already built) functional end-to-end.
3. **End of Sprint 12:** FYP Delivery Increment exit criteria met (Part 1, D.3) — demo-ready.

### Testing and stabilization

Tests run on every PR throughout (per EPIC-FOUND); **Sprint 12** is additionally reserved as a dedicated stabilization/rehearsal period, not new-feature time — consistent with the ≈23% capacity reserve established in Q.0, most of which sits inside the individual sprints rather than only at the end.

### Vendor pilot and customer beta

**Vendor pilot** (BL-OPS-002) begins once EPIC-VEND + EPIC-IMPORT are functional (end of Sprint 4) and runs continuously through Sprint 12. **Customer beta** (BL-OPS-003) starts **at Sprint 9**, once the *entire* loop — not just the customer-facing half of it — is usable: search → compare → cart → checkout → payment (Sprint 7) → **a vendor actually confirming/dispatching the order** (`BL-ORD-002`, moved into Sprint 8 specifically for this reason) → delivery/pickup (also Sprint 8). Starting beta any earlier — including at the end of Sprint 8 itself, before the sprint's work is confirmed stable — would put real users through a path where their order could be placed and paid for with no vendor ever able to act on it.

### Production rollout and post-launch monitoring

Explicitly **out of the FYP window**: gated on OPEN-001 (payment gateway), OPEN-004 (SMS/OTP), and OPEN-006 (formal FYP-increment sign-off), plus the `Should`/`Could`/`Full MVP`-tagged items in this backlog that the FYP window didn't have capacity for. Post-launch monitoring reuses EPIC-FOUND/EPIC-DEPLOY/EPIC-OPS tooling (Sentry, admin dashboards, the one runbook built) — sustained ownership at that point is the subject of RISK-011, not a tooling gap.

### Medium-team scenario (reference only — for the full confirmed scope, post-FYP)

A 6–8 person team (2 backend, 2 frontend/mobile, 1 QA, 1 DevOps/platform, 1 catalog/support operations, 1 product/PM) could parallelize genuinely independent workstreams — e.g., Returns/Refunds and Analytics/CMS proceeding simultaneously rather than sequentially, and the full-depth versions of every item marked `Should`/`Could`/`Full MVP` above being picked up directly rather than deferred — compressing the remaining full-scope work (live payment gateway, live courier, full nationwide vendor density, ads/sponsored placement, POS/ERP, advanced analytics) into a meaningfully shorter span than doing it serially with 2 people. **No specific calendar date is given**, consistent with the master prompt's instruction not to invent delivery dates without real team size/velocity data — this scenario shows the parallelization *structure* available once the team grows, not a committed timeline.

---

**Next:** Part 9 will cover acceptance criteria (Given/When/Then per requirement), the full requirement-to-test-to-release traceability matrix, and the final recommendations required by the master prompt's Section 10 — the last part of this SRS.
