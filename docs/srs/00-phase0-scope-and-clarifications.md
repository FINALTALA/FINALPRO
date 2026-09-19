# Phase 0 — Understanding, Clarification Questions, Assumptions, and Proposed SRS Table of Contents

Status: **Historical clarification baseline, answered by the product owner (2026-09-14).** Later approved product decisions are recorded in [`docs/approved-product-decisions-2026-09.md`](../approved-product-decisions-2026-09.md) and take precedence wherever they conflict with this historical record. The nine SRS parts must be revised against that approved change-control baseline before any affected feature is implemented.
Governing spec: [`docs/master-prompt.md`](../master-prompt.md)
Role split: Claude = developer/author · Codex = auditor/reviewer · Product owner = final approver.

---

## 1. Understanding of the proposed platform

The platform is a **multi-vendor marketplace and product-comparison engine** for local stores across the West Bank, now confirmed to launch with **full national coverage, full multi-vendor checkout, and three client platforms (Web, Android, iOS) from day one** (see Section 2). It is not a single-vendor storefront and not a pure classifieds/listing site — its defining feature is the separation between:

- **Canonical product** — one normalized identity per real-world product, used as the anchor for search and comparison.
- **Vendor offer** — a specific store's sellable instance of that canonical product (price, currency, stock, branch, variant, fulfillment options).

Confirmed capability set (per Section 2 answers):

- **Discovery, comparison, and full multi-vendor cart/checkout** together from launch — a customer can buy from several stores in a single cart/checkout.
- **Parent order + per-vendor suborder** structure so each store manages its own fulfillment independently while the customer sees one order.
- **Dual payment** (cash on delivery + online payment) and **dual fulfillment** (vendor delivery + branch pickup) from launch.
- **Heterogeneous, per-vendor currency** — vendors are not forced onto a single platform currency.
- **Nationwide vendor onboarding** across all West Bank governorates from day one, with physical-store vendors verified by geolocation + storefront photo.
- **Omni-channel client apps** — responsive web, Android, and iOS simultaneously.
- **Subscription-based vendor monetization** (monthly fee) rather than per-order commission.
- Bilingual, RTL-first UX (Arabic primary, English secondary).

This is a materially larger MVP than a typical comparison-first soft launch — see Section 4 (Reconciliation) for how this is handled against the confirmed 2-person / 3-month delivery team.

---

## 2. Clarification questions — confirmed answers (2026-09-14)

| # | Topic | Confirmed decision |
|---|---|---|
| Q1 | MVP transaction model | **Full multi-vendor cart & checkout from day one.** Items from multiple vendors in one cart → one checkout flow (not phased in later). |
| Q2 | Multi-vendor cart semantics | **One parent `CustomerOrder` containing a `VendorSuborder` per store** (recommended default accepted). Each vendor manages its own suborder status/fulfillment independently; the customer sees one order. |
| Q3 | Payment methods | **Cash on delivery AND online payment, both at launch** (not phased). *Requires a confirmed, licensed local/regional payment gateway — flagged for financial/legal confirmation, see OPEN-001.* |
| Q4 | Delivery model | **Vendor delivers its own orders, or customer picks up from the branch.** At order confirmation the customer must submit their home location (map pin) and two phone numbers (plus any other confirmation details). The platform then sends **three notifications**: (1) an in-app alert on the vendor portal's order/notifications screen, (2) an SMS/message to the store's own registered phone number, and (3) a confirmation SMS/message to the phone number the customer entered. |
| Q5 | Product-matching automation | **Exact-identifier (barcode/GTIN/MPN) matches auto-link; all other matches (name/image/spec similarity) require human review** before publishing (recommended default accepted). |
| Q6 | Vendor ingestion | **Manual entry + Excel/CSV import** as the primary path at launch. |
| Q7 | Currency | **Each vendor sets its own currency** (not a single platform-wide ILS). New design implication — see Section 3, BR-CURRENCY. |
| Q8 | Geographic rollout | **All West Bank governorates/cities from day one** (no single-pilot-city phase). Every vendor must submit profile info; a vendor with a physical store must also provide its location (map pin) **and a storefront photo** as part of onboarding verification. |
| Q9 | Client platforms | **Web + Android + iOS, all three from launch.** |
| Q10 | Vendor monetization | **Monthly subscription fee per vendor**, not a per-transaction commission. |
| Q11 | Legal/regulatory framework | **No specific confirmed Palestinian law to build against.** Proceed on a general-purpose good-practice standard (GDPR-inspired data-subject rights, configurable retention, consumer-protection-style defaults for returns/refunds), and explicitly flag every legal/tax/financial rule in the SRS as "requires professional confirmation." |
| Q12 | Authentication | **Phone number + password** as the primary credential, with **OTP used to verify the phone number**; email is optional and not required to register. |
| Q13 | Guest checkout | **Guests may browse and compare freely; login is required at the point of purchase.** No guest checkout — guest cart must merge into the account cart on login. |
| Q14 | Team & timeline | **2 people; delivery window revised to 3 months** (from the originally stated 2 months). |
| Q15 | Ingestion channels | **Manual entry / Excel-CSV / vendor-authorized API only for now**; web scraping deferred to a future phase (recommended default accepted). |

---

## 3. New business rules and design implications surfaced by these answers

These are concrete, non-obvious consequences of the answers above that must carry into the full SRS (Section E functional requirements and Section F business-rules catalog) rather than being silently absorbed:

- **BR-DELIVERY-CONFIRM (Q4):** Order confirmation is not complete until the customer supplies a home location pin + two phone numbers. On confirmation, the platform must fire three independent notifications (vendor-portal in-app alert, SMS to the store's registered number, SMS to the customer-entered number) — each is a separate deliverable/retryable notification, not a single multiplexed message, and each needs its own delivery/failure tracking per the Notifications module (Section E.17).
- **BR-CURRENCY (Q7):** Because vendors may each use a different currency, canonical-product comparison ("cheapest offer") cannot assume a single currency. Recommended approach (to confirm in Phase 1): each `VendorOffer` stores its native currency + amount; the platform maintains an FX-rate table and computes a normalized comparison price in a platform base currency (ILS) for ranking/"best offer" display, while checkout still charges in the vendor's native currency. FX-rate source/refresh method is an open item (OPEN-002). This still leaves open how a **single online payment covers a multi-vendor parent order whose suborders are priced in different vendor currencies** — one gateway charge per suborder/currency vs. a single blended charge, which currencies the chosen gateway can actually settle, conversion-rate disclosure to the customer at checkout, and refund rules when the FX rate has moved since purchase. This is tracked separately as **OPEN-007** and must be resolved before Part 2's checkout/payment functional requirements are finalized.
- **BR-VENDOR-VERIFICATION (Q8):** A vendor with a physical branch cannot be approved without a geolocation pin and a storefront photo attached to that branch. Review/approval ownership of these photos is an open item (OPEN-005).
- **BR-SUBSCRIPTION (Q10):** Vendor visibility/selling rights are gated by an active monthly subscription rather than by per-order commission deduction. A grace-period/suspension policy on missed payment is needed (OPEN-003).
- **BR-AUTH (Q12):** Registration/login is phone + password; OTP verifies the phone at signup and should gate sensitive actions (password reset, phone-number change). SMS/OTP provider is an open item (OPEN-004, shared with BR-DELIVERY-CONFIRM's SMS need).
- **BR-GUEST (Q13):** Search, browse, and comparison must work fully unauthenticated; a guest's in-progress cart must be preserved and merged into their account the moment they log in at checkout.

---

## 4. Reconciliation — full target scope vs. the 2-person / 3-month delivery window

The confirmed answers describe a **full commercial-scale launch scope** (multi-vendor checkout, dual payment, nationwide coverage, three client apps, subscriptions) — considerably more than a typical MVP, and not realistically buildable end-to-end, production-grade, by 2 people in 3 months.

This is not treated as a contradiction to resolve away — it is handled the way the master prompt itself already requires:

1. **The SRS documents the full confirmed target scope** in Section D (Scope and release strategy) and Section E (functional requirements) as the platform's real design — nothing here is being scoped down silently.
2. **Section D's phased release plan (PoC → MVP → Phase 2 → Phase 3)** will explicitly carve out a **"FYP Delivery Increment"**: the specific slice of the full scope that 2 people can realistically design, build, and demo within 3 months (e.g., one client platform fully functional + the others stubbed/scaffolded, a reduced set of governorates seeded with real data, a mocked or sandbox payment gateway, manual/CSV ingestion only, subscription billing simulated rather than integrated with a live payment processor). This increment will be proposed explicitly in Section D for product-owner sign-off — **not decided silently**.
3. **Section 7 (Sprint & release plan)** will use the real team size (2) and real window (3 months) as the "small-team scenario," per the master prompt's own instruction not to invent delivery dates without knowing team size/velocity.

This keeps the SRS honest as a complete design document (useful beyond the FYP) while keeping the actual academic deliverable realistic. Flagged as **OPEN-006** below for explicit confirmation once Section D is drafted.

---

## 5. Open follow-up items for Phase 1 (to confirm before or during SRS drafting)

| ID | Item | Related question |
|---|---|---|
| OPEN-001 | Identity of a licensed, integrable online-payment gateway operating in the West Bank | Q3 |
| OPEN-002 | FX-rate source and refresh frequency for cross-currency offer comparison | Q7 |
| OPEN-003 | Monthly subscription price tier(s) and grace-period/suspension policy on non-payment | Q10 |
| OPEN-004 | SMS/OTP provider for Palestinian phone numbers (used for auth OTP and order-confirmation SMS) | Q12, Q4 |
| OPEN-005 | Who reviews/approves vendor storefront-verification photos, and rejection criteria | Q8 |
| OPEN-006 | Sign-off on the proposed "FYP Delivery Increment" (realistic 2-person/3-month build slice) once drafted in Section D | Q14, Section 4 above |
| OPEN-007 | How a single online payment settles a multi-vendor parent order whose suborders are priced in different vendor currencies (per-suborder charge vs. blended charge, gateway-supported settlement currencies, conversion disclosure, refund-on-rate-move rules) | Q7, Q1/Q2 |

None of these block starting Phase 1 — each will carry an explicit "requires confirmation" flag in the relevant SRS section, per the master prompt's requirement not to assert unconfirmed legal/financial/operational facts.

---

## 6. Proposed SRS table of contents (Phase 1 deliverable, in progress)

Mirrors the structure mandated by the master prompt (Section 5), delivered in numbered parts with consistent requirement IDs across parts:

- **Part 1 — A.** Executive summary · **B.** Product vision and objectives (incl. KPIs) · **C.** Stakeholders and user roles (+ role-permission matrix) · **D.** Scope and release strategy (PoC → FYP Delivery Increment → Phase 2 → Phase 3 → Future)
- **Part 2 — E.** Functional requirements — 22 modules (FR-AUTH, FR-VEND, FR-CAT, FR-MATCH, FR-IMPORT, FR-SEARCH, FR-COMP, FR-PRICE, FR-INV, FR-CART, FR-ORD, FR-PAY, FR-FUL, FR-RET, FR-REV, FR-FAV, FR-NOTIF, FR-SUP, FR-ADMIN, FR-VPORTAL, FR-CMS, FR-ANALYTICS)
- **Part 3 — F.** Business rules catalog (BR-xxx) · **G.** Data model (conceptual ERD, entity list, cardinalities, fields, constraints, indexing, ownership, audit, retention)
- **Part 4 — H.** API and integration requirements · **I.** Non-functional requirements (NFR-xxx) · **J.** Security and privacy
- **Part 5 — K.** UX and screen inventory + end-to-end journeys · **L.** Edge cases and failure scenarios
- **Part 6 — M.** Architecture recommendation · **N.** Product matching and data-quality strategy · **O.** Testing and QA · **P.** DevOps and operations
- **Part 7 — Q.** Risks and decisions (registers, ADRs, BDRs)
- **Part 8 — Backlog:** Epics → Features → User stories → Tasks · **Sprint & release plan** (2-person/3-month scenario + reference medium-team scenario)
- **Part 9 — Acceptance criteria** (Given/When/Then) · **Traceability matrix** · **Final recommendations** (12 items per master-prompt Section 10, incl. first 30 actionable tasks)

---

## 7. What happens next

Phase 1 begins now with **Part 1 (Sections A–D)**. Codex (auditor): please review Part 1, once posted, for (a) whether the executive summary and vision faithfully reflect the confirmed answers in Section 2 above, (b) whether the FYP Delivery Increment proposed in Section D is a defensible, honest slice of the full scope for 2 people / 3 months, and (c) whether the role-permission matrix omits any stakeholder implied by the confirmed feature set (e.g., delivery/pickup confirmation flow, subscription billing).
