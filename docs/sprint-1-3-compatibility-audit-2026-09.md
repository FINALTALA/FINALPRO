# FINALPRO — Sprint 1–3 Compatibility Audit (September 2026 Baseline)

**Date:** 2026-09-19
**Auditor:** Codex
**Decision baseline:** [Approved Product Decisions, September 2026](approved-product-decisions-2026-09.md) (`PDR-001`–`PDR-034`)
**Code examined:** `main` at `a1c506c` (Sprint 1–2) and `feat/sprint-3-catalog` at `2c03ed7` (Sprint 3; unmerged).

## Verdict

Do **not** merge `feat/sprint-3-catalog` into `main` unchanged. Its foundation work is valuable and several parts are compatible, but three direct product-decision conflicts must be remediated first. Sprint 4 must not start until the remediation items are planned and the revised backlog is approved.

This is a compatibility audit, not a request to discard working security/concurrency work. The correct approach is additive migration and targeted refactoring, with regression tests retained.

## 1. Sprint 1 — Foundation (`c51d084` and review fixes)

| Area | Assessment | Reason / required action |
|---|---|---|
| API errors, correlation IDs, rate limits | Compatible | Still required by the approved API amendment. Preserve the implementation and tests. |
| Idempotency claim/completion safety | Compatible, high value | Atomic DB claims and transactional completion are especially important for checkout, stock movements, imports and delivery actions. Reuse the pattern for future mutating routes. |
| `AuditLog` / `OutboxEvent` | Compatible | New BranchOrder, stock, return and notification flows must continue writing audit/outbox records atomically. |
| PostgreSQL, Redis, CI | Compatible | No product decision contradicts the platform foundation. CI must eventually add the new regression tests. |

**Sprint 1 conclusion:** retain. No product-decision blocker found.

## 2. Sprint 2 — Identity and initial vendor application (`6991619` through `a1c506c`)

| Area | Assessment | Reason / required action |
|---|---|---|
| Phone/password/OTP, session version, password-reset atomicity | Compatible, high value | PDR-034 needs deactivation/recovery later, but does not invalidate the existing authentication/security model. Preserve its concurrency tests. |
| Idempotency recovery / Redis failure behaviour | Compatible | The same durability discipline is needed in checkout and staff-invite flows. |
| Customer profile and address baseline | Partially compatible | Map pin/landmark is useful. Add default address, active-order edit guard, explicit current-location save and new delivery-address decision logic later. |
| Vendor creation/application | Partially compatible | Current model starts from a physical-style branch. It needs extension for physical, online-only and hybrid stores, hidden warehouse and public pickup points. |
| Account deletion | Missing approved behaviour | Add deactivation, active-unreceived-order block, PII minimisation/session invalidation and 30-day OTP recovery; do not hard-delete historical rows. |
| Guest cart | No conflict in shipped code | No guest cart was found in the current schema. Keep it that way; cart creation must remain authenticated under PDR-002. |

**Sprint 2 conclusion:** retain and extend through additive migrations; no reason to rewrite its security fixes.

## 3. Sprint 3 — Catalog, matching, verification and subscription (`2c03ed7`)

### 3.1 Direct merge blockers

| ID | Finding in actual Sprint 3 code | Conflict | Required remediation before merge |
|---|---|---|---|
| S3-B01 | `OfferVariant.currency` is a free string (default `ILS`); `CreateOfferVariantDto` accepts `currency`; API response exposes it. | PDR-001 / FR-PRICE-008 / BR-027: ILS is the only platform currency. | Remove client-selectable currency, migrate existing values safely, enforce ILS-only storage/validation, remove FX-oriented fields/usages, and add `TC-ILS-001`. |
| S3-B02 | `SubscriptionPlan` exposes `BASIC`, `STANDARD`, `PREMIUM`; selection endpoint requires a plan. | PDR-033 / BDR-024: unified one-month sandbox/trial; no Basic/Pro/tier logic in FYP. | Replace plan-selection contract with trial activation/mock monthly renewal and expiry behaviour. Preserve subscription status history if useful; do not expose tier selection. |
| S3-B03 | Exact identifier matching in `MatchingService` and `createVariant()` immediately links to the canonical variant/product. | PDR-012: vendor must explicitly confirm a proposed match, even when an exact identifier generated the proposal. | Persist/propose exact candidate, show vendor confirmation/reject/research flow, and ensure comparison only follows confirmation. Add concurrent/idempotent confirmation tests. |

### 3.2 Required major follow-up (not a reason to throw away the branch)

| ID | Gap | Product decision / target change |
|---|---|---|
| S3-M01 | `VendorUserRole` only has `OWNER`; no `branch_id` assignment and no employee lifecycle. | Add `BRANCH_EMPLOYEE`, active assignment rule, phone+OTP invite, transfer/disable and workspace authorization. |
| S3-M02 | `StoreBranch.isPhysical` boolean cannot express hybrid store, hidden warehouse or non-stock pickup points. | Introduce explicit physical branch, warehouse and pickup-point modelling; do not expose warehouse address. |
| S3-M03 | `Vendor` lacks stable slug, display name, bio, cover/background, store types, contacts, availability state, custom sections and follows. | Add storefront/public discovery model in a planned migration. |
| S3-M04 | Barcode/identifier is optional and combines identifier concepts; no `store_inventory_barcode` versus internal `platform_product_barcode` boundary. | Make local inventory barcode required/unique within vendor; add stable internal shared product barcode; scanner selects colour/size/quantity. |
| S3-M05 | Sprint 3 intentionally omits media, inventory, import, matching review queue and branch inventory. | These are valid deferrals in that sprint, but must be scheduled now because approved product behaviour requires them. |
| S3-M06 | Titles are `titleAr`/`titleEn`, whereas owner may enter one language and needs automatic translation/original text. | Keep storage capable of both languages if useful, but add source language/original content and generated-translation semantics. |
| S3-M07 | Branch verification follows existing physical rules only. | Preserve strong evidence/CAS protections, but add approved online-only verification policy once OPEN-011 is decided. |

### 3.3 Compatible strengths to preserve

- Category hierarchy and concurrency-safe cycle prevention.
- Brand normalized-name uniqueness (a useful baseline; fuzzy review remains later work).
- Canonical product / canonical variant / vendor offer / offer variant separation and its offer-variant race protection.
- Atomic idempotency completion inside resource transactions, including its regression tests.
- Verification evidence completeness checks, vendor lifecycle checks, audited review decision and concurrent approval locking.
- Transactional vendor application creation and tests.
- Root workspace lockfile/CI repair and Redis-backed E2E environment setup.

## 4. Required integration order

1. Keep `main` protected and leave Sprint 3 unmerged.
2. After the decision-documentation PR is merged, create a **new remediation branch from `feat/sprint-3-catalog`’s current reviewed tip** (then rebase it onto updated `main` if necessary). Do not mutate the historical Sprint 3 branch to hide its reviewed history or reimplement its compatible work from scratch.
3. Implement S3-B01–S3-B03 first, with additive-safe migrations and passing tests.
4. Open one PR from the remediation branch to `main`; it contains the reviewed Sprint 3 work plus the remediations and is reviewed as a whole before merge.
5. Create the redesigned Sprint 4 backlog from the approved baseline. Major items S3-M01–M07 need estimates before assignment to sprints.

## 5. Audit limitations

This audit reviewed Git history, Prisma schema and code references/contracts on the named commits. It did not execute the Docker test suite in this documentation-only pass, and it does not replace a line-by-line pull-request review after remediation. Existing reported test results are not re-certified against the new requirements until new/changed tests exist.
