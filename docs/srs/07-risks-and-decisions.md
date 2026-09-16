# SRS — Part 7: Risks and Decisions (Section Q)

Consolidates every provisional item flagged across Parts 0–6 into the six registers the master prompt requires: risk register, assumption register, dependency register, open-question register, Architecture Decision Records (ADRs), and Business Decision Records (BDRs). This part is a *consolidation*, not a new source of truth — every entry links back to where it was actually decided or raised.

---

## Q.1 Risk register

Per the master prompt, particular attention is given to: vendor adoption, poor product data, wrong product matching, stale inventory, price disputes, multi-vendor checkout complexity, payment availability, delivery fragmentation, return disputes, fraud, operational staffing, Arabic search quality, legal uncertainty, and platform monetization.

| ID | Description | Probability | Impact | Early warning indicator | Mitigation | Contingency | Owner |
|---|---|---|---|---|---|---|---|
| RISK-001 | Too few vendors adopt the platform to make comparison meaningful | Medium–High | High — no supply, no comparison value, nothing to demo | Onboarding-funnel drop-off rate (application → active) | Low-friction manual/CSV onboarding (Q6); white-glove onboarding for the FYP pilot cohort (Part 1, D.4) | Seed the catalog with a small hand-picked cohort even below the original target count; delay wider marketing until real supply exists | Product owner |
| RISK-002 | Vendor-submitted product data is incomplete or low-quality | High (assumed reality per master prompt, not a surprise) | Medium — hurts comparison trust, not a launch-blocker | Completeness-score distribution trending low (N.3) | Completeness-score nudges in the offer editor (N.3), import validation reports (FR-IMPORT-002/003) | Catalog admin manually enriches the highest-traffic listings first | Catalog admin |
| RISK-003 | An incorrect product match reaches customers, undermining the "cheapest offer" claim | Medium | High — this is the platform's core trust mechanism | Reported-incorrect-match rate (N.4) | Human review for every non-exact match (BR-001); explicit never-auto-match rules (N.2) | Manual re-review sweep of a reviewer's decisions if their error rate exceeds threshold | Product-matching reviewer / catalog admin |
| RISK-004 | Stale inventory causes checkout failures or oversell | Medium–High (manual entry is the primary channel, Q6) | Medium — checkout-time revalidation (FR-CART-002) contains the damage | Sold-out-at-checkout rate (FR-ANALYTICS) | Staleness flags (BR-005), checkout-time revalidation, safety-stock buffer (FR-INV-007) | Tighten the staleness window for repeat-offending vendors; prompt manual re-confirmation | Vendor / Operations |
| RISK-005 | Price disputes between what a customer saw and what they were charged | Medium | Medium | Price-related support-ticket volume | Checkout-time price revalidation (FR-CART-002), full price-history audit trail (FR-PRICE-002) | Support-agent refund authorization within limit (FR-SUP-004) | Support |
| RISK-006 | Multi-vendor checkout's complexity produces bugs or incomplete orders | Medium | High — the platform's defining and riskiest mechanic (Part 1, D.2) | `TC-CHECKOUT-*`/`TC-ORD-*` failure rate; partial-order ticket volume | Built for real in the FYP increment, not deferred (Part 1, D.4); explicit state machines with invalid-transition guards (Part 2, E.11) | **Contingency only, requires explicit product-owner approval before activation — engineering must never flip this unilaterally, since it contradicts the confirmed launch scope (BDR-001):** feature-flag a temporary fallback to single-vendor checkout (FR-ADMIN-004) if a systemic bug surfaces post-launch, and only with that approval | Engineering (execution); Product owner (approval to activate) |
| RISK-007 | No licensed, integrable online-payment gateway confirmed in time | Medium | High — blocks the entire online-payment scope (Q3) | ⚠ OPEN-001 still unresolved past a set checkpoint | COD-first design; sandboxed/simulated online payment for the FYP demo (Part 1, D.4) | **Contingency only, requires explicit product-owner approval before activation — engineering must never drop online payment unilaterally, since dual payment is confirmed launch scope (BDR-003):** launch/demo with COD only, and defer online payment to Phase 2, only with that approval | Product owner / Finance (approval required; not an engineering-only call) |
| RISK-008 | Delivery quality/reliability is inconsistent across vendors (vendor-run delivery by design, Q4) | High | Medium | Per-vendor delivery-failure rate (FR-VEND-011) | Performance indicators visible to admin; failed-delivery reschedule flow (FR-FUL-006) | Flag/suspend a chronically-failing vendor's delivery option, push customers toward pickup for that vendor | Operations |
| RISK-009 | Return disputes escalate beyond support capacity | Medium | Medium | Dispute-queue backlog (Part 5, admin screen) | SLA-driven auto-escalation (FR-RET-003); abuse-prevention limits (FR-RET-007) | Temporarily require stricter return-reason evidence | Support / Operations |
| RISK-010 | Fraud: fake reviews, return abuse, account takeover attempts | Medium | Medium | Fraud-signal dashboard triggers (FR-ADMIN-006) | Review/return anomaly detection (FR-REV-007/FR-RET-007); OTP + login rate-limiting (FR-AUTH-011) | Manual moderator sweep; temporary stricter verification on flagged accounts | Content moderator / Operations |
| RISK-011 | A 2-person team cannot sustain catalog review, support, and engineering simultaneously as volume grows | High — the core structural constraint of this project (Q14) | High | Match-review queue backlog growth; support SLA breaches | FYP Delivery Increment deliberately narrows *breadth*, not the core mechanic (Part 1, D.4); exact-match auto-linking (BR-001) minimizes manual review load by design | Pause new-vendor onboarding temporarily to protect existing quality rather than let backlog grow unbounded | Product owner (both team members) |
| RISK-012 | Arabic search quality is insufficient for the Arabic-first requirement | Medium | High — core UX requirement, not a nice-to-have | Zero-result rate on Arabic queries (FR-ANALYTICS-004) | Normalization/transliteration/synonym handling (FR-SEARCH-002/012) | Manually curate a synonym list for the highest-volume search terms | Catalog admin / Engineering |
| RISK-013 | No confirmed Palestinian legal/tax/consumer-protection framework (Q11) | High — confirmed as unresolved, not merely unlikely | High — could force rework of retention/return-window/tax defaults | Any professional legal review surfacing a hard requirement conflicting with a shipped default | Every legal/tax rule explicitly flagged "requires confirmation" rather than asserted (Q11); conservative general-practice defaults chosen | Adjust retention/return-window/tax defaults promptly once legal review lands (Dependency register, DEP-006) | Product owner (depends on external legal counsel) |
| RISK-014 | Subscription revenue doesn't cover platform operating costs | Medium | Medium — a business-sustainability risk, not an FYP blocker | Vendor churn rate at subscription renewal | Low-friction onboarding keeps vendor acquisition cost low; Phase-2 ad/sponsored-placement revenue stream already planned (FR-CMS/FR-SEARCH-009) | Revisit subscription price tiers (⚠ OPEN-003); consider a hybrid commission model | Product owner / Finance |
| RISK-015 | The `WebhookInbox`/reconciliation or `OutboxEvent` relay worker falls behind under load | Low–Medium (the transactional-outbox design in Part 6 substantially mitigates this) | Medium | `Reconciling`/`Pending` backlog depth (Part 6, Section P alerting) | Dead-letter visibility (FR-ADMIN-001); scheduled reconciliation retry (Section P) | Manual reconciliation via the admin portal's Payments & settlements screen | Engineering |
| RISK-016 | Scope creep against the hard 3-month FYP window | High — the confirmed scope is genuinely ambitious (Part 1, D.4) | High — risks the academic deadline itself | FYP Delivery Increment items slipping past their planned sprint (Part 8) | Explicit FYP-vs-full-MVP scope separation maintained throughout every part | Further narrow the increment's pilot-vendor/governorate count; the core multi-vendor-checkout mechanic itself is non-negotiable (D.2) | Product owner |
| RISK-017 | App Store / Google Play review rejects or delays one of the two mobile builds (DEP-010–012) | Medium — first-time submissions are commonly rejected on a fixable but time-costly issue (missing privacy disclosures, incomplete metadata, a crash on the reviewer's device) | High — directly threatens the fixed FYP demo date if discovered late | No developer-account enrollment yet (DEP-010/011) as the FYP timeline progresses; no build submitted with meaningful lead time before the demo date | Enroll in both developer programs early (well before code-complete); submit for review with real lead time, not at the deadline; test on physical devices (DEP-013) before submission to catch the issues stores commonly reject on | If review isn't resolved in time, demo the mobile apps via TestFlight/internal-testing-track builds (which don't require full store approval) rather than missing the deadline outright | Product owner / Engineering |

---

## Q.2 Assumption register

Consolidates Part 0's `ASM-001`–`ASM-015`. Most were converted to **confirmed requirements** once the product owner answered Q1–Q15 (Part 0, Section 2) — listed here as "Confirmed" for traceability. A few remain genuine ongoing assumptions.

| ID | Assumption | Status | Risk if wrong |
|---|---|---|---|
| ASM-001–ASM-009, ASM-011–ASM-015 | The original MVP-scope, currency, geography, mobile, commission, auth, guest-checkout, timeline, and ingestion defaults proposed in Part 0 | **Confirmed** — superseded by the product owner's answers (Part 0, Section 2); kept here only for traceability, not as live assumptions | N/A — no longer assumptions |
| ASM-010 | No confirmed Palestinian legal/tax/data-protection framework; general-practice defaults used, every legal/financial rule flagged | **Still assumed** — this is Q11's confirmed *approach*, but the underlying legal uncertainty itself (RISK-013) is not resolved | Shipped defaults (retention periods, return windows, tax handling) may need rework once real legal confirmation lands |
| ASM-016 (new) | The FX-normalization approach (BR-021: native price + ILS-normalized comparison price) is an adequate resolution of Q7's per-vendor-currency requirement, pending only the FX-rate *source* (⚠ OPEN-002), not the mechanism itself | Assumed, not yet validated against a real second currency in production data | If real cross-currency vendor pairs are rarer or more complex (e.g., three currencies, not two) than assumed, the normalization UI/logic may need revisiting |
| ASM-017 (new) | A 2-person team can realistically execute the FYP Delivery Increment (Part 1, D.4) within 3 months | Assumed, tracked via RISK-011/RISK-016 | If wrong, the increment itself needs re-scoping, not just individual features |

---

## Q.3 Dependency register

| ID | Dependency | Type | Status | Risk if delayed/unavailable | Owner |
|---|---|---|---|---|---|
| DEP-001 | Licensed, integrable online-payment gateway for the West Bank | External service | ⚠ Open (OPEN-001) | Online payment scope (Q3) cannot ship for real; FYP uses a sandbox/simulated flow (Part 1, D.4) | Product owner |
| DEP-002 | SMS/OTP provider covering Palestinian phone numbers | External service | ⚠ Open (OPEN-004) | Blocks real OTP-based auth (FR-AUTH-003) and BR-DELIVERY-CONFIRM's SMS legs; FYP falls back to a logged/visible admin view (Part 1, D.4) | Product owner / Engineering |
| DEP-003 | FX-rate source for cross-currency comparison normalization | External service or manual admin process | ⚠ Open (OPEN-002) | Comparison-price normalization (BR-021) cannot run for real; demo can use a manually entered rate as a stopgap | Engineering |
| DEP-004 | Managed hosting platform (Railway/Render/Fly.io — final pick during setup) | External service | Not yet selected | Deployment/CI-CD pipeline (Part 6, Section P) cannot stand up until chosen | Engineering |
| DEP-005 | Cloudflare (CDN) + R2 (object storage) accounts | External service | Not yet provisioned | Image/media serving and CDN benefits unavailable until set up; low switching cost if deferred briefly | Engineering |
| DEP-006 | Professional Palestinian legal/tax review | Professional/external | Not engaged | Every item flagged "requires legal confirmation" across Parts 2–6 (retention, tax, consumer-protection return windows) stays provisional indefinitely without this | Product owner |
| DEP-007 | Meilisearch (future search-engine migration target) | External service, **not needed at FYP scale** | Deferred by design (Part 6, M.2) | Only relevant once the migration trigger (catalog > ~100k offers or search p95 breach) is hit | Engineering |
| DEP-008 | Third-party delivery/courier provider (Phase 2) | External service, **out of scope for FYP/initial MVP** | Deferred by design (Q4) | Only relevant once Phase 2 delivery expansion begins | Product owner |
| DEP-009 | Map-tile/rendering provider for the interactive map picker used in address entry (FR-AUTH-008), branch geo-pin verification (BR-022), delivery-zone definition (FR-FUL-004), and location-aware search (FR-SEARCH-006) | External service (or a free/self-hosted option) | Not yet selected | **Explicit scope statement:** every map pin in this system (customer address, vendor branch, delivery-zone boundary) is **manually placed by a user dragging a pin on an embedded map** — no automatic address-text-to-coordinate geocoding is required or assumed anywhere in this SRS. What's still needed is only a map-tile provider to *render* that interactive map (e.g., OpenStreetMap tiles via Leaflet — free, no API key, recommended default for a cost-conscious FYP build — or Mapbox/Google Maps Platform as paid alternatives with richer styling). Location-aware search/distance sorting (FR-SEARCH-006) and delivery-zone eligibility checks (BR-006) run on the coordinates already captured this way, via PostGIS (Part 6, M.2) — they do not need geocoding either | Engineering |
| DEP-010 | Apple Developer Program account (annual paid enrollment) | External/administrative | Not yet enrolled | Blocks any iOS build/distribution, including internal testing via TestFlight — must be enrolled well before the FYP demo date, not left until submission time | Product owner |
| DEP-011 | Google Play Console account (one-time paid registration) | External/administrative | Not yet registered | Blocks any Android build distribution beyond direct APK sideloading | Product owner |
| DEP-012 | App Store / Google Play review-and-approval process for the two mobile builds | External/process (review turnaround and outcome are outside this team's control) | Not yet applicable (no build submitted) | A rejection or multi-day review delay directly threatens the FYP demo date if submission is left late; risk tracked as RISK-017 below | Engineering |
| DEP-013 | Physical iOS and Android devices (or equivalent access) for real-device testing | Internal/equipment | Not yet confirmed available to the 2-person team | Simulator/emulator-only testing can miss real-device issues (camera/upload for verification photos, GPS accuracy for map pins, SMS/OTP autofill) before submission | Engineering |

---

## Q.4 Open-question register

Consolidates OPEN-001–007 (first raised in Part 0) plus two items formalized here for the first time.

| ID | Pending decision | First raised | Status |
|---|---|---|---|
| OPEN-001 | Licensed, integrable online-payment gateway for the West Bank | Part 0 (Q3) | Open |
| OPEN-002 | FX-rate source/refresh frequency for cross-currency comparison | Part 0 (Q7) | Open |
| OPEN-003 | Monthly subscription price tier(s) and grace-period/suspension policy | Part 0 (Q10) | Open |
| OPEN-004 | SMS/OTP provider for Palestinian phone numbers | Part 0 (Q12, Q4) | Open |
| OPEN-005 | Vendor storefront-verification reviewer assignment and rejection criteria | Part 0 (Q8) | Open |
| OPEN-006 | Sign-off on the FYP Delivery Increment slice (Part 1, D.4) | Part 0 (Q14) | **✅ Approved 2026-09-16.** Product owner formally approved the FYP Delivery Increment as documented in Part 1 §D.4 and Part 8. Implementation begins at Sprint 1 (EPIC-FOUND) on this basis. |
| OPEN-007 | Mixed-currency parent-order payment settlement (checkout charging, refund currency/amount) | Part 0 (Q7, Q1/Q2) | Open — BR-013/BR-021's checkout-currency clause remains a labeled proposed default, not binding (Part 3 review) |
| OPEN-008 (new) | Policy for an uncollected pickup order past a configured window (auto-cancel? escalate to vendor? hold indefinitely?) | Part 2, E.13 (flagged in passing as "not yet an OPEN-item") | Open — formalized here |
| OPEN-009 (new) | Specific legal/tax/retention/consumer-protection parameter values (exact retention periods, return-window minimums, tax-invoice fields) once professional confirmation (DEP-006) is obtained | Scattered across Parts 2–4 (FR-AUTH-010, FR-RET-001, FR-PRICE-005, NFR-RETAIN-001) | Open — the *approach* (flag, don't assert) is confirmed via Q11; the specific numbers are not |

None of these block proceeding — every tagged item carries an explicit "pending" marker everywhere it's referenced, per the master prompt's requirement not to silently assert unconfirmed facts.

---

## Q.5 Architecture Decision Records (ADR list)

| ID | Title | Decision | Key consequence |
|---|---|---|---|
| ADR-001 | Modular monolith over microservices | Single NestJS application, internally modularized by FR domain (Part 6, M.1) | Avoids distributed-transaction/deployment complexity a 2-person team can't absorb; extraction remains possible later, not foreclosed |
| ADR-002 | NestJS + TypeScript for the backend | Chosen for structured modular-monolith support and a shared language with the frontend (Part 6, M.2) | Reduces context-switching for a 2-person team |
| ADR-003 | PostgreSQL + PostGIS as the system of record | Chosen over MySQL/MongoDB for relational integrity matching Part 3's FK-heavy model, plus real geo-distance queries (Part 6, M.2) | Every entity in Part 3 assumes relational FK enforcement; a NoSQL choice would have undermined G.1's anti-pattern prevention |
| ADR-004 | Next.js (SSR) + Capacitor instead of Flutter for the client | Chosen specifically to resolve the NFR-SEO-001 risk that a client-rendered framework would leave open (Part 6, M.2) | Public catalog/comparison pages stay indexable without a second SEO-only web surface |
| ADR-005 | Postgres full-text search now; Meilisearch as a defined migration target | Avoids operating a dedicated search engine before catalog size justifies it (Part 6, M.2) | Migration trigger explicitly defined (>100k offers or search-latency breach) so the decision isn't revisited on a whim |
| ADR-006 | Transactional outbox (`OutboxEvent`) instead of enqueueing a background job inside a database transaction | Corrects the initial draft's flawed assumption that a Redis/BullMQ enqueue could be part of a Postgres transaction (Part 6, M.4; Part 3) | A Redis outage at commit time can no longer silently lose a vendor notification or payment follow-up job |
| ADR-007 | Four-level canonical/variant/offer model for color/size/storage ownership | `CanonicalProduct` / `CanonicalProductVariant` / `OfferVariant` / unmatched-offer, each owning a specific class of attribute (FR-MATCH-008) | Prevents different developers from storing the same attribute at inconsistent levels, which would have broken comparison/inventory |
| ADR-008 | Per-suborder `Fulfillment` (not per-order) as the fulfillment/shipment unit | Enables split shipment (FR-FUL-007) and item-level return eligibility independent of sibling items (BR-025) | Resolved the Part-2-review finding that return eligibility was wrongly tied to whole-suborder completion |
| ADR-009 | `PaymentAllocation` + `PaymentTransactionAllocation` join model | Lets one parent `Payment` settle per vendor suborder, in that suborder's currency, without presupposing how OPEN-007 resolves (Part 3) | Avoids a future schema redesign once the checkout-currency question is actually decided |
| ADR-010 | `AwaitingPayment` gate before vendor visibility on online-payment suborders | A `VendorSuborder` is invisible to the vendor, and fires no notifications, until its payment is no longer at risk of failing (Part 2, resolving the L-15 review finding) | COD orders are unaffected (no gate, since there's nothing to fail) |
| ADR-011 | Row-level, application-layer vendor data isolation now; Postgres RLS as a Phase-2 upgrade | Every vendor-owned table already carries `vendor_id` (Part 3 review fix), making the schema RLS-ready without a future migration (Part 6, M.5) | Sufficient for FYP/initial-MVP scale; a stronger database-enforced guarantee is a deliberate, cheap-to-adopt upgrade path |
| ADR-012 | No dedicated API gateway component | The NestJS app itself handles H.1's cross-cutting conventions (versioning, rate limiting, auth) (Part 6, M.2) | Unjustified operational complexity avoided at this scale; reconsidered only if microservices decomposition ever happens (ADR-001) |

---

## Q.6 Business Decision Records (BDR list)

Every BDR below traces to the product owner's confirmed answer in Part 0, Section 2, except BDR-015 which is an emergent decision from the review process itself.

| ID | Title | Decision | Source |
|---|---|---|---|
| BDR-001 | Full multi-vendor checkout from day one | A single cart/checkout may span multiple vendors from launch, not phased in | Q1 |
| BDR-002 | Parent order + vendor suborder structure | One `CustomerOrder` per checkout, one `VendorSuborder` per vendor | Q2 |
| BDR-003 | Dual payment methods at launch | Cash on delivery and online payment both available from day one | Q3 |
| BDR-004 | Vendor-delivery/pickup fulfillment + triple-notification confirmation rule | Vendor delivers or customer picks up; order confirmation requires home pin + two phone numbers and fires three tracked notifications | Q4 |
| BDR-005 | Exact-match auto-approval, human review for everything else | No fuzzy match is ever auto-approved | Q5 |
| BDR-006 | Manual/CSV/API ingestion only, no web scraping | Controlled ingestion channels only | Q6, Q15 |
| BDR-007 | Per-vendor currency | Vendors are not forced onto a single platform currency | Q7 |
| BDR-008 | Nationwide rollout with physical-branch verification | All West Bank governorates from day one; physical branches require geo-pin + photo evidence | Q8 |
| BDR-009 | Web + Android + iOS from launch | Three client platforms from day one, not web-only | Q9 |
| BDR-010 | Monthly subscription vendor monetization | Flat subscription, not per-order commission | Q10 |
| BDR-011 | General-practice legal/privacy standard | No specific confirmed Palestinian legal framework; conservative defaults, everything flagged for professional confirmation | Q11 |
| BDR-012 | Phone + password + OTP authentication | Primary credential is phone+password; OTP verifies the phone; email optional | Q12 |
| BDR-013 | No guest checkout | Guests browse/compare freely; login required at the point of purchase | Q13 |
| BDR-014 | 2-person team, 3-month delivery window | The real constraint the entire delivery plan is built around | Q14 |
| BDR-015 | **✅ Approved** FYP Delivery Increment as the build-scope reconciliation | The full confirmed scope (BDR-001–013) remains the documented target design; the narrower, explicitly-scoped increment (Part 1 §D.4, Part 8) is what the 2-person/3-month team builds first — formally accepted by the product owner 2026-09-16, alongside the FR-SUP informal-support decision (`EPIC-SUP`/`BL-SUP-001`, Part 8) and the instruction to begin implementation at Sprint 1 with OPEN-001/003/004 left open, using the documented sandbox/fallback behavior until those are resolved | Part 1, D.4; Part 8 — status was OPEN-006, now resolved (above) |

---

**Next:** Part 8 will cover the development backlog (Epics → Features → User stories → Tasks with stable IDs, MoSCoW priority, and estimates) and the sprint & release plan, built directly against the FYP Delivery Increment (BDR-015) and the full scope (BDR-001–013) as its post-FYP roadmap.
