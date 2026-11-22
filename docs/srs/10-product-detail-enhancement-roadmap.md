# SRS — Product-detail enhancement roadmap

**Status:** Proposed product decision and implementation plan — requires product-owner approval before any migration or API contract change.  
**Scope:** Public store product page (`/store/:slug/products/:offerId`) and the data/APIs it consumes.  
**Does not change:** Cart, checkout, stock, order, comparison eligibility, or the current public-store route contract without versioned regression coverage.

## 1. Goal

The product-detail page must let a shopper make a confident decision about a *specific store offer*: see the correct media for a selected colour/variant, understand price and fulfilment, choose a size, assess credible reviews, and move to cart or comparison without invented data.

The page remains store-offer-first. A canonical product comparison is reached explicitly through “قارني الأسعار”; it must not replace the seller-specific page.

## 2. Current foundation and reuse decisions

| Capability | Current source | Decision |
| --- | --- | --- |
| Offer colours, sizes, price, stock | `OfferVariant` + `BranchStock` | Reuse. A colour/size selection must always resolve to one real variant. |
| Variant media | `OfferVariantMedia` with `kind`, `sortOrder`, alt text and per-variant cap | Reuse; expose it per variant in the public detail response. No new `image_url` column. |
| Reviews and verified purchase gate | `Review.sourceBranchOrderItemId`, `Review`, delivered/picked-up lifecycle | Reuse for eligibility; extend carefully for optional review metadata. |
| Delivery/pickup availability | branch zones, fees, calendar/windows and stock | Reuse the checkout eligibility rules; product detail may never promise a path that checkout rejects. |
| Rating aggregate | `ReviewsService` | Reuse the same visible-review aggregation everywhere. |
| Follow count | `StoreFollow` | Compute/count active follows; do not duplicate a counter until scale proves it necessary. |

## 3. Binding product and business rules

### PD-FR-001 — Variant-specific gallery

1. The detail API must return ordered media *for each* sellable variant, not only one flattened gallery for the whole offer.
2. Selecting a colour selects a valid variant and changes the gallery to that variant’s media. Selecting a size within the same colour changes only when that size maps to another variant.
3. If the chosen variant has no media, the client uses the offer’s primary fallback image and labels it as a representative image; publication rules should continue to require a primary image before publishing.
4. Video remains supported where already stored; first release does not add video upload formats or autoplay.
5. “HOT” is not a manual decorative badge. It is shown only when a later sales-ranking rule qualifies the offer; until then the badge is absent.

### PD-FR-002 — Trustworthy review detail

1. Only a verified delivered/picked-up purchaser may create one immutable product review and one immutable store review per purchased order item, preserving existing review rules.
2. A product review may additionally contain: purchased colour/size snapshot, optional fit feedback (`SMALL`, `TRUE_TO_SIZE`, `LARGE`, `NOT_APPLICABLE`), up to five images, and helpful-vote count.
3. The colour/size displayed on a review is copied from the purchased variant at review creation, not read live from a later-edited offer.
4. A signed-in account may cast at most one helpful vote per review; repeat action toggles/removes its own vote. Review authors may not vote for themselves.
5. Review media is subject to the existing upload/security policy and moderation. Hidden reviews and their media are never public; reported reviews retain the current visibility/aggregate rules until an administrator decides.
6. “جودة جيدة” and similar tags are derived aggregate labels only after a defined minimum visible-review threshold; they are never fabricated from individual comments. Arabic NLP/tag extraction is deferred; first release supports only structured fit aggregates.

### PD-FR-003 — Size guide

1. Size guides are category-template data, beginning with clothing only. A guide is versioned, locale-aware, and contains named measurements/units plus rows per size.
2. A canonical product may choose one applicable guide; an offer may not invent conflicting measurements for the same canonical product.
3. “دليل المقاسات” displays the selected guide. “ليس مقاسك؟” initially opens the guide and an explanatory note; it does **not** recommend a size from body measurements until a separate consent, privacy and recommendation design is approved.
4. Products/categories without a guide show no empty size-guide call to action.

### PD-FR-004 — Delivery expectation

1. The page may show an expected delivery range only when a selected address/zone, an eligible branch and a configured service promise exist.
2. The range is calculated from the same selected branch/zone and service calendar as checkout, including closures/cut-off rules. It is always labelled an estimate, not a guarantee.
3. Without sufficient configuration, show current delivery fee/zone availability only; never invent a date.
4. Pickup displays eligible public pickup locations/branches only when the selected variant has live stock there.

### PD-FR-005 — Sales rank and merchandising

1. Bestseller rank is based on completed, non-refunded units in a documented rolling window (proposed: 30 days) within a defined category/audience scope.
2. Cancelled, failed, returned/refunded units and test/demo orders do not count. Ties use a documented stable rule.
3. Rank is precomputed/updated from order lifecycle events or a job; a public product request must not scan orders to calculate rank.
4. “قد يعجبك أيضاً” remains taxonomy-based as it is today. Curated “Matching styles / More style” is a separate manual-merchandising capability; no opaque recommendation model is required for this release.

### PD-FR-006 — Loyalty and social proof

1. Display the real active follower count where useful. “Recurring customers”, sales uplift and loyalty points are not displayed until their data definitions and accounting rules exist.
2. Loyalty points are explicitly **out of scope** for this roadmap’s first releases. They require a separate ledger, expiry/refund policy, anti-fraud rules and checkout/payment integration.

## 4. Data-model changes

### 4.1 No migration: media contract expansion

`OfferVariantMedia` already supports the required data. The public offer-detail endpoint must return, for each variant:

```ts
{
  id, color_code, color_label, size_code, size_label,
  media: [{ url, kind, media_type, alt_text_ar, alt_text_en, sort_order }]
}
```

The current flattened `images` list remains temporarily for backwards compatibility, marked deprecated only after all clients migrate.

### 4.2 Migration A: enriched reviews

| Entity/field | Purpose | Constraints |
| --- | --- | --- |
| `Review.purchasedColorLabel`, `Review.purchasedSizeLabel` | immutable purchase snapshot | nullable for historical reviews |
| `Review.fitFeedback` | structured sizing signal | nullable enum; product reviews only |
| `ReviewMedia` | review image records | max 5/review; ordered; moderation-aware; uploaded by author |
| `ReviewHelpfulVote` | a user’s useful/not-useful signal | unique `(reviewId, customerId)`; author prohibited |

Historical reviews remain valid and simply omit the new metadata.

### 4.3 Migration B: category size guides

`SizeGuideTemplate`, `SizeGuideColumn`, `SizeGuideRow`, and a nullable canonical-product guide reference/version. The exact physical schema may vary, but must preserve: category applicability, AR/EN labels, units, ordered rows, draft/published status, and immutable published versions.

### 4.4 Migration C: delivery promise and sales statistics

| Entity | Minimum data |
| --- | --- |
| `BranchDeliveryPromise` (or equivalent extension of current delivery config) | branch, zone, min/max business days, order cut-off, effective dates |
| `CanonicalProductSalesStat` | canonical product, taxonomy scope, window start/end, completed units, rank, computed timestamp |

Both are derived/configuration data; neither changes historical orders.

### 4.5 Migration D: manual product collections (post-core)

`ProductCollection` and ordered `ProductCollectionItem`, with collection type (`STYLED_WITH`, `MORE_STYLE`, `EDITORIAL`) and published state. Items reference canonical products; eligibility is rechecked at read time.

## 5. API plan

### Extend, do not replace

1. Extend `GET /storefronts/:slug/offers/:offerId` (or introduce a documented `.../product-detail` projection behind the same authorization/public-eligibility rules) with a versioned `product_detail` object.
2. Preserve existing fields and the existing flattened gallery through client migration.
3. The endpoint returns only active/public offer data and applies the exact live-stock, delivery-zone and reservation utilities already used by checkout/storefront routes.

### New read/write endpoints

| Endpoint | Purpose | Access |
| --- | --- | --- |
| `GET /canonical-products/:id/reviews?cursor=` | paginated enriched product reviews + aggregate/fit summary | public |
| `POST /reviews/:id/helpful` / `DELETE /reviews/:id/helpful` | own helpful-vote mutation | authenticated customer |
| `POST /reviews/:id/media` | upload/link review media during permitted review flow | verified review author |
| `GET /size-guides/:id` | published guide | public |
| owner/admin size-guide CRUD | manage templates and publish versions | authorized owner/admin |
| `GET /canonical-products/:id/merchandising` | bestseller metadata, curated collections and taxonomy fallback | public |

All list responses need cursor pagination, stable ordering, input validation, rate limits on writes, and DTO contracts shared with web/mobile.

## 6. Phased delivery plan

| Increment | Scope | Dependencies | Definition of done |
| --- | --- | --- | --- |
| **PD-1: Variant media and detail contract** | Per-variant gallery, selected-variant media switching, fallback, API compatibility and seller media-management validation | existing `OfferVariantMedia` | Selected colour always changes to correct media; old clients still work; API/e2e tests cover colour-size combinations and no-media fallback. |
| **PD-2: Reliable service facts** | Delivery/pickup representation audit, active follower count, clear fulfilment copy | branch stock/zones/calendar | Detail page and checkout agree on eligible pickup/delivery for every tested variant/address. |
| **PD-3: Enriched reviews** | review snapshots, fit feedback, media, helpful votes, moderation and pagination | delivered-order review gate, uploads | Permission/BOLA/moderation tests plus historical-review migration tests pass. |
| **PD-4: Size guides** | clothing guide model, admin/owner management, published read and detail UI | taxonomy/category templates | Guide versioning, unsupported categories and AR/EN rendering covered. |
| **PD-5: Promises and merchandising** | delivery estimates, sales ranking, curated collections | reliable branch calendars/order lifecycle | No estimate/rank appears without qualifying data; event/job idempotency and refund correction tested. |
| **Deferred separately** | loyalty ledger, body-measurement recommendation, automated visual/style recommendations, seller replies | product/legal/privacy decisions | Requires its own approved SRS amendment. |

PD-1 and PD-2 are the recommended next sprint: they provide the highest visible product-page value without a migration. PD-3 through PD-5 each need their own migration, API contract review, seed/backfill plan and rollback rehearsal.

## 7. Cross-cutting safeguards

- **Authorization:** public reads expose only public active offers; review writes verify ownership and delivered/picked-up status server-side; owner/admin changes enforce tenant scope.
- **Data integrity:** use foreign keys, unique indexes and transaction boundaries for votes/media/ranking updates; never trust IDs, price, stock or zone from the client.
- **Privacy:** review photo upload requires consent text; no body measurements are collected in this scope; follower/customer metrics are aggregated only.
- **Performance:** CDN/optimized media derivatives, bounded galleries, cursor pagination, indexed review queries, and precomputed ranks.
- **Accessibility/i18n:** keyboard gallery, image alt text, RTL/AR and EN labels, clear disabled size state, non-colour-only availability signal.
- **Operations:** audit owner/admin changes to size guides, delivery promises and collections; monitoring for failed image processing and ranking jobs; feature flags for PD-3–PD-5 rollout.
- **Regression:** checkout quote/stock, comparison, store page, favorites, cart and review aggregates must remain covered in CI after every increment.

## 8. Acceptance gates before each release

1. Database migration tested forward and rollback/recovery documented; existing rows remain readable.
2. DTO/API contract and mobile/web consumers reviewed together.
3. Unit, API, authorization/BOLA, and browser e2e tests pass; TypeScript/ESLint clean.
4. Manual RTL/mobile/slow-network review passes.
5. No placeholder counts, fake delivery dates, synthetic reviews, or manual “HOT/bestseller” badges are shipped.

## 9. Decisions requested from product owner

1. Approve PD-1 + PD-2 as the immediate implementation scope.
2. Confirm whether review photos are permitted for the FYP and the moderation owner/SLA.
3. Confirm the sales-rank window and whether it is category-only or category + audience.
4. Confirm whether delivery promises are vendor-configured ranges or platform-wide defaults until stores configure them.
5. Confirm that loyalty and body-measurement size recommendations remain deferred, rather than being approximated.
