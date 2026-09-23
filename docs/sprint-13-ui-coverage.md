# Sprint 13 — Modern UI, Following, Discovery: coverage table

Branch: `feat/sprint-13-modern-ui` (from `origin/main` @ `1fdbc27`, Sprint 12 merged).

Sources reviewed before any code: SRS Parts 0–9 (`docs/srs`), `approved-product-decisions-2026-09.md`
(PDR-002/011/012/013/015/016/017 and §3.1 "Following"), `post-sprint3-replan-2026-09.md`
(RB-STOREF-003 follow/Following and RB-STOREF-004b segment pages were explicitly deferred "Should"
items; this sprint delivers them), and every web page and API route from Sprints 1–12.

Rule for this table: no existing capability is removed or reduced because it is visually incomplete.
"API-only" rows have no web page today; they stay exactly as they are unless the row says otherwise.

Status legend: **Planned** (at first commit) → updated to **Done** / **Kept (API-only)** in the final commit.

## A. Customer / public journeys

| # | Journey | Current page | API / real data | What Sprint 13 changes | Status |
|---|---|---|---|---|---|
| 1 | Landing / home | `/` (login button only) | `GET /discovery/all` | New home: hero (approved banner image, demo only), category strip (Women/Men/Kids/Accessories), search box, featured product cards | Planned |
| 2 | Sign in | `/login` | `POST /auth/login` | Restyle; link to register; redirect back to intended page | Planned |
| 3 | Sign up | none (API only) | `POST /auth/otp/request`, `/auth/otp/verify`, `/auth/register` | New `/register` page over the existing OTP flow | Planned |
| 4 | Discovery All | `/discovery` | `GET /discovery/all` | Modern card grid; real cards with image, brand/category, colours/sizes, lowest price, store count, "قارني الأسعار" | Planned |
| 5 | Category pages (Women/Men/Kids/Accessories) | none (deferred RB-STOREF-004b) | `GET /discovery/all?segment=` (new, read-only; uses `VendorApplicableCategory`) | Category strip + `/discovery?segment=` | Planned |
| 6 | Search (products + stores) | none | `GET /discovery/all?q=`, `GET /discovery/stores?q=` (new, read-only) | Header search → results page with product and store sections | Planned |
| 7 | Card → comparison | `/compare/:id` | `GET /canonical-products/:id/comparison` | Card-grid comparison, variant (colour/size) filter, store logos | Planned |
| 8 | Card store logo → that store's offer | store product page | existing card `store_logos` | Small store circles under each card; each opens that store's offer | Planned |
| 9 | Public store page | `/store/:slug` | `GET /storefronts/:slug`, `/sections` | Cover, circular logo, name/bio, share, contacts, section chips, featured + all products, follow button | Planned |
| 10 | Store product page | `/store/:slug/products/:offerId` | `GET /storefronts/:slug/offers/:offerId` | Image, title, options, price, store count, add to cart, compare | Planned |
| 11 | Follow / unfollow a store | none | **new** `PUT/DELETE /customers/me/following/:slug`, `GET /customers/me/following/:slug` | Follow button on store page (real, persisted) | Planned |
| 12 | Following page | none | **new** `GET /customers/me/following`, `GET /customers/me/following/feed` | `/following`: followed-store logo strip + eligible product cards; empty state | Planned |
| 13 | Cart | `/cart` | `/cart*` | Restyle; item images; nav badge | Planned |
| 14 | Checkout | `/checkout` | `/checkout/*`, `/customers/me/addresses` | Restyle only; logic untouched | Planned |
| 15 | My orders | `/orders` | `/customers/me/orders*` | Restyle only; logic untouched | Planned |
| 16 | Account | `/workspaces` | `GET /customers/me`, `GET /me/workspaces` | `/account` (profile, workspace switcher, sign out); `/workspaces` kept | Planned |
| 17 | Password reset | none (API only) | `/auth/password/reset-*` | Unchanged | Kept (API-only) |

## B. Store owner / branch employee journeys

| # | Journey | Current page | API / real data | What Sprint 13 changes | Status |
|---|---|---|---|---|---|
| 18 | Workspace switch | `/workspaces` | `GET /me/workspaces` | Header switcher: customer / owner store / employee branch | Planned |
| 19 | Owner dashboard | none | existing vendor APIs | New `/vendor/:vendorId` hub linking store, sections, offers, branches, zones, windows, orders | Planned |
| 20 | Storefront settings | `/vendor/:id/storefront` | `GET/PUT /vendors/:id/storefront`, publish/unpublish | Live logo/cover preview and link entry only (no upload backend) | Planned |
| 21 | Sections | `/vendor/:id/sections` | `/vendors/:id/sections*` | Restyle | Planned |
| 22 | Offers list | none (API only) | `GET /vendors/:id/offers` | Read-only list page (+ existing status action) | Planned |
| 23 | Branches | none (API only) | `GET /vendors/:id/branches` | Read-only list page linking each branch's orders and windows | Planned |
| 24 | Delivery zones / windows | `/vendor/:id/delivery-zones`, `/delivery-windows`, `/branches/:b/delivery-windows` | existing | Restyle | Planned |
| 25 | Orders (owner / branch) | `/vendor/:id/orders`, `/vendor/:id/branches/:b/orders` | existing | Restyle; employee sees only own branch | Planned |
| 26 | Stock, offer create/import, match review, verification, staff invites, pickup points, subscription, warehouse | none | existing APIs | Unchanged | Kept (API-only) |

## C. New backend surface (all additive, no breaking change)

- Migration `store_follows` (additive table): `userId`, `vendorId`, `createdAt`, `UNIQUE(userId, vendorId)`.
- `PUT/DELETE/GET /customers/me/following/:slug`, `GET /customers/me/following`, `GET /customers/me/following/feed`
  (session-scoped; a user can only ever read/change their own follows; only published + ACTIVE stores are followable, listed or fed).
- `GET /discovery/all` gains optional `segment`, `q`; cards gain `image_url`, `brand_name`, `category_name`, `store_count`, `colors`, `sizes`.
- `GET /discovery/stores` (public, published + ACTIVE stores only).
- Public offer summaries/detail gain `image_url` / `images` from existing `OfferVariantMedia`.

## D. Decisions to confirm

- PDR "Following" says inactive followed stores stay faded; this sprint's brief says never show unpublished/inactive
  stores in Following. Implemented per the brief: they are hidden from the strip and feed, the follow row is kept
  (so the follow reappears if the store returns).
- Featured products on a store page use newest-first (view tracking and the 40/30/30 ranking are still deferred, RB-COMP-002).
