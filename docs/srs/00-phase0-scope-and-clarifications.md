# Phase 0 — Understanding, Clarification Questions, Assumptions, and Proposed SRS Table of Contents

Status: **Draft — awaiting product-owner answers / approval before Phase 1 (full SRS) is generated.**
Governing spec: [`docs/master-prompt.md`](../master-prompt.md)
Role split: Claude = developer/author of this document · Codex = auditor/reviewer · Product owner = final approver.

---

## 1. Understanding of the proposed platform

The platform is a **multi-vendor marketplace and product-comparison engine** for local stores across the West Bank. It is not a single-vendor storefront and not a pure classifieds/listing site — its defining feature is the separation between:

- **Canonical product** — one normalized identity per real-world product (e.g. "Apple iPhone 16 Pro 256GB"), used as the anchor for search and comparison.
- **Vendor offer** — a specific store's sellable instance of that canonical product (price, stock, branch, variant, fulfillment options).

On top of that model, the platform must support:

- **Discovery & comparison** across vendors (search, filters, side-by-side comparison, "best offer" logic) as a value proposition independent of checkout.
- **Transactional marketplace** capability — single- or multi-vendor cart, checkout, vendor suborders, payment, delivery/pickup — that may be switched on after the comparison experience is validated.
- **Heterogeneous vendor data quality** — some vendors will have POS/ERP/API integration, most will not; the system must work with manual entry and spreadsheet import as first-class citizens, not edge cases.
- **Bilingual, RTL-first UX** (Arabic primary, English secondary), tuned to West Bank addressing realities (villages, governorates, non-standardized addresses, map pins/landmarks).
- **Local payment and delivery fragmentation** — cash-on-delivery, vendor-run delivery, and inconsistent inventory accuracy are the norm, not the exception, and the spec must not assume otherwise.

This is effectively three products bundled into one platform: (1) a product-comparison engine, (2) a multi-tenant vendor marketplace with catalog/inventory/order management, and (3) an operations/support back office — all bilingual and RTL-first from day one.

The master prompt explicitly asks that, before any SRS content is generated, we surface the decisions that would materially reshape the system, propose defaults, and get sign-off. That is the purpose of this document.

---

## 2. High-impact clarification questions (15)

Each question lists: why it matters, the recommended default (what we'll assume if no answer is given), and the main alternatives.

### Q1. MVP transaction model — comparison-only, reservation, single-vendor checkout, or full multi-vendor checkout?
- **Why it matters:** This is the single biggest driver of scope, data model complexity (suborders, split payment/delivery), and time-to-market. Getting it wrong means either shipping too little to be useful or building marketplace-checkout complexity before there's proven vendor/customer demand.
- **Recommended default:** Start with **discovery & comparison + single-vendor checkout** (customer can only check out one vendor's items at a time even if the cart UI shows multiple vendors' items grouped). Multi-vendor single-cart checkout becomes Phase 2 once vendor supply and order volume justify the added complexity.
- **Alternatives:** (a) Comparison + "buy" redirects to vendor's own channel (WhatsApp/phone/store) with no in-platform checkout at all; (b) Full multi-vendor checkout from day one.

### Q2. Multi-vendor cart semantics — one parent order with vendor suborders, or fully separate orders per vendor?
- **Why it matters:** Determines the order/payment/refund data model, vendor settlement logic, and customer-facing order tracking UX. Hard to retrofit later without a migration.
- **Recommended default:** **One parent `CustomerOrder` containing N `VendorSuborder`s**, one shared payment authorization split by suborder, independent suborder status/fulfillment lifecycles. This matches how the master prompt frames "orders" (Section E.11) and is the industry-standard pattern (Amazon-style).
- **Alternatives:** Fully independent orders per vendor (simpler but breaks "one cart, one checkout" UX and shared payment/delivery-fee logic).

### Q3. Payment methods at launch — COD only, or online payment (card/wallet) integrated too?
- **Why it matters:** Online payment requires a licensed local/regional payment gateway, PCI-DSS boundary decisions, and settlement/reconciliation logic; COD requires cash-handling and driver-reconciliation workflows instead. This changes both the NFR/security scope and the vendor-settlement design.
- **Recommended default:** **Cash on delivery + pay-at-pickup at launch**, online card/wallet payment added in Phase 2 once a compliant local payment gateway is confirmed. *(Flagged: requires confirmation from a licensed Palestinian/regional payment provider — see Section J of the eventual SRS.)*
- **Alternatives:** Launch with online payment via an international gateway if one is confirmed to operate legally and reliably in the West Bank; launch with both from day one (higher build cost).

### Q4. Delivery model — platform-operated fleet, vendor-own delivery, third-party courier integration, or a mix?
- **Why it matters:** Drives the Fulfillment/Delivery data model (driver assignment, tracking, proof of delivery), and whether the platform carries operational liability for late/failed delivery.
- **Recommended default:** **Vendor-own delivery + customer pickup at launch**, with the data model designed to support a future third-party courier integration (Phase 2/3) without rework — i.e., `Delivery` as its own entity from day one, not bolted onto `VendorSuborder`.
- **Alternatives:** Platform-operated delivery fleet from day one (high operational cost, out of scope for an MVP); third-party courier API integration from day one (depends on provider availability in the West Bank, currently unconfirmed).

### Q5. Product-matching automation — how much is automatic vs. manually reviewed at launch?
- **Why it matters:** Directly affects catalog-team staffing, time-to-onboard a vendor's catalog, and risk of bad matches (wrong price shown against wrong product) reaching customers.
- **Recommended default:** **Exact-identifier matching (barcode/GTIN/MPN) is auto-approved; everything else (title/attribute-similarity matches) is queued for human review** before a vendor offer is linked to a canonical product. Confidence scoring exists but does not auto-approve fuzzy matches at launch.
- **Alternatives:** Fully automatic matching above a confidence threshold (faster onboarding, higher error risk); fully manual matching for every offer regardless of identifier (safest, does not scale past a handful of vendors).

### Q6. Vendor technical capability — should we assume most pilot vendors have POS/ERP or API access?
- **Why it matters:** If most vendors can only do manual entry or spreadsheet upload, the ingestion module (CSV import, templates, validation reports) must be first-class and highly polished; POS/ERP/API integration becomes a secondary, longer-lead-time capability.
- **Recommended default:** **Assume manual entry + CSV/Excel import is the primary ingestion path for the pilot cohort**; APIs/POS/ERP integration and scheduled feeds are Phase 2+, built opportunistically per vendor demand.
- **Alternatives:** Require vendors to have inventory-management software as an onboarding condition (severely limits vendor pool given the stated market reality).

### Q7. Currency scope — ILS only, or also JOD/USD given cross-border commerce in the West Bank?
- **Why it matters:** Multi-currency affects pricing, tax, comparison logic (can't compare prices in different currencies without conversion), and payment/settlement.
- **Recommended default:** **ILS (₪) as the sole transactional currency at launch**; store/display prices in JOD or USD is out of scope for MVP but the schema stores currency per price record so it isn't a rewrite later.
- **Alternatives:** Support ILS + JOD from day one (adds FX-rate management and comparison-normalization complexity).

### Q8. Geographic rollout — full West Bank at once, or a pilot city/governorate first?
- **Why it matters:** Determines delivery-zone modeling complexity, vendor-onboarding pipeline sizing, and realistic MVP success metrics.
- **Recommended default:** **Pilot in one or two governorates/cities** (e.g., Ramallah/Al-Bireh area) with the delivery-zone data model built to scale to all West Bank governorates without rework.
- **Alternatives:** Launch across the full West Bank simultaneously (harder to control quality/support load during MVP).

### Q9. Mobile apps — required at MVP, or responsive web only?
- **Why it matters:** Native/cross-platform apps roughly double front-end build and QA effort; the master prompt says mobile apps are only "potentially" needed.
- **Recommended default:** **Responsive, mobile-first web app only for MVP**; native apps (or a wrapped PWA) considered in Phase 2 based on usage data.
- **Alternatives:** Build a cross-platform app (e.g., Flutter/React Native) alongside web from day one.

### Q10. Vendor commission/monetization model — per-transaction commission, subscription, featured-placement ads, or a mix?
- **Why it matters:** Directly shapes the Settlement/Commission data model and the Pricing/Promotions module, and determines whether monetization exists before or after checkout is live.
- **Recommended default:** **No commission at the comparison-only stage** (platform value is discovery, monetized later via optional featured placement); introduce **per-order commission** once checkout launches. Subscription plans deferred to Phase 2+.
- **Alternatives:** Flat vendor subscription fee regardless of sales; commission from day one even during comparison-only phase (hard to justify without checkout).

### Q11. Regulatory/legal framework — is there a specific Palestinian e-commerce, consumer-protection, tax, or data-protection law the platform must follow?
- **Why it matters:** Affects consent flows, data retention, invoicing/tax fields, and return/refund rules; the master prompt explicitly requires flagging anything needing professional legal confirmation rather than inventing rules.
- **Recommended default:** **Treat as an explicit open legal question** — design privacy/consent/audit/retention to a reasonable general-purpose standard (GDPR-inspired data-subject rights, configurable retention) and flag every place a local legal/tax review is required rather than asserting compliance.
- **Alternatives:** None — this cannot be safely defaulted away; it is listed here because it changes several data-model and workflow details (e.g., invoice fields, return windows) once answered.

### Q12. Primary authentication method — phone/OTP as the main identity, or email+password?
- **Why it matters:** Regionally, phone-based OTP tends to have far higher completion rates than email/password and matches how vendors/customers already communicate (SMS/WhatsApp); this affects the Identity module design and third-party SMS provider dependency.
- **Recommended default:** **Phone number + OTP as the primary registration/login method**, email optional/secondary, social login deferred.
- **Alternatives:** Email+password as primary with phone only for verification/notifications; support both as equal first-class options from day one (more QA surface).

### Q13. Guest checkout — allowed, or is account creation mandatory to purchase?
- **Why it matters:** Guest checkout raises conversion but complicates order lookup, returns, and fraud prevention without an account.
- **Recommended default:** **Guest checkout allowed for comparison/browsing and for COD orders**, with a lightweight phone-verified account auto-created at order time (order history then tied to phone number, upgradable to a full account later).
- **Alternatives:** Mandatory account creation before any purchase (simpler backend, worse conversion); fully anonymous guest checkout with no phone verification at all (higher fraud/no-show risk on COD orders).

### Q14. Team size / timeline for the sprint-and-release plan — is this a solo/small student team, or a larger multi-person team?
- **Why it matters:** The master prompt requires small-team and medium-team delivery scenarios rather than a single invented date; since this is explicitly a final-year project (FYP), the realistic scenario is a very small team (likely 1, possibly 2-3) working part-time across an academic term.
- **Recommended default:** Plan primarily around a **small-team / solo-student scenario** (reduced-scope MVP: comparison + single-vendor COD checkout only, one pilot city), with a medium-team scenario documented for reference/future scaling.
- **Alternatives:** Plan for a fully staffed multi-role team (more realistic for a commercial launch, not for an academic FYP timeline).

### Q15. Web-scraping/controlled ingestion — is pulling product data from vendor websites (without an API) something we're allowed to pursue for MVP, or explicitly out of scope?
- **Why it matters:** The master prompt permits "controlled web ingestion, only when authorized and legally permitted" — this has real legal exposure (ToS violations, scraping law) and technical fragility, so scope needs an explicit decision rather than silent inclusion.
- **Recommended default:** **Out of scope for MVP.** Ingestion limited to manual entry, CSV/Excel import, and vendor-authorized API/feed integration only; web ingestion revisited later only with explicit per-vendor written authorization.
- **Alternatives:** Build a generic scraping pipeline for vendors without APIs (higher legal/technical risk, faster catalog growth).

---

## 3. Recommended initial assumptions (used only where Section 2 is not yet answered)

Labeled `ASM-xxx` so they can be traced and revisited once real answers arrive.

| ID | Assumption |
|---|---|
| ASM-001 | MVP = discovery/comparison + **single-vendor** COD checkout (Q1, Q3). Multi-vendor single-cart checkout and online payment are Phase 2. |
| ASM-002 | Order model uses parent `CustomerOrder` + `VendorSuborder` from day one even though MVP checkout is single-vendor, so Phase 2 multi-vendor checkout doesn't require a data-model migration (Q2). |
| ASM-003 | Delivery is vendor-fulfilled or customer-pickup only at MVP; `Delivery` modeled as an independent entity to allow a future third-party courier plug-in (Q4). |
| ASM-004 | Only exact-identifier (barcode/GTIN/MPN) matches auto-link to a canonical product; all fuzzy/attribute matches require human review before publishing (Q5). |
| ASM-005 | Primary vendor ingestion path is manual entry + CSV/Excel import; POS/ERP/API integration is opportunistic, not required for onboarding (Q6). |
| ASM-006 | Single currency: ILS (₪). Currency is still stored per price record in the schema (Q7). |
| ASM-007 | Launch geography is one pilot governorate/city, with delivery-zone data modeled to extend to all West Bank governorates later (Q8). |
| ASM-008 | No native mobile app at MVP; mobile-first responsive web only (Q9). |
| ASM-009 | No vendor commission during comparison-only phase; commission introduced when checkout launches (Q10). |
| ASM-010 | No confirmed Palestinian legal/tax/data-protection framework — every legal/financial rule in the SRS will be explicitly flagged "requires professional confirmation" rather than asserted (Q11). |
| ASM-011 | Phone number + OTP is the primary identity method; email is optional/secondary (Q12). |
| ASM-012 | Guest checkout allowed for COD, with a phone-verified lightweight account auto-created at order time (Q13). |
| ASM-013 | Delivery scenario is a small/solo student team on an academic-term timeline; the sprint plan will present a reduced-scope small-team path as primary (Q14). |
| ASM-014 | No web scraping/controlled ingestion in MVP; only manual entry, import, and vendor-authorized feeds/APIs (Q15). |
| ASM-015 | No confirmed local online-payment gateway yet — anything payment-related beyond COD is explicitly marked as requiring provider confirmation, not designed in detail until Phase 2. |

---

## 4. Proposed SRS table of contents (Phase 1 deliverable, pending approval)

Mirrors the structure mandated by the master prompt (Section 5), to be produced as the full SRS once Sections 2–3 above are confirmed or explicitly approved-as-assumed:

- **A.** Executive summary
- **B.** Product vision and objectives (incl. KPIs)
- **C.** Stakeholders and user roles (+ role-permission matrix)
- **D.** Scope and release strategy (PoC → MVP → Phase 2 → Phase 3 → Future)
- **E.** Functional requirements — 22 modules (FR-AUTH, FR-VEND, FR-CAT, FR-MATCH, FR-IMPORT, FR-SEARCH, FR-COMP, FR-PRICE, FR-INV, FR-CART, FR-ORD, FR-PAY, FR-FUL, FR-RET, FR-REV, FR-FAV, FR-NOTIF, FR-SUP, FR-ADMIN, FR-VPORTAL, FR-CMS, FR-ANALYTICS)
- **F.** Business rules catalog (BR-xxx)
- **G.** Data model (conceptual ERD, entity list, cardinalities, fields, constraints, indexing, ownership, audit, retention)
- **H.** API and integration requirements (per-domain representative endpoints + contract rules)
- **I.** Non-functional requirements (NFR-xxx)
- **J.** Security and privacy (incl. threat model, legal-confirmation flags)
- **K.** UX and screen inventory (customer, vendor portal, admin portal, support) + end-to-end journeys
- **L.** Edge cases and failure scenarios (table format)
- **M.** Architecture recommendation (MVP architecture, component diagram, scaling path)
- **N.** Product matching and data-quality strategy
- **O.** Testing and quality assurance (test scenarios + traceability)
- **P.** DevOps and operations
- **Q.** Risks and decisions (risk/assumption/dependency/open-question registers, ADRs, BDRs)
- **Backlog:** Epics → Features → User stories → Tasks, stable IDs, MoSCoW priority, estimates
- **Sprint & release plan:** small-team and medium-team scenarios
- **Acceptance criteria:** Given/When/Then per requirement
- **Traceability matrix:** objective → requirement → rule → story → API → test → phase
- **Final recommendations:** the 12 items required by Section 10 of the master prompt, incl. first 30 actionable tasks and decisions the product owner must approve before implementation

---

## 5. What happens next

This document is a **checkpoint, not a blocker forever** — per the master prompt's working method, the full SRS (Phase 1) will be generated once:

- the product owner answers as many of the 15 questions in Section 2 as they can, **or**
- the product owner explicitly approves proceeding with the ASM-xxx defaults in Section 3 as-is.

Codex (auditor): please review this document for (a) any material ambiguity from the master prompt that isn't captured in the 15 questions, (b) whether the recommended defaults in Section 3 are internally consistent with each other and with the master prompt's constraints (no reliable vendor APIs assumed, vendor offers never treated as canonical products, no microservices without justification, legal/financial items flagged not asserted), and (c) whether the proposed TOC omits anything mandated by Section 5 of the master prompt.
