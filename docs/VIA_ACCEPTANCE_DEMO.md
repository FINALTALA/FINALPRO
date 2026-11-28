# VIA acceptance DEMO

## Open the environment

- Web: http://127.0.0.1:3213/login
- API health: http://127.0.0.1:3212/api/v1/health
- Private roster: C:\fpwt\via-acceptance-demo\docs\demo-scenarios.json and acceptance-accounts.private.json in the same directory.
- For manual review, start with platform admin, regular customer, customer with empty cart, store owner, branch employee, and verification reviewer. Sign in only on the DEMO web origin.

## Isolation

PostgreSQL lives in via-acceptance-demo-postgres at 127.0.0.1:55442. The exact database is via_acceptance_demo_2026 and its PostgreSQL database comment is via-acceptance-v1. Redis lives in via-acceptance-demo-redis at 127.0.0.1:56389. Index 1 was empty before its marker was installed. Media, uploads, review media and import staging each have separate directories below C:\fpwt\via-acceptance-demo. The private environment file and account rosters live outside Git. The running development web and API kept their original process IDs throughout the work.

The wrapper checks the database name, database comment, container labels and port bindings, reserved Redis index, and exact media directories before operations. SMS, external notification, and Sentry providers are disabled in the DEMO configuration. Payment records are sandbox fixtures. No credentials or session tokens are in this report.

## Inventory and module coverage

| Module | DEMO fixture and manual coverage |
| --- | --- |
| Accounts and authorization | 57 accounts, including 30 customer profiles, 2 admins and 3 reviewers. Owner and employee memberships. Existing demonstration credentials and additional generated credentials are in the private roster. |
| Stores, branches and verification | 12 stores and 19 branches. Approved, pending, suspended, expired, unpublished and other supported cases from existing fixtures. Eight designated branches represent Nablus, Ramallah, Hebron, Jenin, Tulkarm, Bethlehem, Qalqilya and Salfit. |
| Catalogue, discovery and inventory | 144 canonical products, 189 offers and 908 branch-stock rows. Women, Men and Kids, with categories, brands, size and colour variants, locally bundled imagery, discounts, and low/out-of-stock and nonpublic states. |
| Checkout, orders and fulfilment | 85 customer-order records, including a failed sandbox payment. 94 branch orders across 84 checkouts with branch orders. 10 multi-store checkouts. Open, preparing, pickup, delivery, completed and cancelled scenarios. |
| Returns and refunds | 12 returns and 6 merchandise refunds. Requested, awaiting drop-off, rejected and refunded cases. Some merchandise refunds deduct the policy fee. |
| POS | 8 completed cash sales with separate stock movement and line-item records. |
| Reviews and moderation | 12 product reviews with purchaser/order-item relationships and 4 moderation reports. Existing store and branch verification and catalogue matching scenarios. |
| Media and editorial content | Six published DEMO page revisions through Content Studio, one generated validated image through Media Library, and two usage references. Bundled catalogue and storefront imagery. |
| Audit and analytics | Real audit events from isolated login, media upload and Content Studio operations. Dashboard, reports, refunds CSV and store XLSX. Independent SQL reconciliation of financial totals. |

## Integrity and executed smoke checks

All 85 migrations applied to the DEMO database. Every store has an owner. SQL found zero negative or over-reserved stock rows, zero line subtotal and order total mismatches, and zero item refunds exceeding their merchandise value. Re-running the commerce stage kept all 60 added checkouts and their related records at the same counts. The 30-day Analytics report reconciled with independent SQL at ILS 4525.00 completed marketplace GMV, ILS 1169.00 merchandise refunds and ILS 1342.00 POS sales. POS stays outside marketplace GMV.

The executed checks are recorded outside Git in C:\fpwt\via-acceptance-demo\docs\smoke-results.json. They include API health, real fixture admin/customer login, catalogue and store discovery, cart/order/return reads, admin stores, verification queue, dashboard and analytics reads, valid CSV/XLSX response formats, Media Library and Content Studio reads, and HTTP 200 for the DEMO login page. API reads and fixture availability do not establish end-to-end acceptance.

## Remaining coverage

Checkout quote, reservation and order confirmation through the customer UI, delivery-fee refunds and forced-cancellation workflows were not smoke-tested. The generated history covers merchandise refunds but no delivery-fee refund. Held-offer discovery and checkout exclusion, formal POS UI flow, full approval sources, Sales Rank, flags and alert-recipient scenarios remain unverified. Media Library currently has one generated image and no video fixture. Content Studio has minimal published documents; distinct draft and scheduled revisions remain pending. A full visual and manual acceptance audit was not run.

## Operate or recreate

Use PowerShell from the repository root. Prefix each action below with:

    powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File apps/api/scripts/via-acceptance-demo.ps1 -Action

- Verify checks isolation and DryRun describes seed stages without writing.
- Stop terminates the identified DEMO API and web processes while retaining data.
- Start prepares an external web copy and starts the two DEMO processes. It uses the existing compiled API under apps/api/dist. Both dedicated Docker containers must be running.
- Migrate deploys source migrations after verification. Seed runs the reusable fixture stages including Commerce. Content uses the running DEMO API to establish the image and page fixtures, then runs smoke checks. Smoke runs just the endpoint checks.
- To recreate deliberately, run Stop, then Recreate -ConfirmDemoCleanup, then Migrate, Seed, Start and Content in that order. Recreate targets the exact marked database and index 1 in the dedicated Redis container. Local rosters and media directories are retained. The destructive path was not executed during setup.
- If the dedicated containers were stopped, start only via-acceptance-demo-postgres and via-acceptance-demo-redis with docker start before Verify or Start.

The initial Docker images are postgis/postgis:16-3.4-alpine and redis:7-alpine. Environment configuration and logs are in C:\fpwt\via-acceptance-demo. Never substitute a development URL.
