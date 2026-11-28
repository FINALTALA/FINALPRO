# VIA Admin handoff — Phase 6 Content Studio

## Repository and scope

- Verified `C:\fpwt\FINALPRO-v1-local`, branch `feat/homepage-v1-updates`, HEAD `432a270`.
- `git status --short --untracked-files=all` showed 64 tracked changes and 81 untracked files before this edit. Phase 6 and earlier admin work are interleaved with Homepage and Trending changes. Preserve all files and existing line endings. Git warned about LF-to-CRLF conversion.
- Scope authority is the approved **Codex FINAL PRODUCT & TECHNICAL SPECIFICATION**. The exact approved document was not located in the targeted repository records. Retrieve it from the original approval before settling scope questions. The working registry is an implementation aid. Preserve the approved Homepage, Trending and editorial Ads Page designs. Paid advertising campaigns remain deferred.
- This audit used source and written evidence only. No database or media storage inspection, tests, builds, migrations or seeds.

## Completed phases 1–5

- **1:** Control Center, role-aware admin shell, audit logs and platform-only sign-in.
- **2A:** Store evidence verification and selling eligibility. **2B:** Seven-source Approval Center. **2C:** Offer moderation, revision-bound corrections, selling restrictions and reservation recovery. **2D:** Admin Orders.
- **3:** Users, Settings and Team, including suspension safeguards. **4:** Dashboard and Analytics, including CSV/XLSX exports.
- **5:** Media Library complete on isolated resources per previous closeout. Admin UI, persistent volume setup, backup/verify/restore, validation, signed previews and usage-aware lifecycle. Prior record reports API **9/9**, browser **3/3**, and regression **17/17**. Real VP8 WebM played in Chrome. WebKit unavailable and MP4 verified structurally only. Prior closeout recorded Phase 5 dev migration pending approval. A later-named pre-Phase-5 backup exists, which establishes backup presence only. Current activation status is unverified. Keep Phases 1–5 closed.

## Phase 6 status — PARTIAL

| Status | Area | Verified state and unfinished work |
| --- | --- | --- |
| DONE | Repository evidence | Module registration, migration SQL, page/field registry, and eight API test cases were verified in the tree. A Phase 6 runtime feature is not yet confirmed by a recorded passing result. |
| PARTIAL | Backend workflow | `ContentStudioModule` is registered. `/admin/content` implements registry, page detail, admin preview, import-current, versioned draft save, publish/unpublish, schedule/cancel/retry, revision restore/load-to-draft/archive. Public `/content/:page` resolves live content and records broken dependencies. Service contains draft concurrency control, an Asia/Hebron schedule worker, immutable revision handling and an audit trail. |
| PARTIAL | Media integration | `syncUsages` writes `DRAFT`, `SCHEDULED`, `PUBLISHED` and `REVISION` references. Publication validates dependencies. Resolution reuses signed Media Library URLs for preview and published URLs for live assets, with fallback or omission and issue tracking. Runtime evidence is pending. |
| PARTIAL | Homepage | `apps/web/src/app/page.tsx` mounts `ManagedContentProvider`; Hero, Stories, Products/Picks, Categories and HowVia read managed sections. Verify default parity, preview, published and unpublished modes. Preserve existing dynamic store/discovery behavior. |
| PARTIAL | Trending | `TrendStage.tsx` reads hero data and `TrendCollections.tsx` reads reels and collections. `app/trending/page.tsx` still lacks the provider, and `TrendLook.tsx` lacks the managed look binding. The partial adapters therefore fall back to existing content on Trending today. Preserve existing TrendPieces behavior. |
| TODO | Editorial Ads | `app/ads/page.tsx` is still static. Mount provider and bind hero, stories, reels, featured ads and featured stores to the existing design. Preserve the offers block and confirm its treatment against the approved specification. |
| TODO | Admin editor and import | The admin route, nav entry and editor are missing. Wire bilingual field/item editing, Media Library selection, validation/issues, preview, publishing, scheduled actions and revision history to existing endpoints. `importCurrent` accepts a caller-supplied document and publishes revision 1. No in-tree caller or baseline import tooling was found. Capture/import the actual existing content and bundled assets without design changes. |
| BLOCKED | Development activation | Current development migration state is unverified by allowed evidence. No Phase 6 deployment record or pre-Phase-6 backup was found in targeted records. Require authorization and confirmation of the Phase 5 prerequisite before any dev migration/activation. Continue isolated implementation and verification. |

## Files, migration, test evidence and stopping point

- **New backend:** `apps/api/src/content-studio/{content-registry.ts,content-document.ts,content-schedule.util.ts,content-studio.controller.ts,content-studio.module.ts,content-studio.service.ts}`. **Modified:** `apps/api/src/app.module.ts` and `apps/api/prisma/schema.prisma`.
- **Migration exists:** `apps/api/prisma/migrations/20261205120000_content_studio/migration.sql`. Adds pages, revisions, schedules and issues, an immutable-revision trigger and a partial unique index for one pending schedule per page. Depends on the existing Media Library schema through service usage. Development application is unknown.
- **New web:** `apps/web/src/lib/contentStudio.tsx` provides public/admin-preview loading, section modes, media/link/ref resolution helpers and item overlays. **Modified:** `app/page.tsx`, Homepage section components, `TrendStage.tsx` and `TrendCollections.tsx`. Ads and Trending route files have no Phase 6 changes.
- Latest identifiable edits among the inspected Phase 6 files were `TrendStage.tsx` then `TrendCollections.tsx`, after the API spec and Homepage wiring. Resume at the missing Trending provider and look adapter.
- `apps/api/test/content-studio-6.e2e-spec.ts` contains **8 cases** covering auth, import/version races, bilingual copy/alt/dependencies, media usage, DST scheduling, worker concurrency/retry, restore/archive and runtime fallback/unpublish. No saved Phase 6 pass/fail result, specific failure log, or dedicated browser spec found. File presence gives coverage intent only.

## Next actions for Claude account 2

1. Retrieve the approved final specification. Complete the Trending provider and look adapter, then the Ads overlays. Check Homepage overlays and preserve the existing designs and dynamic blocks.
2. Add the admin Content Studio workflow and a repeatable initial import of the real current content for all three pages. Reuse the renderer for previews and existing Media Library selection. Verify revision 1 matches the existing public experience.
3. On a fresh marked disposable DB with isolated Redis and temporary media storage, validate the Phase 5 → 6 migration path and regenerate Prisma. Run the focused eight-case API spec. Record actual outcomes, including any repro for scheduling, usages and recovery.
4. Add focused browser coverage for all three public renderers and admin workflows, including Arabic/English, responsive design parity, preview privacy, publish/unpublish, schedule/retry and revision restore. Record exact results and remaining acceptance gaps.
5. With separate approval, confirm the target dev prerequisites and verified backups before Phase 6 activation. Then hand off to Phase 7 for final acceptance across phases, roles, locale/mobile, regression and design parity, including backup/restore and publish/schedule/rollback behavior.

## Business and safety rules

- Platform-admin edits and previews only. Keep drafts private, use signed preview media, and expose public media only with published usage. Keep references from drafts, schedules, live pages and retained revisions protected from archive/purge.
- Keep bilingual copy and informative alt text validation, current dependency checks and immutable revisions. Use Asia/Hebron wall time, handle repeated/skipped DST times, freeze scheduled content, and keep the live revision when a schedule fails. Retain page shells and built-in designs through fallback and unpublish behavior.
- Preserve Homepage, Trending, Ads and all prior work. During handoff, only this file may change. No branch switch, reset, clean, commit, merge, push, changes in `C:\soft project`, or database/media storage access.

## Phase 6 closeout — 2026-11-26 (Claude account 2)

Status: **implementation and isolated verification complete. Dev activation is still BLOCKED until approved.** Nothing committed. The dev DB, dev media storage and dev servers (:3100/:3101) were not touched.

- **Trending:** `app/trending/page.tsx` mounts the provider. `TrendLook.tsx` binds `trend.look`: the active piece stays correct for pieces without a cue, product link and image are used, and hidden mode removes the section. TrendPieces is unchanged and stays the live catalogue.
- **Ads:** `app/ads/page.tsx` mounts the provider. The new `components/ads/adsManaged.ts` overlays the hero, stories, reels, featured ads and featured stores. Featured ads keep the same 60/40 · 40/60 mosaic; `.fa-cell.is-10` is used only when the managed count is odd. Featured stores show picked Via stores first, then live Via stores, then curated cards. The offers block is untouched and stays the live catalogue. Paid campaigns remain deferred.
- **Homepage:** `HomeHero.tsx` keeps the phone image when the managed photo is the bundled one. A `/#section` CTA scrolls within the page.
- **Import:** `lib/contentBaseline.ts` builds revision 1 from the renderers' own built-in data, translations and bundled media.
  - Built-in copy that exists only in Arabic (Trending hero and look, gallery alt text) keeps English empty. The next Trending publication therefore needs English first; 20 items are reported.
  - Ads demo cards carry no store refs, so `ads.stores` needs real stores before it can be republished.
- **Admin:** `/admin/content` is the overview. `/admin/content/[page]` covers:
  - bilingual fields and items, with ordering and enable/disable;
  - the Media Library picker with alt text, and the problems list;
  - private preview, publish and unpublish;
  - Asia/Hebron schedule, replace, cancel and retry;
  - revisions (preview, restore, load into draft, archive) and live issues.
  Also new: `lib/contentStudioText.ts`, plus a nav tile and labels.
- **Tests:** run on fresh marked disposable DBs, Redis indices 11/12 and temp media. All were dropped or cleared afterwards.
  - Every migration applied cleanly, including Phase 5→6.
  - API `content-studio-6.e2e-spec.ts`: **8/8**.
  - Browser `e2e/content-studio-6.spec.ts`: **4/4** in Chrome. Covered: AR+EN import parity on all three pages (text and every media source); draft privacy; admin preview; a Library image moving from signed to public URL; publish; unpublish keeping the shell; restore creating a new revision; the Trending translation gate; schedule and cancel; EN at 390 px; the reviewer being refused.
  - Fixed during verification: an editor refetch loop caused by the identity of `useT`, and a 40 px overflow at phone width.
  - Web `tsc` and eslint are clean.
- **Not covered:** WebKit/Firefox; schedule failure and retry in the browser (the API spec covers it); pixel comparison (parity was checked on DOM text and media sources).
- **Remaining for activation (needs approval):**
  1. Confirm the dev DB's Phase 5 state and take a verified backup.
  2. Apply the pending migrations (`20261202…` to `20261205120000_content_studio`) as needed.
  3. Regenerate and rebuild.
  4. Import the three pages from the admin UI.
  Then Phase 7.

## Phase 6 activation on development — 2026-11-26 (approved)

- **Target verified:** branch `feat/homepage-v1-updates`, DB `finalpro_v1_partner` (127.0.0.1:55432). Phase 5 was already applied; the only pending migration was `20261205120000_content_studio`, which is additive: four new `content_*` tables, an immutability trigger on the new revisions table, and FKs between the new tables only.
- **Backup:** `C:\fpwt\db-backups\finalpro_v1_partner_pre-p6_20261126-225140.dump` (pg_dump -Fc, 440,525 bytes, sha256 `76941c66…7027ac`). It was restored into a marked disposable DB: 102 tables and 8,839 rows, identical to live, table by table. The disposable DB was then dropped.
- **Migration:** `prisma migrate deploy` applied `20261205120000_content_studio` only. Afterwards live has 106 tables: the 4 new `content_*` tables (empty) and one new `_prisma_migrations` row. Every pre-existing table count is unchanged. Prisma Client already matched the schema, so no regeneration was needed. No reset, seed, drop or secret change.
- **Services:**
  - API :3101: the old process was stopped, `nest build` rebuilt `dist`, and it was restarted detached with the same command (`node --env-file=.env --enable-source-maps dist/src/main.js`). Logs: `C:\fpwt\logs\finalpro-v1-api.{out,err}.log`. Health is 200 and `/content/{HOMEPAGE,TRENDING,ADS}` return 200 with `managed:false`. Admin routes return 401 without a session.
  - Web :3100: the `next dev` server already served the current source, so it was not restarted. `/`, `/trending`, `/ads` and the `/admin` pages (content, the three editors, media, users, orders, analytics) all return 200.
- **Public parity:** anonymous Chrome, reduced motion, AR and EN, visible text plus every img/video src/srcset/poster. Compared before activation, after the migration and after the API restart: **SAME on all 6 page/language views**. The baseline was confirmed deterministic first.
- **Import: NOT DONE — needs an admin.** No page is managed yet, so the public pages show their built-in content, which is the same content. The import runs from the admin UI with a real admin session (it was not done by impersonating an admin). After the import, re-run the parity comparison against the baseline. Script: `scratchpad/fingerprint.cjs`, baseline `pre-p6.json`, kept in the session scratchpad.
- **Follow-ups (not blockers):**
  - Trending needs 20 English entries before its next publish.
  - The Ads featured-store placeholders need real, eligible store references.
  - A manual Media Library upload and preview check.
  - Safari/Firefox and pixel-level parity are unverified.

## Content Studio extension: Women, Men, Kids, plus content gaps — 2026-11-26 (implemented and tested in isolation; NOT activated)

- **Editable now (same engine, editors and rules):**
  - `<page>.hero`: page title for screen readers, Men/Kids bold and second line, button label and link, hero image (structural fallback). Women also has title artwork and the cut-out image, marked `decorative` (they render `alt=""`/aria-hidden, so no alt text is required).
  - `<page>.ticker`: label plus 1–6 phrases.
  - `<page>.offer`: before amount, amount, after amount, benefit, link label, link.
- **Stays live catalogue (untouched):** category grid (taxonomy counts), the CollectionShowcase audience collection, the discovery listing (`/discovery/all`: filters, sorting, favourites, load more, scroll restore), and everything merchant-owned.
- **Files:**
  - API: `content-registry.ts` (`WOMEN`/`MEN`/`KIDS`, `audiencePage()`, `decorative`), `content-document.ts` (no alt check for decorative media), `schema.prisma` enum, migration `20261206120000_content_studio_audience_pages` (three `ALTER TYPE … ADD VALUE`, additive only).
  - Web: `lib/audienceEditorial.ts` (hook plus the pages' built-in values), `app/{women,men,kids}/page.tsx` (provider plus the same markup), `lib/contentBaseline.ts` (import from those values), `lib/contentStudioText.ts`, `lib/contentStudio.tsx`, the editor (picker falls back to all categories; "fill missing English" action).
- **Translations:** `lib/contentTranslations.ts` holds 20 faithful EN translations for Trending: hero headline and subline, 6 Look names, 6 Look alts and 6 gallery alts. The editor offers them as an unsaved draft change. A suggestion fills a field only if its English is empty and its Arabic still equals the source text. Nothing is saved or published automatically. Women/Men/Kids copy is already bilingual, so nothing was missing there.
- **Ads stores:** dev has one store, `via-owner-demo`, which is ACTIVE but its storefront is unpublished, so it is **not eligible**. The demo placeholders stay as the safe fallback (blocked until a store publishes its storefront).
- **Tests (fresh marked disposable DBs, Redis 11/12, temp media; all dropped/cleared):**
  - Migrations, including the new one, applied cleanly.
  - API `content-studio-6-audience.e2e-spec.ts`: **3/3**. Existing `content-studio-6.e2e-spec.ts`: **8/8**.
  - Browser `e2e/content-studio-6-audience.spec.ts`: **4/4** in Chrome. Covered: parity before and after import on all three pages at AR 1440, EN 1440 and AR 390 (text, media src/srcset/alt, anchors, overflow, and the identical `/discovery/all` requests); Women draft privacy, preview, publish and restore; Trending suggestions filling exactly 20 values as an unsaved, unpublished change; Men editor in EN at 390 px.
  - Web `tsc`/eslint and API `tsc` are clean.
- **Dev state:** the dev DB, dev API and published content are unchanged. The dev web (`next dev`) already serves the new page code. The dev API answers `/content/{WOMEN,MEN,KIDS}` with 404 (unknown page), so the pages keep their built-in content. `/admin/content/{WOMEN,MEN,KIDS}` shows an error until activation.
- **Activation (separate approval needed):**
  1. Back up.
  2. `migrate deploy` (applies `20261206120000…` only).
  3. Rebuild and restart the API.
  4. As admin, import WOMEN, MEN and KIDS (and ADS if it is still not imported).
  5. In TRENDING, review "fill missing English", save the draft, then publish it yourself.

## Women / Men / Kids activation on development — 2026-11-26 (approved)

- **Before:** DB `finalpro_v1_partner` verified. The only pending migration was `20261206120000_content_studio_audience_pages`: three `ALTER TYPE "ContentPageKey" ADD VALUE`, additive only. HOMEPAGE, TRENDING and ADS were each imported (draft v1, revision 1 IMPORT).
- **Backup:** `C:\fpwt\db-backups\finalpro_v1_partner_pre-p6aud_20261126-232802.dump` (474,383 bytes, sha256 `42ba7fbc…0cdb`). It was restored into a marked disposable DB, which matched live exactly (106 tables, 8,854 rows), and was then dropped.
- **Migration:** `migrate deploy` applied only that migration. Afterwards the only difference from the backup is one new `_prisma_migrations` row. Merchant records, offers, media, users and orders are unchanged. Content pages and revisions have the same IDs, draft versions and document md5s as before.
- **API :3101:** rebuilt (`nest build`) and restarted detached with the same command and `.env` (PID 20688, logs `C:\fpwt\logs\finalpro-v1-api.*`). Health is 200. `/content/{HOMEPAGE,TRENDING,ADS}` are managed and published; `/content/{WOMEN,MEN,KIDS}` return 200 with `managed:false`, so the pages show their built-in content. Admin routes (content, registry, WOMEN, media, users, orders) return 401 without a session. The error log is empty.
- **Web :3100:** not restarted. `/`, `/trending`, `/ads`, `/women`, `/men`, `/kids`, `/admin/content`, `/admin/content/WOMEN` and `/admin/media` return 200.
- **Parity:** the public Homepage, Trending and Ads (AR and EN, text plus all media sources) are the SAME as the pre-Phase-6 baseline, after the user's imports.
- **Manual (admin):** import WOMEN, MEN and KIDS. The 20 Trending suggestions are untouched (nothing saved or published). Ads featured stores stay demo placeholders (no eligible store).


## Phase 7 closeout for tonight

- **Focused technical verification: 41/41 passed.** Users and sessions 9/9, orders and refunds 2/2, analytics and exports 5/5, Sprint 25 flags and audit 25/25. No reproducible product defect or technical blocker was confirmed in that scope. Full acceptance is still open.
- **Manual follow-ups:** Men and Kids are not imported. Confirm Women’s current import status. Review the 20 Trending English suggestions. Ads has no eligible published featured store. Manual image/video checks and browser coverage beyond Chrome remain open.
- The approved Codex specification has not been recovered. Trending Pieces uses static curated cards and stays unchanged pending a product decision.
- [Phase 7 focused acceptance report](VIA_ADMIN_PHASE7_ACCEPTANCE.md)
- [Morning manual acceptance checklist](VIA_ADMIN_MANUAL_ACCEPTANCE_CHECKLIST.md)
