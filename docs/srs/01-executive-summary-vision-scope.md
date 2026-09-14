# SRS — Part 1: Executive Summary, Vision & Objectives, Stakeholders, Scope & Release Strategy

Covers Sections **A–D** of the structure required by [`docs/master-prompt.md`](../master-prompt.md). Built on the confirmed answers in [`00-phase0-scope-and-clarifications.md`](00-phase0-scope-and-clarifications.md). Requirement IDs introduced here (`FR-*`, `BR-*`, `NFR-*` where referenced) are stable and will be reused unchanged in later parts.

---

## A. Executive summary

**What it is.** A bilingual (Arabic-first, RTL, English-secondary) multi-vendor marketplace and product-comparison platform for local stores across the West Bank. It aggregates products from many independent vendors into one searchable catalog, lets customers compare equivalent products across stores on price, availability, variants and fulfillment, and lets customers buy from one or several vendors in a single cart and checkout.

**The business problem it solves.** Today, a West Bank shopper who wants the best price or availability for a product must check multiple individual store pages, social-media posts, or physically visit stores — there is no neutral, bilingual place to compare local vendors side by side. Vendors, meanwhile, have no shared channel to reach shoppers outside their existing customer base without building their own e-commerce presence.

**Target users.** (1) Customers across the West Bank shopping in Arabic or English, on web, Android, or iOS. (2) Local store owners/staff of varying technical sophistication, from spreadsheet-only shops to those with POS/ERP systems. (3) A platform-operator team running catalog quality, vendor onboarding, support, and operations.

**Primary value proposition.** For customers: one bilingual place to find, compare, and buy from many local stores, with a clear view of who has the best price or best overall offer. For vendors: access to comparison-driven demand and a straightforward (manual or spreadsheet-based) way to list products, in exchange for a flat monthly subscription rather than a cut of every sale.

**How it differs from a single-vendor online store.** A single-vendor store sells its own inventory under its own identity. This platform is explicitly multi-tenant: it separates the **canonical product** (the thing being compared, e.g. "Apple iPhone 16 Pro 256GB") from each **vendor offer** (a specific store's price, stock, variant, and fulfillment for that product), and a single customer order can legitimately contain suborders fulfilled independently by several unrelated vendors.

**How product aggregation and price comparison work.** Vendors submit offers (manually or via CSV/Excel import at launch). Each offer is matched to a canonical product — automatically when an exact identifier (barcode/GTIN/MPN) is present, otherwise queued for human review before it is linked and published. Comparison and search operate on canonical products, surfacing every matched vendor offer with a normalized "best offer" indicator that accounts for price (converted to a common comparison currency where vendors price in different currencies), stock, delivery/pickup option, and store distance.

**Recommended scope boundaries.** The product owner has confirmed an ambitious full-scope launch target — full multi-vendor checkout, dual payment (COD + online), nationwide coverage, three client platforms (Web/Android/iOS), and subscription-based vendor monetization, all from day one (see Section D). Because the actual build team is 2 people over 3 months, this document distinguishes that **full target scope ("the MVP")** from a **smaller, explicitly-scoped "FYP Delivery Increment"** — the realistic slice buildable and demoable in the available time, sharing the same architecture and data model so nothing built has to be thrown away when the remaining scope is completed post-FYP.

**Recommended future expansion.** Live courier/third-party delivery integration, a production payment-gateway integration (beyond the sandbox used in the FYP increment), automated/confidence-based product matching at scale, seller ads and sponsored placement, loyalty/referral programs, and POS/ERP vendor integrations — see Phase 2/Phase 3 in Section D.

---

## B. Product vision and objectives

**Product vision.** To become the default place West Bank shoppers check before buying anything from a local store — trusted for honest comparison, useful even before a purchase is made, and valuable enough to vendors that listing on it is worth a monthly subscription regardless of transaction volume.

**Business objectives.**
- Reach a self-sustaining base of subscribed vendors across all West Bank governorates.
- Establish the canonical-product/vendor-offer model as reusable infrastructure for future monetization (ads, sponsored placement, data products).
- Keep vendor onboarding cost low enough that stores without any existing software can join within one sitting (manual entry or a spreadsheet).

**Customer objectives.**
- Find a product regardless of which store carries it, in Arabic or English.
- Trust that "cheapest" or "best offer" reflects a fair, transparent comparison, not sponsored bias.
- Buy from multiple stores in one checkout without juggling separate carts, and know clearly how delivery/pickup and confirmation will happen.

**Vendor objectives.**
- Get discovered by comparison-driven shoppers without building their own storefront.
- Keep control of price, stock, currency, and delivery/pickup for their own offers and branches.
- Predictable, flat monthly cost (subscription) rather than commission uncertainty tied to sales volume.

**Platform-operator objectives.**
- Keep catalog quality high (accurate matches, fresh price/inventory) with a lean review team.
- Keep vendor-onboarding and subscription operations lightweight enough for a very small operations team to run.
- Maintain trust and safety (verified vendors, moderated reviews, fraud controls) without over-building before there is real usage to justify it.

**Success criteria (qualitative).** A shopper can find and compare a common product across at least two real vendors and complete a multi-vendor checkout end to end (cart → confirmation → vendor-side order visibility) in the demo environment; a vendor can onboard, list products via CSV, and receive/process an order without developer intervention.

**Key performance indicators.** Formulas will be finalized in Part 3 (Section G, once entities are defined) and Part 6 (Section O, analytics); the KPI set to track from launch includes: active subscribed vendors, published offers, canonical-product match rate (auto-matched vs. human-reviewed vs. unmatched), search success rate (searches returning ≥1 relevant result), comparison-tool usage rate, product-detail→cart conversion, cart abandonment rate, order completion rate, inventory-accuracy proxy (out-of-stock-at-checkout rate), price freshness (age of last price update per offer), vendor order-response time, delivery/pickup success rate, return and cancellation rates, and customer-support resolution time.

---

## C. Stakeholders and user roles

| Role | Responsibilities | Key permissions | Prohibited actions | Data visibility | Key workflows |
|---|---|---|---|---|---|
| **Guest customer** | Browse, search, compare | Read-only catalog/search/comparison access | Cannot checkout, review, or save favorites | Public catalog data only | Search & compare (see Part 5, K) |
| **Registered customer** | Browse, buy, manage own orders/profile | Full guest permissions + cart, checkout, order history, reviews, favorites, alerts | Cannot see other customers' data or vendor-internal data | Own profile/orders + public catalog | Search, compare, checkout, track order, return/refund, review |
| **Vendor owner** | Owns the store account; full control of that vendor's data | Full CRUD on own store profile, branches, staff accounts, subscription/billing, catalog, orders | Cannot access other vendors' data or platform-wide admin functions | Own vendor's full data | Onboarding, subscription management, staff management |
| **Vendor administrator** | Delegated store management (owner-appointed) | Same as vendor owner except billing/staff-account changes (configurable) | Cannot change owner-level billing or delete the store account | Own vendor's full data | Day-to-day catalog/order management |
| **Branch manager** | Manages a single branch's inventory, hours, pickup readiness | CRUD scoped to their branch's inventory and order fulfillment | Cannot edit other branches or vendor-level settings | Own branch data | Branch inventory updates, pickup/delivery confirmation |
| **Vendor catalog employee** | Enters/imports products and offers | Create/edit offers, run CSV imports | Cannot access orders, payments, or settlements | Own vendor's catalog data | Manual entry, CSV import, respond to catalog-review feedback |
| **Vendor order-processing employee** | Handles incoming orders | View/update suborder status, confirm delivery/pickup | Cannot edit catalog or subscription | Own vendor's order data | Order confirmation, delivery-notification flow (BR-DELIVERY-CONFIRM) |
| **Delivery driver / provider** | Fulfills vendor-arranged delivery | Update delivery status, proof of delivery | Cannot access catalog, pricing, or other vendors' orders | Assigned deliveries only | Delivery tracking, proof of delivery, failed-delivery handling |
| **Platform super administrator** | Full platform control | All admin-portal permissions, including role/permission management | Bound by audit logging; break-glass access logged | All data | Platform configuration, escalations, break-glass access |
| **Catalog administrator** | Owns taxonomy and canonical-product quality | Manage categories, brands, attributes; approve merges/splits | Cannot access vendor financials or customer PII beyond what's needed | Catalog + match-review data | Taxonomy management, duplicate prevention |
| **Product-matching reviewer** | Reviews queued (non-exact) offer-to-canonical matches | Approve/reject/reassign matches, flag ambiguous cases | Cannot edit taxonomy structure or vendor financials | Match-review queue | Manual matching workflow (BR referenced in Section N, Part 6) |
| **Content moderator** | Moderates reviews, images, vendor content | Approve/reject/remove flagged content | Cannot edit orders or financials | Flagged-content queue | Review moderation, abuse reports |
| **Customer-support agent** | Handles tickets, order-linked complaints | View order/customer data needed for the ticket, issue refunds within authorized limits | Cannot edit catalog or vendor settlement configuration | Ticket-scoped customer/order data | Ticket handling, escalation, refund authorization within limits |
| **Finance employee** | Vendor settlements/subscriptions, platform financial reporting | View/manage subscription billing, payouts, financial reports | Cannot edit catalog or customer PII beyond billing needs | Financial data across vendors | Subscription billing, payout reconciliation |
| **Marketing employee** | Content/campaign management | Manage banners, featured placement, campaign pages | Cannot edit orders, catalog structure, or vendor financials | Content/campaign data | Home-page/campaign management (Part 6, Section 21 scope) |
| **Operations manager** | Cross-cutting operational oversight | Read access across modules, escalation authority | Cannot bypass audit logging | Broad read access | Operational dashboards, escalation routing |
| **System integration (technical actor)** | Vendor API/feed/webhook consumer | Scoped API credentials per vendor/integration | Cannot exceed granted API scope | Integration-scoped data | Feed ingestion, webhook delivery (Part 4, Section H) |
| **Payment gateway (external actor)** | Processes online payments | Receives authorization/capture requests, sends webhooks | No platform data access beyond transaction scope | Transaction data only | Payment authorization/capture/refund (OPEN-001 pending) |
| **Notification provider (external actor)** | Delivers SMS/email/push | Receives notification payloads | No platform data access beyond delivery need | Notification payload only | BR-DELIVERY-CONFIRM triple-notification flow (OPEN-004 pending) |
| **External delivery service (future actor)** | Third-party courier (Phase 2+) | Out of scope for launch — see Section D | — | — | Deferred to Phase 2 |

A full role-permission matrix (module × role, CRUD-level) will be finalized in Part 4 (Section H, alongside API authorization) once every FR module's actions are enumerated in Part 2 — this table establishes the role set and boundaries those permissions will be built against.

---

## D. Scope and release strategy

### D.1 The nine platform areas (per master-prompt Section D)

| # | Area | In full target scope? |
|---|---|---|
| 1 | Discovery and comparison | Yes — core differentiator, in every phase |
| 2 | Vendor marketplace | Yes — nationwide, subscription-based |
| 3 | Ordering and checkout | Yes — full multi-vendor checkout from launch (confirmed Q1) |
| 4 | Payment | Yes — COD + online (confirmed Q3; online gateway pending OPEN-001) |
| 5 | Fulfillment and delivery | Yes — vendor delivery + pickup (confirmed Q4); third-party courier is Phase 2 |
| 6 | Reviews and trust | Yes — needed to keep multi-vendor comparison credible; basic version at launch |
| 7 | Promotions and monetization | Partial at launch — subscription billing yes; ads/sponsored placement is Phase 2 |
| 8 | Vendor integrations | Partial — manual/CSV/API only at launch (confirmed Q6, Q15); POS/ERP is Phase 2+ |
| 9 | Analytics and operations | Partial — operational essentials at launch; advanced analytics is Phase 2 |

### D.2 Explicit MVP-checkout-model evaluation (per master-prompt requirement)

The master prompt requires evaluating comparison-only, reservation/purchase-request, single-vendor checkout, and full multi-vendor checkout, then recommending one. **The product owner has confirmed full multi-vendor checkout from day one (Q1)** — a single cart may contain items from several vendors and completes in one checkout, materializing as one `CustomerOrder` with a `VendorSuborder` per vendor (Q2). This is accepted as the target design. It is the most complex option operationally (independent vendor fulfillment, split delivery fees, partial-vendor failure handling — see Part 5, Section L for edge cases), which is exactly why the FYP Delivery Increment below scopes down *breadth* (fewer vendors, platforms, governorates live at once) rather than *depth* (the multi-vendor checkout mechanism itself is built for real, since it is the platform's defining mechanic and the riskiest thing to retrofit later).

### D.3 Phased delivery plan

| Phase | Included | Excluded | Dependencies | Key risks | Exit criteria |
|---|---|---|---|---|---|
| **PoC** | Canonical product + vendor offer data model; manual catalog entry; basic search/compare for a handful of seeded products across 2–3 demo vendors | Checkout, payments, delivery, subscriptions, native mobile apps | None | Data model doesn't hold up once real vendor data is entered | Two vendors' equivalent products can be searched and compared correctly |
| **FYP Delivery Increment** (the 2-person/3-month build — see D.4) | Full multi-vendor cart/checkout mechanic; COD + sandboxed/simulated online payment; manual/CSV vendor onboarding for a pilot set of vendors across a representative (not exhaustive) set of governorates; one shared codebase targeting Web + Android + iOS (see D.4); BR-DELIVERY-CONFIRM notification flow with a real or logged-fallback SMS provider; exact-match + manual-review product matching; basic reviews; subscription status modeled and enforced, billing collection simulated | Live third-party payment-gateway integration; live courier integration; ads/sponsored placement; POS/ERP integrations; advanced analytics; full nationwide vendor density | PoC data model validated | Scope creep against a hard 3-month/2-person constraint (see D.4 mitigation) | End-to-end demo: guest search → compare → multi-vendor cart → checkout (COD or sandbox online) → vendor order confirmation with triple notification → vendor fulfills/marks delivered |
| **MVP (full target scope)** | Everything confirmed in Phase 0 Section 2 at production quality: live payment gateway, all West Bank governorates actively onboarded, native-quality apps on all 3 platforms, live SMS/OTP provider, enforced subscription billing | Third-party courier, ads/sponsored placement, POS/ERP | FYP Delivery Increment proven; OPEN-001–OPEN-005 resolved | Vendor adoption; payment-gateway availability (OPEN-001) | Sustained real transactions across ≥2 governorates with paying subscribed vendors |
| **Phase 2** | Third-party courier integration; sponsored placement/ads; POS/ERP integrations; advanced analytics; loyalty/referral | — | MVP stable in production | Vendor API heterogeneity | Defined per initiative at the time |
| **Phase 3 / Future** | AI-assisted image matching, voice search, expanded currency/market support | — | Phase 2 stable | — | — |

### D.4 The FYP Delivery Increment, in concrete terms

This is a **recommendation pending OPEN-006 sign-off**, not a unilateral scope cut — it changes nothing about what the full SRS specifies as the target platform (Parts 2–9 describe the full confirmed scope). It only defines what the 2-person/3-month team actually builds first, using the same data model and API contracts so later work extends rather than replaces it.

- **Client platforms:** build one shared codebase (framework choice finalized in Part 6, Architecture) capable of producing Web, Android, and iOS builds, rather than three independent native codebases — this is the only realistic way to honor "Web + Android + iOS from launch" (Q9) inside 3 months with 2 people.
- **Payment:** real COD flow; online payment implemented against a sandbox/test-mode gateway (or a clearly-labeled simulated "online payment" flow) until OPEN-001 (a licensed, integrable local gateway) is resolved.
- **Geography:** the full list of West Bank governorates/cities is present in the data model and UI (address forms, vendor onboarding, delivery-zone selection per Q8), but live pilot vendors are onboarded in a representative subset, not exhaustively across every governorate.
- **Vendors:** a small pilot cohort (indicatively 3–6 vendors) onboarded manually/via CSV, enough to demonstrate real cross-vendor comparison and a genuine multi-vendor checkout.
- **Currency:** schema supports per-vendor currency (Q7) and the FX-normalized comparison logic (BR-CURRENCY) is implemented; demo data is predominantly ILS with at least one non-ILS vendor to prove the mechanism.
- **Subscriptions:** status (active/past-due/suspended) is modeled and enforced on vendor visibility; actual payment collection can be recorded manually by an admin rather than integrated with a live billing processor.
- **Notifications:** BR-DELIVERY-CONFIRM's three notifications are implemented against a real low-cost SMS provider if OPEN-004 resolves in time, otherwise logged/visible in an admin/dev view as a fallback so the workflow is still demonstrably complete.
- **Product matching:** built for real (exact-match auto-link + human-review queue) — this is core IP, not a corner to cut.

---

**Next:** Part 2 will cover Section E (Functional requirements, all 22 modules) with stable `FR-*` IDs, building directly on the roles and scope defined here.
