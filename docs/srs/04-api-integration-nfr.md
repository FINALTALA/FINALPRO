# SRS — Part 4: API & Integration Requirements (Section H) & Non-Functional Requirements (Section I)

Builds on [Part 2](02-functional-requirements.md) (FR-*) and [Part 3](03-business-rules-data-model.md) (BR-*, entities). Per the master prompt, this is a **coherent API contract and endpoint inventory**, not exhaustive documentation of every endpoint — the inventory (H.2) lists the surface area per domain; a handful of **representative endpoints** (H.3) get the full method/purpose/actor/request/response/validation/authorization/errors/idempotency/pagination treatment as the pattern the rest follow.

---

## H.1 Cross-cutting API conventions

| Concern | Rule |
|---|---|
| **Versioning** | URI-prefixed: `/api/v1/...`. Additive/backward-compatible changes ship within a version; breaking changes require a new major version, with the previous version kept live for a defined deprecation window. |
| **Error format** | Every error response is `{ "error": { "code": "SNAKE_CASE_CODE", "message": "localized per Accept-Language", "details": [...], "correlation_id": "..." } }`. HTTP status follows convention: `400` validation, `401` unauthenticated, `403` authorization/RBAC, `404` not found, `409` conflict (incl. idempotency-key reuse with a different payload), `422` business-rule violation (e.g., a BR-0xx check failing), `429` rate-limited, `500` server error. |
| **Idempotency keys** | Every mutating endpoint that creates a financial or order-affecting resource (`POST /checkout`, payment capture, import commit) requires a client-supplied `Idempotency-Key` header; the server stores the key with its original response for a configurable window and replays that response on a retry instead of reprocessing (FR-CART-008). |
| **Correlation IDs** | Every request carries (or is assigned) an `X-Correlation-Id`, propagated through downstream calls, webhooks, and log/audit entries — every `AuditLog` row (Part 3, G.3) and every error response includes it. |
| **Rate limiting** | Per-actor (user, vendor, API credential) token-bucket limiting; auth/OTP endpoints (FR-AUTH-011) and search get materially stricter limits than read-only catalog browsing. `429` responses include `Retry-After`. |
| **Webhook authentication (outbound)** | Platform-originated webhooks (to a vendor's system, FR-IMPORT-006/FR-VPORTAL-008) are HMAC-SHA256-signed with a per-integration secret and a timestamp; receivers must verify the signature and reject requests outside a replay-protection window. |
| **Webhook authentication (inbound)** | Payment-gateway and future delivery-provider webhooks are verified against that provider's own signing scheme. ⚠ **OPEN-001** (gateway) and Phase-2 courier selection are prerequisites — this row cannot be finalized until then. |
| **Retry policy** | Async delivery (outbound webhooks, notification dispatch per FR-NOTIF-004) uses exponential backoff with jitter, a configurable max-attempt count, and a dead-letter queue visible in the admin portal (FR-ADMIN-001) once exhausted. |
| **Integration monitoring** | Every external integration (payment gateway, SMS/OTP provider, future courier) has a status entry in the admin portal tracking success rate, latency, and last failure, feeding FR-ANALYTICS. |
| **Pagination** | All list endpoints use cursor-based pagination (`?cursor=...&limit=...`), default `limit` 20, max 100 — offset pagination is avoided given the catalog/order tables are append-heavy and can grow past the point where offset pagination stays performant. |

---

## H.2 Endpoint inventory by domain

Representative surface area per domain (`✓` = idempotent by design or via the idempotency-key convention; `↕` = paginated).

| Domain | Endpoints |
|---|---|
| **Authentication** | `POST /auth/otp/request` · `POST /auth/otp/verify` ✓ · `POST /auth/register` · `POST /auth/login` · `POST /auth/password/reset-request` · `POST /auth/password/reset-confirm` |
| **Customers** | `GET /customers/me` · `PATCH /customers/me` · `GET/POST /customers/me/addresses` ↕ · `PATCH/DELETE /customers/me/addresses/{id}` · `DELETE /customers/me` (FR-AUTH-010) |
| **Vendors** | `POST /vendors` (FR-VEND-001) · `GET /vendors/{id}` · `PATCH /vendors/{id}` · `POST /vendors/{id}/verification-evidence` (FR-VEND-002) · `POST /vendors/{id}/staff` · `GET /vendors/{id}/performance` |
| **Branches** | `POST/GET/PATCH /vendors/{vendorId}/branches` ↕ · `POST /branches/{id}/delivery-zones` |
| **Catalog** | `GET /categories` / `/brands` / `/attributes` ↕ (public) · `POST/PATCH /categories` / `/brands` (admin) · `GET /canonical-products/{id}` · `POST /canonical-products/{id}/merge` / `/split` (FR-MATCH-006) · `GET /product-matches` ↕ (review queue) · `POST /product-matches/{id}/decision` (full detail in H.3) |
| **Search** | `GET /search` ↕ · `GET /search/autocomplete` |
| **Comparison** | `POST /comparisons` · `GET /comparisons/{id}` · `GET /comparisons/{id}/share-link` |
| **Offers** | `POST/GET/PATCH /vendors/{vendorId}/offers` ↕ · `POST /offers/{id}/variants` · `PATCH /offer-variants/{id}` |
| **Inventory** | `GET/PATCH /offer-variants/{id}/inventory` · `POST /vendors/{vendorId}/inventory/reconciliation-report` |
| **Pricing** | `PATCH /offer-variants/{id}/price` · `GET /offer-variants/{id}/price-history` ↕ |
| **Cart** | `GET /cart` · `POST /cart/items` · `PATCH/DELETE /cart/items/{id}` |
| **Checkout** | `POST /checkout` ✓ (full detail in H.3) |
| **Orders** | `GET /orders` ↕ / `GET /orders/{id}` · `GET /vendors/{vendorId}/suborders` ↕ · `PATCH /suborders/{id}/status` (full detail in H.3) |
| **Payments** | `GET /orders/{id}/payment` · `POST /payments/{id}/capture` (internal) · `POST /webhooks/payment-gateway` (full detail in H.3) |
| **Delivery** | `PATCH /fulfillments/{id}/status` · `POST /deliveries/{id}/proof-of-delivery` |
| **Returns** | `POST /order-items/{id}/return-requests` (full detail in H.3) · `PATCH /return-requests/{id}` |
| **Reviews** | `POST /reviews` · `PATCH/DELETE /reviews/{id}` · `GET /offer-variants/{id}/reviews` ↕ |
| **Favorites & alerts** | `POST/GET/DELETE /customers/me/favorites` ↕ (FR-FAV-001) · `POST/GET /customers/me/saved-comparisons` ↕ (FR-FAV-002) · `PATCH /customers/me/alert-preferences` (FR-FAV-005) |
| **CMS & marketing** | `GET /content/home-sections` (public) · `POST/PATCH /admin/content/banners` ↕ · `POST/PATCH /admin/content/campaign-pages` ↕ (FR-CMS-001/002, draft/preview/scheduled-publish) |
| **Notifications** | `GET /vendors/{vendorId}/notifications` ↕ (FR-VPORTAL-011; dispatch itself is an internal service, not a public endpoint) |
| **Support** | `POST/GET /support-tickets` ↕ · `POST /support-tickets/{id}/messages` |
| **Administration** | `GET/PATCH /admin/{resource}` (role-gated, per FR-ADMIN-001's entity list) · `GET /admin/audit-logs` ↕ |
| **Imports** | `POST /vendors/{vendorId}/imports` (full detail in H.3) · `GET /imports/{id}` · `GET /imports/{id}/rows?status=failed` ↕ |
| **Webhooks** | `POST /webhooks/payment-gateway` (inbound, ⚠ OPEN-001) · `POST /webhooks/delivery-provider` (inbound, Phase 2, FR-FUL-014) · `GET/POST /vendors/{vendorId}/webhook-subscriptions` (outbound registration, FR-IMPORT-006) |

---

## H.3 Representative endpoints, fully specified

### H.3a September 2026 API amendment

The endpoint inventory and representative contracts above predate the approved ILS-only, BranchOrder and workspace model. The following target surface is binding; old `/suborders` and FX/currency routes must be deprecated rather than extended for new work.

| Domain | Required target endpoints / contract boundaries |
|---|---|
| Public discovery | `GET /discover/{all|women|men|kids|accessories}` · `GET /stores/{slug}` · `GET /products/{canonicalId}` · `GET /stores/{slug}/offers/{offerId}` · `GET /products/{canonicalId}/compare`. Public card endpoints return only public availability state, lowest eligible ILS price and no exact stock. |
| Storefront and following | `PATCH /vendors/{id}/storefront` · `POST/PATCH/DELETE /vendors/{id}/sections` · `POST/DELETE /stores/{id}/follow` · `GET /following`. Section deletion must not delete offers. |
| Roles and locations | `POST /vendors/{id}/employees` (phone + OTP invite) · `PATCH /vendor-employees/{id}` (assign/transfer/disable) · `POST/PATCH /vendors/{id}/warehouses` · `POST/PATCH /vendors/{id}/pickup-points`. All employee operations enforce one active assigned branch; public pickup-point response never reveals warehouse data. |
| Inventory | `POST /branch-inventory/sales` · `POST /branch-inventory/adjustments` · `POST /inventory/imports`. Sale/adjustment requests include barcode, selected variant and quantity; manual adjustment requires reason. No transfer endpoint exists. |
| Checkout | `POST /checkout/quote` calculates selected cart-line BranchOrder groups, eligible locations, ILS fees/total and slots without mutation. `POST /checkout` receives selected lines plus a per-BranchOrder fulfilment/payment decision and creates the parent order/BranchOrders atomically. |
| Branch orders | `GET /orders` · `GET /orders/{id}` · `GET /branches/{id}/orders?view=today|all` · `PATCH /branch-orders/{id}/actions`. Allowed actions include start preparation, revert with reason, sent, delivered, pickup handover, item cancellation, delivery retry and refund approval as permitted by the BranchOrder state. |
| Calendar/addresses | `GET /branches/{id}/delivery-slots` · `POST/PATCH/DELETE /branches/{id}/delivery-slots` · `POST /branch-orders/{id}/reschedule` · `PATCH /orders/{id}/address` (only before preparation). Slot mutation must identify affected orders; address response provides cancel/pickup/supported-address choices where required. |
| Returns/reviews/alerts | `POST /order-items/{id}/returns` · `PATCH /returns/{id}/decision` · `POST /reviews` (no customer edit/delete endpoint) · `GET/PATCH /notifications` (read state/deep link). |

All mutating endpoints in this amendment require the existing correlation/audit convention, and order/payment/inventory mutations require `Idempotency-Key`. Requests must use ILS values only. A client must never be able to choose another vendor, owner workspace, employee branch, hidden warehouse, or unavailable branch by submitting an identifier.

### `POST /auth/otp/verify`
- **Purpose / Actor:** Complete phone verification (FR-AUTH-003); Guest (pre-account) or Customer.
- **Request:** `{ phone, otp_code, purpose: "signup" | "password_reset" | "phone_change" }`, with a required `Idempotency-Key` header.
- **Response:** `{ session_token, phone_verified_at }`
- **Validation:** OTP must match, be unexpired, and not yet consumed. Consumption happens exactly once, on first successful verification — there is no "OTP stays valid for repeat checks" behavior. Safe retry is handled the same way as every other mutating endpoint (H.1): the server stores the verification outcome against the request's `Idempotency-Key` for a short window (e.g., 5 minutes) and replays that stored outcome — including a still-valid `session_token` — if the identical request is retried within it, without touching the (already-consumed) OTP a second time. A retry using a *different* key against an already-consumed OTP fails with `OTP_INVALID`, since that's a distinct, not a replayed, request. Rate-limited attempts per phone (FR-AUTH-011).
- **Authorization:** None required to call; the resulting session is scoped to the verified phone only.
- **Errors:** `400 OTP_INVALID`, `409 OTP_EXPIRED`, `429 TOO_MANY_ATTEMPTS`.
- **Idempotency:** `Idempotency-Key` **required**, per the mechanism described above — this is the one safe retry path; the OTP itself is single-use.
- **Pagination:** N/A. — ⚠ **OPEN-004** governs the OTP provider this endpoint ultimately calls.

### `POST /checkout`
- **Purpose / Actor:** Materialize a multi-vendor cart into one `CustomerOrder` + per-vendor `VendorSuborder`s (FR-CART-011, BR-009/010); Customer.
- **Request:** `{ cart_id, delivery_address_id, phone_1, phone_2, terms_accepted: true, per_vendor: [{ vendor_id, fulfillment_method, scheduled_window?, delivery_note?, branch_id (if pickup) }], payment_method: "cod" | "online" }`
- **Response:** `{ customer_order_id, suborders: [{ vendor_suborder_id, vendor_id, status }], payment: { payment_id, status } }`
- **Validation:** Revalidates price/inventory per line (FR-CART-002); per-vendor minimum order (FR-CART-003); delivery-zone eligibility per vendor partition unless pickup (FR-CART-004); terms acceptance (FR-CART-012); incompatible-fulfillment conflicts surfaced per partition, not merged away (FR-CART-015).
- **Authorization:** Authenticated, phone-verified Customer session only (FR-AUTH-004, BR-024 — no guest checkout).
- **Errors:** `409 PRICE_OR_STOCK_CHANGED` (FR-INV-004), `422 MINIMUM_ORDER_NOT_MET`, `422 DELIVERY_ZONE_INELIGIBLE`, `402 PAYMENT_FAILED` (online only).
- **Idempotency:** `Idempotency-Key` **required** — a retried submission with the same key returns the original order rather than creating a duplicate (FR-CART-008); on failure, the cart is preserved unchanged for resubmission (FR-CART-016).
- **Pagination:** N/A.

### `PATCH /suborders/{id}/status`
- **Purpose / Actor:** Drive the `VendorSuborder` state machine (Part 2, E.11 / Part 3 BR tables); Vendor order-processing employee (or owner/admin, per action).
- **Request:** `{ action: "confirm" | "reject" | "start_preparing" | "dispatch" | "mark_ready_for_pickup", reason? }`
- **Response:** `{ vendor_suborder_id, status, updated_at }`
- **Validation:** Action must be a legal transition from the suborder's current state (Part 2's explicit valid/invalid transition tables); `reject` requires a reason.
- **Authorization:** Role-scoped per Part 1, Section C (e.g., dispatch-time cancellation requires vendor owner/admin, not a line employee — FR-ORD-007).
- **Errors:** `409 INVALID_STATE_TRANSITION`, `403 ROLE_NOT_PERMITTED`.
- **Idempotency:** Naturally idempotent for same-state re-application (repeating `confirm` on an already-Confirmed suborder is a no-op success, not an error); a true duplicate submission just returns the current state.
- **Pagination:** N/A.

### `POST /webhooks/payment-gateway` (inbound)
- **Purpose / Actor:** Receive authorize/capture/refund/chargeback events from the payment gateway; External actor (payment gateway).
- **Request:** Gateway-defined payload (shape depends on the provider selected — ⚠ **OPEN-001**).
- **Processing (transactional, per event):**
  1. Verify the signature (H.1). A failed signature is rejected outright — never landed.
  2. Insert a `WebhookInbox` row keyed on `(provider, event_id)` (Part 3, G.3) with the raw payload and `Received` state. The unique constraint is what makes a duplicate delivery safe: if the insert hits the constraint, the event was already received — skip straight to acknowledgment (see Response below) without reprocessing. **If this insert itself fails (database unavailable, timeout, etc.), the event has not been durably received — see Errors below; nothing is acknowledged.**
  3. In one database transaction: create/update the `PaymentTransaction`, create the matching `PaymentTransactionAllocation` row(s), update the affected `PaymentAllocation`(s)' status, write the corresponding `AuditLog` entries, and mark the `WebhookInbox` row `Processed`.
  4. If the event's `gateway_ref` doesn't match any known `PaymentTransaction`/`PaymentAllocation` (unknown reference), or arrives referencing a state its predecessor event hasn't reached yet (out-of-order delivery), the `WebhookInbox` row is marked `Reconciling` instead of `Failed` — a background reconciliation job retries it on a schedule as related state catches up, rather than the event being dropped or bounced back to the gateway.
- **Response:** `200 OK` (empty body) once the event is **durably recorded** — i.e., step 2 (or the duplicate-detection it triggers) has committed. This covers a duplicate delivery and an event left `Reconciling` (steps 2/4) just as much as a fully `Processed` one, since in all three cases the event itself is safely captured and will not be lost or need re-sending. It does **not** cover a failure to even complete step 2: if the `WebhookInbox` insert itself fails (database unavailable, timeout), nothing has been durably received, and returning `200` there would acknowledge — and thereby lose — a real event. Gateways commonly retry non-2xx responses indefinitely, which is exactly the desired behavior in that specific case.
- **Validation:** Signature verification before any processing (see step 1); everything else, once durably received, is handled as a processing-state outcome, not a rejection, per the point above.
- **Authorization:** Signature-based, not session-based — this endpoint is unauthenticated in the user sense but must reject any request that fails signature verification.
- **Errors:** `401 SIGNATURE_INVALID` for a failed signature; `5xx` if the event cannot be durably written to `WebhookInbox` (so the gateway retries a genuinely lost event, per the Response note above) — these are the only two cases this endpoint returns a non-2xx status for. Everything past durable receipt (duplicate, unknown reference, out-of-order) is a `200` with internal-only state tracking.
- **Idempotency:** Enforced by the `WebhookInbox(provider, event_id)` uniqueness constraint (Part 3, G.3) once a row is durably written, not by rejecting the retry — this is what closes FR-PAY-009's "succeeds but order creation fails" scenario (and its reverse) without ever telling the gateway to keep retrying something already safely captured — while still letting it retry something that genuinely wasn't.
- **Pagination:** N/A. Full request/response contract is finalized once ⚠ OPEN-001 resolves.

### `POST /vendors/{vendorId}/imports`
- **Purpose / Actor:** Submit a bulk CSV/Excel offer import (FR-IMPORT-002); Vendor catalog employee.
- **Request:** `multipart/form-data` file + `{ field_mapping: {...} }` (FR-IMPORT-011); or `{ retry_of_import_job_id }` to re-attempt only previously failed rows (FR-IMPORT-012). Every submission — **initial or retry** — requires an `Idempotency-Key` header (H.1); the server additionally computes a content hash of the uploaded file and treats a resubmission with a new key but an identical file content hash within a short window as the same duplicate-submission case, so an accidental double-click doesn't require the client to have preserved the original key.
- **Response:** `{ import_job_id, status: "processing" }` (async — result fetched via `GET /imports/{id}`)
- **Validation:** File format/size limits; per-row schema validation against the category's attribute template (FR-CAT-003); partial success allowed (FR-IMPORT-003).
- **Authorization:** Vendor catalog employee or higher, scoped to `vendorId` only.
- **Errors:** `400 UNSUPPORTED_FILE_TYPE`, `413 FILE_TOO_LARGE`.
- **Idempotency:** A duplicate **initial** submission (same `Idempotency-Key`, or the file-content-hash match above) returns the existing `import_job_id` rather than starting a second job; a `retry_of_import_job_id` submission is idempotent per failed row (FR-IMPORT-012) — already-committed rows from the original job are never reprocessed.
- **Pagination:** N/A for submission; `GET /imports/{id}/rows` is paginated and filterable by `status`.

### `POST /order-items/{id}/return-requests`
- **Purpose / Actor:** Start the Return state machine (Part 2, E.11/E.14) for one item; Customer.
- **Request:** `{ reason_code, note?, evidence_urls?: [] }`
- **Response:** `{ return_request_id, status: "Requested" }`
- **Validation:** The `OrderItem`'s own `Fulfillment` must be Delivered/PickedUp (BR-025 — not the whole suborder); within the category's return window (FR-RET-001).
- **Authorization:** Customer must own the parent `CustomerOrder`.
- **Errors:** `422 RETURN_WINDOW_CLOSED`, `422 ITEM_NOT_YET_DELIVERED`, `409 RETURN_ALREADY_OPEN`.
- **Idempotency:** A duplicate submission for the same item while a request is already open returns `409` rather than opening a second one.
- **Pagination:** N/A.

### `POST /product-matches/{id}/decision`
- **Purpose / Actor:** Resolve one queued `ProductMatch` (Part 3, G.3) — approve, reject, or reassign a vendor offer's proposed link to a `CanonicalProductVariant` (FR-MATCH-002/003). Product-matching reviewer, or platform admin. This is a higher-risk endpoint than most in this inventory: it directly controls whether `VendorOffer.canonical_product_id` and its variants' `canonical_variant_id` stay consistent (Part 3's post-review invariant), and every decision feeds the comparison model's correctness (BR-001/BR-007).
- **Request:** `{ decision: "approve" | "reject" | "reassign", reassign_to_canonical_variant_id? (required if decision = "reassign"), note? }`
- **Response:** `{ product_match_id, status, offer_variant: { id, canonical_variant_id }, decided_at, reviewer_id }`
- **Validation:** The `ProductMatch` must currently be `Queued` to accept a decision — a match that is already decided is rejected (`409 MATCH_ALREADY_DECIDED`), **except** the one idempotency case in the row below; corrections beyond that go through a new match record, preserving history, never a silent overwrite. `reassign` requires the target `CanonicalProductVariant` to exist and be `Published`; an `approve` writes `OfferVariant.canonical_variant_id` and re-derives `VendorOffer.canonical_product_id` from it (Part 3's authoritative-variant-link invariant) in the same transaction.
- **Authorization:** Product-matching reviewer or platform admin only (Part 1, Section C) — never the vendor who submitted the offer (conflict of interest with BR-001/BR-002).
- **Errors:** `409 MATCH_ALREADY_DECIDED`, `422 TARGET_VARIANT_NOT_PUBLISHED` (reassign only), `403 ROLE_NOT_PERMITTED`.
- **Idempotency:** The explicit exception to the "must be Queued" rule above: a request that is byte-for-byte identical (same reviewer, same `decision`, same `reassign_to_canonical_variant_id` where applicable) to the decision already recorded on that match is treated as a safe retry and returns the existing decided state with `200`, not `409`. Any *other* request against an already-decided match — a different decision, a different target, or a different reviewer — is a genuine conflict and gets `409 MATCH_ALREADY_DECIDED`; corrections in that case require a fresh `ProductMatch`/merge-split flow (FR-MATCH-006), not overwriting the recorded decision.
- **Pagination:** N/A. `GET /product-matches` (the review queue itself) is paginated and filterable by `status`/`confidence_score`.

### `GET /search`
- **Purpose / Actor:** Full-text/faceted product search (FR-SEARCH-001–010); any actor including Guest.
- **Request (query params):** `q`, `category_id?`, `brand_id?`, `attribute_filters[]?`, `price_min/max?`, `availability?`, `condition?`, `sort`, `lat/lng?` (for FR-SEARCH-006), `cursor?`, `limit?`
- **Response:** `{ results: [{ canonical_product_id | vendor_offer_id (unmatched), title, best_offer: {...}, is_unmatched: bool, ... }], facets: {...}, next_cursor }`
- **Validation:** `limit` capped at 100; malformed filters ignored with a warning, never a hard failure (keeps search resilient per FR-SEARCH-008's no-dead-end requirement).
- **Authorization:** None (public read); sponsored results (FR-SEARCH-009, Phase 2) are labeled in the response, never silently reordering organic results.
- **Errors:** `400 INVALID_FILTER_VALUE` (only for structurally malformed, not merely zero-result, filters).
- **Idempotency:** N/A (read-only).
- **Pagination:** Cursor-based, per H.1.

---

## I. Non-functional requirements

All targets below are **operational defaults, configurable, not hardcoded** — consistent with how staleness/grace-period values are treated in Part 3 (BR-004, BR-014). Where a target genuinely cannot be set without data that doesn't exist yet (e.g., real production traffic), the FYP Delivery Increment's demo-scale value is given alongside an explicit "production target TBD" note, rather than inventing a number with no basis.

### I.1 Performance & scalability

| ID | Requirement |
|---|---|
| NFR-PERF-001 | Product-detail page response, p95, must be ≤ 2s under a simulated 3G-equivalent low-bandwidth profile. |
| NFR-PERF-002 | Search results, p95, must be ≤ 1.5s against a catalog of up to 10,000 offers (FYP/initial-MVP scale); the production target is re-baselined once real catalog size is known. |
| NFR-PERF-003 | Checkout submission (`POST /checkout` through order creation), p95, must be ≤ 3s, **excluding** external payment-gateway round-trip time (⚠ OPEN-001 — gateway latency unknown until selected). |
| NFR-SCALE-001 | The system must sustain 50 concurrent active sessions in the FYP demo environment without breaching NFR-PERF-001/002; production concurrency targets are TBD pending real usage data, not invented ahead of it. |
| NFR-IMPORT-001 | A CSV/Excel import of 1,000 rows must complete processing (validation + commit) within 5 minutes. |

### I.2 Availability & reliability

| ID | Requirement |
|---|---|
| NFR-AVAIL-001 | Target availability for the production MVP is 99.5% monthly uptime for customer-facing read paths (search, browse, comparison); the FYP Delivery Increment has no formal SLA (single small-team-operated demo environment). |
| NFR-REL-001 | Recovery Point Objective (RPO): ≤ 1 hour of data loss in a disaster-recovery scenario, via at least hourly database backups. |
| NFR-REL-002 | Recovery Time Objective (RTO): ≤ 4 hours to restore service from a full-environment loss, for the production MVP; not a formal target for the FYP demo environment. |
| NFR-REL-003 | Every payment-affecting operation must be reconciled by a scheduled job that detects and flags (never silently auto-resolves) the "payment succeeded, order failed" / "order succeeded, payment failed" cases from FR-PAY-009. |

### I.3 Security & privacy

Detailed threat modeling is Part 6, Section J; the baseline platform-wide targets carried here are:

| ID | Requirement |
|---|---|
| NFR-SEC-001 | All traffic is served over TLS 1.2+; no plaintext HTTP endpoint exists, including webhooks. |
| NFR-SEC-002 | Passwords are stored using a modern salted hash (e.g., bcrypt/argon2) — never reversible encryption, never plaintext. |
| NFR-SEC-003 | Every `AuditLog`-covered action (Part 3, G.4) is retained and queryable for at least the data-retention period defined once Q11 is resolved. |
| NFR-PRIV-001 | Customer PII (phone numbers, addresses) is visible only to roles whose data-visibility boundary (Part 1, Section C) explicitly includes it — enforced at the API authorization layer, not just the UI. |

### I.4 Accessibility & localization

| ID | Requirement |
|---|---|
| NFR-A11Y-001 | Customer-facing web must meet WCAG 2.1 AA on core flows (search, product detail, cart, checkout) as the target; the FYP Delivery Increment demo is evaluated against this target but a full audit is not required before the academic deadline. |
| NFR-L10N-001 | Every customer-facing string ships in both Arabic and English from a translation source, never hardcoded per-language UI branches. |
| NFR-RTL-001 | The entire customer-facing UI (not just text direction) must mirror correctly in RTL for Arabic — layout, icons, and form flow, not only text alignment. |

### I.5 Mobile & low-bandwidth

| ID | Requirement |
|---|---|
| NFR-MOBILE-001 | All customer-facing screens must be fully usable at 400px width (per the artifact/responsive-design baseline used across this project's tooling) and on both Android and iOS builds (Q9). |
| NFR-BW-001 | Product images are served in a compressed, responsive format (e.g., WebP with size variants) so a product-detail page's total payload stays reasonable on a constrained connection — exact byte budget set alongside NFR-IMG-001. |

### I.6 Observability, maintainability, testability

| ID | Requirement |
|---|---|
| NFR-OBS-001 | Every request is traceable end-to-end via its `X-Correlation-Id` (H.1) across logs, `AuditLog` rows, and any downstream webhook it triggers. |
| NFR-OBS-002 | Every external integration (H.1's integration-monitoring row) exposes success rate, latency, and last-failure timestamp to the admin dashboard (FR-ADMIN-006). |
| NFR-MAINT-001 | Every business-facing selectable list (BR-003) is changed via admin configuration, not a code deployment — this is as much a maintainability requirement as a functional one. |
| NFR-TEST-001 | Every state machine defined in Part 2 (E.11) has an automated test covering each valid transition and at least one invalid-transition rejection. |

### I.7 Backup, disaster recovery, data retention

| ID | Requirement |
|---|---|
| NFR-BACKUP-001 | Database backups run at least hourly (ties to NFR-REL-001's RPO) and are verified restorable on a regular schedule, not just taken and assumed good. |
| NFR-DR-001 | A documented disaster-recovery runbook exists and is exercised at least once before the production MVP launch (not required for the FYP demo). |
| NFR-RETAIN-001 | Transactional records (`CustomerOrder`, `Payment`, `AuditLog`) are retained per BR-018; exact periods pending legal confirmation (Q11). |

### I.8 Browser/device support, SEO, images

| ID | Requirement |
|---|---|
| NFR-BROWSER-001 | The latest two major versions of Chrome, Safari, Firefox, and Edge are supported for the customer-facing web app. |
| NFR-DEVICE-001 | Android and iOS builds target the latest two major OS versions at time of release. |
| NFR-SEO-001 | Canonical-product pages are server-rendered or pre-rendered (not client-only JS rendering) so search engines can index them — a material risk if the shared cross-platform framework chosen in Part 6 defaults to client-side rendering for its web build. |
| NFR-IMG-001 | Uploaded product images are capped at a configurable maximum size (recommended default: 10MB per original upload, served as compressed derivatives) — enforced by FR-IMPORT-010's image-import path too. |

### I.9 Domain-specific thresholds

| ID | Requirement |
|---|---|
| NFR-STALE-001 | Maximum delay before inventory is labeled stale (BR-005): 7 days for manual-entry offers, 24 hours for API/feed-synced offers — both admin-configurable, not hardcoded. |
| NFR-STALE-002 | Maximum delay before a price is labeled stale (BR-004): 30 days, admin-configurable. |
| NFR-AUDIT-001 | 100% of state transitions defined in Part 2 (E.11) and every admin break-glass action (BR-019) produce an `AuditLog` row — this is a hard requirement, not a best-effort target. |

---

**Next:** Part 5 will cover Section K (UX and screen inventory + end-to-end journeys) and Section L (edge cases and failure scenarios), grounding the API contracts and NFRs defined here in concrete screens and failure-mode handling.
