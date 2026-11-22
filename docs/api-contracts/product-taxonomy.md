# Product taxonomy — API contract for the frontend (Sprint 27)

Base URL: `/api/v1`. Every example below was recorded from the real API on a
throwaway database (ids shortened). Errors always use the platform shape:

```json
{ "error": { "code": "SNAKE_CASE", "message": "…", "details": [], "correlation_id": "…" } }
```

**Status of each part**

| Part | Status |
|---|---|
| `GET /taxonomy` | ✅ built + tested |
| Classification, unified price, combinations (owner) | ✅ built + tested |
| Store products with filters + facets, product options (customer) | ✅ built + tested |
| `POST /vendors/:vendorId/offers` taking `audiences/categories/season` | ✅ built + tested — a new product is born classified |
| Combinations carrying identifier / SKU / barcode / condition / specs (matching) | ✅ built + tested |
| Discovery (`/discovery/all`) taxonomy filters | ✅ built + tested |

**Ground rules the UI must follow**

- Never hard-code a list: read audiences, categories, seasons, colours and
  sizes from `GET /taxonomy` and show `name_ar` / `label`.
- Always send **codes** (`JEANS`, `BLACK`, `AGE_2_3Y`), never Arabic text.
- A product's price is **one** price. Colour/size only ever change
  availability — never send a price per combination.
- Prices are strings with 2 decimals (`"119.00"`); stock is never exposed to
  customers, only `availability`: `available` | `low_stock` (1–3) | `sold_out`.

---

## 1. Taxonomy (public)

### `GET /taxonomy`

No auth. Cache it client-side for the session (`version` changes only with a
new migration).

```json
{
  "version": 1,
  "audiences": [
    { "code": "WOMEN", "name_ar": "نساء", "name_en": "Women" },
    { "code": "MEN", "name_ar": "رجال", "name_en": "Men" },
    { "code": "KIDS", "name_ar": "أطفال", "name_en": "Kids" }
  ],
  "seasons": [
    { "code": "SUMMER", "name_ar": "صيفي", "name_en": "Summer" },
    { "code": "WINTER", "name_ar": "شتاء", "name_en": "Winter" },
    { "code": "FALL", "name_ar": "خريفي", "name_en": "Fall" }
  ],
  "categories": [
    { "code": "DRESSES_WOMEN", "name_ar": "فساتين", "name_en": "Dresses", "audiences": ["WOMEN"] },
    { "code": "JEANS", "name_ar": "جينز", "name_en": "Jeans", "audiences": ["WOMEN", "MEN", "KIDS"] },
    { "code": "TOPS", "name_ar": "بلايز وتوبات", "name_en": "Tops & blouses", "audiences": ["WOMEN", "KIDS"] }
  ],
  "colors": [
    { "code": "WHITE", "name_ar": "أبيض", "name_en": "White", "hex": "#ffffff" },
    { "code": "MULTICOLOR", "name_ar": "ألوان متعددة", "name_en": "Multicolour", "hex": null }
  ],
  "sizes": [
    { "code": "ONE_SIZE", "label": "One Size", "group": "ADULT" },
    { "code": "M", "label": "M", "group": "ADULT" },
    { "code": "AGE_0_3M", "label": "0–3 أشهر", "group": "KIDS_AGE" }
  ]
}
```

(49 categories — 38 WOMEN / 30 MEN / 38 KIDS links —, 20 colours, 34 sizes:
16 `ADULT` + 18 `KIDS_AGE`.)

**UI rules from this data**

- Owner picks audiences → show the categories whose `audiences` contain **any**
  chosen audience (the union). A shared code such as `JEANS` appears **once**.
- Show `KIDS_AGE` sizes **only** when `KIDS` is among the chosen audiences
  (the API refuses them otherwise). KIDS products may also use `ADULT` sizes.
- `hex: null` (multicolour) → render a gradient/pattern swatch.

---

## 2. Owner: add / edit a product

All owner routes: `Authorization: Bearer <session>`, **OWNER of that store
only** (a branch employee gets `403 VENDOR_ROLE_FORBIDDEN`, another store
`403 NOT_VENDOR_MEMBER`, a suspended store `403 VENDOR_SUSPENDED` on writes,
another store's offer under your vendorId `404 OFFER_NOT_FOUND`).

### Flow

1. `POST /vendors/:vendorId/offers` with title, brand **and** `audiences`,
   `categories`, `season` — the product is classified from the start.
2. `POST …/combinations` with the price → the first combinations (with an
   identifier when the owner has one — that is what puts the product in
   discovery and comparison, see §4).
3. If a combination got `match_proposal_status: "PENDING"`, the owner
   confirms it with the existing
   `POST …/variants/:variantId/match-confirmation` (§4).
4. Publish with the existing `PATCH …/offers/:offerId/status` once it has a
   primary image and stock (a product that is not classified is refused
   with `409 OFFER_NOT_CLASSIFIED`).
5. `PUT …/classification` stays for **editing** the classification later
   (and for classifying an old product).

### `POST /vendors/:vendorId/offers` (existing endpoint, new fields)

Headers: `Authorization`, `Idempotency-Key` (as before). Request:
```json
{
  "title_ar": "جينز واسع", "title_en": "Wide jeans",
  "brand_id": "a0000000-0000-4000-8000-000000000001",
  "audiences": ["WOMEN", "MEN"], "categories": ["JEANS"], "season": null
}
```
`audiences` (1–3) and `categories` (≥ 1) are **required**; `season` optional.
The other fields (`brand_id`, `category_template`, `template_attributes`)
are unchanged.

Response `201` — the usual offer body plus the classification:
```json
{
  "id": "cde7862c-…", "vendor_id": "9775a00b-…", "canonical_product_id": null,
  "title_ar": "جينز واسع", "title_en": "Wide jeans", "status": "DRAFT",
  "brand_id": "a0000000-0000-4000-8000-000000000001",
  "category_template": null, "template_attributes": null, "archived_at": null,
  "audiences": ["WOMEN", "MEN"], "categories": ["JEANS"], "season": null
}
```

Errors (`400`, nothing is created):

| code | When |
|---|---|
| `AUDIENCE_REQUIRED` | `audiences` missing or empty |
| `CATEGORY_REQUIRED` | `categories` missing or empty |
| `UNKNOWN_CATEGORY` | `details` = the unknown codes |
| `CATEGORY_NOT_IN_AUDIENCE` | `details` = offending codes |
| `BAD_REQUEST` | an audience/season value that is not one of the codes |

```json
{ "error": { "code": "AUDIENCE_REQUIRED",
  "message": "Choose at least one of WOMEN, MEN or KIDS", "details": [], "correlation_id": "…" } }
```
```json
{ "error": { "code": "CATEGORY_NOT_IN_AUDIENCE",
  "message": "Category GIRLS_DRESSES does not belong to the chosen audience(s) MEN",
  "details": ["GIRLS_DRESSES"], "correlation_id": "…" } }
```

Products created by **CSV import** are the exception: they stay an
unclassified DRAFT (no taxonomy columns) and cannot be published until
classified on screen with `PUT …/classification`.

### `PUT /vendors/:vendorId/offers/:offerId/classification`

Request:
```json
{ "audiences": ["WOMEN", "MEN"], "categories": ["JEANS"], "season": null }
```
- `audiences`: 1–3 of `WOMEN|MEN|KIDS` (required, ≥ 1).
- `categories`: ≥ 1 code, each belonging to at least one chosen audience.
- `season`: `SUMMER|WINTER|FALL`, or `null`/omitted = not seasonal. One value only.

Response `200`:
```json
{
  "classified": true,
  "taxonomy_version": 1,
  "requires_taxonomy": true,
  "audiences": ["WOMEN", "MEN"],
  "categories": ["JEANS"],
  "season": null
}
```

Errors:

| Status | code | When |
|---|---|---|
| 400 | `BAD_REQUEST` | empty/unknown audience, empty categories, invalid season |
| 400 | `UNKNOWN_CATEGORY` | `details` = the unknown codes |
| 400 | `CATEGORY_NOT_IN_AUDIENCE` | e.g. `GIRLS_DRESSES` with only `WOMEN`; `details` = offending codes |
| 409 | `PRICES_NOT_UNIFIED` | an **old** product whose variants have different prices — set one price first (`PUT …/price`) |
| 409 | `KIDS_SIZES_IN_USE` | removing `KIDS` while a combination uses an age size |

Example (`CATEGORY_NOT_IN_AUDIENCE`):
```json
{ "error": { "code": "CATEGORY_NOT_IN_AUDIENCE",
  "message": "Category GIRLS_DRESSES does not belong to the chosen audience(s) WOMEN",
  "details": ["GIRLS_DRESSES"], "correlation_id": "…" } }
```

### `GET /vendors/:vendorId/offers/:offerId/classification`

Same body as the `PUT` response. `classified: false` + empty lists for an old
product → show the «غير مصنّف» badge.

---

## 3. Owner: the one price

### `PUT /vendors/:vendorId/offers/:offerId/price`

A **full replacement** of the product's price, applied to every combination
in one transaction (with price history and the usual price-drop alerts).

Request — one of:
```json
{ "base_price": 150 }
{ "base_price": 150, "sale_price": 119 }
{ "base_price": 150, "discount_percent": 20,
  "discount_start_at": "2026-11-01T00:00:00.000Z", "discount_end_at": "2026-11-10T00:00:00.000Z" }
```

Response `200`:
```json
{
  "base_price": "150.00", "sale_price": "119.00", "discount_percent": null,
  "discount_start_at": null, "discount_end_at": null, "variants_updated": 4
}
```

Errors: `400 INVALID_BASE_PRICE`, `INVALID_SALE_PRICE` (must be > 0 and <
base), `INCOMPLETE_DISCOUNT_WINDOW`, `DISCOUNT_PERCENT_OUT_OF_RANGE`,
`INVALID_DISCOUNT_WINDOW`, `DISCOUNT_RESULTS_IN_ZERO_PRICE`,
`SALE_AND_DISCOUNT_EXCLUSIVE`; `409 NO_VARIANTS_YET` (send the price with
the first combinations instead).

> **The old per-variant edit on a combination** (`PUT …/variants/:variantId`
> where the variant is `is_combination: true`), whatever the number of
> combinations:
>
> | Sent field | Answer |
> |---|---|
> | `base_price`, `sale_price`, `discount_percent`, `discount_start_at`, `discount_end_at` (even `null`) | `409 PRICE_IS_OFFER_LEVEL` — use this endpoint |
> | `colour`, `size` | `409 USE_COMBINATION_ENDPOINT` — a combination's options are fixed; add the new one with `POST …/combinations` (stop the old one by bringing its stock to 0) |
> | anything else (`specs_text_*`, `condition`, `identifier_*`, …) | `200`, as before |
>
> Nothing is written when it is refused. An old, unclassified product's
> variants (`is_combination: false`) keep the old edit unchanged.
>
> ```json
> { "error": { "code": "USE_COMBINATION_ENDPOINT",
>   "message": "A combination's colour/size cannot be edited - add the new combination through POST .../combinations",
>   "details": [], "correlation_id": "…" } }
> ```

---

## 4. Owner: combinations and stock

A combination = one colour/size option the store **actually has**. Never
send the full colours × sizes grid — only the rows the owner adds.

Supported shapes: colour only (`size_code` omitted), size only
(`color_code` omitted), colour + size, or no options (both omitted — at most
one such row per product).

### `POST /vendors/:vendorId/offers/:offerId/combinations`

First combinations — **with the price** (the product has none yet):
```json
{
  "items": [
    { "color_code": "BLACK", "size_code": "M",
      "stock": [ { "branch_id": "<branch A>", "quantity": 5 }, { "branch_id": "<branch B>", "quantity": 1 } ] },
    { "color_code": "BLACK", "size_code": "L", "stock": [ { "branch_id": "<branch A>", "quantity": 0 } ] },
    { "color_code": "BEIGE", "size_code": "M", "stock": [ { "branch_id": "<branch A>", "quantity": 2 } ] }
  ],
  "price": { "base_price": 150 }
}
```

Later additions — **without** `price` (the product price is reused):
```json
{ "items": [ { "color_code": "BEIGE", "size_code": "L", "stock": [ { "branch_id": "<branch A>", "quantity": 3 } ] } ] }
```

Each item may also carry the fields of the old "add variant" form — all
**optional**:

| Field | Meaning |
|---|---|
| `identifier_type` + `identifier_value` | `GTIN` / `UPC` / `EAN` / `MPN` / … and its value — **both or neither** |
| `seller_sku` | the store's own SKU; generated (`<offer>-<COLOR>-<SIZE>`) when absent |
| `store_inventory_barcode` | the product's own barcode; generated (`SIB-…`) when absent |
| `condition` | `NEW` (default) / `USED` / … (same values as before) |
| `specs_text_ar`, `specs_text_en` | free-text specs |

An identifier runs the **same exact-match** the old form used: if the
platform catalogue has a product with that identifier, the combination gets
`match_proposal_status: "PENDING"` and `proposed_canonical_variant_id`. It
is linked **only after the owner confirms** (next section) — only confirmed
combinations of published products appear in discovery and comparison.

Real request (first combinations, one with an identifier):
```json
{
  "items": [
    { "color_code": "BLACK", "size_code": "M",
      "identifier_type": "GTIN", "identifier_value": "6291041500213", "condition": "NEW",
      "seller_sku": "JEANS-BLK-M", "specs_text_ar": "قطن 100%", "specs_text_en": "100% cotton",
      "stock": [ { "branch_id": "<branch A>", "quantity": 5 }, { "branch_id": "<branch B>", "quantity": 1 } ] },
    { "color_code": "BLACK", "size_code": "L", "stock": [ { "branch_id": "<branch A>", "quantity": 0 } ] }
  ],
  "price": { "base_price": 150 }
}
```

Response `201`:
```json
{ "created": [
  { "variant_id": "4fcaa959-…", "color_code": "BLACK", "size_code": "M",
    "seller_sku": "JEANS-BLK-M", "store_inventory_barcode": "SIB-4FCAA959…",
    "proposed_canonical_variant_id": "a5b8cecf-…", "match_proposal_status": "PENDING" },
  { "variant_id": "fd830dca-…", "color_code": "BLACK", "size_code": "L",
    "seller_sku": "cde7862c-BLACK-L", "store_inventory_barcode": "SIB-FD830DCA…",
    "proposed_canonical_variant_id": null, "match_proposal_status": "NONE" }
] }
```

- `stock`: one entry per branch, quantity ≥ 0. A single-branch store sends
  one entry. Opening stock is recorded as an `INITIAL_STOCK` movement.
- The product must be classified first.
- `match_proposal_status: "PENDING"` → show «يوجد منتج مطابق في الكتالوج —
  تأكيد؟» with confirm / reject.

### Confirming a match (existing endpoint, unchanged)

`POST /vendors/:vendorId/offers/:offerId/variants/:variantId/match-confirmation`
(`Idempotency-Key` header) with `{ "decision": "confirm" }` or
`{ "decision": "reject" }`. Response `200` = the variant, now:
```json
{ "id": "4fcaa959-…", "canonical_variant_id": "a5b8cecf-…",
  "match_proposal_status": "CONFIRMED", "colour": "أسود", "size": "M",
  "identifier_type": "GTIN", "identifier_value": "6291041500213", "effective_price": 150, "…": "…" }
```
Note: as before, confirming links the **product** to the catalogue entry,
and the product's title then shows the catalogue name (here «جينز ليفايس
501 واسع»).

Errors:

| Status | code | When |
|---|---|---|
| 400 | `UNKNOWN_COLOR` / `UNKNOWN_SIZE` | code not in `GET /taxonomy` |
| 400 | `AGE_SIZE_REQUIRES_KIDS` | an age size on a product without `KIDS` |
| 404 | `BRANCH_NOT_FOUND` | a branch of another store, or archived |
| 409 | `OFFER_NOT_CLASSIFIED` | classify first |
| 409 | `PRICE_REQUIRED` | first combinations sent without `price` |
| 409 | `PRICE_IS_OFFER_LEVEL` | `price` sent when the product already has one |
| 400 | `INCOMPLETE_IDENTIFIER_PAIR` | `identifier_type` without `identifier_value`, or the reverse |
| 409 | `DUPLICATE_COMBINATION` | the same colour/size twice in one request |
| 409 | `COMBINATION_EXISTS` | it already exists (even at quantity 0) — refill it instead |
| 409 | `SELLER_SKU_ALREADY_EXISTS` | this store already uses that `seller_sku` |
| 409 | `STORE_INVENTORY_BARCODE_ALREADY_EXISTS` | this store already uses that barcode |

A failed request creates **nothing** (all items or none).

Example (`AGE_SIZE_REQUIRES_KIDS`):
```json
{ "error": { "code": "AGE_SIZE_REQUIRES_KIDS",
  "message": "Age size AGE_2_3Y is only allowed on a product whose audiences include KIDS",
  "details": ["AGE_2_3Y"], "correlation_id": "…" } }
```

### `GET /vendors/:vendorId/offers/:offerId/combinations`

Everything, **including sold-out** rows (so the owner can refill them):
```json
{
  "classified": true,
  "items": [
    {
      "variant_id": "4fcaa959-…", "is_combination": true,
      "color_code": "BLACK", "size_code": "M", "colour": "أسود", "size": "M",
      "seller_sku": "JEANS-BLK-M", "store_inventory_barcode": "SIB-4FCAA959…",
      "identifier_type": "GTIN", "identifier_value": "6291041500213", "condition": "NEW",
      "match_proposal_status": "PENDING", "proposed_canonical_variant_id": "a5b8cecf-…",
      "canonical_variant_id": null,
      "base_price": "150.00", "sale_price": null,
      "total_quantity": 6, "status": "available", "availability": "available",
      "stock": [ { "branch_id": "<branch A>", "quantity": 5, "reserved": 0 },
                 { "branch_id": "<branch B>", "quantity": 1, "reserved": 0 } ]
    },
    {
      "variant_id": "fd830dca-…", "is_combination": true,
      "color_code": "BLACK", "size_code": "L", "colour": "أسود", "size": "L",
      "seller_sku": "cde7862c-BLACK-L", "store_inventory_barcode": "SIB-FD830DCA…",
      "identifier_type": null, "identifier_value": null, "condition": "NEW",
      "match_proposal_status": "NONE", "proposed_canonical_variant_id": null,
      "canonical_variant_id": null,
      "base_price": "150.00", "sale_price": null,
      "total_quantity": 0, "status": "sold_out", "availability": "sold_out", "stock": []
    }
  ]
}
```
- `status: "sold_out"` → show «نفد/موقوف» and a refill action.
- `is_combination: false` rows are an old product's variants (no codes).

### Changing stock (existing endpoint, unchanged)

`POST /vendors/:vendorId/branches/:branchId/stock/:variantId/movements`
```json
{ "quantity_delta": 4, "reason": "COUNT_CORRECTION", "reason_note": "إعادة تعبئة" }
```
- Refill / correction up: `COUNT_CORRECTION` with a positive delta
  (note: this reason notifies the owner, per PDR-021).
- Decrease: `DAMAGE` / `LOSS` / `SALE` / `COUNT_CORRECTION` with a negative delta.
- "Stopping" a combination = bring it to 0; it disappears for customers.

---

## 5. Customer: store page with filters

### `GET /storefronts/:slug/products`

No auth. The store's published products, filtered. **Store Sections are
unchanged** (`GET /storefronts/:slug/sections` still serves the chips) and
combine here through `section`.

Query parameters (all optional; lists are comma-separated):

| Param | Values | Meaning |
|---|---|---|
| `section` | `all` (default) · `new` · `sale` · `<custom section id>` | same groups as the chips |
| `audience` | `WOMEN,MEN,KIDS` | any of |
| `category` | category codes | any of |
| `season` | `SUMMER,WINTER,FALL` | any of |
| `color` | colour codes | any of, **in stock** |
| `size` | size codes | any of, **in stock** |
| `min_price`, `max_price` | numbers | on the price the card shows |
| `sort` | `newest` (default) · `price_asc` · `price_desc` | |
| `page`, `page_size` | default 1 / 60 (max 200) | |

Semantics:
- values inside one filter = OR; different filters = AND;
- `color` + `size` must be **one in-stock combination** (black **in** M);
- any taxonomy filter hides unclassified old products (shown with no filter);
- a Unisex product appears under each of its audiences.

Example `GET /storefronts/demo-shop/products?audience=MEN&color=BLACK`:
```json
{
  "is_available": true, "section": "all", "total": 1, "page": 1, "page_size": 60,
  "items": [
    {
      "id": "7e5b68d6-…", "title_ar": "جينز واسع", "title_en": "Wide jeans",
      "min_price": "119.00", "original_price": "150.00", "discount_percent": 21,
      "availability": "available", "image_url": null, "created_at": "2026-10-21T15:34:12.863Z",
      "favorite_variant_id": null,
      "classified": true, "audiences": ["WOMEN", "MEN"], "categories": ["JEANS"], "season": null,
      "colors": ["BLACK", "BEIGE"], "sizes": ["M", "L"]
    }
  ],
  "facets": {
    "audiences": [ { "code": "WOMEN", "count": 1 }, { "code": "MEN", "count": 1 } ],
    "categories": [ { "code": "JEANS", "count": 1 } ],
    "seasons": [],
    "colors": [ { "code": "BLACK", "count": 1 }, { "code": "BEIGE", "count": 1 } ],
    "sizes": [ { "code": "M", "count": 1 } ],
    "price": { "min": "119.00", "max": "119.00" }
  }
}
```

- `items[].colors` / `sizes`: what is **in stock** for that card.
- `facets`: only values that would return something. Each facet ignores its
  own selection (after picking BLACK, the colour facet still lists the other
  colours you can add), so render the counts next to each option.
- Under a chosen audience, `facets.categories` only lists that audience's
  categories.
- `favorite_variant_id: null` → hide the heart for that card.
- An unpublished/suspended store answers `200` with `is_available: false`,
  `total: 0` (never a 404).

Errors `400`: `UNKNOWN_AUDIENCE`, `UNKNOWN_CATEGORY`, `UNKNOWN_SEASON`,
`UNKNOWN_COLOR`, `UNKNOWN_SIZE`, `INVALID_PRICE_FILTER` (negative, or min >
max), `UNKNOWN_SECTION`, `INVALID_SORT`. `404 STOREFRONT_NOT_FOUND`.

---

## 6. Customer: product page — choosing colour/size

### `GET /storefronts/:slug/offers/:offerId/options`

Only **in-stock** combinations; the price is the same whatever is picked.
```json
{
  "offer_id": "7e5b68d6-…", "classified": true,
  "audiences": ["WOMEN", "MEN"], "categories": ["JEANS"], "season": null,
  "price": { "min_price": "119.00", "original_price": "150.00", "discount_percent": 21 },
  "colors": [ { "code": "BLACK", "name_ar": "أسود", "hex": "#111111" },
              { "code": "BEIGE", "name_ar": "بيج", "hex": "#d9c7a7" } ],
  "sizes": [ { "code": "M", "label": "M", "group": "ADULT" },
             { "code": "L", "label": "L", "group": "ADULT" } ],
  "combinations": [
    { "variant_id": "c340443c-…", "color_code": "BLACK", "size_code": "M", "availability": "available" },
    { "variant_id": "2684b1dd-…", "color_code": "BEIGE", "size_code": "M", "availability": "low_stock" },
    { "variant_id": "7bf18b86-…", "color_code": "BEIGE", "size_code": "L", "availability": "low_stock" }
  ]
}
```

How to use it:
- After a colour is picked, enable only sizes with a row
  `{color_code: picked}` in `combinations` — and the reverse. (Here BLACK
  disables L; BLACK/L is sold out so it is not listed at all.)
- A colour whose every size is sold out is simply absent.
- The chosen combination's `variant_id` is what goes to the cart (the
  existing cart API, unchanged).
- Never change the displayed price on selection.
- `classified: false` (old product) → `combinations: []`; keep using the
  existing `GET /storefronts/:slug/offers/:offerId` variants for it.
- `404 OFFER_NOT_FOUND` for a product that is not ACTIVE in this store.

---

## 7. Customer: discovery (all stores) with filters

### `GET /discovery/all` (existing endpoint, new filters)

No auth. The cards are **catalogue products**; a product is listed when at
least one **confirmed**, published offer exists for it. The existing params
(`page`, `page_size`, `segment`, `q`) are unchanged; new, all optional,
comma-separated like the store page:

| Param | Meaning |
|---|---|
| `audience` | `WOMEN,MEN,KIDS` — any of |
| `category` | category codes — any of |
| `season` | `SUMMER,WINTER,FALL` — any of |
| `color` | colour codes — any of, **in stock** |
| `size` | size codes — any of, **in stock** |

Semantics:
- values inside one filter = OR; different filters = AND;
- all filters must hold for **one and the same** store offer: a store
  selling it for MEN in black and another for WOMEN in white does **not**
  make `audience=MEN&color=WHITE` match;
- `color` + `size` = one combination of that offer that is in stock now;
- any taxonomy filter skips old unclassified offers (they still appear with
  no filter).

Real example `GET /discovery/all?audience=MEN&category=JEANS&color=BLACK&size=M`:
```json
{
  "page": 1, "page_size": 20, "total": 1,
  "items": [
    {
      "canonical_product_id": "03af2ac1-…",
      "canonical_name_ar": "جينز ليفايس 501 واسع", "canonical_name_en": "Levis 501 Wide",
      "lowest_price": "150.00", "lowest_price_availability": "available",
      "image_url": "https://example.com/jeans.jpg",
      "brand_name": "Levis", "category_name": "جينز", "store_count": 1,
      "colors": [], "sizes": [],
      "cheapest_offer": { "vendor_id": "9775a00b-…", "vendor_slug": "demo-shop-2",
                          "offer_id": "cde7862c-…", "offer_variant_id": "4fcaa959-…" },
      "store_logos": [ { "vendor_id": "9775a00b-…", "vendor_slug": "demo-shop-2",
                         "display_name": "متجر تجريبي", "logo_url": null,
                         "offer_id": "cde7862c-…", "offer_variant_id": "4fcaa959-…", "price": "150.00" } ]
    }
  ]
}
```
`?audience=MEN&color=BLACK&size=L` on the same data (BLACK/L is sold out) →
`{ "page": 1, "page_size": 20, "total": 0, "items": [] }`.

Errors `400`: `UNKNOWN_AUDIENCE`, `UNKNOWN_CATEGORY`, `UNKNOWN_SEASON`,
`UNKNOWN_COLOR`, `UNKNOWN_SIZE` (plus the existing `INVALID_SEGMENT`):
```json
{ "error": { "code": "UNKNOWN_COLOR", "message": "Unknown colour: PURPLE",
  "details": ["PURPLE"], "correlation_id": "…" } }
```

### Browse mode — the `/women`, `/men`, `/kids` listings

Adding any of `sort`, `filter`, `min_price`, `max_price`, `available_only`,
`cursor`, `facets` switches the same endpoint to cursor pages (the call
above, without them, is unchanged). The listings send
`audience=WOMEN|MEN|KIDS` — the **product's** audience. `segment` keeps its
old meaning (the store declared that segment) everywhere.

| Param | Values | Meaning |
|---|---|---|
| `sort` | `newest` (default) · `price-asc` · `price-desc` · `discounts` | newest = when a store added the product |
| `min_price`, `max_price` | numbers ≥ 0 | on the price the card shows (`lowest_price`) |
| `available_only` | `true` / `false` | live stock (branch stock minus live checkout holds) |
| `filter` | `trend` · `discounts` | the listing tabs |
| `facets` | `categories` | adds `category_counts` + `all_count` |
| `cursor` | from `next_cursor` | the next page; only valid for the same filters |
| `page_size` | 1–50 (default 20) | |

Response:
```json
{ "page_size": 20, "total": 15, "items": [ /* comparison cards */ ],
  "next_cursor": null,
  "category_counts": { "DRESSES_WOMEN": 11, "JEANS": 4, "SKIRTS": 0 },
  "all_count": 89 }
```
- `category_counts`: products per **taxonomy category of the chosen
  audience** under every other filter (colour, size, season, price,
  availability, tab) — never under the category filter itself, so the
  circles show what each category would give. `all_count` = same set, all
  categories.
- Errors `400`: `INVALID_SORT`, `INVALID_FILTER`, `INVALID_FACETS`,
  `INVALID_PRICE_FILTER` (negative, or min > max), `INVALID_AVAILABLE_ONLY`,
  `INVALID_CURSOR`, plus the `UNKNOWN_*` codes above.

Seasons are now `SUMMER`, `WINTER`, `FALL`, `SPRING` and colours include
`GRAY` (`#808080`); every `GET /taxonomy` list carries `sort_order`.

### Comparison (existing endpoint, unchanged)

`GET /canonical-products/:id/comparison` lists every confirmed offer; a
combination appears like any other offer (real excerpt):
```json
{ "offers": [ {
  "vendor_id": "9775a00b-…", "vendor_slug": "demo-shop-2", "display_name": "متجر تجريبي",
  "offer_id": "cde7862c-…", "offer_variant_id": "4fcaa959-…",
  "currency": "ILS", "price": "150.00", "availability": "available", "condition": "NEW",
  "is_cheapest": true, "…": "…" } ] }
```

## Known limits

- Discovery cards keep their **catalogue** fields: `colors` / `sizes` on a
  card come from the catalogue product's attributes (often empty), not from
  the stores' combinations. Use the filters to narrow; use the store page /
  options endpoint to show a store's actual colours and sizes.
- A product without any identifier is never matched, so it appears on its
  store page but not in discovery/comparison (unchanged rule).
- Images stay per variant; shared per-colour images are a later improvement.
