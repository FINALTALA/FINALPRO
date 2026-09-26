# FINALPRO — Approved Product Decisions, September 2026

**Status:** Approved by the product owner on 2026-09-19; amended 2026-09-26 (PDR-035, PDR-036, and the explicit Phase-2 exclusion list added to §6).
**Authority:** This document is the change-control baseline for the decisions gathered during the product-discovery sessions in September 2026. Where it conflicts with Parts 0–9 of the current SRS, **this document takes precedence** until the listed SRS sections are revised on this branch and reviewed in a pull request.
**Implementation status:** Requirements only. No code change or Sprint-3 change is authorised by this record by itself.

## 1. Why this record exists

The nine-part SRS was internally consistent when approved, but the owner subsequently made detailed product decisions about storefronts, roles, stock, checkout, delivery, returns, online-only vendors, and public discovery. Several decisions intentionally supersede earlier assumptions. This record provides one unambiguous source for the next SRS revision, backlog re-estimation, and later implementation work.

It is not a silent scope cut. It expands and sharpens the target product, while preserving the existing FYP constraint: two people, three months, and a phased delivery plan. Before any new sprint is authorised, the affected backlog and capacity plan must be re-estimated.

## 2. Decisions that supersede prior SRS assumptions

| ID | Approved decision | Supersedes / clarifies |
|---|---|---|
| PDR-001 | **ILS is the only platform currency.** Product prices, delivery/return/exchange fees, comparison, payment, refunds, subscriptions, and reporting use ILS. There is no FX conversion, vendor-native checkout currency, or mixed-currency settlement. | Phase 0 Q7, BR-CURRENCY, OPEN-002, OPEN-007, and all per-vendor currency/FX statements. These must be retired or rewritten. |
| PDR-002 | A signed-in customer may browse, compare, favourite, follow, add to cart, and checkout. Guests may only browse/search/compare. Cart creation requires login and the server-side cart persists across devices. | The guest-cart merge requirement. |
| PDR-003 | A cart does not select fulfilment when an item is added. At checkout the customer selects the items to buy; unselected lines remain in the cart. The system then forms fulfilment groups by eligible branch/execution location. | Any product-page branch/pickup/delivery choice. |
| PDR-004 | A **BranchOrder** is the operational unit: all selected items fulfilled by the same physical branch travel together, have one fulfilment method, one delivery fee where relevant, one status flow, and one payment choice. If no single eligible branch has every selected item, the system creates separate BranchOrders. | The earlier vendor-only suborder model is insufficient; retain a parent order, but model fulfilment/payment at branch-order level. |
| PDR-005 | Online-paid BranchOrders in the same checkout are charged through one sandbox electronic transaction. COD/pay-at-pickup BranchOrders are collected by their respective branch. All payments are ILS. | Earlier mixed-currency allocation/settlement design. |
| PDR-006 | There is no internal delivery-driver user role in phase 1. Delivery coordination with a courier is outside the platform; a branch employee updates the branch order as sent/delivered. | The Delivery Driver role and driver-facing functions. |
| PDR-007 | No internal chat or stories in phase 1. Each store must publish at least one external contact route: Instagram, Facebook, or WhatsApp. | Any implication that support/chat is a launch workflow. |
| PDR-008 | One account may be a customer and also hold store-owner or branch-employee roles. The interface has a role/workspace switcher. A branch employee is assigned to exactly one branch at a time; an owner may own multiple stores. | The old split vendor-admin/catalog/order-processing staff roles. |
| PDR-009 | The owner controls store configuration, catalog, prices/discounts, staff, all store inventory/orders, subscription and analytics. An employee controls only the assigned branch’s orders and stock, and cannot edit prices, media, descriptions, store configuration, analytics, or another branch. | Broad vendor-staff permissions. |
| PDR-010 | A verified store can be physical, online-only, or hybrid. An online-only store has one hidden warehouse execution location and may configure multiple public pickup points; pickup points hold no stock. | Physical-branch-only fulfilment and verification assumptions. |
| PDR-011 | Store pages are public social-commerce storefronts. They have a stable URL, editable display name, logo, biography/description, cover/background image or colour, contacts, store sections, products, and follow control. | Generic vendor profile presentation. |
| PDR-012 | Store product sections are one level: fixed **All**, automatic **New arrivals** and **Discounts**, plus vendor-created sections. A product can be in several custom sections. A custom section may be renamed/reordered/deleted; deletion removes only that grouping, not its products. Maximum: 20 custom sections. | A generic category-only store view. |
| PDR-013 | Public discovery has external pages for All, Women, Men, Kids, and Accessories. Stores choose one or more applicable types at registration and may edit them. The All page mixes the four. | A single undifferentiated discovery surface. |
| PDR-014 | Store hero suggestions use 40% store views, 30% newness, 30% rating. General product feeds use 40% product views, 30% newness, 30% discount. Ties and cold-start behaviour must be deterministic and documented. | Unspecified/promotional ranking. |
| PDR-015 | A global canonical-product card shows the lowest **available** ILS price and up to five logos for the cheapest eligible stores. Selecting a logo opens that offer’s product detail inside that store. Selecting the card opens the cheapest eligible offer (ties: higher rating, then permitted location proximity). | Native-currency card amounts and unspecified navigation. |
| PDR-016 | Price comparison lists every eligible store offer from lowest to highest, in a usable card grid (4–6 desktop, 1–2 mobile). A chosen colour/size limits results to matching offers. A customer must enter a store product page to add to cart. | Comparison without variant and navigation rules. |
| PDR-017 | A product is publicly available at store level if any branch has the chosen variant. Public surfaces show Available, Low stock (1–3), or Sold out—not exact quantities—except that a cart quantity validation shows the maximum allowed. | General public inventory count visibility. |
| PDR-018 | A seller must provide a barcode for every product. If no manufacturer code exists, the platform generates a printable store-internal inventory barcode. Store inventory barcode is unique within a store. It is not automatically overwritten by the internal shared platform-product barcode. | Treating one barcode as both universal matching identifier and store stock label. |
| PDR-019 | Exact barcode plus a new colour/size during import is an additive update, not a conflict. Mandatory manual review conflicts are differing brand, differing base product type, or differing MPN/model when present. | A stricter same-barcode import rejection rule. |
| PDR-020 | Physical stock is per branch/variant. No transfer between branches is supported in phase 1. A staff physical sale scans a product barcode, selects colour/size, enters quantity, confirms the sale, and atomically decrements that branch’s stock. It records the stock movement/audit only, not receipt or payment details. | Inventory transfer and POS/payment-recording assumptions. |
| PDR-021 | Manual non-sale stock reductions (damage, loss, count correction) need a mandatory reason and immediately notify the owner, regardless of amount. | Threshold-based manual-adjustment alerts. |
| PDR-022 | Physical-store delivery/pickup settings are branch-specific. Delivery fees are store-wide by region: West Bank, Jerusalem, and Inside. A store may disable zones. | Per-branch delivery-fee assumptions. |
| PDR-023 | For delivery, checkout first finds branches that stock every selected variant in a BranchOrder; it proposes the nearest eligible branch, while the customer can deliberately choose a farther eligible branch. The customer then picks an available branch calendar slot in the next three days. | Automatic branch choice without customer selection. |
| PDR-024 | Delivery slot calendars belong to branches. Slots have configurable non-overlapping start/end times, capacity, normal hours and exceptions. A slot that has orders cannot be changed/deleted without resolving affected orders. | Generic delivery scheduling. |
| PDR-025 | The branch employee explicitly starts preparation. If it is not started six hours before the scheduled slot, remind the employee. If the slot is reached unprepared: an online-paid customer chooses a new slot or receives an automatic refund; a COD customer must choose a new slot within 48 hours or the order is cancelled. | A simpler delivery-confirmation flow. |
| PDR-026 | A branch employee marks **Sent** at hand-off and **Delivered** when informed of arrival. The customer then confirms delivery in the Orders UI. A “not received” report requires a reason and directs the customer to external store contact; no in-platform dispute case is created. Remind after 48 hours, auto-confirm after 72. Staff may re-send or re-request confirmation after external resolution. | A delivery-driver proof/confirmation workflow. |
| PDR-027 | First failed delivery requires the customer to choose a new branch-calendar slot within two days. COD is cancelled after a second failed attempt. Online-paid orders continue attempts; after the second failed attempt, the customer may request a refund and the employee approves it. | One uniform two-attempt cancellation policy. |
| PDR-028 | Before preparation, the customer can cancel an individual item. After preparation but before Sent, staff may cancel an item/order after external contact. If it is the last item, refund delivery fee too; otherwise retain the fee. Once Sent, neither side self-cancels in-app. | Parent/vendor-wide cancellation wording. |
| PDR-029 | Addresses have map pins, written descriptions, defaults, and an explicit-save rule for current location. An address may change before preparation only. If it is unsupported, customer chooses cancel, pickup conversion, or another supported address; online cancellation refunds automatically and changing to pickup refunds the delivery fee. The original branch is retained if still able to fulfil. | Address/fulfilment changes after checkout. |
| PDR-030 | Returns are governed by a per-store policy selected at registration: return days and refund/exchange/both/no-return, separate fixed ILS return/exchange fees, disclosed and snapshotted at purchase. Policy/fees change at most once per six months. Product exceptions allowed. | A single platform-wide return policy. |
| PDR-031 | A return request needs a reason, optional photos, store response in 48 hours and delayed notice at 72; no automatic approval. An approved request has a six-digit code valid seven days. All physical branches accept it if that store accepts returns; all online pickup points accept it if the online store accepts returns. | Branch-by-branch return policy. |
| PDR-032 | Only verified delivered/picked-up purchasers can review. Product and store reviews are separate, each 1–5 plus mandatory comment; first name and last initial appear. Reviews are immutable by the customer; reports may hide them after admin review. Seller replies are deferred. | Generic review and vendor-reply behaviour. |
| PDR-033 | A unified sandbox/trial subscription begins after verification, lasts one month and has mock monthly renewal. No Basic/Pro logic now. On expiry, listings/page are unavailable for new orders but the owner can see the account and work existing pre-expiry orders; renewal restores automatically. Reminders: seven days before and on expiry. | Tiered subscription/payment rules. |
| PDR-034 | Account deletion is deactivation: active unreceived orders block it; then sessions are revoked, nonessential personal data is hidden, necessary order/audit records remain, and account recovery by OTP is possible for 30 days. | Unqualified hard deletion. |
| PDR-035 | **(2026-09-26)** A PHYSICAL or HYBRID store keeps the existing requirement: a physical branch cannot leave "pending verification" without a geolocation pin and a storefront photo. An ONLINE_ONLY store needs neither — instead it must submit a warehouse address pin (lat/lng plus an address note) before verification-evidence review. The warehouse address/pin/any warehouse data is never returned by a public or storefront endpoint under any circumstance; only a vendor-verification reviewer sees it, and only inside the verification-decision path. | Closes OPEN-011. Refines PDR-010 and the FR-VEND-002/FR-VEND-012 evidence requirement for the ONLINE_ONLY case specifically. |
| PDR-036 | **(2026-09-26)** Colour and size are offer-variant options, never one of a category's five required structural matching/search fields (FR-CAT-015) — the enclosing public discovery segment (Women/Men/Kids/Accessories) already carries audience/gender, so it is not repeated as a field either. The five required fields per clothing/accessory category are the ten templates fixed in §3.2. A missing/unbranded item uses the controlled value "No brand" (بدون علامة تجارية), never a blank brand field. | Closes OPEN-013 for the clothing/accessories category set the platform currently supports. A future category outside this set (e.g., electronics, home goods) still needs its own five-field decision — this does not resolve OPEN-013 in general, only for clothing/accessories. |

## 3. Full approved baseline by product area

### 3.1 Storefront, discovery, language, and engagement

- Arabic is the default and layout is RTL. The customer can explicitly switch Arabic/English; the choice is retained account-wide. Vendor-entered titles/descriptions may be Arabic or English. The platform supplies an automatic translation with access to the original text.
- A store can be listed in one or more of Women, Men, Kids, Accessories. Its own page can have only one level of sections; **All** is always present, **New arrivals** and **Discounts** are automatic, and custom sections are optional.
- Public pages use the global card, not a store-specific section card. Store page cards reflect that store’s offers. A card’s up-to-five store logos are clickable as specified in PDR-015.
- The external **Following / أتابعه** page is reached from public top navigation, not from account settings. It has a horizontally scrolling row of followed-store logos/names and a product feed using the public global cards. Empty state suggests stores. Inactive followed stores stay faded; following is retained. Every qualifying product/discount event from a followed store is a separate notification (not an aggregate).
- Favourite products require sign-in. A favourite can notify for restock or discount at any store that offers the canonical product. Multiple same-type alerts may be grouped.
- Search covers stores and products; provide immediate suggestions, Arabic/English tolerance and similar-result fallback. Searching a temporarily unavailable store still opens it with a clear unavailable state. Inactive offers cannot determine the active “starts from” price or active ranking.
- Store and product views count at most once per account/device every two hours. Featured store-page products rank by views, falling back to newness. Cap a featured display at 40 products.

### 3.2 Catalog, media, matching, pricing, and availability

- Publishing requires: title, primary image, general platform category, regular ILS price, stock, and five category-specific matching/search fields. `N/A` is allowed where a field does not apply. Condition defaults to New and may be Used, Refurbished, or Open Box; notes are optional.
- A product supports up to ten images and three videos of up to 60 seconds each. Vendor can choose/reorder/edit/delete/replace the primary image. Every media item is a matching signal. Media/detail edits rerun matching.
- Category-specific colour and size lists are supplied. A vendor may create a product-only custom value without administrator approval.
- **(2026-09-26, PDR-036) Colour and size are offer-variant options, not structural fields** — they never occupy one of the five required matching/search fields below, and the public discovery segment (Women/Men/Kids/Accessories) already carries audience, so no field repeats it. The five required fields for each clothing/accessory category are:

  | Category | Five required fields |
  |---|---|
  | Dresses (الفساتين) | Brand, material, pattern, length, sleeve length/type |
  | Tops/shirts (البلوزات/القمصان) | Brand, material, pattern, cut/fit, sleeve length/type |
  | Bottoms — trousers/jeans/skirts (البناطيل/الجينز/التنانير) | Brand, material, pattern, cut, length or waist |
  | Coats/jackets (المعاطف/الجاكيتات) | Brand, material, pattern, closure type, length |
  | Sets/pyjamas (الأطقم/البيجامات) | Brand, material, pattern, piece count, cut |
  | Kids' clothing (ملابس الأطفال) | Brand, age range, material, pattern, category-specific detail (sleeve/length/cut) |
  | Shoes (الأحذية) | Brand, upper material, closure type, heel/sole type, size system |
  | Bags (الحقائب) | Brand, material, bag type, dimensions/capacity, closure type |
  | Jewellery/watches (المجوهرات/الساعات) | Brand, material, sub-type, stone/finish, dimensions |
  | Other accessories (الإكسسوارات الأخرى) | Brand, material, sub-type, pattern, fixed dimensions/size |

  A missing brand uses the controlled value **"No brand" (بدون علامة تجارية)**, never a blank field. `N/A` remains allowed on any field genuinely not applicable to a specific product. This closes OPEN-013 for the categories above (PDR-036); any category outside this list still needs its own five-field decision.
- Vendor price/discount applies across all physical branches, though colour/size variants may have different base prices. Exactly one active percentage discount applies, with vendor-specified start/end and 0 < percentage < 100. It reduces each variant’s own base price.
- Archiving removes an offer from public display but retains orders/reviews; owner can restore/revalidate/publish it.
- Unknown brands are allowed as pending review; the product may remain published with its pending state. A rejection results in correction notice rather than silent deletion.
- Matching order: structured product attributes, text similarity, then image similarity. Exact identifier matches can be proposed automatically. The vendor must explicitly confirm a proposed match; rejected/ignored matches publish as unmatched and can be re-searched. Admin may correct/unmatch and notify owner.
- The first confirmed matched offer supplies a provisional canonical name and shared internal `platform_product_barcode`. A later matching vendor must adopt the canonical name if it accepts that the product is identical. Any matched vendor may request a canonical-name change for admin approve/reject. The platform code is stable and never reused; it survives the first offer being archived/deleted/unmatched. It is not shown to customers.

### 3.3 Physical stores, online stores, branches, stock, and staff

- A physical store has at least one public branch with address/map/hours. Physical verification needs the evidence already defined in the SRS. One branch rejection rejects the joined application; correctable issues use resubmission. A rejected vendor may submit a corrected new application immediately; retain the old record/audit.
- A physical branch has delivery, pickup, or both; it can close temporarily (visible but unavailable for new work while existing work finishes) or be permanently archived/reactivated. It may never be hard-deleted.
- An online-only store’s warehouse is hidden. It verifies through identity/business material where applicable, external contact, and product media; it may have multiple public pickup points with maps, text guidance, hours and slots. Pickup points do not own stock.
- **(2026-09-26, PDR-035) ONLINE_ONLY verification evidence:** no branch photo or physical-branch geo-pin is required. Instead, before verification-evidence review, the vendor submits a warehouse address pin (lat/lng) plus an address note. The warehouse address, pin, and any other warehouse data are never returned by a public or storefront endpoint under any circumstance. Only a vendor-verification reviewer sees the warehouse evidence, and only inside the verification-decision path — never a public-facing screen. PHYSICAL and HYBRID stores are unaffected: they keep the existing branch-photo-and-pin requirement unchanged.
- Owner assigns, transfers and disables branch employees. Employee data access ends immediately on disable; audit remains. Employees may perform only their branch operations, including physical-sales stock movement and manual adjustment.

### 3.4 Cart, checkout, payments, delivery, and orders

- Items are selected for checkout explicitly; there is no automatic selection. Matching lines merge by exact offer/colour/size; other variants remain separate. Cart reflects a later sold-out line as dimmed with a remove control, and checkout requires an adjustment before proceeding.
- Electronic checkout reserves stock and delivery capacity for ten minutes. Success confirms; failure/timeout releases. COD reserves on confirmed order. Any reserve that leaves only 1–3 stock notifies owner and branch employee.
- Price changes are disclosed at checkout. The quote is held for ten minutes while payment occurs. No payment instrument is actually connected in the FYP; present a realistic sandbox card flow and never retain real card data.
- Checkout confirmation is one screen of separate BranchOrder cards. The customer may retry a declined sandbox card within the ten-minute quote period. No printable customer confirmation is needed.
- Pay-at-pickup uses a six-digit pickup code. Staff sees only name, phone and pickup code, not delivery address. Marking handover marks payment paid.
- Order UI groups products from the same branch into one BranchOrder; different branches never share a delivery/fee/status even if they belong to one store. It shows changing status based on employee updates. The customer sees all their BranchOrders across stores in one Orders experience.

### 3.5 Returns, reviews, administration, alerts, and account

- Exchanges: customer chooses the replacement in-app before visit; after store approval reserve it for 24 hours. A cheaper/more-expensive replacement permits refund/payment of the difference plus exchange fee.
- Customer may cancel a pending return, but not an approved return (it expires). There may not be simultaneous open returns for one delivered item. Accepted resellable returns restore stock to the receiving branch; damaged stock remains unavailable until owner restores with a reason. Cash returns are paid at branch; electronic returns go to original payment method less disclosed fee.
- Admin may create/correct canonical products/brands/matches, decide reported product/review actions, suspend/reactivate store (reason + owner notification), and decide store appeal (text + attachments).
- Order state changes always appear in the Orders UI. In-app notifications are reserved for action-required events and cancellation/refund; normal prepared/sent state need not generate a notification. Employee gets immediate new-order notification; owner receives exceptions, not every order.
- The notification centre contains unread count/read state and deep links to the target. Store follow events are deliberately separate per event, not bundled.

## 4. Required SRS and planning impact

| Priority | Affected work | Required outcome before implementation |
|---|---|---|
| P0 | Parts 0, 1, 2, 3, 4, 5, 7, 8, 9 | Remove currency/FX contradictions; add BranchOrder, online-only vendor/pickup point, role boundaries, checkout grouping, inventory movement, calendar, return, notification and public storefront requirements. |
| P0 | Part 8 capacity plan | Re-estimate all new/expanded capabilities. The prior 65-Must-item / 12-sprint plan is no longer a valid delivery claim until revised. |
| P0 | Sprint 3 schema/code | Audit after SRS revision. Existing `VendorOffer`, branch, subscription, currency, verification, roles, matching and barcode work must be checked against this baseline before merge. No retroactive claim of compliance. |
| P1 | Parts 4–6 | Revise API inventory, data model/ERDs, state machines, UX screens/journeys/edge cases, tests and architecture decisions. |
| P1 | Security/privacy | Add least-privilege owner/employee branches, public/private warehouse/pickup data, OTP staff invite, stock adjustment audit, customer deletion/deactivation and delivery-address visibility rules. |
| P2 | Future enhancement register | Keep chat, stories, seller review replies, Basic/Pro plans and live payment integration explicitly deferred. |

## 5. Outstanding decisions that remain open

| ID | Open decision | Why it remains open |
|---|---|---|
| OPEN-001 | Production payment gateway/provider | FYP uses sandbox only; production integrator remains unknown. |
| OPEN-004 | Production SMS/OTP provider for Palestinian numbers | Existing logged fallback remains unsuitable for a production claim. |
| OPEN-009 | Legal, tax, consumer protection, retention and payment parameters | Must be professionally confirmed; amounts/retention cannot be invented. |
| OPEN-011 | Exact onboarding evidence/verification policy for online-only stores | **✅ Closed 2026-09-26 — PDR-035:** a warehouse address pin + note replaces the branch photo/pin for ONLINE_ONLY stores; the warehouse is never public and is visible only to the verification reviewer inside the verification path. |
| OPEN-012 | Delivery-zone boundary source/classification and operational service coverage | Three commercial regions are approved; a defensible geographic boundary/source is still needed. |
| OPEN-013 | Product-category templates: the exact five required matching/search fields per category | **✅ Closed 2026-09-26 for clothing/accessories — PDR-036:** ten category templates fixed in §3.2; colour/size are variant options, not structural fields. Still open for any future category outside that set. |

## 6. Explicitly deferred or excluded from the FYP baseline

- Internal chat and store stories.
- Seller replies to reviews.
- Basic/Pro subscription tiers; the one-month sandbox/trial subscription remains.
- Live bank/payment-gateway connection and real card handling.
- Stock transfer between branches.
- Internal delivery-driver accounts and in-platform delivery disputes.
- Image/video URL import; imports cover structured Excel/CSV data and manual media upload later.
- Formal customer-support/ticket system beyond the existing deferred SRS item.

### Confirmed 2026-09-26: explicit Phase-2/out-of-FYP requirement list

The following SRS Part 2 requirements are Phase-2-only by the SRS's own text. They were previously unaddressed by this record — carried in the engineering traceability audit as a pending scope question — and are now formally added here by product-owner decision, closing that question. None of these is built in the FYP window; each remains fully specified in the SRS and stays available to build post-FYP without a data-model change forced by this exclusion.

- `FR-AUTH-012` — social login.
- `FR-IMPORT-006` — vendor-authorized API/feed ingestion.
- `FR-IMPORT-007` — scheduled feeds/webhooks and POS/ERP integration.
- `FR-SEARCH-009` — sponsored/featured search results.
- `FR-SEARCH-011` — voice search.
- `FR-PRICE-004` — platform promotion/coupon stacking rules.
- `FR-PRICE-008` (Section E.8) — flash sales, bundle pricing, quantity discounts.
- `FR-PRICE-009` (Section E.8) — sponsored/paid placement.
- `FR-CART-007` — platform-wide or vendor-specific coupons.
- `FR-FUL-007` — vendor-enabled split shipment within one BranchOrder.
- `FR-SUP-006` — bilingual public knowledge base/FAQ.
- `FR-VPORTAL-008` — vendor integration-credential management.
- `FR-VPORTAL-010` — vendor settlements screen (commission/payout).
- `FR-CMS-001` — home-page sections/banners/featured placement.
- `FR-CMS-002` — campaign/SEO content pages.
- `FR-CMS-003` — sponsored/paid-placement labelling infrastructure.
- `FR-CMS-004` — referral/affiliate programs.
- `FR-CMS-005` — CMS deep links into web/mobile builds.

## 7. Review and change-control rule

This record must be reviewed in a pull request together with its SRS integration. A developer may suggest implementation details or modest UX enhancements, but cannot change a numbered PDR decision without an explicit product-owner decision recorded in a later change record. Any feature not directly covered must preserve these invariants: ILS-only monetary data; least-privilege branch access; stock never below zero; store/branch fulfilment separation; durable auditability; and customer-visible clarity when a store or offer is unavailable.
