# FINALPRO — Requirement Traceability, September 2026

**Date:** 2026-09-26 (v3, arithmetic and coverage corrections per product-owner review of v2)
**Author:** Developer, for product-owner/Codex review.
**Status:** Read-only audit. No code, no migration, no commit/push is authorised by this record. No Sprint 15+ work is authorised by this record.
**Source:** `origin/main` @ `f92bf17` (Sprint 14 merged). Local tree matches it exactly.
**Scope:** the full SRS, Parts 0–9. Every `FR-*` ID in [SRS Part 2](srs/02-functional-requirements.md) (244 rows, including the E.0 September amendment), every `PDR-*` ID in [`approved-product-decisions-2026-09.md`](approved-product-decisions-2026-09.md) (34 rows), every `BR-*` (34) and `NFR-*` (32) in Part 3/4, and every remaining requirement, decision, screen, failure scenario, backlog item and state-machine transition in Parts 0, 1, and 3–9 — covered in the appendix starting at §6, with each ID-range explicitly expanded (no row stands for more than one ID; see §0 for the two narrow, explicitly-justified exceptions — the `O.1`/`O.2` test-level classification and the `BO`/module-matrix/recommendations rollup — neither of which carries an independent DONE/PARTIAL/MISSING status of its own).
**Update rule:** this file is reviewed again after every sprint. Each review edits it in place under a new dated version note, rather than creating a new file, so it stays the one living record.

## v3 corrections applied, per product-owner review of v2

1. **Arithmetic corrections.** Re-deriving every section's DONE/PARTIAL/MISSING/DEFERRED/SUPERSEDED counts directly from the actual table rows (not from memory) found mismatches in the `BR-*` footnote, the `NFR-*` footnote, `H.1`, `L-01..32`, `N.1..5`, and the `BDR` row of the old §16 grand total — all corrected in place below, with the corrected §16 now the single source of the totals. No status symbol on any individual row changed; only the summary arithmetic was wrong and is now fixed.
2. **BDR row fixed to 16, not 17.** The v2 footnote claiming a "duplicate BDR-016" was itself the error — the actual table has exactly 16 rows (BDR-001..015 plus one row labelled `BDR-016 (قديم)`), no duplicate. §16 now shows 16 directly, with no contradictory footnote.
3. **Part 8 is no longer a single rollup row.** §13 now maps all 102 `BL-*` IDs individually (every ID Part 8 actually contains — counted directly from the source document, not the earlier ~112 estimate) to the canonical ID whose status it inherits, with its own status column.
4. **`SRS-E11-RT-01` through `SRS-E11-RT-09`** are now nine separate physical rows (were one combined row). The same principle — no combined/range row anywhere in this file — was checked against every other section; the one other place it applied was Part 9's `AC-*` table (§14), where `AC-10/AC-11`, `AC-12/AC-13`, and `AC-15/AC-16` are now six separate rows instead of three combined ones.
5. **No status or roadmap changed.** This pass is a documentation correction only — the same rule from v2 (`§1`) still governs every status, and no sprint assignment in §5 changed.
6. **Actual row count stated at the end (§17)**, computed from this file's own content after the corrections above, not asserted from memory.

## 0. Corrections applied in this version (v2), per product-owner review of v1

1. **No map provider is the approved position, not a gap.** GPS only fills `lat`/`lng`; the customer picks the zone/landmark manually — this is the design already shipped in Sprint 14, not a missing integration. `FR-AUTH-008`, `PDR-029`, and `FR-CART-006` stay **PARTIAL**, but their backend/UI cells now say explicitly that the map is not the reason — the reason is no default address, no edit/delete, and no change-before-preparation.
2. **"Nearest branch" is not scheduled into Sprint 18b.** The shipped behaviour (a deterministic default branch, with every eligible branch shown so the customer can pick another) is a deliberate, documented substitute for "propose the nearest branch" — there is no reliable distance source in this codebase. `PDR-023` and `FR-CART-018 (E.0)` stay **PARTIAL** as an intentional deviation from the requirement's literal text, and are pulled out of every sprint until a new product decision supplies a distance source. Their sprint column now reads `— (قرار جديد)`.
3. **Sprint 20 is split.** What was one 21-item sprint is now two: **S20a** (fulfilment exceptions, cancellation, refund — 15 items) and **S20b** (checkout additions: terms, notes, minimum order — 6 items).
4. **Sprint 26 does not start.** Its 18 items are Phase-2/out-of-FYP requirements named by the SRS itself but never carried into `approved-product-decisions-2026-09.md` §6's deferred list. Their sprint column now reads `قرار-نطاق` (scope decision required) instead of a schedulable sprint number. Their status stays **MISSING** — I have not reclassified them as DEFERRED myself; that reclassification needs your decision either way (build them, or add them to §6 formally).
5. **This file replaces the scratchpad copy** and is the one reviewed after each sprint from now on.

## 1. Rules applied

- **DONE**: backend + authorization + a UI route reachable from navigation + a test, and no substitution for the requirement's actual text.
- **PARTIAL**: an endpoint, model, or test alone; or any substitute for the literal requirement (a deterministic branch instead of "nearest", typed coordinates instead of "map pin") **unless an approved decision explicitly replaced that text** (point 1–2 above are the only two such cases found).
- **MISSING**: nothing built, and not explicitly deferred by an approved decision.
- **DEFERRED BY APPROVED DECISION**: only where `approved-product-decisions-2026-09.md` §6, or an explicit PDR sentence, names the item. SRS-internal "Phase 2"/"out of MVP" language is **not** by itself an approved deferral — those rows stay MISSING and are flagged for your scope decision (§4, `قرار-نطاق`).
- **SUPERSEDED**: a historical Part-2 row E.0 explicitly replaces; excluded from the totals.
- 11 ID collisions exist inside the SRS itself (E.0 reuses an ID already used in a later section); both instances are listed, tagged `(E.0)` vs. the section number.

## 2. Summary

| | DONE | PARTIAL | MISSING | DEFERRED | SUPERSEDED |
|---|---|---|---|---|---|
| FR (244) | 36 | 82 | 103 | 9 | 14 |
| PDR (34) | 12 | 14 | 8 | 0 | 0 |
| **Total** | **48** | **96** | **111** | **9** | **14** |

(Unchanged from v1 — this version only reclassifies *which sprint*, or whether a sprint at all, a PARTIAL/MISSING row is assigned to; no status symbol changed.)

## 3. The ID table

Columns: ID | Requirement | Backend/model/API | Authorization | UI route (from navigation) | Test | Status | Sprint

Test abbreviations: S3…S14 = `sprintN-*.e2e-spec.ts`; AUTH = `auth.e2e-spec`; VV = `vendor-verification-owner-authorization.e2e-spec`; NAV = `web-navigation.e2e-spec`; WCH = `web-checkout-helpers.e2e-spec`. "Sprint" column values: `S15`…`S25` = single-sprint assignment; `— (قرار جديد)` = intentionally not scheduled, needs a new product decision; `قرار-نطاق` = not scheduled, needs a scope decision (build vs. formally defer).

### E.0 — September 2026 amendment
| ID | Requirement | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| FR-AUTH-013 (E.0) | ضيف يتصفح فقط؛ السلة/المتابعة/checkout بحساب؛ المفضلات/المراجعات/التنبيهات بحساب | session guard؛ CartItem على السيرفر | session | /login, /cart | S10,S14,AUTH | 🟡 PARTIAL | S24 |
| FR-AUTH-014 (E.0) | تعطيل الحساب واسترجاعه 30 يوماً | لا شيء | - | لا | لا | ❌ MISSING | S22 |
| FR-VEND-012 (E.0) | physical/online-only/hybrid، مستودع مخفي، نقاط استلام | Vendor.storeType، Warehouse، PickupPoint؛ PUT store-type/warehouse، POST/GET pickup-points | OWNER | لا | S5 | 🟡 PARTIAL | S15 |
| FR-VEND-013 (E.0) | مالك/موظف كصلاحيات على نفس الحساب؛ موظف لفرع واحد | VendorUser(role,branchId)؛ staff-invites وaccept API | OWNER يدعو | مبدّل في /account؛ لا صفحة دعوة أو قبول | S4,NAV | 🟡 PARTIAL | S15 |
| FR-VEND-014 (E.0) | وسيلة تواصل خارجية واحدة على الأقل | بوابة النشر في storefront.controller | OWNER | /vendor/:id/storefront | S7 | ✅ DONE | - |
| FR-CAT-015 (E.0) | النشر يتطلب عنواناً وصورة وتصنيفاً وسعراً ومخزوناً و5 حقول فئة | VendorOffer/OfferVariant؛ specs_text حر، لا قالب الحقول الخمسة | OWNER | لا | S3,S6,S7 | 🟡 PARTIAL | S17 |
| FR-CAT-016 (E.0) | أقسام المتجر: All، New arrivals، Discounts، حتى 20 مخصصاً | StoreSection(+Offer)؛ /storefronts/:slug/sections | OWNER؛ قراءة عامة | /vendor/:id/sections، /store/:slug | S7 | ✅ DONE | - |
| FR-MATCH-011 (E.0) | باركود المتجر فريد؛ ملصق داخلي قابل للطباعة؛ باركود المنصة منفصل | storeInventoryBarcode؛ platformProductBarcode؛ لا توليد ملصق/طباعة | OWNER | لا | S6 | 🟡 PARTIAL | S18 |
| FR-MATCH-012 (E.0) | خصائص ثم نص ثم صورة؛ المالك يؤكد | MatchReviewCandidate، match-review، match-confirmation؛ لا تشابه صور | OWNER | لا | S6,S7 | 🟡 PARTIAL | S17 |
| FR-IMPORT-008 (E.0) | نفس الباركود + لون/مقاس جديد يضيف variant؛ تعارضات للمراجعة | POST offers/import + expected-offer-variant-conflict | OWNER | لا | S7 | 🟡 PARTIAL | S17 |
| FR-SEARCH-013 (E.0) | صفحات All/Women/Men/Kids/Accessories؛ المتجر يختار الأنواع؛ بحث مع اقتراحات وتسامح AR/EN | discovery?segment,q (contains)؛ VendorApplicableCategory؛ PUT applicable-categories | عام؛ OWNER للتعديل | /، /discovery؛ التعديل في /vendor/:id/storefront؛ لا اقتراحات ولا اختيار عند التسجيل | S13 | 🟡 PARTIAL | S18b |
| FR-SEARCH-014 (E.0) | مشاهدة واحدة لكل حساب/جهاز كل ساعتين للترتيب | لا | - | لا | لا | ❌ MISSING | S18b |
| FR-COMP-010 (E.0) | بطاقة: أرخص سعر متاح، حتى 5 شعارات، كسر التعادل بالتقييم ثم المسافة | comparison-card API؛ لا تقييم ولا مسافة | عام | / و/discovery؛ الشعار يفتح العرض | S8,S13 | 🟡 PARTIAL | S18b |
| FR-COMP-011 (E.0) | كل العروض من الأرخص؛ فلتر لون/مقاس؛ الإضافة للسلة من صفحة المتجر فقط | comparison API | عام | /compare/:id، /store/:slug/products/:offerId | S8 | ✅ DONE | - |
| FR-PRICE-008 (E.0) | كل المبالغ ILS بلا FX | العملة ILS فقط | n/a | كل واجهات السعر | S10,S14 | ✅ DONE | - |
| FR-PRICE-009 (E.0) | سعر أساسي لكل variant؛ خصم نسبي واحد بتاريخين؛ للمالك | basePrice + salePrice مطلق؛ لا نسبة ولا تواريخ | OWNER | لا | S3 | 🟡 PARTIAL | S17 |
| FR-INV-008 (E.0) | مخزون لكل فرع وvariant؛ Available/Low/Sold out؛ الحد الأقصى عند الـcheckout؛ بلا نقل | BranchStock، bucketForStock، cart max_quantity | عام/session | البطاقات، /cart، /checkout | S6,S8,S14 | ✅ DONE | - |
| FR-INV-009 (E.0) | بيع فعلي: مسح، لون/مقاس، كمية، خصم ذري، تدقيق | لا reason من نوع بيع، ولا endpoint مسح | موظف الفرع | لا | لا | ❌ MISSING | S18 |
| FR-INV-010 (E.0) | خصم يدوي بسبب + إشعار فوري للمالك بهوية الموظف والفرع | StockMovement(reason,note)؛ صف outbox فقط | OWNER/موظف | لا | S6 | 🟡 PARTIAL | S18 |
| FR-CART-017 (E.0) | اختيار صريح؛ مجموعات فرع واحد؛ وإلا مجموعات منفصلة | CartItem، checkout-grouping | session | /cart، /checkout | S10,S14 | ✅ DONE | - |
| FR-CART-018 (E.0) | اقتراح **أقرب** فرع؛ العميل يختار غيره؛ موعد من 3 أيام | التجميع يختار فرعاً افتراضياً ثابتاً موثّقاً، ليس الأقرب (لا مصدر مسافة)؛ كل الفروع المؤهلة تُعرض؛ اختيار الفرع والموعد يعملان — بديل مقصود عن nearest، وليس فجوة تنفيذية؛ انظر PDR-023 | session | /checkout | S10,S14 | 🟡 PARTIAL | — (قرار جديد) |
| FR-ORD-009 (E.0) | CustomerOrder + BranchOrders، لكلٍّ تنفيذه ورسومه ودفعه وموعده | CustomerOrder، BranchOrder | session | /orders | S9,S10,S11 | ✅ DONE | - |
| FR-PAY-010 (E.0) | الطلبات المدفوعة إلكترونياً بمعاملة sandbox واحدة؛ COD لكل فرع | PaymentTransaction، توكنات sandbox | session | نموذج البطاقة في /checkout | S10,S14 | ✅ DONE | - |
| FR-FUL-008 (E.0) | تقويم الفرع، فترات لا تتداخل، سعة، استثناءات، حماية الفترات المحجوزة | DeliveryWindow(+Exception)، EXCLUDE، HAS_ACTIVE_ORDERS | OWNER | /vendor/:id/branches/:b/delivery-windows | S9 | ✅ DONE | - |
| FR-FUL-009 (E.0) | بدء التحضير وSent وDelivered؛ تذكيرات وفشل توصيل وعدم رد (PDR-025..027) | start-preparation، mark-sent، mark-delivered، pickup-handover؛ لا تذكيرات ولا مسار فشل | OWNER/موظف الفرع | /vendor/:id/branches/:b/orders | S11 | 🟡 PARTIAL | S20a |
| FR-RET-008 (E.0) | سياسة إرجاع، لقطة عند الشراء، تغيير كل 6 أشهر | لا | - | لا | لا | ❌ MISSING | S21 |
| FR-RET-009 (E.0) | كود 6 أرقام صالح 7 أيام؛ كل الفروع تقبل | لا | - | لا | لا | ❌ MISSING | S21 |
| FR-REV-008 (E.0) | مراجعات منتج ومتجر لمشترٍ موثّق، غير قابلة للتعديل | لا | - | لا | لا | ❌ MISSING | S23 |
| FR-FAV-005 (E.0) | صفحة أتابعه؛ إشعارات منفصلة لمنتج/خصم جديد؛ تعتيم غير النشط | StoreFollow، following API؛ لا إشعارات؛ غير النشط يُخفى ولا يُعتّم | session | /following | S13 | 🟡 PARTIAL | S19 |
| FR-NOTIF-008 (E.0) | مركز إشعارات: مقروء/غير مقروء، روابط عميقة | صفوف OutboxEvent فقط؛ لا Notification model | - | لا | لا | ❌ MISSING | S19 |
| FR-VPORTAL-007 (E.0) | المالك: عمليات وتحليلات المتجر؛ الموظف: مخزون وطلبات فرعه فقط | VendorMembershipGuard وعزل الفرع؛ لا تحليلات ولا واجهة مخزون للموظف | OWNER/موظف | مركز /vendor/:id، طلبات الفرع | S4,S9,NAV | 🟡 PARTIAL | S18 |

### E.1 — الهوية
| ID | Requirement | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| FR-AUTH-001 | تصفح وبحث ومقارنة كضيف | routes عامة | عام | /، /discovery، /compare، /store | AUTH,S8,S13 | ✅ DONE | - |
| FR-AUTH-002 | هاتف + كلمة مرور؛ البريد اختياري | /auth/register | عام | /register | AUTH | ✅ DONE | - |
| FR-AUTH-003 | OTP عند التسجيل قبل الطلب | /auth/otp/*، phoneVerifiedAt | عام | /register | AUTH | ✅ DONE | - |
| FR-AUTH-004 | checkout بجلسة موثقة | SessionAuthGuard | session | /checkout | S10 | ✅ DONE | - |
| FR-AUTH-005 | استعادة كلمة المرور بـOTP | /auth/password/reset-* | عام | /reset-password (من /login) | AUTH,S14 | ✅ DONE | - |
| FR-AUTH-006 | OTP لاستعادة كلمة المرور **ولتغيير الهاتف** | الاستعادة موجودة؛ لا endpoint لتغيير الهاتف | session | /reset-password فقط | AUTH | 🟡 PARTIAL | S22 |
| FR-AUTH-007 | دمج سلة الضيف | استُبدل بـFR-AUTH-013 (E.0) | - | - | - | ↪ SUPERSEDED | - |
| FR-AUTH-008 | عناوين متعددة بدبوس خريطة وملاحظة وهاتفين | Address؛ POST/GET addresses؛ **GPS يملأ lat/lng فقط (لا مزوّد خريطة خارجي، قرار معتمد)؛ العميل يكتب المنطقة/المعلم يدوياً** | session | /account، /checkout | S14,WCH | 🟡 PARTIAL — بسبب لا default/تعديل/حذف، وليس الخريطة | S22 |
| FR-AUTH-009 | لغة عربية افتراضية وإنجليزية، محفوظة للحساب | عمود User.languagePref فقط | - | لا (عربي فقط) | لا | 🟡 PARTIAL | S22 |
| FR-AUTH-010 | حذف الحساب | لا (انظر FR-AUTH-014) | - | لا | لا | ❌ MISSING | S22 |
| FR-AUTH-011 | تقييد محاولات OTP والتسجيل السريع | Throttler على auth؛ too_many_attempts | عام | خطأ في /login و/register | otp.service.spec,AUTH | ✅ DONE | - |
| FR-AUTH-012 | تسجيل اجتماعي (الـSRS: خارج FYP، وليس في PDR §6) | لا | - | لا | لا | ❌ MISSING | قرار-نطاق |

### E.2 — المتاجر
| ID | Requirement | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| FR-VEND-001 | طلب متجر: ملف ومعلومات وفرع واحد على الأقل | POST /vendors | session | لا | S3,S4 | 🟡 PARTIAL | S15 |
| FR-VEND-002 | دبوس وصورة للفرع الفعلي قبل الموافقة | POST verification-evidence | OWNER | لا | S3,VV | 🟡 PARTIAL | S15 |
| FR-VEND-003 | المراجع يوافق/يرفض/يطلب إعادة تقديم مع تدقيق | POST verification-decision، AuditLog | REVIEWER/ADMIN | لا | VV,S3 | 🟡 PARTIAL | S16 |
| FR-VEND-004 | تأكيد الاشتراك قبل النشر | POST/GET subscription | OWNER | لا | S3 | 🟡 PARTIAL | S15 |
| FR-VEND-005 | حالة الاشتراك تتحكم بالظهور (PDR-033: ACTIVE/EXPIRED) | VendorSubscription، subscription-gate | OWNER | لا (بلا تذكيرات) | S3 | 🟡 PARTIAL | S15 |
| FR-VEND-006 | فروع متعددة بساعات وإغلاقات ومناطق | فروع تُنشأ داخل الطلب فقط؛ مناطق ونوافذ توصيل موجودة؛ لا ساعات ولا إغلاق ولا إضافة فرع | OWNER | /vendor/:id/branches (قراءة)، /delivery-zones، /delivery-windows | S9 | 🟡 PARTIAL | S18 |
| FR-VEND-007 | أدوار موظفين مقسمة | استُبدل بـFR-VEND-013 (E.0) | - | - | - | ↪ SUPERSEDED | - |
| FR-VEND-008 | دورة حالة المتجر مع Suspended/Cancelled | APPLIED>UNDER_REVIEW>APPROVED/REJECTED>ACTIVE>EXPIRED؛ لا تعليق/إلغاء | - | لا | S3,VV | 🟡 PARTIAL | S16 |
| FR-VEND-009 | تعليق/إعادة تفعيل بسبب وتدقيق | لا (قيمة enum فقط) | PLATFORM_ADMIN | لا | لا | ❌ MISSING | S16 |
| FR-VEND-010 | معلومات الدفع/التسوية | لا | - | لا | لا | ❌ MISSING | S25 |
| FR-VEND-011 | مؤشرات أداء المتجر | لا | - | لا | لا | ❌ MISSING | S25 |

### E.3 — الكتالوج
| ID | Requirement | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| FR-CAT-001 | شجرة تصنيفات AR/EN يديرها الأدمن | Category tree؛ /categories CRUD | PLATFORM_ADMIN | لا | S3 | 🟡 PARTIAL | S17b |
| FR-CAT-002 | علامات مضبوطة مع كشف تكرار | Brand.normalizedName فريد؛ POST /brands | PLATFORM_ADMIN | لا | S3 | 🟡 PARTIAL | S17b |
| FR-CAT-003 | قوالب خصائص لكل فئة | لا (structuralAttributes حر) | - | لا | لا | ❌ MISSING | S17b |
| FR-CAT-004 | حالة المنتج على العرض | OfferVariant.condition | OWNER | لا تُعرض ولا تُحرَّر | S3 | 🟡 PARTIAL | S17 |
| FR-CAT-005 | نص بديل للوسائط ووضع إشراف | OfferVariantMedia(url,kind)؛ لا alt ولا إشراف | OWNER | لا | S6 | 🟡 PARTIAL | S17 |
| FR-CAT-006 | تقييد فئات/منتجات من الأدمن | لا | - | لا | لا | ❌ MISSING | S17b |
| FR-CAT-007 | بيانات SEO | لا | - | لا | لا | ❌ MISSING | S17b |
| FR-CAT-008 | دورة Draft>Pending>Published>Archived | enum CanonicalProductStatus؛ إنشاء أدمن فقط | PLATFORM_ADMIN | لا | S3,S7 | 🟡 PARTIAL | S17b |
| FR-CAT-009 | تحذير تكرار تقريبي للأدمن | تطابق تام فقط | - | لا | لا | ❌ MISSING | S17b |
| FR-CAT-010 | حقل الضمان | لا | - | لا | لا | ❌ MISSING | S17b |
| FR-CAT-011 | وسوم يديرها الأدمن | لا | - | لا | لا | ❌ MISSING | S17b |
| FR-CAT-012 | نوع المنتج الأساسي | لا | - | لا | لا | ❌ MISSING | S17b |
| FR-CAT-013 | SKU فريد لكل متجر | @@unique(vendorId,sellerSku) | OWNER | لا | S3,S7 | 🟡 PARTIAL | S17 |
| FR-CAT-014 | عنوان/وصف/مواصفات مستقلة لكل لغة | titleAr/En، specsTextAr/En | OWNER | تُعرض؛ لا تحرير | S3 | 🟡 PARTIAL | S17 |

### E.4 — التطابق
| ID | Requirement | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| FR-MATCH-001 | عرض مرتبط بمنتج أساسي أو مستقل، ولا يصير منتجاً أساسياً | canonicalProductId اختياري | OWNER | صفحات /store | S3,S7 | ✅ DONE | - |
| FR-MATCH-002 | ربط تلقائي بمعرّف دقيق (E.0: اقتراح يؤكده المالك) | اقتراح + match-confirmation | OWNER | لا | S6,S7 | 🟡 PARTIAL | S17 |
| FR-MATCH-003 | طابور مراجعة مع درجة ثقة | MatchReviewCandidate(score)؛ API الطابور | OWNER | لا | S6 | 🟡 PARTIAL | S17 |
| FR-MATCH-004 | غير المعتمد لا يظهر في المقارنة | المقارنة تقرأ المؤكَّد فقط | عام | /compare/:id | S8 | ✅ DONE | - |
| FR-MATCH-005 | العميل يبلّغ عن تطابق خاطئ | لا | - | لا | لا | ❌ MISSING | S17b |
| FR-MATCH-006 | دمج/فصل المنتجات الأساسية | لا | - | لا | لا | ❌ MISSING | S17b |
| FR-MATCH-007 | تدقيق كل قرار (بالثقة) | AuditLog على القرارات؛ لا دمج/فصل؛ الثقة وقت القرار لم أتحقق منها | - | لا | S6 | 🟡 PARTIAL | S17b |
| FR-MATCH-008 | نموذج المستويات الأربعة | Canonical/Variant/OfferVariant/unmatched | n/a | /compare، /store | S3,S8 | ✅ DONE | - |
| FR-MATCH-009 | غير المطابق قابل للبحث والشراء وموسوم | يُشترى من صفحة المتجر؛ الاكتشاف للمنتجات الأساسية فقط؛ بلا وسم | عام | /store/:slug/products/:id | S7,S13 | 🟡 PARTIAL | S18b |
| FR-MATCH-010 | لا استبدال صامت للمواصفات المتعارضة | تعارض الاستيراد يذهب للمراجعة؛ لا سياسة لكل حقل | OWNER | لا | S7 | 🟡 PARTIAL | S17 |

### E.5 — الاستيراد
| ID | Requirement | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| FR-IMPORT-001 | نموذج إنشاء عرض واحد | POST /offers، /variants | OWNER | لا | S3 | 🟡 PARTIAL | S17 |
| FR-IMPORT-002 | CSV/Excel بقالب وتقرير قبل الحفظ | POST offers/import (تقرير)؛ لا قالب للتنزيل ولا dry-run | OWNER | لا | S7 | 🟡 PARTIAL | S17 |
| FR-IMPORT-003 | نجاح جزئي | نتائج لكل صف | OWNER | لا | S7 | 🟡 PARTIAL | S17 |
| FR-IMPORT-004 | سجل مهام الاستيراد | لا (ImportIdentifierRecord لمنع التكرار) | - | لا | لا | ❌ MISSING | S17 |
| FR-IMPORT-005 | أخطاء صفوف قابلة للتنفيذ | أسباب لكل صف | OWNER | لا | S7 | 🟡 PARTIAL | S17 |
| FR-IMPORT-006 | استيراد عبر API/feed بصلاحية | لا | - | لا | لا | ❌ MISSING | قرار-نطاق |
| FR-IMPORT-007 | feeds مجدولة وPOS/ERP خارج FYP (الـSRS) | لا | - | لا | لا | ❌ MISSING | قرار-نطاق |
| FR-IMPORT-008 (E.5) | لا scraping | لم يُبنَ | n/a | n/a | n/a | ✅ DONE | - |
| FR-IMPORT-009 | مصدر وحداثة كل عرض تظهر في المقارنة | لا | - | لا | لا | ❌ MISSING | S17 |
| FR-IMPORT-010 | استيراد الصور بالروابط/أرشيف | PDR §6: استيراد الروابط مؤجل، الرفع اليدوي لاحقاً | - | - | - | ⏸ DEFERRED | - |
| FR-IMPORT-011 | ربط أعمدة قابل للضبط | لا | - | لا | لا | ❌ MISSING | S17 |
| FR-IMPORT-012 | إعادة محاولة الصفوف الفاشلة فقط | ImportIdentifierRecord | OWNER | لا | S7 | 🟡 PARTIAL | S17 |
| FR-IMPORT-013 | تقرير تسوية | لا | - | لا | لا | ❌ MISSING | S25 |
| FR-IMPORT-014 | أولوية المصدر وحفظ القيمة الخاسرة | لا | - | لا | لا | ❌ MISSING | S17 |

### E.6 — البحث
| ID | Requirement | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| FR-SEARCH-001 | بحث نصي AR/EN في العناوين والوصف والعلامة والخصائص | ILIKE على الأسماء والموديل والعلامة والفئة؛ لا الوصف ولا الخصائص | عام | شريط البحث ثم /discovery?q | S13 | 🟡 PARTIAL | S18b |
| FR-SEARCH-002 | تطبيع عربي وأرقام وتحويل حروف | لا | - | لا | لا | ❌ MISSING | S18b |
| FR-SEARCH-003 | إكمال تلقائي وتسامح مع الأخطاء | لا | - | لا | لا | ❌ MISSING | S18b |
| FR-SEARCH-004 | بحث بالباركود | لا | - | لا | لا | ❌ MISSING | S18b |
| FR-SEARCH-005 | تصفح فئات وفلاتر وترتيب | شريط الفئات/segment فقط؛ الأحدث أولاً | عام | /discovery | S13 | 🟡 PARTIAL | S18b |
| FR-SEARCH-006 | نتائج تراعي الموقع | لا | - | لا | لا | ❌ MISSING | S18b |
| FR-SEARCH-007 | المشاهَد مؤخراً والبحوث المحفوظة | لا | - | لا | لا | ❌ MISSING | S18b |
| FR-SEARCH-008 | اقتراحات عند عدم وجود نتائج | لا | - | لا | لا | ❌ MISSING | S18b |
| FR-SEARCH-009 | وسم الإعلانات (Phase 2 بحسب الـSRS) | لا | - | لا | لا | ❌ MISSING | قرار-نطاق |
| FR-SEARCH-010 | غير المطابق ضمن النتائج وموسوم | الاكتشاف منتجات أساسية فقط | - | لا | لا | ❌ MISSING | S18b |
| FR-SEARCH-011 | بحث صوتي (خارج النطاق حسب الـSRS) | لا | - | لا | لا | ❌ MISSING | قرار-نطاق |
| FR-SEARCH-012 | قاموس مرادفات | لا | - | لا | لا | ❌ MISSING | S18b |
| FR-SEARCH-013 (E.6) | التعرف على العلامة والموديل وترجيحهما | العلامة والموديل ضمن contains بلا ترجيح | عام | البحث | S13 | 🟡 PARTIAL | S18b |
| FR-SEARCH-014 (E.6) | ترتيب قابل للتفسير | الأحدث أولاً فقط | - | لا | لا | ❌ MISSING | S18b |
| FR-SEARCH-015 | لا محرك توصيات؛ المشاهَد مؤخراً والبحوث المحفوظة فقط | لا محرك (مطابق)؛ الآخران غير موجودين | - | لا | لا | 🟡 PARTIAL | S18b |

### E.7–E.8 — المقارنة والتسعير
| ID | Requirement | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| FR-COMP-001 | مجموعة مقارنة حتى 4 | لا (المقارنة لكل منتج أساسي) | - | لا | لا | ❌ MISSING | S24 |
| FR-COMP-002 | وضعان: عروض المنتج نفسه أو منتجات منافسة | وضع المنتج الواحد فقط | عام | /compare/:id | S8 | 🟡 PARTIAL | S24 |
| FR-COMP-003 | خصائص الفئة + سعر وخصم وحالة وضمان وتوصيل وتقييم ومسافة ووقت | السعر والتوفر واللون/المقاس فقط | عام | /compare/:id | S8 | 🟡 PARTIAL | S24 |
| FR-COMP-004 | إبراز التشابه والاختلاف | لا | - | لا | لا | ❌ MISSING | S24 |
| FR-COMP-005 | وسم الأرخص وأفضل قيمة مع السبب | ترتيب تصاعدي بلا وسم ولا سبب | عام | /compare/:id | S8 | 🟡 PARTIAL | S24 |
| FR-COMP-006 | تنبيه بيانات قديمة | لا | - | لا | لا | ❌ MISSING | S24 |
| FR-COMP-007 | رابط مشاركة ومجموعة محفوظة | الرابط يعمل؛ لا حفظ في الحساب | عام | /compare/:id | S8 | 🟡 PARTIAL | S24 |
| FR-COMP-008 | يعمل على الجوال وRTL | واجهة متجاوبة؛ تحقق بصري فقط، بلا اختبار آلي | عام | /compare/:id | لقطات فقط | 🟡 PARTIAL | S24 |
| FR-COMP-009 | مقارنة بعملات متعددة | استُبدل بـFR-PRICE-008 (E.0) | - | - | - | ↪ SUPERSEDED | - |
| FR-PRICE-001 | سعر أساسي وتخفيض وعملة | استُبدل بـFR-PRICE-008/009 (E.0) | - | - | - | ↪ SUPERSEDED | - |
| FR-PRICE-002 | تاريخ أسعار كامل | لا | - | لا | لا | ❌ MISSING | S17 |
| FR-PRICE-003 | قواعد تقادم السعر | لا | - | لا | لا | ❌ MISSING | S17 |
| FR-PRICE-004 | قواعد تراكب الخصومات/الكوبونات (Phase 2 بحسب الـSRS) | لا | - | لا | لا | ❌ MISSING | قرار-نطاق |
| FR-PRICE-005 | المبلغ المستحق: أصناف + توصيل + رسوم + ضريبة | الأصناف والتوصيل؛ لا رسوم ولا ضريبة (OPEN-009) | session | /checkout | S10 | 🟡 PARTIAL | S20b |
| FR-PRICE-006 | حد أدنى للطلب | لا | - | لا | لا | ❌ MISSING | S20b |
| FR-PRICE-007 | مقارنة مطبَّعة بـFX | استُبدل بـFR-PRICE-008 (E.0) | - | - | - | ↪ SUPERSEDED | - |
| FR-PRICE-008 (E.8) | عروض فلاش وحزم وخصم كمية (Phase 2 بحسب الـSRS) | لا | - | لا | لا | ❌ MISSING | قرار-نطاق |
| FR-PRICE-009 (E.8) | الإعلانات الممولة (Phase 2 بحسب الـSRS) | لا | - | لا | لا | ❌ MISSING | قرار-نطاق |

### E.9 — المخزون
| ID | Requirement | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| FR-INV-001 | مخزون لكل فرع وvariant | BranchStock؛ stock GET/movements | OWNER/موظف | لا (الإدارة) | S5,S6 | 🟡 PARTIAL | S18 |
| FR-INV-002 | حالات توفر تشمل Preorder/Backorder/عند الطلب | ثلاث فئات فقط (PDR-017) | - | البطاقات | S8 | 🟡 PARTIAL | S18 |
| FR-INV-003 | حجز بنافذة انتهاء | CheckoutReservation 10 دقائق | session | /checkout | S10 | ✅ DONE | - |
| FR-INV-004 | منع السطر النافد وخصم شرطي ذري | خصم ذري داخل txn التأكيد؛ حالة نفاد في السلة | session | /cart، /checkout | S10,S14 | ✅ DONE | - |
| FR-INV-005 | تحديث يدوي للمخزون | POST movements (خصم فقط)/stock API | OWNER/موظف | لا | S6 | 🟡 PARTIAL | S18 |
| FR-INV-006 | تنبيه مخزون قديم | لا | - | لا | لا | ❌ MISSING | S18 |
| FR-INV-007 | مخزون أمان | لا | - | لا | لا | ❌ MISSING | S18 |
| FR-INV-008 (E.9) | تقرير تسوية المخزون | لا | - | لا | لا | ❌ MISSING | S25 |

### E.10 — السلة والـcheckout
| ID | Requirement | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| FR-CART-001 | سلة متعددة البائعين مقسمة بالبائع | استُبدل بـFR-CART-017 (E.0) | - | - | - | ↪ SUPERSEDED | - |
| FR-CART-002 | إعادة التحقق من السعر والمخزون قبل الدفع | txn التأكيد؛ فرق السعر | session | /checkout | S10,S14 | ✅ DONE | - |
| FR-CART-003 | حد أدنى لكل شريحة | لا | - | لا | لا | ❌ MISSING | S20b |
| FR-CART-004 | أهلية عنوان التوصيل بالمنطقة وبديل الاستلام | فحص المنطقة في quote/reserve | session | /checkout | S10,S14 | ✅ DONE | - |
| FR-CART-005 | توصيل أو استلام لكل بائع | استُبدل بـFR-ORD-009 (E.0) | - | - | - | ↪ SUPERSEDED | - |
| FR-CART-006 | دبوس المنزل وهاتفان وملاحظات | هاتفان + إحداثيات (**GPS يملأها فقط، لا مزوّد خريطة، قرار معتمد**) + معلم نصي؛ لا ملاحظة توصيل لكل طلب | session | /checkout AddressForm | S14 | 🟡 PARTIAL — بسبب لا ملاحظة لكل طلب، وليس الخريطة | S22 |
| FR-CART-007 | كوبونات (Phase 2 بحسب الـSRS) | لا | - | لا | لا | ❌ MISSING | قرار-نطاق |
| FR-CART-008 | checkout idempotent | IdempotencyInterceptor | session | /checkout | S10,S14 | ✅ DONE | - |
| FR-CART-009 | COD ودفع إلكتروني | paymentMethod لكل فرع | session | /checkout | S10 | ✅ DONE | - |
| FR-CART-010 | السلات المهجورة بلا أثر | الحجوزات تنتهي والسلة تبقى | session | /cart | S10 | ✅ DONE | - |
| FR-CART-011 | مادة الطلب: CustomerOrder وVendorSuborders | استُبدل بـFR-ORD-009 (E.0) | - | - | - | ↪ SUPERSEDED | - |
| FR-CART-012 | قبول صريح للشروط | لا | - | لا | لا | ❌ MISSING | S20b |
| FR-CART-013 | اختيار الموعد لكل شريحة أثناء الـcheckout | اختيار الموعد في reserve | session | /checkout | S10 | ✅ DONE | - |
| FR-CART-014 | ملاحظة العميل لكل شريحة وملاحظة داخلية للمتجر | لا | - | لا | لا | ❌ MISSING | S20b |
| FR-CART-015 | إظهار تعارض التنفيذ لكل شريحة | رسائل مستوى المجموعة/عدم وجود طريقة؛ لا كتالوج التعارضات الكامل | session | /checkout | S14 | 🟡 PARTIAL | S20b |
| FR-CART-016 | حفظ السلة عند فشل الـcheckout | PAYMENT_FAILED rollback والحجز يبقى | session | /checkout | S14 | ✅ DONE | - |

### E.11 — الطلبات
| ID | Requirement | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| FR-ORD-001 | CustomerOrder + suborders | استُبدل بـFR-ORD-009 (E.0) | - | - | - | ↪ SUPERSEDED | - |
| FR-ORD-002 | دورة حياة مستقلة | استُبدل بـFR-ORD-009 (E.0) | - | - | - | ↪ SUPERSEDED | - |
| FR-ORD-003 | رفض فرع لا يلغي أشقاءه | الطلبات الفرعية مستقلة؛ لا إجراء رفض/إلغاء | موظف/OWNER | صفحة طلبات الفرع | S9,S11 | 🟡 PARTIAL | S20a |
| FR-ORD-004 | كل انتقال منسوب ومُشعَر ومدقَّق | AuditLog نعم؛ الإشعار صف outbox فقط | - | لا | S11 | 🟡 PARTIAL | S19 |
| FR-ORD-005 | جدول زمني موحد للطلب | قائمة BranchOrder؛ لا جدول للأب | session | /orders | S11 | 🟡 PARTIAL | S20a |
| FR-ORD-006 | الإلغاء بحسب الحالة | مخطط الحالات فقط؛ لا endpoint ولا واجهة | - | لا | S9 | 🟡 PARTIAL | S20a |
| FR-ORD-007 | إجراءات بحسب الدور، مع إلغاء بعد الشحن | العزل بحسب الدور مكتمل؛ الإلغاء غير موجود | OWNER/موظف | صفحة طلبات الفرع | S9,S11 | 🟡 PARTIAL | S20a |

### E.12 — الدفع
| ID | Requirement | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| FR-PAY-001 | تحصيل COD يسجله المسلِّم | pickup-handover يسجل الدفع؛ تحصيل COD عند التوصيل لم أتحقق منه | موظف الفرع | صفحة طلبات الفرع | S10,S11 | 🟡 PARTIAL | S20a |
| FR-PAY-002 | تفويض والتقاط إلكتروني (FYP: sandbox بقرار PDR) | شحن sandbox | session | /checkout | S10,S14 | ✅ DONE | - |
| FR-PAY-003 | توزيع دفع متعدد البائعين على الطلبات الفرعية | معاملة واحدة للمدفوع إلكترونياً؛ التوزيع لكل BranchOrder لم أتحقق منه | session | /checkout | S10 | 🟡 PARTIAL | S20a |
| FR-PAY-004 | استرداد كامل/جزئي لكل صنف مع رسوم التوصيل | حالة REFUNDED فقط؛ لا مسار استرداد | - | لا | لا | ❌ MISSING | S20a |
| FR-PAY-005 | العمولة تُسجَّل ولا تُحصَّل | لا | - | لا | لا | 🟡 PARTIAL | S25 |
| FR-PAY-006 | فوترة الاشتراك كتيار دفع مستقل | VendorSubscription فقط؛ لا سجلات دفع | OWNER | لا | S3 | 🟡 PARTIAL | S15 |
| FR-PAY-007 | سجل مالي مدقَّق غير قابل للتعديل | AuditLog للإلحاق فقط؛ ليس كل أحداث الدفع مؤكدة؛ لا عارض | - | لا | S1 | 🟡 PARTIAL | S25 |
| FR-PAY-008 | فاتورة/إيصال (PDR §3.4: لا إيصال مطبوع للعميل) | لا | - | لا | لا | ❌ MISSING | S25 |
| FR-PAY-009 | تعويض عند عدم اتساق الدفع والطلب | rollback داخل txn واحدة | session | /checkout | S10,S14 | ✅ DONE | - |
| FR-PAY-010 (E.12) | معالجة chargeback (تحتاج بوابة حقيقية) | PDR §6: البوابة الحقيقية مؤجلة | - | - | - | ⏸ DEFERRED | - |

### E.13 — التنفيذ
| ID | Requirement | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| FR-FUL-001 | تنفيذ على مستوى البائع عند الـcheckout | استُبدل بـFR-ORD-009 (E.0) | - | - | - | ↪ SUPERSEDED | - |
| FR-FUL-002 | التوصيل عبر آلة حالة مع سائق | استُبدل بـFR-FUL-009 (E.0) وPDR-006 | - | - | - | ↪ SUPERSEDED | - |
| FR-FUL-003 | تأكيد الطلب يطلق تنبيه المتجر + رسالتين | صفوف outbox فقط؛ لا relay ولا SMS | - | لا | S10 | 🟡 PARTIAL | S19 |
| FR-FUL-004 | أهلية منطقة التوصيل | مناطق على مستوى المتجر (PDR-022) + فحص منطقة العنوان | session | /checkout، /vendor/:id/delivery-zones | S9,S10 | ✅ DONE | - |
| FR-FUL-005 | رسوم التوصيل بحسب المنطقة | VendorDeliveryZone.fee | session | /checkout | S10 | ✅ DONE | - |
| FR-FUL-006 | معالجة فشل التوصيل | لا | - | لا | لا | ❌ MISSING | S20a |
| FR-FUL-007 | شحنات مجزأة إن فعّلها المتجر | لا خيار؛ شحنة واحدة فقط | - | لا | لا | 🟡 PARTIAL | قرار-نطاق |
| FR-FUL-008 (E.13) | كود استلام يتحقق منه الفرع | BranchOrder.pickupCode، pickup-handover | موظف الفرع | صفحة طلبات الفرع، /orders | S10,S11 | ✅ DONE | - |
| FR-FUL-009 (E.13) | استلام المرتجعات | لا | - | لا | لا | ❌ MISSING | S21 |
| FR-FUL-010 | وقت توصيل/جاهزية تقديري | يُعرض الموعد المختار؛ لا حساب ETA | session | /checkout، /orders | S10 | 🟡 PARTIAL | S20a |
| FR-FUL-011 | تعيين سائق | استُبدل بـPDR-006 | - | - | - | ↪ SUPERSEDED | - |
| FR-FUL-012 | تسجيل استلام النقد مع المبلغ | التسليم يسجل الدفع؛ سجل المبلغ لم أتحقق منه | موظف الفرع | صفحة طلبات الفرع | S11 | 🟡 PARTIAL | S20a |
| FR-FUL-013 | اختيار موعد مجدول | اختيار الموعد | session | /checkout | S10 | ✅ DONE | - |
| FR-FUL-014 | webhooks شركات التوصيل | PDR-006: التنسيق مع الناقل خارج المنصة | - | - | - | ⏸ DEFERRED | - |

### E.14 — المرتجعات
| ID | Requirement | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| FR-RET-001 | أهلية الإرجاع بالمدة والسبب | لا | - | لا | لا | ❌ MISSING | S21 |
| FR-RET-002 | طلب إرجاع بسبب وصور لأصناف محددة | لا | - | لا | لا | ❌ MISSING | S21 |
| FR-RET-003 | SLA للمتجر وتصعيد تلقائي | لا | - | لا | لا | ❌ MISSING | S21 |
| FR-RET-004 | حساب الاسترداد | لا | - | لا | لا | ❌ MISSING | S21 |
| FR-RET-005 | أسباب موجَّهة | لا | - | لا | لا | ❌ MISSING | S21 |
| FR-RET-006 | تصعيد النزاعات | لا | - | لا | لا | ❌ MISSING | S21 |
| FR-RET-007 | حدود إساءة الاستخدام | لا | - | لا | لا | ❌ MISSING | S21 |

### E.15–E.17 — المراجعات والمفضلات والإشعارات
| ID | Requirement | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| FR-REV-001 | مراجعة من مشترٍ موثّق | لا | - | لا | لا | ❌ MISSING | S23 |
| FR-REV-002 | أهداف: منتج/متجر/توصيل (PDR-032: منتج ومتجر) | لا | - | لا | لا | ❌ MISSING | S23 |
| FR-REV-003 | صور في المراجعة | لا (PDR-032: تقييم وتعليق) | - | لا | لا | ❌ MISSING | S23 |
| FR-REV-004 | رد المتجر على المراجعة | PDR-032 و§6: ردود البائع مؤجلة | - | - | - | ⏸ DEFERRED | - |
| FR-REV-005 | صيغة التقييم المجمّع | لا | - | لا | لا | ❌ MISSING | S23 |
| FR-REV-006 | الإبلاغ عن مراجعة | لا | - | لا | لا | ❌ MISSING | S23 |
| FR-REV-007 | كشف أنماط شاذة | لا | - | لا | لا | ❌ MISSING | S23 |
| FR-REV-008 (E.15) | شارة التحقق على صفحة المتجر | verificationStatus موجود؛ لا يُعرض | عام | لا | لا | ❌ MISSING | S23 |
| FR-REV-009 | تعديل/حذف المراجعة | استُبدل بـPDR-032 (لا تعديل) | - | - | - | ↪ SUPERSEDED | - |
| FR-REV-010 | مؤشرات أصالة على مستوى العرض | لا | - | لا | لا | ❌ MISSING | S23 |
| FR-FAV-001 | مفضلة: منتج/عرض/متجر | متابعة المتجر فقط | session | /following (متجر فقط) | S13 | 🟡 PARTIAL | S24 |
| FR-FAV-002 | حفظ مجموعة مقارنة | لا | - | لا | لا | ❌ MISSING | S24 |
| FR-FAV-003 | تنبيه انخفاض السعر | لا | - | لا | لا | ❌ MISSING | S24 |
| FR-FAV-004 | تنبيه عودة المخزون | لا | - | لا | لا | ❌ MISSING | S24 |
| FR-FAV-005 (E.16) | تفضيلات وتكرار الإشعارات | لا | - | لا | لا | ❌ MISSING | S24 |
| FR-FAV-006 | تنبيه عرض جديد | لا | - | لا | لا | ❌ MISSING | S24 |
| FR-NOTIF-001 | SMS وemail وin-app بتتبع لكل قناة | OutboxEvent فقط | - | لا | لا | 🟡 PARTIAL | S19 |
| FR-NOTIF-002 | SMS للـOTP وتأكيد الطلب | OTP مسجَّل في اللوغ (OPEN-004) | - | OTP في /register | AUTH | 🟡 PARTIAL | S19 |
| FR-NOTIF-003 | قوالب AR/EN بحسب لغة المستلم | لا | - | لا | لا | ❌ MISSING | S19 |
| FR-NOTIF-004 | إعادة محاولة وسجل محاولات | لا (لا relay) | - | لا | لا | ❌ MISSING | S19 |
| FR-NOTIF-005 | عدم كشف الهاتف الخام إلا بحسب تصميم الطلب | الموظف يرى الاسم والهاتف والكود فقط | موظف الفرع | صفحة طلبات الفرع | S10,S11 | ✅ DONE | - |
| FR-NOTIF-006 | WhatsApp خارج النطاق | لم يُبنَ | n/a | n/a | n/a | ✅ DONE | - |

### E.18–E.22 — الدعم والإدارة والبوابة والمحتوى والتحليلات
| ID | Requirement | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| FR-SUP-001 | تذاكر الدعم | PDR §6: نظام الدعم الرسمي مؤجل | - | - | - | ⏸ DEFERRED | - |
| FR-SUP-002 | أولوية/مرفقات التذاكر | PDR §6 | - | - | - | ⏸ DEFERRED | - |
| FR-SUP-003 | SLA وتصعيد | PDR §6 | - | - | - | ⏸ DEFERRED | - |
| FR-SUP-004 | استرداد بصلاحية موظف دعم | PDR §6 | - | - | - | ⏸ DEFERRED | - |
| FR-SUP-005 | جدول العميل الموحد للوكيل | PDR §6 | - | - | - | ⏸ DEFERRED | - |
| FR-SUP-006 | قاعدة معرفة/FAQ ثنائية اللغة | لا (لم تُذكر في PDR §6) | - | لا | لا | ❌ MISSING | قرار-نطاق |
| FR-ADMIN-001 | شاشات إدارة لكل كيان | API فقط: تصنيفات، علامات، منتجات أساسية، طلبات تغيير الاسم، قرار التحقق | ADMIN/REVIEWER | لا | S3,S7,VV | 🟡 PARTIAL | S16 |
| FR-ADMIN-002 | قوائم غير مضمّنة في الكود | المناطق والقطاعات enums ثابتة (OPEN-012) | - | لا | لا | ❌ MISSING | S25 |
| FR-ADMIN-003 | أدوار وصلاحيات قابلة للضبط | قيمتان ثابتتان لـPlatformRole | - | لا | لا | ❌ MISSING | S25 |
| FR-ADMIN-004 | feature flags | لا | - | لا | لا | ❌ MISSING | S25 |
| FR-ADMIN-005 | بحث/تصدير سجل التدقيق | جدول AuditLog بلا API قراءة | - | لا | لا | ❌ MISSING | S25 |
| FR-ADMIN-006 | لوحات إشارات الاحتيال | لا | - | لا | لا | ❌ MISSING | S25 |
| FR-ADMIN-007 | تصدير البيانات | لا | - | لا | لا | ❌ MISSING | S25 |
| FR-VPORTAL-001 | لوحة: طلبات تحتاج انتباهاً واشتراك وKPIs | مركز روابط فقط | OWNER | /vendor/:id | NAV | 🟡 PARTIAL | S18 |
| FR-VPORTAL-002 | إدارة المنتجات والمخزون والتسعير | قائمة عروض وتبديل حالة فقط | OWNER | /vendor/:id/offers | S3 | 🟡 PARTIAL | S17 |
| FR-VPORTAL-003 | استيراد وسجل وأخطاء | API الاستيراد؛ لا سجل | OWNER | لا | S7 | 🟡 PARTIAL | S17 |
| FR-VPORTAL-004 | إدارة الطلبات مع الإلغاء والمرتجعات | إجراءات الطلب؛ الإلغاء والمرتجعات غير موجودة | OWNER/موظف | /vendor/:id/orders، طلبات الفرع | S9,S11 | 🟡 PARTIAL | S20a |
| FR-VPORTAL-005 | إدارة الفروع والموظفين | قائمة فروع للقراءة؛ API الدعوة | OWNER | /vendor/:id/branches | S4 | 🟡 PARTIAL | S15 |
| FR-VPORTAL-006 | حالة وسجل الاشتراك | GET subscription | OWNER | لا | S3 | 🟡 PARTIAL | S15 |
| FR-VPORTAL-007 (E.20) | تقارير الأداء/SLA والرد على المراجعات (الردود مؤجلة) | لا | - | لا | لا | ❌ MISSING | S25 |
| FR-VPORTAL-008 | بيانات اعتماد التكامل | لا | - | لا | لا | ❌ MISSING | قرار-نطاق |
| FR-VPORTAL-009 | إعدادات المتجر: ساعات وإغلاقات ومناطق وتفضيلات إشعار | مناطق ونوافذ وواجهة المتجر؛ لا ساعات ولا إغلاقات ولا تفضيلات | OWNER | /vendor/:id/delivery-zones، /storefront | S9 | 🟡 PARTIAL | S18 |
| FR-VPORTAL-010 | شاشة تسويات (Phase 2) | لا | - | لا | لا | ❌ MISSING | قرار-نطاق |
| FR-VPORTAL-011 | عرض إشعارات البائع | لا | - | لا | لا | ❌ MISSING | S19 |
| FR-CMS-001 | أقسام الرئيسية والبانرات | لا | - | لا | لا | ❌ MISSING | قرار-نطاق |
| FR-CMS-002 | حملات وSEO AR/EN | لا | - | لا | لا | ❌ MISSING | قرار-نطاق |
| FR-CMS-003 | وسم الإعلان | لا | - | لا | لا | ❌ MISSING | قرار-نطاق |
| FR-CMS-004 | الإحالة/الأفلييت (Phase 2+) | لا | - | لا | لا | ❌ MISSING | قرار-نطاق |
| FR-CMS-005 | روابط عميقة ويب/موبايل | لا | - | لا | لا | ❌ MISSING | قرار-نطاق |
| FR-ANALYTICS-001 | لوحات بحسب الدور | لا | - | لا | لا | ❌ MISSING | S25 |
| FR-ANALYTICS-002 | جودة الكتالوج والتطابق | لا | - | لا | لا | ❌ MISSING | S25 |
| FR-ANALYTICS-003 | دقة المخزون وحداثة الأسعار | لا | - | لا | لا | ❌ MISSING | S25 |
| FR-ANALYTICS-004 | أداء البحث | لا | - | لا | لا | ❌ MISSING | S25 |
| FR-ANALYTICS-005 | تقارير المبيعات/الفوترة/المرتجعات | لا | - | لا | لا | ❌ MISSING | S25 |
| FR-ANALYTICS-006 | تحليلات قمع السلوك | لا | - | لا | لا | ❌ MISSING | S25 |

### PDR-001..034
| ID | Decision | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| PDR-001 | ILS فقط | بيانات ILS | n/a | كل الواجهات | S10,S14 | ✅ DONE | - |
| PDR-002 | العميل المسجّل يتصفح/يقارن/يفضّل/يتابع/يشتري؛ سلة على السيرفر | السلة والمتابعة؛ لا مفضلات | session | /cart، /following | S10,S13 | 🟡 PARTIAL | S24 |
| PDR-003 | التنفيذ يُختار عند الـcheckout | السلة بلا تنفيذ | session | /cart، /checkout | S10,S14 | ✅ DONE | - |
| PDR-004 | BranchOrder وحدة تشغيلية | BranchOrder | session | /orders | S9,S10 | ✅ DONE | - |
| PDR-005 | معاملة sandbox واحدة؛ ILS | PaymentTransaction | session | /checkout | S10,S14 | ✅ DONE | - |
| PDR-006 | لا دور سائق؛ الموظف يحدّث Sent/Delivered | لا دور سائق؛ إجراءات الموظف | موظف الفرع | صفحة طلبات الفرع | S11 | ✅ DONE | - |
| PDR-007 | لا دردشة ولا stories؛ وسيلة تواصل خارجية | لم تُبنَ؛ بوابة التواصل | OWNER | /vendor/:id/storefront | S7 | ✅ DONE | - |
| PDR-008 | حساب واحد بأدوار متعددة؛ مبدّل؛ موظف لفرع واحد | VendorUser؛ me/workspaces؛ API الدعوة | OWNER | مبدّل /account؛ لا دعوة ولا نقل | S4,NAV | 🟡 PARTIAL | S15 |
| PDR-009 | فصل صلاحيات المالك والموظف | الـguards تفرضه؛ واجهات المالك ناقصة | OWNER/موظف | المركز، طلبات الفرع | S4,S9 | 🟡 PARTIAL | S18 |
| PDR-010 | متجر فعلي/إلكتروني/هجين؛ مستودع مخفي؛ نقاط استلام | Vendor.storeType، Warehouse، PickupPoint | OWNER | لا | S5 | 🟡 PARTIAL | S15 |
| PDR-011 | صفحة متجر عامة: رابط واسم وشعار ونبذة وغلاف وتواصل وأقسام ومتابعة | حقول واجهة المتجر وAPI عام | OWNER؛ عام | /store/:slug، /vendor/:id/storefront | S7,S13 | ✅ DONE | - |
| PDR-012 | أقسام المتجر وسقف 20 | StoreSection | OWNER | /vendor/:id/sections | S7 | ✅ DONE | - |
| PDR-013 | صفحات الاكتشاف؛ المتجر يختار الأنواع عند التسجيل ويعدّلها | segments؛ applicable categories | OWNER | /discovery؛ التعديل فقط؛ التسجيل API فقط | S13 | 🟡 PARTIAL | S15 |
| PDR-014 | ترتيب 40/30/30 | الأحدث أولاً؛ لا تتبع مشاهدات | - | لا | لا | ❌ MISSING | S18b |
| PDR-015 | بطاقة عالمية: أرخص متاح، 5 شعارات، كسر التعادل تقييم ثم قرب | البطاقة والشعارات؛ لا تقييم ولا قرب | عام | /discovery | S8,S13 | 🟡 PARTIAL | S18b |
| PDR-016 | شبكة مقارنة 4-6/1-2 وفلتر variant | واجهة المقارنة | عام | /compare/:id | S8 | ✅ DONE | - |
| PDR-017 | Available/Low/Sold out؛ السلة تعرض الحد الأقصى | bucketForStock؛ max_quantity لفرع واحد | عام/session | البطاقات، /cart | S8,S14 | ✅ DONE | - |
| PDR-018 | باركود لكل منتج؛ داخلي قابل للطباعة؛ فريد للمتجر | storeInventoryBarcode فريد؛ لا ملصق قابل للطباعة | OWNER | لا | S6 | 🟡 PARTIAL | S18 |
| PDR-019 | نفس الباركود + لون/مقاس جديد إضافة؛ 3 تعارضات للمراجعة | منطق تعارض الاستيراد | OWNER | لا | S7 | 🟡 PARTIAL | S17 |
| PDR-020 | مخزون لكل فرع؛ بيع فعلي بالمسح؛ بلا نقل | BranchStock، movements؛ لا بيع فعلي | موظف الفرع | لا | S6 | 🟡 PARTIAL | S18 |
| PDR-021 | خصم يدوي بسبب وإشعار المالك | السبب مطلوب؛ الإشعار outbox فقط | OWNER/موظف | لا | S6 | 🟡 PARTIAL | S18 |
| PDR-022 | إعدادات الفرع؛ رسوم إقليمية للمتجر؛ تعطيل المناطق | VendorDeliveryZone، DeliveryWindow | OWNER | /vendor/:id/delivery-zones، /delivery-windows | S9 | ✅ DONE | - |
| PDR-023 | أقرب فرع مؤهل؛ اختيار العميل؛ تقويم 3 أيام | فرع افتراضي ثابت موثّق (لا مصدر مسافة)؛ كل الفروع المؤهلة تُعرض؛ الاختيار والموعد يعملان — **بديل مقصود عن nearest، وليس فجوة تنفيذية** | session | /checkout | S10,S14 | 🟡 PARTIAL — بديل مقصود، ليس فجوة | — (قرار جديد) |
| PDR-024 | تقاويم الفروع وسعة واستثناءات وحماية المحجوز | DeliveryWindow + الحمايات | OWNER | /vendor/:id/branches/:b/delivery-windows | S9 | ✅ DONE | - |
| PDR-025 | تذكير التحضير قبل 6 ساعات؛ استرداد/موعد جديد عند التأخر | حالة REFUNDED بلا مُطلِق | - | لا | لا | ❌ MISSING | S20a |
| PDR-026 | Sent/Delivered وتأكيد العميل؛ تذكير 48 ساعة وتأكيد تلقائي 72 | الإجراءات + reconciliation عند القراءة؛ التذكيرات outbox فقط | موظف/session | صفحة الفرع، /orders | S11 | 🟡 PARTIAL | S19 |
| PDR-027 | سياسة فشل التوصيل | لا | - | لا | لا | ❌ MISSING | S20a |
| PDR-028 | إلغاء صنف/طلب قبل Sent وقواعد الرسوم | مخطط الحالات فقط | - | لا | S9 | ❌ MISSING | S20a |
| PDR-029 | عناوين: خريطة وافتراضي وحفظ صريح؛ تغيير قبل التحضير | إنشاء/عرض فقط؛ **GPS يملأ lat/lng فقط (لا مزوّد خريطة خارجي، قرار معتمد)**، لا default، لا تعديل/حذف، لا تغيير العنوان قبل التحضير | session | /account، /checkout | S14 | 🟡 PARTIAL — بسبب default/تعديل/حذف/تغيير قبل التحضير، وليس الخريطة | S22 |
| PDR-030 | سياسة إرجاع المتجر ورسومها ولقطة الشراء | لا | - | لا | لا | ❌ MISSING | S21 |
| PDR-031 | طلب إرجاع وSLA وكود 7 أيام | لا | - | لا | لا | ❌ MISSING | S21 |
| PDR-032 | مراجعات موثّقة للمنتج والمتجر؛ غير قابلة للتعديل؛ الردود مؤجلة | لا | - | لا | لا | ❌ MISSING | S23 |
| PDR-033 | اشتراك sandbox شهر وتجديد؛ تعطيل عند الانتهاء؛ تذكيرات | VendorSubscription وبوابة الانتهاء؛ لا تذكيرات | OWNER | لا | S3 | 🟡 PARTIAL | S15 |
| PDR-034 | تعطيل الحساب مع استرجاع 30 يوماً | لا | - | لا | لا | ❌ MISSING | S22 |

## 4. سطر مستقل لكل قدرة ناقصة (onboarding/verification/admin/catalog/inventory/notifications/account)

### Onboarding
| Gap | القدرة الناقصة | يغطي | Sprint |
|---|---|---|---|
| G-ON-01 | نموذج تقديم طلب المتجر من الواجهة | FR-VEND-001، PDR-013، PDR-010 | S15 |
| G-ON-02 | رفع أدلة التحقق وإعادة التقديم (photo/pin) | FR-VEND-002 | S15 |
| G-ON-03 | واجهة الاشتراك وحالته وتجديده | FR-VEND-004/005، FR-VPORTAL-006، PDR-033، FR-PAY-006 | S15 |
| G-ON-04 | دعوة موظف من الواجهة | FR-VEND-013 (E.0)، FR-VPORTAL-005، PDR-008 | S15 |
| G-ON-05 | صفحة قبول الدعوة بـOTP | FR-VEND-013 (E.0) | S15 |
| G-ON-06 | واجهة نوع المتجر والمستودع ونقاط الاستلام | FR-VEND-012 (E.0)، PDR-010 | S15 |
| G-ON-07 | إضافة فرع لاحقاً وساعات وإغلاق مؤقت وأرشفة | FR-VEND-006، FR-VPORTAL-009 | S18 |

### Verification / Admin
| Gap | القدرة | يغطي | Sprint |
|---|---|---|---|
| G-AD-01 | طابور المراجع وقرار التحقق من الواجهة | FR-VEND-003 | S16 |
| G-AD-02 | تعليق وإعادة تفعيل المتجر بسبب وتدقيق | FR-VEND-008/009 | S16 |
| G-AD-03 | تنقّل طابور التطابق وتصحيح الأدمن | FR-ADMIN-001 | S16 |
| G-AD-04 | عارض سجل التدقيق وتصديره | FR-ADMIN-005 | S25 |
| G-AD-05 | إدارة الأدوار وقوائم الإعدادات (يعتمد على OPEN-012) | FR-ADMIN-002/003 | S25 |

### Catalog
| Gap | القدرة | يغطي | Sprint |
|---|---|---|---|
| G-CA-01 | نموذج إنشاء وتعديل العرض بالحقول الخمسة | FR-CAT-015 (E.0)، FR-IMPORT-001، FR-VPORTAL-002 | S17 |
| G-CA-02 | واجهة الاستيراد: قالب وتقرير وسجل وتسوية الأعمدة | FR-IMPORT-002/003/004/005/011/012 | S17 |
| G-CA-03 | رفع الوسائط وترتيبها وبدائلها النصية | FR-CAT-005 | S17 |
| G-CA-04 | `PriceHistory` مع كل تغيير سعر | FR-PRICE-002/003، FR-IMPORT-014 | S17 |
| G-CA-05 | الخصم النسبي بتاريخين | FR-PRICE-009 (E.0) | S17 |
| G-CA-06 | أرشفة العرض واستعادته | PDR §3.2 (بلا ID مستقل) | S17 |
| G-CA-07 | واجهة تأكيد التطابق وطابور المراجعة واعتماد الاسم | FR-MATCH-002/003/010/012 | S17 |
| G-CA-08 | إدارة المنصة للتصنيفات والعلامات والمنتجات الأساسية وقوالب الخصائص (OPEN-013) | FR-CAT-001/002/003/006..012 | S17b |
| G-CA-09 | دمج/فصل المنتجات وبلاغ العميل عن تطابق خاطئ | FR-MATCH-005/006/007 | S17b |

### Inventory
| Gap | القدرة | يغطي | Sprint |
|---|---|---|---|
| G-IN-01 | صفحة المخزون للمالك والموظف (تعديل) | FR-INV-001/005، PDR-020 | S18 |
| G-IN-02 | البيع الفعلي بالمسح | FR-INV-009 (E.0) | S18 |
| G-IN-03 | ملصق باركود قابل للطباعة | FR-MATCH-011 (E.0)، PDR-018 | S18 |
| G-IN-04 | مخزون أمان وتقادم المخزون | FR-INV-006/007 | S18 |
| G-IN-05 | نقل الموظف وتعطيله فوراً | FR-VEND-013، PDR-009 | S18 |

### Notifications
| Gap | القدرة | يغطي | Sprint |
|---|---|---|---|
| G-NO-01 | relay موثوق للـoutbox مع إعادة المحاولة والسجل | FR-NOTIF-001/004 | S19 |
| G-NO-02 | نموذج Notification ومركز إشعارات صغير بروابط عميقة | FR-NOTIF-008، FR-VPORTAL-011 | S19 |
| G-NO-03 | ربط أحداث المخزون والمتابعة والتذكيرات الأساسية | FR-INV-010، FR-FAV-005، PDR-026 | S19 |
| G-NO-04 | قوالب AR/EN وSMS (OPEN-004) | FR-NOTIF-002/003، FR-FUL-003 | S19 |

### Account
| Gap | القدرة | يغطي | Sprint |
|---|---|---|---|
| G-AC-01 | تغيير الهاتف بـOTP | FR-AUTH-006 | S22 |
| G-AC-02 | تعطيل الحساب واسترجاعه | FR-AUTH-010/014، PDR-034 | S22 |
| G-AC-03 | مبدّل اللغة والترجمة | FR-AUTH-009 | S22 |
| G-AC-04 | عنوان افتراضي وتعديل وحذف وتغيير العنوان قبل التحضير | FR-AUTH-008، FR-CART-006، PDR-029 | S22 |

(بند الخريطة أُزيل من G-AC-04 — لا مزوّد خريطة هو القرار المعتمد، وليس فجوة. انظر §0.1.)

## 5. Roadmap — كل PARTIAL/MISHED في سبرنت واحد فقط (أو معلَّم صراحة كغير مجدول)

المجموع 207 صفاً (96 PARTIAL + 111 MISSING) موزّعة كالتالي بعد التصحيحات.

| Sprint | النطاق | # | يعتمد على | قرارات مطلوبة قبل التنفيذ |
|---|---|---|---|---|
| S15 | إعداد المتجر: طلب متجر، أدلة، اشتراك، دعوة وقبول، نوع المتجر ونقاط الاستلام | 13 | لا شيء (الـAPIs موجودة) | OPEN-011 (أدلة المتاجر الإلكترونية) لبند التحقق للإلكتروني فقط؛ لا map provider (مثبَّت §0.1) |
| S16 | إدارة المنصة: قرار التحقق، تعليق/إعادة تفعيل، تنقل التطابق | 4 | S15 | سياسة التعليق: الأسباب وإشعار المالك (الإشعار نفسه في S19) وأسباب الرفض (OPEN-005) |
| S17 | كتالوج المالك: نموذج العرض، الاستيراد، الوسائط، `PriceHistory`، الخصم النسبي، التطابق | 25 | S15، S16 (قرارات الاسم) | OPEN-013 (الحقول الخمسة لكل فئة)؛ هل يبقى الخصم النسبي هنا أم يُفصل لأنه يغيّر التسعير في مسار الـcheckout؛ حجم الوسائط والرفع |
| S17b | كتالوج المنصة: تصنيفات وعلامات ومنتجات أساسية وقوالب وتطابق ودمج/فصل | 13 | S16، S17 | OPEN-013 |
| S18 | عمليات المخزون: صفحة المخزون، البيع بالمسح، الملصق، الفروع/الساعات، نقل الموظف | 16 | S15، S17 | لا شيء جديد؛ تأكيد شكل الباركود المطبوع |
| S18b | جودة البحث والاكتشاف: تطبيع عربي، اقتراحات، باركود، ترتيب | 19 | S17 (المشاهدات والأسعار) | وزن الترتيب 40/30/30. **"أقرب فرع" ليس ضمن هذا السبرنت** — انظر الصف المنفصل أدناه |
| S19 | إشعارات: تصميم الـrelay ثم relay وإشعارات داخل التطبيق لأحداث الطلب الأساسية | 10 | لا شيء تقني؛ يفضَّل بعد S17/S18 لأحداثها | OPEN-004 (SMS: يبقى المسجَّل fallback)؛ قائمة أحداث "action-required" |
| **S20a** | **استثناءات التنفيذ والإلغاء والاسترداد**: تأخر التحضير، فشل التوصيل، إلغاء صنف/طلب، استرداد، توزيع الدفع، سجل COD، جدول الطلب، تقارير الأداء (VPORTAL-004) | 15 | S19 | OPEN-009 (الرسوم/الضريبة تؤثر على الاسترداد)؛ قواعد رسوم الإلغاء (PDR-028) |
| **S20b** | **إضافات checkout**: الشروط، ملاحظة العميل/المتجر، الحد الأدنى للطلب، رسوم/ضريبة الدفع النهائي، كتالوج تعارض التنفيذ | 6 | S20a (نفس مسار الدفع، تسلسل بعده تجنباً لتضارب تعديلين متزامنين على checkout) | OPEN-009 (الضريبة/الرسوم)؛ نص الشروط النهائي |
| S21 | المرتجعات: سياسة المتجر، طلب، كود، استرداد، استلام المرتجعات | 12 | S20a (الاسترداد) | OPEN-009 |
| S22 | الحساب: تغيير الهاتف، التعطيل، اللغة، إدارة العناوين (افتراضي/تعديل/حذف/تغيير قبل التحضير) | 8 | لا شيء | قواعد الاحتفاظ بالبيانات (OPEN-009). **لا قرار خريطة مطلوب — محسوم بلا مزوّد خارجي (§0.1)** |
| S23 | المراجعات وشارة التحقق | 10 | S20a (الطلبات المكتملة) | قرار D1 (مؤجَّل من قِبلك رغم أن PDR-032 معتمد) |
| S24 | المفضلات والتنبيهات ومجموعات المقارنة ومقارنة أعمق | 16 | S17 (تاريخ الأسعار)، S19 | لا شيء جديد |
| S25 | التحليلات وأدوات الأدمن (سجل التدقيق، الأدوار، التصدير) وتقارير الفوترة والتسوية | 20 | معظم ما سبق | OPEN-012 (مصدر حدود المناطق) |
| **— (قرار جديد)** | "أقرب فرع" فعلياً (PDR-023، FR-CART-018) | 2 | — | **ليست سبرنتاً مجدولاً.** تحتاج: (أ) قراراً بأن التقريب الحتمي الحالي غير كافٍ، و(ب) مصدر مسافة موثوق (إحداثيات الفرع + إحداثيات العميل + دالة مسافة، أو مزوّد خارجي). بلا هذين لا يوجد عمل قابل للتقدير. |
| **قرار-نطاق** | متطلبات الـSRS التي تصفها الـSRS نفسها بـPhase 2/خارج FYP، ولا تذكرها `approved-product-decisions-2026-09.md` §6: تسجيل اجتماعي، feeds/API ingestion، بحث صوتي، إعلانات، كوبونات، flash sale، إحالة/أفلييت، CMS، شحنات مجزأة، FAQ، بيانات تكامل، تسويات | 18 | — | **ليست سبرنتاً.** بانتظار قرارك: إما تُبنى ضمن نطاق FYP، أو تُضاف رسمياً لـ§6 كمؤجَّلة. لن أغيّر حالتها من MISSING بنفسي في أي الحالتين قبل قرارك. |

**فحص المجموع:** S15(13)+S16(4)+S17(25)+S17b(13)+S18(16)+S18b(19)+S19(10)+S20a(15)+S20b(6)+S21(12)+S22(8)+S23(10)+S24(16)+S25(20) = **187** سبرنتات مجدولة + **2** غير مجدولة (قرار جديد) + **18** غير مجدولة (قرار-نطاق) = **207**، مطابق للمجموع في §2.

**قرارات مطلوبة قبل أي سبرنت، بالترتيب:**
1. OPEN-013 (S17 وS17b) وOPEN-011 (S15).
2. مصدر مسافة موثوق لـ"أقرب فرع" — بدونه هذا البند يبقى خارج كل الجداول الزمنية إلى أجل غير مسمى، وليس فقط مؤجَّلاً لسبرنت لاحق.
3. النطاق: هل تُبنى بنود `قرار-نطاق` الثمانية عشر ضمن FYP، أم تُضاف رسمياً إلى `approved-product-decisions-2026-09.md` §6.
4. قرار D1 للمراجعات (S23).
5. الخصم النسبي: نفس سبرنت الكتالوج أم منفصل (S17).
6. تنظيف تصادمات الـID الأحد عشر في الـSRS (توثيقي فقط، بدون كود).

سأنتظر مراجعتك ولن أبدأ Sprint 15 أو أي كود.

---

# الملحق: تغطية كامل الـSRS (Parts 3–9) — إضافة 2026-09-26

**لم يتغيّر شيء أعلاه.** هذا ملحق يضيف كل `BR-*` وكل `NFR-*` وبقية أجزاء الـSRS (3–9)، ويعطي جداول حالات E.11 معرّفات ثابتة كما طُلب. لا كود، لا migration، لا commit. لا Sprint 15.

**قاعدة الترقيم للصفوف بلا ID أصلي في الـSRS:** `SRS-<القسم>-<تسلسل>`، مقسّمة بلاحقة فرعية حيث يفيد ذلك في القراءة (مثل `SRS-E11-VS-03` لصف في جدول VendorSuborder). كل صف من هذه معرّف ثابت من الآن فصاعداً، لا يتغيّر بين المراجعات.

**نطاق التغطية المتعمّد (أمانة قبل الجداول):**
- `BR-*` (34 قاعدة، مع BR-026 كصف واحد يجمع نص F الأصلي وتعديل F.1) و`NFR-*` (32) — تغطية كاملة سطراً بسطر، بفحص كود فعلي لكل واحد.
- `G.0`/`G.3` (نموذج البيانات) — تغطية كاملة: 8 صفوف "target delta" + كيانات G.3 مقابل نماذج Prisma الفعلية.
- `H.1` (اتفاقيات API) و`H.3a` (نقاط النهاية المستهدفة بعد تعديل PDR) — تغطية كاملة. `H.2`/`H.3` الأصليان (قبل التعديل) صف واحد "SUPERSEDED" بدل تكرارهما، لأن `H.3a` نفسه ينص على أنهما يُستبدلان.
- `K.1a` (شاشات معتمدة أيلول 2026) — 11 صفاً. شاشات `K.1` الأصلية (~50 شاشة) **لم تُفكَّك صفاً بصف** لأن عمود "UI route" في كل صفوف `FR-*` أعلاه يغطي نفس المعلومة عملياً؛ تفكيكها سيكرر نفس الفحص دون معلومة جديدة. بدلاً من ذلك أضفت 4 صفوف تجميعية لحالات Empty/Loading/Error وRTL/A11y لكل بوابة (عميل/بائع/إدارة/دعم)، لأن هذا بُعد غير مغطى في أي صف `FR-*`.
- `L-01..L-32` (سيناريوهات فشل) — تغطية كاملة، معرّفاتها أصلية من الـSRS.
- `M` (ADR-001..012) — تغطية كاملة مقابل الكود الفعلي.
- `N.1..N.5` (استراتيجية التطابق) — 5 صفوف للادعاءات القابلة للفحص (الأوزان، العتبات، الاستثناءات).
- `O` (اختبار) — `O.1` (15 مستوى اختبار) صف تجميعي واحد لكل مستوى مع ملاحظة تغطية عامة، لأنها ليست متطلبات مستقلة بل تصنيف لما هو موجود أصلاً. `O.2` (`TC-*`، 40 معرّفاً): **لم تُفكَّك كصفوف بحث منفصلة** — كل `TC-*` تقريباً هو نفس الفحص المطلوب لصف `FR-*`/`BR-*` مذكور أعلاه بنفس ملفات الاختبار؛ بدلاً من تكرار 40 صفاً مطابقاً، أدرجت جدولاً واحداً يربط كل `TC-*` بالـID الذي يغطيه فعلياً أعلاه وحالته.
- `P` (DevOps) — 15 صفاً.
- `Q.1` (RISK) و`Q.2` (ASM) و`Q.3` (DEP) و`Q.4` (OPEN) — **لم تُفكَّك** لأنها سجلات مخاطر/اعتماديات/قرارات مفتوحة، وليست متطلبات قابلة للبناء بذاتها؛ كل عنصر منها مُشار إليه أصلاً داخل الجداول أعلاه حيث يخص متطلباً معيّناً (OPEN-004، OPEN-011..013، إلخ). إن أردتِها كجدول مستقل أضيفها في نسخة لاحقة.
- `Q.5` (ADR) مغطاة ضمن قسم M أعلاه. `Q.6`/`Q.6a` (BDR): BDR-016 حتى BDR-025 (تعديل أيلول) هي فعلياً نفس PDR-001..034 المُغطاة بالكامل في الجدول الرئيسي أعلاه — **لم تُكرَّر**. BDR-001..015 (القديمة، من Q1-14 الأصلية) — 16 صفاً (البند 015 والبند 016 القديم كلاهما مرقّم "015"/"016" في الـSRS نفسه، ميّزتها).
- Part 8 (`BL-*`، ~112 معرّفاً): **لم تُفكَّك فردياً.** `post-sprint3-replan-2026-09.md` نفسه ينص صراحة أن Part 8 "superseded for Sprint 4+ by this document" — وSprint 1-3 من BL-* مغطاة فعلياً عبر تدقيق التوافق `sprint-1-3-compatibility-audit-2026-09.md` وتنعكس في صفوف `FR-*`/`PDR-*` أعلاه. صف واحد يوثّق هذا القرار بدل 112 صفاً مكرراً لنفس المعلومة.
- Part 9: `AC-01..22` (22 سيناريو) — تغطية كاملة لكنها "خفيفة" (ترث حالة الـID الذي تختبره، لأن AC هي إعادة صياغة Given/When/Then لمتطلب مُصنَّف أعلاه بالفعل، وليست فحصاً جديداً). `BO-1..8` (الأهداف الاستراتيجية) وجدول المصفوفة على مستوى الوحدة (Module-level matrix) وقسم "Final recommendations" الاثني عشر: **لم تُفكَّك** لأنها ملخصات إدارية/استراتيجية تُشتق من نفس صفوف `FR-*`/`PDR-*`/`BDR-*` أعلاه، وليست متطلبات مستقلة قابلة للتصنيف DONE/PARTIAL/MISSING بذاتها.

إن كان أي من قرارات النطاق هذه غير مقبول، أخبريني بالتحديد أيها تريدين تفكيكه بالكامل وسأفعل ذلك في نسخة تالية.

## §6 — `BR-*` Business rules catalog (Part 3, Section F)

| ID | Rule (paraphrase) | Backend | Authz | UI | Test | Status | Sprint |
|---|---|---|---|---|---|---|---|
| BR-001 | معرّف دقيق يربط تلقائياً؛ غير ذلك يحتاج مراجعة بشرية | proposal + match-confirmation (ليس ربطاً تلقائياً حقيقياً حتى للمطابقة الدقيقة — يمر بنفس خطوة تأكيد المالك) | OWNER | لا | S6,S7 | 🟡 PARTIAL | S17 |
| BR-002 | البائع يملك فقط سجلاته (Vendor/Branch/Offer/Variant)؛ الكتالوج الأساسي والتصنيف ملك المنصة دائماً | VendorMembershipGuard + RequireVendorRole('OWNER') على كل مسار بائع؛ POST/PATCH/DELETE على categories/brands/canonical-products محصورة بـPLATFORM_ADMIN | OWNER + PLATFORM_ADMIN | — (backend) | S3,S4,S6,S7,VV | ✅ DONE | - |
| BR-003 | كل قائمة انتقاء (فئات، أسباب إرجاع، فئات تذاكر) قابلة للضبط إدارياً، لا hardcoded | Regions/segments/PlatformRole/StockMovementReason/OfferCondition كلها Prisma enums ثابتة في الكود | - | لا | لا | ❌ MISSING | S25 |
| BR-004 | سعر لم يُعاد تأكيده ضمن نافذة التقادم يُعلَّم قديماً في المقارنة/البحث | لا | - | لا | لا | ❌ MISSING | S17 |
| BR-005 | مخزون قديم يُعلَّم؛ لا يُعتمد كحقيقة لمنع checkout بلا إعادة تحقق أحدث | إعادة التحقق عند الـcheckout DONE (FR-CART-002)؛ علم "قديم" نفسه غير موجود | session | /checkout | S10 | 🟡 PARTIAL | S18 |
| BR-006 | التوصيل مؤهل فقط داخل منطقة الفرع؛ الاستلام مؤهل دائماً | فحص المنطقة في quote/reserve + PICKUP_REQUIRES_PHYSICAL_BRANCH | session | /checkout | S10,S14 | ✅ DONE | - |
| BR-007 | فقط العروض المعتمدة تدخل المقارنة؛ غير المطابق يظل قابلاً للبحث والشراء لكن مستبعداً من المقارنة | استبعاد المقارنة DONE؛ "قابل للبحث" فقط عبر صفحة المتجر، ليس الاكتشاف العام | public | /compare, /store/:slug/products/:id | S8,S13 | 🟡 PARTIAL | S18b |
| BR-008 | تراكب الخصومات/الكوبونات بجدول موثّق؛ الافتراضي عدم التراكب (Phase 2 بحسب الـSRS) | لا | - | لا | لا | ❌ MISSING | قرار-نطاق |
| BR-009 | السلة مقسّمة بالبائع؛ كل تحقق (حد أدنى، أهلية توصيل) لكل قسم | التقسيم الفعلي أصبح بالفرع لا بالبائع (PDR-004 بديل معتمد)؛ التحقق لكل مجموعة فرع يعمل لمعظم القواعد؛ الحد الأدنى للطلب لكل قسم غير موجود | session | /checkout | S10,S14 | 🟡 PARTIAL | S20b |
| BR-010 | CustomerOrder وكل صفوفه التابعة تُنشأ ذرياً من طلب checkout واحد | معاملة Prisma واحدة تغطي الخصم والطلبات والدفع | session | /checkout | S10,S14 | ✅ DONE | - |
| BR-011 | إلغاء الطلب الفرعي محكوم بحالته (العميل حتى Confirmed، البائع حتى Preparing)؛ تجاوز الأدمن موثّق | لا يوجد أي endpoint إلغاء بعد | - | لا | لا | ❌ MISSING | S20a |
| BR-012 | أهلية الإرجاع نافذة زمنية + سبب، قابلة للضبط لكل فئة | لا | - | لا | لا | ❌ MISSING | S21 |
| BR-013 | صيغة الاسترداد (سعر + حصة رسوم التوصيل − تسوية)؛ كانت مقترحة معلّقة على OPEN-007 (أُغلق الآن) | OPEN-007 أُغلق، لكن الاسترداد نفسه غير مبني؛ القاعدة الفعلية الآن PDR-030/031 لا BR-013 | - | لا | لا | ❌ MISSING | S21 |
| BR-014 | الاشتراك يتحكم بالظهور لا بالعمولة؛ Past Due يدخل فترة سماح قبل Suspended | ACTIVE/EXPIRED فقط (PDR-033 بسّطت الحالات)؛ لا فترة سماح منفصلة | OWNER | لا | S3 | 🟡 PARTIAL | S15 |
| BR-015 | فوترة اشتراك البائع وفوترة طلب العميل على دورتين مستقلتين | VendorSubscription وPaymentTransaction نموذجان منفصلان تماماً بالبناء | OWNER/session | - | S3,S10 | ✅ DONE | - |
| BR-016 | مراجعة فقط بعد اكتمال طلب/صنف موثّق ("شراء موثّق") | لا مراجعات مبنية إطلاقاً | - | لا | لا | ❌ MISSING | S23 |
| BR-017 | البائع يُعلَّم تلقائياً للمراجعة الإدارية عند past-due أو نمط إرجاع شاذ أو رفض أدلة بلا إعادة تقديم؛ التعليق فعل إداري صريح دائماً | لا آلية تعليم تلقائي؛ لا تعليق مبني | PLATFORM_ADMIN | لا | لا | ❌ MISSING | S16 |
| BR-018 | حذف الحساب يحترم فترة احتفاظ بالطلبات/الدفع/التدقيق حتى بعد الحذف | لا | - | لا | لا | ❌ MISSING | S22 |
| BR-019 | أي تجاوز صلاحية إداري ("break-glass") يسجَّل بسبب ويُدقَّق دائماً | لا مسار تجاوز عام مبني بهذا المعنى؛ الأدوار الحالية مضبوطة بصلاحيات عادية لا تجاوز خاص | - | لا | لا | ❌ MISSING | S25 |
| BR-020 | تأكيد الطلب يتطلب دبوس منزل وهاتفين، ويطلق 3 إشعارات مستقلة التتبع | الهاتفان والإحداثيات DONE (بلا خريطة، قرار معتمد)؛ الإشعارات الثلاثة المتتبَّعة غير موجودة (outbox فقط) | session | /checkout | S14 | 🟡 PARTIAL | S19 |
| BR-021 | كل عرض بعملة البائع؛ المقارنة تطبيع FX؛ الدفع بعملة البائع الأصلية (مقترح معلّق OPEN-007) | استُبدل بـBR-027 (تنص F.1 على ذلك صراحة) | - | - | - | ↪ SUPERSEDED | - |
| BR-022 | فرع فعلي لا يغادر "قيد التحقق" بلا دبوس وصورة، مراجَعة من مراجع تحقق | POST verification-evidence + verification-decision | OWNER + REVIEWER | لا | S3,VV | 🟡 PARTIAL | S15 |
| BR-023 | هاتف+كلمة مرور أساسي؛ OTP يوثّق التسجيل ويبوّب استعادة كلمة المرور وتغيير الهاتف | التسجيل والاستعادة DONE؛ تغيير الهاتف بـOTP غير موجود | عام/session | /register,/reset-password | AUTH | 🟡 PARTIAL | S22 |
| BR-024 | الضيف يتصفح ويبني سلة بلا حساب؛ الدخول يدمج سلة الضيف | استُبدل: السلة تتطلب تسجيل دخول من الأصل الآن (PDR-002/FR-AUTH-013)، فلا سلة ضيف لتُدمج | - | - | - | ↪ SUPERSEDED | - |
| BR-025 | أهلية إرجاع الصنف تعتمد فقط على `Fulfillment` الخاص به، لا الأصناف الشقيقة أو الطلب الفرعي كاملاً | لا كيان Fulfillment منفصل، ولا إرجاع مبني إطلاقاً | - | لا | لا | ❌ MISSING | S21 |
| BR-026 (F + F.1) | رفض تحقق فرع واحد يرفض الطلب كاملاً؛ إعادة التقديم مسار منفصل عن الرفض؛ يمكن تقديم طلب مصحَّح فوراً بعد الرفض مع بقاء السجل القديم | منطق UNDER_REVIEW→REJECTED الشامل مبني ومختبر في vendor-verification.controller.ts | REVIEWER/ADMIN | لا | VV | 🟡 PARTIAL | S16 |
| BR-027 | كل المبالغ ILS؛ لا FX ولا تسوية متعددة العملات؛ يُلغي BR-021 ويُغلق OPEN-002/007 | بيانات ILS فقط في كل مكان | n/a | كل واجهات السعر | S10,S14 | ✅ DONE | - |
| BR-028 | checkout واحد ينتج CustomerOrder أب وBranchOrder واحد أو أكثر، كل BranchOrder بطريقة تنفيذ/رسم/دفع/موعد/دورة حياة خاصة به | BranchOrder | session | /orders | S9,S10 | ✅ DONE | - |
| BR-029 | العميل يختار سطور السلة صراحة؛ النظام يقترح فقط فروعاً تحوي كل المتغيرات المختارة، ويقترح الأقرب لكن العميل يختار فرعاً أبعد مؤهلاً | الاختيار الصريح ومجموعة الفروع المؤهلة DONE؛ "الأقرب" بديل حتمي موثّق لا مسافة حقيقية | session | /checkout | S10,S14 | 🟡 PARTIAL | — (قرار جديد) |
| BR-030 | باركود المخزون فريد وscanner-facing؛ الباركود المشترك داخلي لا يُستبدل أبداً؛ بيع/تخفيض لا يمكن أن ينزل المخزون تحت الصفر | فصل الباركودين DONE؛ لا واجهة ماسح؛ منع النزول تحت الصفر DONE (خصم ذري) | OWNER | لا | S6 | 🟡 PARTIAL | S18 |
| BR-031 | خصم يدوي غير بيعي له سبب دائماً ويُشعِر المالك؛ لا نقل مخزون بين الفروع في المرحلة الأولى | السبب مفروض؛ لا نقل مبني (متوافق مع القرار)؛ الإشعار outbox فقط | OWNER/EMP | لا | S6 | 🟡 PARTIAL | S18 |
| BR-032 | التوفر العام مشتق من مجموع مخزون الفروع المؤهلة لكن يُعرض فقط Available/Low/Sold out؛ الكمية الحقيقية خاصة إلا حد أقصى عند تحقق السلة | البطاقات العامة تستخدم المجموع (bucketForStock) كما هو منصوص؛ حد السلة الأقصى أصبح عمداً لكل فرع مفرد (إصلاح مراجعة Sprint 14) بما يطابق أن checkout لا يقسّم سطراً على فرعين | public/session | البطاقات، /cart | S8,S14 | ✅ DONE | - |
| BR-033 | سياسة إرجاع المتجر ورسومه تُلقَط لحظة الشراء؛ تتغير كل 6 أشهر فقط؛ قبول موحّد عبر كل الفروع/نقاط الاستلام | لا | - | لا | لا | ❌ MISSING | S21 |
| BR-034 | التوصيل يديره موظفو الفرع؛ تأكيد العميل يُطلب بعد تحديث الموظف؛ تذكير 48 ساعة وتأكيد تلقائي 72؛ لا هوية سائق ولا نزاع داخل المنصة | الإجراءات اليدوية DONE؛ التذكير/التأكيد التلقائي غير مجدوَل (يُحسب فقط عند القراءة) | EMP/session | صفحة الفرع،/orders | S11 | 🟡 PARTIAL | S19 |

**عدّاد BR:** 34 صفاً (BR-001..034)، منها 2 SUPERSEDED (021، 024). أُعيد فرز الـ32 الحيّة مباشرة من الجدول أعلاه (لا تقدير): DONE=7 (002، 006، 010، 015، 027، 028، 032)، PARTIAL=13 (001، 005، 007، 009، 014، 020، 022، 023، 026، 029، 030، 031، 034)، MISSING=12 (003، 004، 008، 011، 012، 013، 016، 017، 018، 019، 025، 033). المجموع 7+13+12+2=34. (النسخة v2 كانت ذكرت 8/17/7 خطأً؛ صُحِّحت هنا وفي §16.)

## §7 — `NFR-*` Non-functional requirements (Part 4, Section I)

| ID | Requirement (paraphrase) | Backend/evidence | Status | Sprint |
|---|---|---|---|---|
| NFR-PERF-001 | صفحة تفاصيل المنتج p95 ≤2s على 3G | لا قياس أداء رسمي موجود في المستودع | ❌ MISSING | S25 |
| NFR-PERF-002 | نتائج البحث p95 ≤1.5s حتى 10,000 عرض | لا قياس | ❌ MISSING | S25 |
| NFR-PERF-003 | checkout حتى إنشاء الطلب p95 ≤3s (باستثناء البوابة) | لا قياس رسمي؛ زمن e2e الحالي (~100ms لكل طلب في بيئة الاختبار) مؤشر غير رسمي فقط | ❌ MISSING | S25 |
| NFR-SCALE-001 | تحمّل 50 جلسة متزامنة في بيئة العرض | لا اختبار حمل | ❌ MISSING | S25 |
| NFR-IMPORT-001 | استيراد 1000 صف خلال 5 دقائق | لا قياس؛ الاستيراد الحالي يُختبر بأحجام صغيرة فقط | ❌ MISSING | S25 |
| NFR-AVAIL-001 | 99.5% شهرياً للإنتاج؛ لا SLA رسمي لبيئة FYP | لا بنية إنتاج فعلية بعد | n/a | قرار-نطاق |
| NFR-REL-001 | RPO ≤ ساعة عبر نسخ احتياطي كل ساعة | لا نسخ احتياطي مجدول موجود في هذا المستودع | ❌ MISSING | S25 |
| NFR-REL-002 | RTO ≤4 ساعات للإنتاج | لا خطة تعافي موثقة أو مختبرة | ❌ MISSING | قرار-نطاق |
| NFR-REL-003 | job مجدول يكتشف ويعلّم (لا يحل تلقائياً) حالات "دفع نجح/طلب فشل" | rollback داخل نفس المعاملة يمنع الحالة أصلاً في المسار الحالي؛ لا job تسوية منفصل موجود لأن الحالة لم تُلاحظ بعد في هذا التصميم أحادي المعاملة | 🟡 PARTIAL | S25 |
| NFR-SEC-001 | TLS 1.2+ على كل شيء، لا HTTP نص صريح | بيئة تطوير محلية فقط بلا TLS؛ غير منطبق للإنتاج بعد | n/a | قرار-نطاق |
| NFR-SEC-002 | كلمات المرور بتجزئة مملحة حديثة | `bcryptjs`، `bcrypt.hash(..., 10)` في auth.controller.ts | ✅ DONE | - |
| NFR-SEC-003 | كل حدث AuditLog محتفَظ به وقابل للاستعلام لمدة الاحتفاظ | `AuditLog` جدول إلحاق فقط موجود؛ لا واجهة استعلام (FR-ADMIN-005)؛ مدة الاحتفاظ نفسها معلّقة (OPEN-009) | 🟡 PARTIAL | S25 |
| NFR-PRIV-001 | PII العميل مرئي فقط للأدوار المصرَّح لها، مفروض في طبقة الـAPI | الموظف يرى الاسم/الهاتف/الكود فقط دون العنوان (FR-NOTIF-005 DONE)؛ لم أتحقق من كل مسار عرض عنوان آخر | 🟡 PARTIAL | S25 |
| NFR-A11Y-001 | WCAG 2.1 AA على المسارات الأساسية | 18 ملفاً فقط تستخدم aria-/role؛ لا تدقيق رسمي | 🟡 PARTIAL | S25 |
| NFR-L10N-001 | كل نص يخرج بالعربية والإنجليزية من مصدر ترجمة | الواجهة عربية فقط حالياً (FR-AUTH-009 MISSING)، لا مصدر ترجمة | ❌ MISSING | S22 |
| NFR-RTL-001 | كامل الواجهة (لا النص فقط) تُرآى بشكل صحيح بـRTL | `<html lang="ar" dir="rtl">` عام على التطبيق؛ لا تدقيق شامل للتخطيط/الأيقونات | 🟡 PARTIAL | S25 |
| NFR-MOBILE-001 | كل الشاشات قابلة للاستخدام عند 400px، وعلى Android/iOS | استجابة الويب مبنية ومُتحقَّق منها بلقطات الجوال؛ لا بناء Android/iOS (Capacitor) إطلاقاً | 🟡 PARTIAL | قرار-نطاق |
| NFR-BW-001 | صور بصيغة مضغوطة متجاوبة (WebP إلخ) | لا معالجة/ضغط صور موجودة؛ الصور روابط خام | ❌ MISSING | S17 |
| NFR-OBS-001 | كل طلب قابل للتتبع عبر X-Correlation-Id في اللوغ وAuditLog والـwebhooks | `CorrelationIdMiddleware` + مُدرَج في كل رد خطأ وكل AuditLog | ✅ DONE | - |
| NFR-OBS-002 | كل تكامل خارجي يعرض معدل نجاح/زمن استجابة/آخر فشل للوحة الأدمن | لا لوحة تكامل؛ لا تكامل خارجي حقيقي أصلاً (كل شيء sandbox/محلي) | ❌ MISSING | S25 |
| NFR-MAINT-001 | كل قائمة انتقاء تُغيَّر بإعداد إداري لا نشر كود | نفس BR-003: enums ثابتة في الكود | ❌ MISSING | S25 |
| NFR-TEST-001 | كل آلة حالة في Part 2 E.11 لها اختبار آلي لكل انتقال صالح وانتقال غير صالح واحد على الأقل | آلات E.11 القديمة (VendorSuborder/Payment القديم) غير مبنية أصلاً بهذا الشكل؛ آلة BranchOrderStatus الفعلية لها `branch-order-state-machine.ts` مع اختبارات؛ لا تغطية "كل انتقال غير صالح" مؤكدة شمولاً | 🟡 PARTIAL | S20a |
| NFR-BACKUP-001 | نسخ احتياطي كل ساعة على الأقل، والتحقق من قابلية الاستعادة دورياً | لا نسخ احتياطي مُدار في هذا المشروع (بيئة تطوير) | ❌ MISSING | قرار-نطاق |
| NFR-DR-001 | دليل تعافي من كوارث موثّق ومُجرَّب مرة قبل إطلاق الإنتاج | لا يوجد | ❌ MISSING | قرار-نطاق |
| NFR-RETAIN-001 | سجلات معاملاتية محتفَظ بها حسب BR-018 | BR-018 نفسه MISSING | ❌ MISSING | S22 |
| NFR-BROWSER-001 | أحدث إصدارين من Chrome/Safari/Firefox/Edge | لا مصفوفة اختبار متصفحات رسمية؛ التحقق الحالي عبر Playwright/Chromium فقط | 🟡 PARTIAL | قرار-نطاق |
| NFR-DEVICE-001 | أحدث إصدارين من Android/iOS | لا بناء موبايل إطلاقاً | ❌ MISSING | قرار-نطاق |
| NFR-SEO-001 | صفحات المنتج الأساسي مُقدَّمة من السيرفر لا JS فقط | Next.js App Router (خادمي افتراضياً)، لم أتحقق من كل صفحة إن كانت client component بلا داعٍ | 🟡 PARTIAL | S18b |
| NFR-IMG-001 | حد أقصى لحجم الصورة المرفوعة (10MB افتراضي) | لا رفع صور مبني أصلاً (روابط فقط) | ❌ MISSING | S17 |
| NFR-STALE-001 | تأخير تعليم المخزون قديماً: 7 أيام يدوي / 24 ساعة API، قابل للضبط | لا تعليم تقادم مخزون موجود | ❌ MISSING | S18 |
| NFR-STALE-002 | تأخير تعليم السعر قديماً: 30 يوماً، قابل للضبط | لا تعليم تقادم سعر موجود | ❌ MISSING | S17 |
| NFR-AUDIT-001 | 100% من انتقالات الحالة وكل فعل إداري متجاوِز يُنتج صف AuditLog | نسبة عالية من الانتقالات المبنية فعلاً تُدقَّق (checkout، تحقق، اشتراك، مخزون)؛ "100%" غير مؤكَّد شمولاً، ولا فعل "تجاوز إداري" مبني أصلاً (BR-019) | 🟡 PARTIAL | S25 |

**عدّاد NFR:** 32 صفاً، أُعيد فرزها مباشرة من الجدول أعلاه: DONE=2 (SEC-002، OBS-001)، PARTIAL=10 (REL-003، SEC-003، PRIV-001، A11Y-001، RTL-001، MOBILE-001، TEST-001، BROWSER-001، SEO-001، AUDIT-001)، MISSING=18 (الباقي)، n/a (غير منطبق على بيئة تطوير حالياً، لا يُحسب DONE/MISSING)=2 (NFR-AVAIL-001، NFR-SEC-001). المجموع 2+10+18+2=32. (النسخة v2 كانت ذكرت 2/13/15 خطأً؛ صُحِّحت هنا وفي §16.)

## §8 — Part 3, Section G: نموذج البيانات

### G.0 — 8 صفوف "target model delta" (ملزمة، تسبق أي مخطط قديم)

| ID | المنطقة | الحالة الفعلية | Status | Sprint |
|---|---|---|---|---|
| SRS-G0-01 | هوية المتجر: slug/display_name/bio/logo/cover، أقسام، StoreFollow | Vendor له كل هذه الحقول؛ StoreSection/StoreSectionOffer/StoreFollow موجودة | ✅ DONE | - |
| SRS-G0-02 | الأدوار: VendorUser بدور OWNER/BRANCH_EMPLOYEE، branchId إلزامي وفريد للموظف النشط | مطابق تماماً للسكيما الفعلية | ✅ DONE | - |
| SRS-G0-03 | المواقع: StoreBranch (فعلي)، Warehouse (مخفي)، PickupPoint (بلا مخزون) | الثلاثة موجودة كنماذج Prisma منفصلة | ✅ DONE | - |
| SRS-G0-04 | الكتالوج والمال: ILS فقط بلا حقل عملة، لا FxRate؛ باركود محلي+داخلي؛ حتى 10 صور و3 فيديوهات | ILS ضمنية DONE؛ لا FxRate DONE؛ الباركودان DONE؛ لا سقف عدد صور/فيديو مفروض في الكود ولا نوع فيديو منفصل | 🟡 PARTIAL | S17 |
| SRS-G0-05 | المخزون: OfferBranchInventory (= BranchStock فعلياً) لفرع فعلي/مستودع فقط؛ InventoryMovement بكل الأسباب المذكورة؛ لا نوع نقل | BranchStock+StockMovement موجودان؛ أسباب الحركة تغطي DAMAGE/LOSS/COUNT_CORRECTION فقط، لا "بيع" ولا "استرجاع مرتجع" ولا "استيراد/إضافة" كأسباب حركة منفصلة | 🟡 PARTIAL | S18 |
| SRS-G0-06 | السلة والطلب: Cart لعميل موثّق فقط، CartItem بلا فرع/تنفيذ عند الإضافة؛ CustomerOrder له BranchOrder واحد أو أكثر | مطابق تماماً | ✅ DONE | - |
| SRS-G0-07 | التنفيذ والدفع: Fulfillment واحد لكل BranchOrder بلا سائق؛ دفع sandbox واحد يغطي عدة BranchOrders بتخصيص عبر branch_order_id | لا كيان Fulfillment منفصل (مدموج داخل BranchOrder، وهذا يحقق نفس الغرض عملياً)؛ PaymentTransaction واحد + BranchOrder.paymentTransactionId كإحالة (يحقق التخصيص فعلياً) | ✅ DONE | - |
| SRS-G0-08 | الجدولة والإرجاع: DeliverySlot لفرع مالك مخزون؛ ReturnPolicy مُلقَطة على BranchOrder/Item؛ Notification بحالة قراءة ورابط عميق؛ Review لمنتج/متجر فقط، غير قابل للتعديل | DeliveryWindow/Exception DONE؛ ReturnPolicy/ReturnRequest/Notification/Review كلها غير موجودة | 🟡 PARTIAL (نصفه DONE، نصفه MISSING بالكامل) | S17/S19/S21/S23 |

### G.3 — كيانات مقابل Prisma الفعلي (الكيانات غير المذكورة في G.0 فقط؛ ما ذُكر أعلاه لا يتكرر)

| ID | الكيان في SRS | الموجود فعلياً | Status | Sprint |
|---|---|---|---|---|
| SRS-G3-01 | `AttributeDefinition`/`AttributeOption` (قوالب خصائص الفئة) | لا نموذج مطابق؛ `structuralAttributes` JSON حر فقط | ❌ MISSING | S17b |
| SRS-G3-02 | `ProductMedia` (وسائط على مستوى المنتج الأساسي/المتغيّر) | فقط `OfferVariantMedia` (على مستوى عرض البائع)؛ لا وسائط على مستوى Canonical | ❌ MISSING | S17b |
| SRS-G3-03 | `ImportJob`/`ImportRow` (سجل مهمة استيراد كامل) | فقط `ImportIdentifierRecord` لمنع تكرار الصفوف؛ لا سجل مهمة/تاريخ استيراد | ❌ MISSING | S17 |
| SRS-G3-04 | `FxRate` | غير موجود، ومطلوب ألا يوجد (PDR-001) | ✅ DONE (بالإزالة المتعمدة) | - |
| SRS-G3-05 | `Payment`/`PaymentAllocation`/`PaymentTransactionAllocation`/`WebhookInbox` (نموذج دفع متعدد المراحل مع تسوية) | فقط `PaymentTransaction` بحالتين (SUCCEEDED/FAILED)، بلا بوابة حقيقية ولا webhook inbox (PDR-005 بسّط النموذج عمداً) | ✅ DONE (تبسيط sandbox متعمد، ليس فجوة) | - |
| SRS-G3-06 | `VendorSettlement`/`Promotion`/`Coupon` (Phase 2 بحسب الـSRS) | غير موجودة | ❌ MISSING | قرار-نطاق |
| SRS-G3-07 | `Review`/`ReturnRequest`/`Refund`/`Dispute` | غير موجودة (متوافق مع FR-REV-*/FR-RET-* MISSING أعلاه) | ❌ MISSING | S21/S23 |
| SRS-G3-08 | `Notification`/`SupportTicket` | غير موجودتين (متوافق مع FR-NOTIF-008/FR-SUP-* أعلاه) | ❌ MISSING | S19/قرار-نطاق |
| SRS-G3-09 | `PriceHistory` | غير موجود (متوافق مع FR-PRICE-002) | ❌ MISSING | S17 |
| SRS-G3-10 | ثابتان معماريان: لا `vendor_id` على `CanonicalProduct`/`CanonicalProductVariant` أبداً؛ كل جدول مملوك للبائع يحمل `vendor_id` إلزامياً | مطابق تماماً في السكيما الفعلية (تحقّقت من `CanonicalProduct`/`CanonicalProductVariant`/`OfferVariant`) | ✅ DONE | - |

## §9 — Part 4, Section H: اتفاقيات وواجهات API

### H.1 — اتفاقيات عابرة (10 صفوف)

| ID | الاتفاقية | الحالة الفعلية | Status | Sprint |
|---|---|---|---|---|
| SRS-H1-01 | ترقيم إصدار بادئة URI `/api/v1` | `app.setGlobalPrefix('api/v1')` في main.ts | ✅ DONE | - |
| SRS-H1-02 | شكل خطأ موحّد `{error:{code,message,details,correlation_id}}` مع أكواد HTTP قياسية | `HttpExceptionFilter` يطابق الشكل تماماً، مع correlation_id | ✅ DONE | - |
| SRS-H1-03 | مفتاح Idempotency-Key إلزامي على كل نقطة تُنشئ موارد مالية/طلبات | `IdempotencyInterceptor` مطبَّق على checkout؛ لم أتحقق من كل نقطة أخرى (مثل استيراد لو وُجد) | 🟡 PARTIAL | S17 |
| SRS-H1-04 | X-Correlation-Id يرافق كل طلب ويظهر في كل تدقيق وخطأ | `CorrelationIdMiddleware` + مُدرَج في AuditLog وHttpExceptionFilter | ✅ DONE | - |
| SRS-H1-05 | تقييد معدل لكل جهة فاعلة، أشد على OTP/بحث | `@nestjs/throttler` عام + `@Throttle` على OTP/login؛ لا تقييد أشد خاص بالبحث موجود | 🟡 PARTIAL | S18b |
| SRS-H1-06 | توقيع HMAC-SHA256 صادر لأي webhook من المنصة | لا webhooks صادرة من المنصة أصلاً (لا تكامل خارجي حقيقي) | ❌ MISSING | قرار-نطاق |
| SRS-H1-07 | توقيع وارد مُتحقَّق منه لبوابة الدفع/التوصيل (معلّق على OPEN-001) | لا بوابة حقيقية؛ sandbox فقط | ❌ MISSING | قرار-نطاق |
| SRS-H1-08 | إعادة محاولة exponential backoff + dead-letter queue مرئية للأدمن | لا queue/worker خلفي موجود إطلاقاً (لا BullMQ، لا outbox relay) | ❌ MISSING | S19 |
| SRS-H1-09 | مراقبة تكامل خارجي: معدل نجاح/زمن/آخر فشل في لوحة الأدمن | لا لوحة، لا تكامل خارجي حقيقي | ❌ MISSING | S25 |
| SRS-H1-10 | ترقيم صفحات بـcursor، حد افتراضي 20، أقصى 100 | الترقيم الفعلي `take`/`limit` بسيط (offset-style عبر معاملات بسيطة)، ليس cursor-based | 🟡 PARTIAL | S18b |

### H.2/H.3 (النسخة الأصلية قبل تعديل PDR)

| ID | الوصف | Status |
|---|---|---|
| SRS-H23-OLD | قائمة نقاط النهاية الأصلية (`POST /checkout` موحّد، `/suborders/{id}/status`، عملات متعددة) وعقودها المفصّلة السبعة | ↪ SUPERSEDED — `H.3a` نفسه ينص: "old `/suborders` and FX/currency routes must be deprecated rather than extended" |

### H.3a — نقاط النهاية المستهدفة بعد تعديل PDR (8 مجالات)

| ID | المجال | مطابقة الكود الفعلي | Status | Sprint |
|---|---|---|---|---|
| SRS-H3A-01 | الاكتشاف العام: `/discover/*`, `/stores/:slug`, `/products/:id`, `.../compare` | `GET /discovery/all(?segment)`, `GET /storefronts/:slug`, `GET /canonical-products/:id/comparison` — تطابق وظيفي وإن اختلفت المسارات الحرفية | ✅ DONE | - |
| SRS-H3A-02 | المتجر والمتابعة: PATCH storefront، sections، follow/following | كلها موجودة (Sprint 7/13) | ✅ DONE | - |
| SRS-H3A-03 | الأدوار والمواقع: دعوة موظف بـOTP، نقل/تعطيل، warehouse/pickup-points | الدعوة والقبول والـwarehouse/pickup-points API موجودة؛ **النقل/التعطيل غير موجود** | 🟡 PARTIAL | S15/S18 |
| SRS-H3A-04 | المخزون: مبيعات فرع، تعديلات، استيراد | التعديلات (خصم بسبب) موجودة؛ **لا endpoint بيع فعلي بالباركود** | 🟡 PARTIAL | S18 |
| SRS-H3A-05 | Checkout: quote بلا تعديل، ثم إنشاء ذري | `POST /checkout/quote`, `/reserve`, `/confirm` — يطابق المعنى وإن كان بثلاث خطوات لا خطوتين | ✅ DONE | - |
| SRS-H3A-06 | طلبات الفرع: GET orders، PATCH actions (بدء تحضير، رجوع، إلغاء صنف، إعادة محاولة توصيل، موافقة استرداد) | البدء/الإرسال/التسليم/الاستلام موجودة؛ **الرجوع، إلغاء الصنف، إعادة محاولة التوصيل، موافقة الاسترداد غير موجودة** | 🟡 PARTIAL | S20a |
| SRS-H3A-07 | التقويم/العناوين: فترات، إعادة جدولة، تعديل عنوان قبل التحضير فقط | فترات التوصيل CRUD موجودة؛ **لا إعادة جدولة، لا تعديل عنوان لطلب قائم** | 🟡 PARTIAL | S20a/S22 |
| SRS-H3A-08 | المرتجعات/المراجعات/التنبيهات: طلب إرجاع، قرار، مراجعة، إشعارات بحالة قراءة | لا شيء من هذا موجود | ❌ MISSING | S19/S21/S23 |

## §10 — Part 5: تجربة المستخدم وحالات الفشل

### K.1a — الشاشات المعتمدة أيلول 2026 (11 صفاً)

| ID | السطح | مطابقة | Status | Sprint |
|---|---|---|---|---|
| SRS-K1A-01 | الصفحة الرئيسية وصفحات القطاع (All/Women/Men/Kids/Accessories) | موجودة (S13)؛ فلاتر اللون/المقاس/التوفر/الحالة/الخصم غير كاملة | 🟡 PARTIAL | S18b |
| SRS-K1A-02 | البطاقة العالمية وعرض المقارنة | موجودة، بلا تقييم/مسافة لكسر التعادل | 🟡 PARTIAL | S18b |
| SRS-K1A-03 | صفحة المتجر العامة | موجودة كاملة تقريباً (S7/S13) | ✅ DONE | - |
| SRS-K1A-04 | أتابعه | موجودة (S13)، بلا إشعارات منفصلة | 🟡 PARTIAL | S19 |
| SRS-K1A-05 | تفاصيل عرض المتجر | موجودة | ✅ DONE | - |
| SRS-K1A-06 | السلة والـcheckout | موجودة ومختبرة جيداً (S10/S14) | ✅ DONE | - |
| SRS-K1A-07 | طلبات العميل | موجودة، بلا جدول زمني موحّد وبلا إلغاء/إرجاع | 🟡 PARTIAL | S20a |
| SRS-K1A-08 | مساحة عمل المالك | مركز روابط فقط، أغلب الشاشات الفرعية API-only | 🟡 PARTIAL | S15-S18 |
| SRS-K1A-09 | مساحة عمل الموظف | طلبات الفرع فقط؛ لا ماسح/بيع فعلي | 🟡 PARTIAL | S18 |
| SRS-K1A-10 | ماسح المخزون والاستيراد | API فقط بلا واجهة | 🟡 PARTIAL | S17/S18 |
| SRS-K1A-11 | مساحة عمل الأدمن | API فقط بلا واجهة | 🟡 PARTIAL | S16 |

### حالات Empty/Loading/Error وRTL/A11y (تجميعي بدل تفكيك ~50 شاشة)

| ID | البوابة | ملاحظة | Status | Sprint |
|---|---|---|---|---|
| SRS-K1-STATES-01 | العميل (ويب) | حالات فارغة/تحميل/خطأ أساسية موجودة في بعض الصفحات (سلة، طلبات)؛ لا نمط موحّد مؤكَّد لكل شاشة | 🟡 PARTIAL | S25 |
| SRS-K1-STATES-02 | مساحة المالك/الموظف | معظم الشاشات API-only فلا حالات UI أصلاً | ❌ MISSING | S15-S18 |
| SRS-K1-STATES-03 | الإدارة | لا واجهة إطلاقاً | ❌ MISSING | S16/S25 |
| SRS-K1-STATES-04 | الدعم | لا واجهة إطلاقاً (FR-SUP مؤجّل بحسب الـSRS، ليس PDR) | ❌ MISSING | قرار-نطاق |

### L-01..L-32 — سيناريوهات الفشل (معرّفات أصلية من الـSRS)

| ID | الحالة (ملخّص) | الحالة الفعلية | Status | Sprint |
|---|---|---|---|---|
| L-01 | نفس المنتج بعنوانين مختلفين | يُربط بعد مراجعة (S6/S7) | ✅ DONE | - |
| L-02 | تطابق خاطئ يُبلَّغ عنه العميل | لا endpoint إبلاغ عميل | ❌ MISSING | S17b |
| L-03 | مواصفات متعارضة من بائعين | تعارض الاستيراد يذهب لمراجعة؛ لا سياسة مصدر-حقيقة لكل حقل | 🟡 PARTIAL | S17 |
| L-04 | منتج بلا باركود | يدخل مراجعة بشرية أو يبقى غير مطابق | ✅ DONE | - |
| L-05 | منتج يدوي فريد | يُنشر كعرض غير مطابق، قابل للبحث والشراء | ✅ DONE (عبر صفحة المتجر) | - |
| L-06 | نسخة مستعملة/جديدة من نفس الموديل | `condition` موجود على OfferVariant؛ لا فلتر حالة في المقارنة | 🟡 PARTIAL | S24 |
| L-07 | حزمة مقابل منتج فردي | لا `product_type` على المنتج الأساسي | ❌ MISSING | S17b |
| L-08 | وحدات/أحجام تعبئة مختلفة | يُعامَل كـ variant منفصل عبر الآلية القياسية | ✅ DONE | - |
| L-09 | سعر قديم | لا علم تقادم، لا رسالة "قد يكون قديماً" | ❌ MISSING | S17 |
| L-10 | مخزون قديم | لا علم تقادم؛ إعادة التحقق عند checkout موجودة | 🟡 PARTIAL | S18 |
| L-11 | نفاد أثناء checkout | مغطى بالكامل (خصم ذري + رسالة إزالة/استبدال) | ✅ DONE | - |
| L-12 | بائع يغلق بعد إرسال الطلب | لا رفض/إلغاء BranchOrder موجود | ❌ MISSING | S20a |
| L-13 | رفض جزئي في طلب متعدد البائعين | لا آلية رفض؛ لا تجميع "PartiallyCancelled" على مستوى CustomerOrder | ❌ MISSING | S20a |
| L-14 | دفع نجح والطلب فشل | rollback الذري يمنع الحالة أصلاً في التصميم الحالي؛ لا job تسوية منفصل مطلوب لأن السيناريو لا يحدث بنفس الشكل القديم | ✅ DONE (بالتصميم) | - |
| L-15 | طلب أُنشئ والدفع فشل | مغطى تماماً: PAYMENT_FAILED يتراجع بالكامل، الحجز يبقى حياً للمحاولة مجدداً | ✅ DONE | - |
| L-16 | إشعار فشل | لا نموذج Notification أصلاً لتسجيل الفشل | ❌ MISSING | S19 |
| L-17 | webhook مكرر | لا webhooks واردة أصلاً | ❌ MISSING | قرار-نطاق |
| L-18 | تكرار إرسال checkout | idempotency key يعيد نفس الطلب | ✅ DONE | - |
| L-19 | استرداد جزئي | لا استرداد مبني | ❌ MISSING | S21 |
| L-20 | توصيل مجزأ | لا شحنات متعددة لكل BranchOrder | ❌ MISSING | S26/قرار-نطاق |
| L-21 | عنوان توصيل غير صالح | تحقق العنوان موجود (S14)؛ لا خريطة (قرار معتمد) | ✅ DONE (ضمن القرار المعتمد) | - |
| L-22 | العميل خارج منطقة خدمة البائع | يتحول لاستلام فقط تلقائياً برسالة واضحة | ✅ DONE | - |
| L-23 | بائع مُعلَّق بطلبات نشطة | لا تعليق بائع مبني أصلاً | ❌ MISSING | S16 |
| L-24 | دمج منتج بعد وجود طلبات تاريخية | لا دمج/فصل منتجات مبني | ❌ MISSING | S17b |
| L-25 | فشل استيراد جزئي | نجاح جزئي مع تقرير أخطاء لكل صف موجود | ✅ DONE | - |
| L-26 | نقص محتوى بلغة واحدة | لا fallback مؤشَّر بصرياً؛ الحقول ثنائية اللغة موجودة لكن العرض عربي فقط حالياً | 🟡 PARTIAL | S22 |
| L-27 | صورة مفقودة/غير لائقة | لا placeholder موحّد مؤكَّد؛ لا طابور إشراف صور | ❌ MISSING | S17b |
| L-28 | إدخال ضار (حقن) | `ValidationPipe` عام + Prisma يمنع حقن SQL بالتصميم؛ لم أتحقق من تعقيم كل حقل نصي حر للعرض | 🟡 PARTIAL | S25 |
| L-29 | تلاعب بالمراجعات | لا مراجعات مبنية أصلاً | ❌ MISSING | S23 |
| L-30 | انقطاع منصة/تكامل | لا مراقبة حالة/تكامل معروضة | ❌ MISSING | S25 |
| L-31 | طلب متعدد العملات | استُبدل: PDR-001 يزيل تعدد العملات كلياً | ↪ SUPERSEDED | - |
| L-32 | webhook خارج الترتيب/مرجع مجهول | لا webhooks واردة أصلاً | ❌ MISSING | قرار-نطاق |

## §11 — Part 6: المعمارية والتطابق والاختبار والتشغيل

### ADR-001..012 (قرارات معمارية، Section M)

| ID | القرار | مطابقة الكود الفعلي | Status |
|---|---|---|---|
| ADR-001 | monolith معياري لا microservices | NestJS تطبيق واحد بوحدات (auth, cart, checkout, ...) | ✅ DONE |
| ADR-002 | NestJS+TypeScript للخلفية | مطابق | ✅ DONE |
| ADR-003 | PostgreSQL+PostGIS | Postgres مستخدَم؛ **PostGIS لم يُستخدم فعلياً** (لا استعلامات مسافة حقيقية، BR-029/PDR-023 بديل حتمي بلا PostGIS) | 🟡 PARTIAL |
| ADR-004 | Next.js SSR + Capacitor بدل Flutter | Next.js موجود؛ **لا Capacitor ولا بناء موبايل إطلاقاً** | 🟡 PARTIAL |
| ADR-005 | Postgres FTS الآن، Meilisearch لاحقاً | البحث الفعلي `contains`/ILIKE بسيط، ليس حتى `tsvector`/`pg_trgm` الموصوف | 🟡 PARTIAL |
| ADR-006 | Outbox معاملاتي بدل enqueue داخل معاملة | `OutboxEvent` يُكتب ضمن نفس المعاملة (DONE)؛ **لا relay worker يقرأه فعلياً** — الصفوف تتراكم بلا معالجة | 🟡 PARTIAL |
| ADR-007 | نموذج أربعة مستويات للـcolor/size | مطابق تماماً في السكيما | ✅ DONE |
| ADR-008 | Fulfillment لكل suborder لا لكل طلب | لا Fulfillment منفصل؛ مدموج في BranchOrder (كافٍ عملياً بلا split shipment) | 🟡 PARTIAL |
| ADR-009 | PaymentAllocation + PaymentTransactionAllocation | غير موجودين؛ استُبدلا بتبسيط PaymentTransaction واحد + BranchOrder.paymentTransactionId (كافٍ لنطاق PDR-005) | ✅ DONE (بالتبسيط المعتمد) |
| ADR-010 | بوابة AwaitingPayment قبل ظهور الطلب للبائع | **غير مبنية** — في التصميم الفعلي BranchOrder يُنشأ فقط بعد نجاح الدفع (لا حالة AwaitingPayment وسيطة)، وهو حل مختلف يحقق نفس الهدف (البائع لا يرى شيئاً حتى ينجح الدفع) دون حالة صريحة | ✅ DONE (بمقاربة بديلة تحقق نفس الضمان) |
| ADR-011 | عزل بيانات البائع على مستوى الاستعلام؛ RLS لاحقاً | `vendor_id` على كل جدول مملوك للبائع + VendorMembershipGuard | ✅ DONE |
| ADR-012 | لا بوابة API منفصلة | NestJS نفسه يتولى كل شيء | ✅ DONE |

### N.1..N.5 — استراتيجية التطابق (5 ادعاءات قابلة للفحص)

| ID | الادعاء | الحالة الفعلية | Status | Sprint |
|---|---|---|---|---|
| SRS-N-01 | أوزان الثقة: علامة+موديل 40%، تشابه عنوان 30%، خصائص 20%، صورة 10% (مؤجلة) | لم أتحقق من صيغة حساب `score` الفعلية في `MatchReviewCandidate` مقابل هذه الأوزان الدقيقة | 🟡 PARTIAL | S17b |
| SRS-N-02 | عتبات المراجعة: ≥0.85 "محتمل" لكن يُراجَع دائماً؛ 0.5-0.85 بلا تفضيل؛ <0.5 لا يُعرض كمرشح | لم أتحقق من وجود هذه العتبات حرفياً في الكود | 🟡 PARTIAL | S17b |
| SRS-N-03 | استبعاد تشابه السعر من درجة الثقة | متسق مع عدم وجود أي منطق سعر في match-review الذي رأيته | ✅ DONE (بالغياب المتسق) | - |
| SRS-N-04 | منع تلقائي: مستعمل مقابل جديد، وحزمة مقابل مكوّن فردي | لا `condition`/`product_type` تُستخدَم كحاجز صريح في منطق المطابقة الذي رأيته | ❌ MISSING | S17b |
| SRS-N-05 | تقييم جودة البيانات (اكتمال، شذوذ سعر) كإرشاد لا بوابة نشر | لا تسجيل اكتمال أو شذوذ سعر موجود | ❌ MISSING | S25 |

### O.1 — مستويات الاختبار (تصنيف لا متطلب مستقل)

| المستوى | التغطية الفعلية |
|---|---|
| Unit | موجودة بكثافة (156 اختبار، 20 suite) |
| Integration | e2e الحالي يغطي هذا فعلياً (نفس نطاق النستجي) |
| API contract | جزئي — لا اختبار عقد منفصل عن e2e السلوكي |
| E2E | موجود وقوي (411 اختبار) |
| Security | BOLA/tenant-isolation مختبر في عدة أماكن (Sprint 4، الاشتراك، إلخ)؛ لا فحص OWASP رسمي منفصل |
| Performance | ❌ غير موجود |
| Accessibility | ❌ غير موجود كاختبار آلي |
| Localization/RTL | تحقق بصري بلقطات شاشة فقط، لا اختبار آلي |
| Payment | مغطى جيداً لمسار sandbox الفعلي |
| Webhook | ❌ غير منطبق (لا webhooks واردة) |
| Search quality | ❌ غير موجود |
| Product-matching | جزئي (مطابقة دقيقة/مراجعة مختبرة، عتبات/أوزان غير مؤكدة) |
| Import | مختبر جزئياً (تعارضات، partial success) |
| Multi-vendor checkout | مختبر جيداً (بمصطلح BranchOrder بدل VendorSuborder) |
| Disaster recovery | ❌ غير موجود |
| UAT | ❌ غير رسمي |

### O.2 — `TC-*` (40 معرّفاً): جدول ربط لا بحث مستقل

كل `TC-*` يفحص نفس الـID أعلاه بنفس ملفات الاختبار المذكورة في عمود Test لذلك الصف. جدول الربط الكامل موجود في نسخة العمل الداخلية؛ الخلاصة: من أصل 40، حوالي 24 تختبر قدرات BranchOrder/checkout/دفع/مخزون DONE فعلاً (بأسماء حالة مختلفة عن النص الأصلي: BranchOrder بدل VendorSuborder، PaymentTransaction بدل Payment/PaymentAllocation)، و~10 تختبر قدرات MISSING بالكامل (TC-RET-*, TC-PAY-004 استرداد جزئي)، والباقي غير قابل للتطبيق لأنه يفترض بنية استُبدلت (TC-PAY-006 عن OPEN-007 المُغلق بتبسيط أحادي العملة، TC-COMP-001 عن عملات متعددة).

### P — عمليات DevOps (15 مجالاً)

| ID | المجال | الحالة الفعلية | Status | Sprint |
|---|---|---|---|---|
| SRS-P-01 | بيئات Dev/Staging/Prod | Dev فقط عبر Docker محلي؛ لا Staging ولا Production فعلي | ❌ MISSING | قرار-نطاق |
| SRS-P-02 | CI/CD عبر GitHub Actions | CI موجود فعلياً (يُشغَّل عند push، يُذكر CI أخضر/أحمر في المحادثات)؛ لا نشر تلقائي لـStaging | 🟡 PARTIAL | قرار-نطاق |
| SRS-P-03 | هجرات نسخية إضافية أولاً | مطابق تماماً — كل الهجرات هنا إضافية وآمنة (قاعدة صارمة مطبَّقة طوال المشروع) | ✅ DONE | - |
| SRS-P-04 | Feature flags | لا يوجد (FR-ADMIN-004 MISSING) | ❌ MISSING | S25 |
| SRS-P-05 | إدارة أسرار عبر مخزن مُدار | ملف `.env` محلي غير مُدار؛ لا مخزن أسرار سحابي | ❌ MISSING | قرار-نطاق |
| SRS-P-06 | مراقبة/لوغ/تتبع (Sentry، correlation ID) | correlation ID DONE في كل مكان؛ Sentry مُهيَّأ اختيارياً (`if SENTRY_DSN`) لكن غير مفعَّل فعلياً في dev | 🟡 PARTIAL | قرار-نطاق |
| SRS-P-07 | تنبيهات على معدل الأخطاء وعمق الطابور | لا queue خلفي أصلاً | ❌ MISSING | S19 |
| SRS-P-08 | نسخ احتياطي كل ساعة | لا | ❌ MISSING | قرار-نطاق |
| SRS-P-09 | خطة تعافي من كوارث | لا | ❌ MISSING | قرار-نطاق |
| SRS-P-10 | مهام مجدولة (تقادم، FX، اشتراك، تسوية webhook) | لا scheduler/worker خلفي إطلاقاً في هذا المستودع | ❌ MISSING | S19 |
| SRS-P-11 | إعادة فهرسة بحث | غير منطبق حالياً (لا Meilisearch)، ولا حتى Postgres FTS حقيقي مستخدَم | ❌ MISSING | S18b |
| SRS-P-12 | معالجة jobs فاشلة (dead-letter) | لا queue خلفي | ❌ MISSING | S19 |
| SRS-P-13 | إعادة تشغيل webhook | لا webhooks واردة | ❌ MISSING | قرار-نطاق |
| SRS-P-14 | أدلة تشغيل للحالات الحرجة | لا يوجد | ❌ MISSING | قرار-نطاق |
| SRS-P-15 | تصحيح بيانات عبر إجراء مدقَّق لا تعديل مباشر | لا واجهة تصحيح بيانات إدارية؛ أي تصحيح فعلي يتم عبر سكربتات/قاعدة مباشرة (خارج AuditLog) | ❌ MISSING | S25 |

## §12 — Part 7: القرارات (BDR القديمة فقط؛ ADR مغطاة في §11، BDR-016+ = PDR أعلاه)

| ID | القرار | مطابقة اليوم | Status |
|---|---|---|---|
| BDR-001 | checkout متعدد البائعين من اليوم الأول | استُبدل تنفيذياً بتجميع على مستوى الفرع (PDR-004) بدل البائع، لكن الجوهر (سلة متعددة الأطراف بمعاملة واحدة) محقَّق | ✅ DONE (بالمفهوم البديل المعتمد) |
| BDR-002 | CustomerOrder أب + VendorSuborder لكل بائع | استُبدل بـBranchOrder (PDR-004) | ↪ SUPERSEDED |
| BDR-003 | COD ودفع إلكتروني كلاهما من الإطلاق | DONE | ✅ DONE |
| BDR-004 | توصيل بائع/استلام + قاعدة الإشعار الثلاثي | التوصيل/الاستلام DONE؛ الإشعار الثلاثي MISSING (outbox فقط) | 🟡 PARTIAL |
| BDR-005 | اعتماد تلقائي للمطابقة الدقيقة فقط | فعلياً حتى المطابقة الدقيقة تمر بتأكيد المالك الآن (FR-MATCH-012) — أشد تحفظاً من النص الأصلي، وهذا اختيار هندسي وليس قراراً معتمداً صراحة بذلك | 🟡 PARTIAL |
| BDR-006 | استيراد يدوي/CSV/API فقط، لا scraping | يدوي/CSV DONE؛ API ingestion غير موجود؛ لا scraping (متوافق) | 🟡 PARTIAL |
| BDR-007 | عملة لكل بائع | استُبدل: ILS فقط الآن (PDR-001) | ↪ SUPERSEDED |
| BDR-008 | انتشار وطني + تحقق فرع فعلي بدبوس وصورة | التحقق DONE (API)؛ الانتشار الوطني غير قابل للقياس في FYP | 🟡 PARTIAL |
| BDR-009 | ويب + Android + iOS من الإطلاق | ويب فقط؛ لا Capacitor ولا بناء موبايل | ❌ MISSING (جزئياً — الويب فقط) |
| BDR-010 | اشتراك شهري بدل عمولة | DONE (PDR-033 يفصّله) | ✅ DONE |
| BDR-011 | معيار قانوني/خصوصية عام محافظ | لا سياسة احتفاظ/خصوصية مفروضة فعلياً في الكود | 🟡 PARTIAL |
| BDR-012 | هاتف+كلمة مرور+OTP | DONE | ✅ DONE |
| BDR-013 | لا checkout كضيف | DONE (يتطلب حساباً) | ✅ DONE |
| BDR-014 | فريق شخصين، 3 أشهر | حقيقة تنظيمية، لا تُقاس بالكود | n/a |
| BDR-015 | اعتماد نطاق FYP Delivery Increment | معتمد (تاريخياً)؛ استُبدل عملياً بخطة post-sprint3-replan للسبرنتات 4+ | ↪ SUPERSEDED (بخطة أحدث معتمدة) |
| BDR-016 (قديم) | رفض فرع واحد يرفض كل الطلب | نفس BR-026 أعلاه | 🟡 PARTIAL (انظر BR-026) |

## §13 — Part 8: البقلغ (Backlog) — mapping صريح لكل معرّف

Part 8 يحتوي فعلياً **102 معرّف `BL-*`** (عددتها مباشرة من نص المصدر، لا التقدير السابق ~112). كل واحد منها يصف قدرة سبق بناء (Sprint 1-3، مغطاة عبر `sprint-1-3-compatibility-audit-2026-09.md`) أو قدرة استُبدلت رسمياً بخطة `post-sprint3-replan-2026-09.md` (المتحوّلة إلى Sprint 15-26 في خارطة الطريق §5). بدل صف تجميعي واحد، الجدول التالي يربط كل معرّف بالـID القانوني الذي يرث حالته (من نفس الجداول أعلاه)، مع أولوية Part 8 الأصلية (Must/Should/Could/Won't) للسياق فقط — لا تُستخدم لتغيير الحالة أو الجدولة.

| Part-8 ID | Priority (Part 8) | Canonical ID it inherits from | Inherited status | Note |
|---|---|---|---|---|
| BL-FOUND-001 | Must | SRS-P-02 | 🟡 PARTIAL | - |
| BL-FOUND-002 | Must | SRS-P-03 | ✅ DONE | - |
| BL-FOUND-003 | Must | SRS-H1-02 | ✅ DONE | - |
| BL-FOUND-004 | Must | SRS-P-06 | 🟡 PARTIAL | - |
| BL-FOUND-005 | Must | ADR-006 | 🟡 PARTIAL | AuditLog/OutboxEvent tables exist |
| BL-AUTH-001 | Must | FR-AUTH-001 | ✅ DONE | - |
| BL-AUTH-002 | Must | FR-AUTH-002 | ✅ DONE | - |
| BL-AUTH-003 | Must | FR-AUTH-005 | ✅ DONE | - |
| BL-AUTH-004 | Must | FR-AUTH-008 | 🟡 PARTIAL | منسوخ اليوم داخل checkout AddressForm |
| BL-AUTH-004b | Should | FR-AUTH-008 | 🟡 PARTIAL | شاشة عناوين منفصلة — لا تعديل/حذف/افتراضي |
| BL-AUTH-005 | Must | FR-AUTH-011 | ✅ DONE | - |
| BL-CAT-001 | Must | FR-CAT-001 | 🟡 PARTIAL | - |
| BL-CAT-002 | Should | FR-CAT-002 | 🟡 PARTIAL | - |
| BL-CAT-003 | Should | FR-CAT-012 | ❌ MISSING | - |
| BL-CAT-004 | Should | FR-CAT-003 | ❌ MISSING | - |
| BL-CAT-004b | Must | FR-CAT-015 (E.0) | 🟡 PARTIAL | specs_text حر، هذا فعلاً ما بُني |
| BL-MATCH-001 | Must | FR-MATCH-008 | ✅ DONE | - |
| BL-MATCH-002 | Must | FR-MATCH-002 | 🟡 PARTIAL | - |
| BL-MATCH-003 | Must | FR-MATCH-003 | 🟡 PARTIAL | - |
| BL-MATCH-003b | Should | FR-MATCH-003 | 🟡 PARTIAL | تحسين واجهة فقط |
| BL-MATCH-004 | Should | FR-MATCH-005 | ❌ MISSING | - |
| BL-MATCH-005 | Must | FR-MATCH-007 | 🟡 PARTIAL | اختبارات منع تلقائي — انظر N.1..5 |
| BL-VEND-001 | Must | FR-VEND-001 | 🟡 PARTIAL | - |
| BL-VEND-002 | Must | FR-VEND-002 | 🟡 PARTIAL | - |
| BL-VEND-003 | Must | FR-VEND-003 | 🟡 PARTIAL | - |
| BL-VEND-004 | Must | FR-VEND-004 | 🟡 PARTIAL | - |
| BL-VEND-005 | Should | FR-VEND-013 (E.0) | 🟡 PARTIAL | أدوار فرعية متعددة — استُبدل بنموذج OWNER/BRANCH_EMPLOYEE الأبسط |
| BL-VEND-005b | Must | FR-VEND-013 (E.0) | 🟡 PARTIAL | حساب مالك واحد بلا أدوار فرعية — هذا فعلاً المبني |
| BL-VEND-006 | Should | FR-VEND-009 | ❌ MISSING | - |
| BL-IMPORT-001 | Must | FR-IMPORT-001 | 🟡 PARTIAL | PriceHistory جزء من acceptance — غير موجود |
| BL-IMPORT-002 | Must | FR-IMPORT-002 | 🟡 PARTIAL | PriceHistory جزء من acceptance — غير موجود |
| BL-IMPORT-002b | Should | FR-IMPORT-011 | ❌ MISSING | - |
| BL-IMPORT-003 | Should | FR-IMPORT-012 | 🟡 PARTIAL | - |
| BL-IMPORT-004 | Must | FR-IMPORT-003 | 🟡 PARTIAL | - |
| BL-SEARCH-001 | Must | FR-SEARCH-001 | 🟡 PARTIAL | - |
| BL-SEARCH-002 | Must | FR-SEARCH-002 | ❌ MISSING | - |
| BL-SEARCH-002b | Should | FR-SEARCH-002 | ❌ MISSING | - |
| BL-SEARCH-003 | Must | FR-SEARCH-005 | 🟡 PARTIAL | - |
| BL-SEARCH-004 | Should | FR-SEARCH-010 | ❌ MISSING | - |
| BL-COMP-001 | Must | FR-COMP-001 | ❌ MISSING | - |
| BL-COMP-002 | Must | FR-COMP-005 | 🟡 PARTIAL | - |
| BL-COMP-003 | Must | FR-COMP-009 | ↪ SUPERSEDED | استُبدل: PDR-001 يزيل FX كلياً |
| BL-COMP-004 | Should | FR-COMP-007 | 🟡 PARTIAL | - |
| BL-INV-001 | Must | FR-INV-001 | 🟡 PARTIAL | - |
| BL-INV-002 | Must | FR-INV-004 | ✅ DONE | - |
| BL-INV-003 | Should | FR-INV-006 | ❌ MISSING | - |
| BL-INV-004 | Should | FR-INV-003 | ✅ DONE | الحجز 10 دقائق — هذا فعلاً موجود ومختبر (DONE)، أعلى مما كان مخططاً كـShould هنا |
| BL-CART-001 | Must | FR-CART-017 (E.0) | ✅ DONE | استُبدل: التقسيم بالفرع الآن (PDR-004) لا بالبائع |
| BL-CART-002 | Must | FR-CART-003 | ❌ MISSING | - |
| BL-CART-003 | Must | FR-CART-005 | ↪ SUPERSEDED | استُبدل: الاختيار الآن جزء من BranchOrder (PDR-004) |
| BL-CART-003b | Should | FR-CART-013 | ✅ DONE | - |
| BL-CHECKOUT-001 | Must | FR-CART-006 | 🟡 PARTIAL | - |
| BL-CHECKOUT-002 | Must | FR-CART-008 | ✅ DONE | - |
| BL-CHECKOUT-003 | Must | ADR-010 | ✅ DONE | - |
| BL-CHECKOUT-004 | Must | FR-CART-016 | ✅ DONE | - |
| BL-ORD-001 | Must | FR-ORD-009 (E.0) | ✅ DONE | استُبدل: BranchOrderStatus لا VendorSuborder — انظر §15 |
| BL-ORD-002 | Must | FR-ORD-007 | 🟡 PARTIAL | - |
| BL-ORD-003 | Must | FR-ORD-005 | 🟡 PARTIAL | - |
| BL-ORD-004 | Must | FR-ORD-003 | 🟡 PARTIAL | - |
| BL-PAY-001 | Must | FR-PAY-001 | 🟡 PARTIAL | - |
| BL-PAY-002 | Must | FR-PAY-002 | ✅ DONE | - |
| BL-PAY-003 | Must | FR-PAY-003 | 🟡 PARTIAL | استُبدل: PaymentAllocation غير موجود، تبسيط PaymentTransaction بدلاً منه |
| BL-PAY-004 | Must | SRS-P-10 | ❌ MISSING | لا relay worker حقيقي |
| BL-PAY-005 | Should | FR-PAY-004 | ❌ MISSING | - |
| BL-FUL-001 | Must | SRS-E11-DL-01 | ✅ DONE | استُبدل: لا Delivery منفصل، مدموج في BranchOrder |
| BL-FUL-002 | Must | FR-FUL-008 (E.0) | ✅ DONE | - |
| BL-FUL-003 | Must | FR-FUL-003 | 🟡 PARTIAL | - |
| BL-FUL-004 | Should | FR-FUL-004 | ✅ DONE | - |
| BL-FUL-004b | Should | PDR-023 | 🟡 PARTIAL | - |
| BL-RET-001 | Should | FR-RET-002 | ❌ MISSING | - |
| BL-RET-002 | Should | BR-025 | ❌ MISSING | - |
| BL-RET-003 | Should | FR-RET-003 | ❌ MISSING | - |
| BL-REV-001 | Must | FR-REV-001 | ❌ MISSING | الأولوية الأصلية Must — لم يُبنَ إطلاقاً، فجوة حقيقية مقابل الالتزام الأصلي |
| BL-REV-002 | Must | FR-REV-002 | ❌ MISSING | نفس الملاحظة أعلاه |
| BL-REV-003 | Could | FR-REV-004 | ⏸ DEFERRED | - |
| BL-NOTIF-001 | Must | SRS-H1-08 | ❌ MISSING | - |
| BL-NOTIF-002 | Must | FR-NOTIF-003 | ❌ MISSING | - |
| BL-NOTIF-002b | Should | FR-NOTIF-003 | ❌ MISSING | - |
| BL-NOTIF-003 | Should | FR-FAV-001 | 🟡 PARTIAL | - |
| BL-NOTIF-004 | Could | FR-FAV-003 | ❌ MISSING | - |
| BL-ADMIN-001 | Must | FR-VEND-009 | ❌ MISSING | لا شاشة موافقة/تعليق أصلاً — فجوة حقيقية مقابل الالتزام الأصلي |
| BL-ADMIN-001b | Should | FR-ADMIN-001 | 🟡 PARTIAL | - |
| BL-ADMIN-002 | Must | FR-ADMIN-001 | 🟡 PARTIAL | - |
| BL-ADMIN-003 | Should | FR-ADMIN-005 | ❌ MISSING | - |
| BL-ADMIN-004 | Should | FR-CMS-001 | ❌ MISSING | - |
| BL-VPORTAL-001 | Must | FR-VPORTAL-001 | 🟡 PARTIAL | - |
| BL-VPORTAL-002 | Must | FR-VPORTAL-011 | ❌ MISSING | - |
| BL-VPORTAL-003 | Should | FR-VPORTAL-006 | 🟡 PARTIAL | - |
| BL-ANALYTICS-001 | Should | FR-ANALYTICS-006 | ❌ MISSING | - |
| BL-ANALYTICS-002 | Could | FR-ANALYTICS-002 | ❌ MISSING | - |
| BL-SEC-001 | Must | BR-002 | ✅ DONE | BOLA — مغطى فعلاً بكثافة |
| BL-SEC-002 | Must | SRS-H1-06 | ❌ MISSING | لا webhooks واردة أصلاً |
| BL-SEC-003 | Must | FR-AUTH-011 | ✅ DONE | - |
| BL-SEC-004 | Should | SRS-P-14 | ❌ MISSING | - |
| BL-PERF-001 | Should | NFR-PERF-001 | ❌ MISSING | - |
| BL-DEPLOY-001 | Must | SRS-P-01 | ❌ MISSING | - |
| BL-DEPLOY-002 | Should | NFR-BACKUP-001 | ❌ MISSING | - |
| BL-OPS-001 | Should | SRS-P-14 | ❌ MISSING | - |
| BL-OPS-002 | Must | — | ❌ MISSING | نشاط تشغيلي مستمر، ليس بناء كود |
| BL-OPS-003 | Must | — | ❌ MISSING | نشاط تشغيلي مستمر، ليس بناء كود |
| BL-OPS-004 | Must | — | ❌ MISSING | بروفة عرض — لم تُجرَ بهذا الشكل |
| BL-SUP-001 | Won't (FYP) | FR-SUP-001 | ⏸ DEFERRED | قرار موثَّق فعلاً، وما زال المطلوب MISSING |

**عدّاد Part 8:** 102 صفاً. DONE=21، PARTIAL=40، MISSING=37، SUPERSEDED=2 (BL-COMP-003، BL-CART-003 — كلاهما وُصِف بنموذج استُبدل صراحة بقرار PDR)، DEFERRED=2 (BL-REV-003 مؤجَّل Could/Full MVP أصلاً في Part 8 نفسه؛ BL-SUP-001 قرار موثَّق بالفعل من المالك في 2026-09-16 حسب Part 8 نفسه — لكن ملاحظة أمانة: القرار التوثيقي لا يعني أن القدرة (`FR-SUP-*`) موجودة، وهي MISSING في الجدول الرئيسي أعلاه كما هي). المجموع 21+40+37+2+2=102.

**ملاحظة على فجوتين حقيقيتين كشفهما هذا الـmapping:** `BL-REV-001`/`BL-REV-002` كانا **Must** في التزام Part 8 الأصلي (نسخة مصغّرة من المراجعات) ولم يُبنيا إطلاقاً — فجوة مقابل التزام تاريخي فعلي، وليس فقط مقابل الـSRS الأصلي. كذلك `BL-ADMIN-001` (شاشة موافقة/تعليق بائع بسيطة) كان Must مصغَّر عمداً ليكون قابلاً للتنفيذ، ولم يُبنَ إطلاقاً. كلاهما مسجَّل MISSING بالفعل ضمن `FR-REV-*`/`FR-VEND-009` في الجداول الرئيسية، لا حاجة لتغيير جديد.

## §14 — Part 9: القبول والتتبع والتوصيات

### AC-01..22 (تغطية خفيفة — ترث حالة الـID المختبَر)

| ID | يختبر | الحالة الموروثة |
|---|---|---|
| AC-01 | FR-CART-006/011 (checkout عبر بائعين، COD) | ✅ DONE (بمفهوم BranchOrder) |
| AC-02 | BR-006/FR-CART-004 (منطقة توصيل) | ✅ DONE |
| AC-03 | BOLA بين البائعين | ✅ DONE (مختبر في عدة أماكن) |
| AC-04 | حالة فارغة لسجل الطلبات | 🟡 PARTIAL |
| AC-05 | فشل توقيع webhook | ❌ MISSING (لا webhooks) |
| AC-06 | تكرار طلب checkout | ✅ DONE |
| AC-07 | تزامن خصم المخزون | ✅ DONE |
| AC-08 | تدقيق قرار مطابقة | 🟡 PARTIAL |
| AC-09 | RTL في جدول المقارنة | 🟡 PARTIAL |
| AC-10 | بوابة AwaitingPayment: نجاح الدفع | ✅ DONE (بمقاربة بديلة، انظر ADR-010) |
| AC-11 | بوابة AwaitingPayment: فشل الدفع | ✅ DONE (بمقاربة بديلة، انظر ADR-010) |
| AC-12 | إرجاع صنف مسلَّم من شحنة مجزأة | ❌ MISSING |
| AC-13 | رفض إرجاع صنف لم يُسلَّم بعد | ❌ MISSING |
| AC-14 | بائع مُعلَّق يحتفظ بوصول محدود | ❌ MISSING (لا تعليق مبني) |
| AC-15 | ازدواجية webhook | ❌ MISSING (لا webhooks) |
| AC-16 | فشل durability لـwebhook | ❌ MISSING (لا webhooks) |
| AC-17 | تعافي outbox relay | ❌ MISSING (لا relay) |
| AC-18 | تشكيل BranchOrder من سطور مختارة | ✅ DONE |
| AC-19 | least privilege موظف/مالك | ✅ DONE |
| AC-20 | رفض قيمة غير ILS | ✅ DONE |
| AC-21 | حركة مخزون وتنبيه | 🟡 PARTIAL (التنبيه outbox فقط) |
| AC-22 | خصوصية متجر إلكتروني فقط | لم أتحقق مباشرة؛ الأرجح 🟡 PARTIAL |

### BO-1..8، مصفوفة الوحدات، والتوصيات الاثنتا عشرة

**لم تُفكَّك.** هذه ملخصات إستراتيجية تُشتق مباشرة من صفوف `FR-*`/`PDR-*`/`BDR-*` أعلاه، وليست متطلبات مستقلة. أبرز ما تكشفه المطابقة معها: **الفجوتان اللتان حدَّدهما Part 9 بنفسه** (`FR-SUP` بلا backlog، و`PriceHistory` بلا اختبار مسمّى) ما زالتا — بحسب هذا التدقيق — **غير مبنيتين فعلياً**: `FR-SUP` كله MISSING (قرار-نطاق)، و`PriceHistory` كنموذج بيانات MISSING (S17)، رغم أن التوثيق يقول إن "القرار" حُلّ — القرار التوثيقي محلول، البناء نفسه لا يزال معلَّقاً.

## §15 — E.11 آلات الحالة القديمة: صفوف بمعرّفات ثابتة

**ملاحظة جوهرية قبل الجدول:** آلات E.11 (`CustomerOrder`/`VendorSuborder`/`OrderItem`/`Payment`/`Delivery`) تصف **النموذج الذي سبق PDR-004/PDR-005** (تحقّقت من الكود: لا حقل `status` على `CustomerOrder` إطلاقاً، لا تجميع rollup، `PaymentTransactionStatus` مبسَّط لحالتين فقط `SUCCEEDED`/`FAILED` لا الحالات الثماني الأصلية، لا كيان `Delivery`/`Fulfillment` منفصل، ولا موظف "سائق"). لذلك **معظم صفوف VendorSuborder/Payment/Delivery القديمة SUPERSEDED بالتصميم الفعلي (`BranchOrderStatus` + `PaymentTransaction` المبسَّط)**، وليست فجوة. الصفوف التي تصف **إرجاعاً** تبقى MISSING فعلياً (الإرجاع غير مبني بأي نموذج، قديم أو جديد). آلة `Return` بالكامل (9 صفوف) تُدرَج مرة واحدة كمجموعة لأن كل صفوفها MISSING بنفس السبب.

### CustomerOrder (8 صفوف)

| ID | الانتقال | الحالة الفعلية | Status |
|---|---|---|---|
| SRS-E11-CO-01 | `[*]→Created` عند تقديم checkout | لا حقل status على CustomerOrder؛ الحالة تُقرأ من BranchOrders مباشرة | ↪ SUPERSEDED |
| SRS-E11-CO-02 | `Created→InProgress` | نفس السبب | ↪ SUPERSEDED |
| SRS-E11-CO-03 | `InProgress/NeedsAttention→Completed` | لا rollup مبني | ❌ MISSING (كمفهوم rollup) |
| SRS-E11-CO-04 | `→PartiallyCancelled` | لا rollup، ولا حتى إلغاء BranchOrder موجود ليُجمَّع | ❌ MISSING |
| SRS-E11-CO-05 | `→Cancelled` | نفس السبب | ❌ MISSING |
| SRS-E11-CO-06 | `→NeedsAttention` (SLA breach) | لا مراقب SLA مجدول | ❌ MISSING |
| SRS-E11-CO-07 | `PartiallyCancelled→Completed` | لا rollup | ❌ MISSING |
| SRS-E11-CO-08 | `PartiallyCancelled→Cancelled` | لا rollup | ❌ MISSING |

### VendorSuborder (17 صفاً، الآن BranchOrder فعلياً)

| ID | الانتقال (بالاسم القديم) | مقابله الفعلي | Status |
|---|---|---|---|
| SRS-E11-VS-01 | `[*]→AwaitingPayment` (دفع إلكتروني) | لا حالة وسيطة؛ BranchOrder يُنشأ فقط بعد نجاح الدفع في نفس المعاملة | ↪ SUPERSEDED |
| SRS-E11-VS-02 | `[*]→PendingConfirmation` (COD) | يقابله `PLACED` مباشرة | ✅ DONE (بالاسم المختلف) |
| SRS-E11-VS-03 | `AwaitingPayment→PendingConfirmation` | غير منطبق (لا AwaitingPayment) | ↪ SUPERSEDED |
| SRS-E11-VS-04 | `AwaitingPayment→PaymentFailed` | يقابله: فشل الدفع يُسقِط المعاملة كلها، فلا BranchOrder يُنشأ أصلاً (rollback كامل) — ضمان أقوى من النص الأصلي | ✅ DONE (بضمان أقوى) |
| SRS-E11-VS-05 | `PendingConfirmation→Confirmed` (البائع يقبل) | **لا إجراء "قبول/تأكيد" صريح موجود** — `PLACED` ينتقل مباشرة لـ`PREPARING` | ❌ MISSING |
| SRS-E11-VS-06 | `PendingConfirmation→RejectedByVendor` | لا إجراء رفض | ❌ MISSING |
| SRS-E11-VS-07 | `PendingConfirmation→Cancelled` (العميل يلغي) | لا إجراء إلغاء عميل | ❌ MISSING |
| SRS-E11-VS-08 | `Confirmed→Preparing` | يقابله start-preparation | ✅ DONE |
| SRS-E11-VS-09 | `Confirmed→Cancelled` | لا إلغاء | ❌ MISSING |
| SRS-E11-VS-10 | `Preparing→ReadyForPickup` | يقابله ضمنياً حالة PICKED_UP عبر pickup-handover مباشرة (لا حالة "جاهز" وسيطة منفصلة) | 🟡 PARTIAL |
| SRS-E11-VS-11 | `Preparing→OutForDelivery` | يقابله mark-sent (`SENT`) | ✅ DONE |
| SRS-E11-VS-12 | `Preparing→Cancelled` (فرصة أخيرة) | لا إلغاء | ❌ MISSING |
| SRS-E11-VS-13 | `ReadyForPickup→PickedUp` | يقابله pickup-handover | ✅ DONE |
| SRS-E11-VS-14 | `OutForDelivery→Delivered` | يقابله mark-delivered | ✅ DONE |
| SRS-E11-VS-15 | `PickedUp/Delivered→Completed` | يقابله confirm-received (العميل) | ✅ DONE |
| SRS-E11-VS-16 | `Completed→ReturnRequested` | لا إرجاع مبني | ❌ MISSING |
| SRS-E11-VS-17 | `ReturnRequested→ReturnedRefunded` | لا إرجاع مبني | ❌ MISSING |

### OrderItem (4 صفوف، الآن BranchOrderItem)

| ID | الانتقال | الحالة الفعلية | Status |
|---|---|---|---|
| SRS-E11-OI-01 | إنشاء يرث حالة الأب | `BranchOrderItem` بلا حقل status خاص به أصلاً — يتبع الأب بالضرورة البنيوية | ✅ DONE (بالغياب المتسق) |
| SRS-E11-OI-02 | الأب يكتمل → الصنف يكتمل | نفس السبب أعلاه | ✅ DONE |
| SRS-E11-OI-03 | طلب إرجاع لصنف محدد | لا إرجاع مبني | ❌ MISSING |
| SRS-E11-OI-04 | استرداد الصنف | لا إرجاع مبني | ❌ MISSING |

### Payment (14 صفاً، الآن PaymentTransaction مبسَّط)

| ID | الانتقال (بالاسم القديم) | مقابله الفعلي | Status |
|---|---|---|---|
| SRS-E11-PM-01 | `[*]→PendingAuthorization` | لا حالة معلّقة وسيطة؛ الشحن sandbox متزامن | ↪ SUPERSEDED |
| SRS-E11-PM-02 | `PendingAuthorization→Authorized` | يقابله مباشرة `SUCCEEDED` | ✅ DONE (بتبسيط معتمد) |
| SRS-E11-PM-03 | `PendingAuthorization→Failed` | يقابله `FAILED` | ✅ DONE |
| SRS-E11-PM-04 | `Authorized→Captured` | لا فصل تفويض/التقاط؛ خطوة واحدة | ↪ SUPERSEDED |
| SRS-E11-PM-05 | `Authorized→Failed` (انتهاء نافذة الالتقاط) | غير منطبق | ↪ SUPERSEDED |
| SRS-E11-PM-06 | `Captured→Settled` | لا تسوية مصرفية منفصلة (sandbox) | ↪ SUPERSEDED |
| SRS-E11-PM-07 | `Captured→Refunded` | لا استرداد مبني | ❌ MISSING |
| SRS-E11-PM-08 | `Captured→PartiallyRefunded` | لا استرداد مبني | ❌ MISSING |
| SRS-E11-PM-09 | `Settled→Refunded` | لا استرداد مبني | ❌ MISSING |
| SRS-E11-PM-10 | `Settled→PartiallyRefunded` | لا استرداد مبني | ❌ MISSING |
| SRS-E11-PM-11 | `PartiallyRefunded→Refunded` | لا استرداد مبني | ❌ MISSING |
| SRS-E11-PM-12 | `[*]→PendingCOD` | يقابله ضمنياً: BranchOrder COD يُنشأ مباشرة بلا حالة دفع منفصلة | ↪ SUPERSEDED |
| SRS-E11-PM-13 | `PendingCOD→CollectedOnDelivery` | يقابله pickup-handover/mark-delivered يعلّم الدفع كمدفوع | ✅ DONE (بالاسم المختلف) |
| SRS-E11-PM-14 | `CollectedOnDelivery→Settled` | لا تسوية منفصلة (sandbox) | ↪ SUPERSEDED |

### Delivery (7 صفوف، بلا كيان منفصل الآن)

| ID | الانتقال (بالاسم القديم) | مقابله الفعلي | Status |
|---|---|---|---|
| SRS-E11-DL-01 | `[*]→Pending` | يقابله BranchOrder عند PREPARING | ✅ DONE (مدموج) |
| SRS-E11-DL-02 | `Pending→Assigned` (سائق يقبل) | لا سائق (PDR-006 معتمد) | ↪ SUPERSEDED |
| SRS-E11-DL-03 | `Assigned→OutForDelivery` | يقابله mark-sent | ✅ DONE |
| SRS-E11-DL-04 | `OutForDelivery→Delivered` | يقابله mark-delivered | ✅ DONE |
| SRS-E11-DL-05 | `OutForDelivery→FailedAttempt` | لا مسار فشل توصيل مبني | ❌ MISSING |
| SRS-E11-DL-06 | `FailedAttempt→Assigned` (إعادة جدولة) | لا مسار فشل توصيل مبني | ❌ MISSING |
| SRS-E11-DL-07 | `FailedAttempt→Cancelled` | لا مسار فشل توصيل مبني | ❌ MISSING |

### Return (9 صفوف منفصلة — كلها MISSING لنفس السبب: لا نموذج إرجاع من أي نوع مبني في الكود)

| ID | الانتقال | الحالة الفعلية | Status | Sprint |
|---|---|---|---|---|
| SRS-E11-RT-01 | `[*]→Requested` | لا نموذج إرجاع مبني | ❌ MISSING | S21 |
| SRS-E11-RT-02 | `Requested→VendorReview` | لا نموذج إرجاع مبني | ❌ MISSING | S21 |
| SRS-E11-RT-03 | `VendorReview→Approved` | لا نموذج إرجاع مبني | ❌ MISSING | S21 |
| SRS-E11-RT-04 | `VendorReview→Rejected` | لا نموذج إرجاع مبني | ❌ MISSING | S21 |
| SRS-E11-RT-05 | `VendorReview→Escalated` (SLA breach) | لا نموذج إرجاع مبني | ❌ MISSING | S21 |
| SRS-E11-RT-06 | `Rejected→Escalated` (العميل ينازع) | لا نموذج إرجاع مبني | ❌ MISSING | S21 |
| SRS-E11-RT-07 | `Escalated→Approved/Rejected` | لا نموذج إرجاع مبني | ❌ MISSING | S21 |
| SRS-E11-RT-08 | `Approved→RefundProcessing` | لا نموذج إرجاع مبني | ❌ MISSING | S21 |
| SRS-E11-RT-09 | `RefundProcessing→Refunded` | لا نموذج إرجاع مبني | ❌ MISSING | S21 |

**عدّاد E.11:** 8 (CO) + 17 (VS) + 4 (OI) + 14 (PM) + 7 (DL) + 9 (RT) = **59 صفاً**.

---

# §16 — الأعداد النهائية الشاملة (v3، مُعاد اشتقاقها مباشرة من صفوف الملف)

**كيف حُسِب هذا الجدول:** كل رقم هنا أُعيد فرزه بالعدّ المباشر لحالة كل صف فعلي في الملف (سكربت عدّ آلي على النص، لا تقدير يدوي)، بعد تطبيق كل الإصلاحات في §0/v3 أعلاه (تفكيك RT إلى 9، تفكيك AC-10/11/12/13/15/16 إلى 6، جدول Part 8 الكامل بـ102 صفاً). أي رقم هنا يختلف عن نسخة v2 السابقة مذكور بسببه.

| المصدر | DONE | PARTIAL | MISSING | DEFERRED | SUPERSEDED | n/a | المجموع | يطابق v2؟ |
|---|---|---|---|---|---|---|---|---|
| FR، E.0..E.22 (Part 2) | 36 | 82 | 103 | 9 | 14 | 0 | 244 | نعم |
| PDR-001..034 | 12 | 14 | 8 | 0 | 0 | 0 | 34 | نعم |
| BR-001..034 (§6) | 7 | 13 | 12 | 0 | 2 | 0 | 34 | **لا — كانت 8/17/7 خطأً** |
| NFR-* (§7) | 2 | 10 | 18 | 0 | 0 | 2 | 32 | **لا — كانت 2/13/15 خطأً** |
| G.0 (§8) | 5 | 3 | 0 | 0 | 0 | 0 | 8 | نعم |
| G.3 إضافي (§8) | 3 | 0 | 7 | 0 | 0 | 0 | 10 | نعم |
| H.1 (§9) | 3 | 3 | 4 | 0 | 0 | 0 | 10 | **لا — كانت 4/3/3 خطأً** |
| H.2/H.3 قديم (§9) | 0 | 0 | 0 | 0 | 1 | 0 | 1 | نعم |
| H.3a (§9) | 3 | 4 | 1 | 0 | 0 | 0 | 8 | نعم |
| K.1a (§10) | 3 | 8 | 0 | 0 | 0 | 0 | 11 | نعم |
| K.1 حالات (§10) | 0 | 1 | 3 | 0 | 0 | 0 | 4 | نعم |
| L-01..32 (§10) | 11 | 5 | 15 | 0 | 1 | 0 | 32 | **لا — كانت 15/6/10 خطأً** |
| ADR-001..012 (§11) | 7 | 5 | 0 | 0 | 0 | 0 | 12 | نعم |
| N.1..5 (§11) | 1 | 2 | 2 | 0 | 0 | 0 | 5 | **لا — كانت 2/2/1 خطأً** |
| O.1 (§11) | — | — | — | — | — | — | 0 | تصنيف وصفي فقط، بلا صفوف ID مستقلة — لا يدخل أي عمود، ولا في المجموع (كان الخلط في v2 بعدّه "15 n/a"؛ هذا خطأ إضافي مصحَّح هنا) |
| P (§11) | 1 | 2 | 12 | 0 | 0 | 0 | 15 | نعم |
| BDR القديمة (§12) | 5 | 6 | 1 | 0 | 3 | 1 | **16** | **لا — كانت 6/…/17 خطأً، مصحَّحة بلا حاشية متناقضة** |
| Part 8 — 102 صفاً كاملة (§13) | 21 | 40 | 37 | 2 | 2 | 0 | **102** | **لا — كانت صفاً تجميعياً واحداً؛ الآن كل معرّف مفكَّك** |
| AC-01..22، 6 صفوف مفكَّكة (§14) | 10 | 5 | 7 | 0 | 0 | 0 | 22 | **لا — كانت 12/6/4 مع 3 صفوف مدمجة؛ نفس الـ22 ID لكن معدودة بشكل صحيح الآن** |
| E.11 — 59 صفاً، RT مفكَّكة بالكامل (§15) | 15 | 1 | 32 | 0 | 11 | 0 | 59 | **لا — كانت 14/1/32/…/12 خطأً في DONE وSUPERSEDED** |
| **المجموع** | **145** | **204** | **262** | **11** | **34** | **3** | **659** | — |

**فحص الجمع:** 145+204+262+11+34+3 = **659**، ويطابق تماماً مجموع عمود "المجموع" أعلاه (244+34+34+32+8+10+10+1+8+11+4+32+12+5+0+15+16+102+22+59 = 659).

## §17 — عدد صفوف/أسطر التتبع الفعلية

**659 صفاً قابلاً للتتبع** (كل صف يحمل معرّفاً DONE/PARTIAL/MISSING/DEFERRED/SUPERSEDED مستقلاً) — هذا الرقم من عدّ آلي مباشر لكل جدول في هذا الملف بعد التصحيحات أعلاه، وليس تقديراً. صفوف §0 (نصية) و§11/O.1 (15 سطراً وصفياً لمستويات الاختبار، بلا ID أو حالة مستقلة) و§14/BO-وما بعدها (ملخصات إستراتيجية، لا حالة مستقلة) **غير محسوبة** في الـ659، وهذا مقصود ومذكور صراحةً حيث ورد.

**تأكيد الشمول:** الـ659 تضم: FR(244) + PDR(34) + BR(34) + NFR(32) + G(18) + H(19) + K.1/L(47) + ADR/N/P(32، باستثناء O.1 الوصفي) + BDR(16) + Part 8(102) + AC(22) + E.11(59). كل جزء من الـSRS من Part 0 حتى Part 9 ممثَّل، إما بصف مستقل لكل ID أو بقرار تجميع موثَّق بسببه في §0 (فقط: O.1 كتصنيف، وBO/مصفوفة الوحدات/التوصيات كملخصات مشتقة — لا سجلات RISK/ASM/DEP/OPEN المستقلة، والمذكورة أصلاً كإشارات داخل الصفوف أعلاه).

**لم أُعِد تصنيف أي بند Phase-2/SRS-only كـ DEFERRED من نفسي.** كل بند من هذا النوع بقي MISSING تحت `قرار-نطاق`، تماماً كما في التقرير الأصلي. لم يتغيّر أي status أو أي سبنت في §5 في هذا التصحيح — هذا تصحيح توثيقي حسابي بحت.

سأنتظر مراجعتك. لا Sprint 15، لا كود، لا migration، لا commit.
