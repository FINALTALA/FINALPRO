# Sprint 14 screenshots

Captured from the built app against the seeded demo data (headless Chromium). The browser script that produced them is `verify-s14.mjs.txt` (28 checks, all passing): a new customer registers through the UI, adds an address inside checkout, pays by delivery with the sandbox card (decline, insufficient funds, retry, success), sees a price change, cart availability, signs out (server-side) and resets a password; plus mobile checks that each new CTA is above the bottom bar and the pages do not overflow horizontally.

### Address form inside checkout (manual lat/lng/landmark/phones/zone, optional geolocation)
![Address form inside checkout (manual lat/lng/landmark/phones/zone, optional geolocation)](01-address-form-desktop.png)

### Sandbox card form
![Sandbox card form](02-card-form-desktop.png)

### Declined card: reason shown, reservation kept
![Declined card: reason shown, reservation kept](03-card-declined-desktop.png)

### Retry with a good card creates the delivery order
![Retry with a good card creates the delivery order](04-order-created-desktop.png)

### CHECKOUT_PRICE_CHANGED shown as old -> new with the delta
![CHECKOUT_PRICE_CHANGED shown as old -> new with the delta](05-price-change-desktop.png)

### Cart: sold-out line dimmed, unselectable, removable
![Cart: sold-out line dimmed, unselectable, removable](06-cart-soldout-desktop.png)

### Cart: quantity above the maximum
![Cart: quantity above the maximum](07-cart-max-quantity-desktop.png)

### Address form (mobile)
![Address form (mobile)](08-address-form-mobile.png)

### Cart (mobile)
![Cart (mobile)](09-cart-mobile.png)

### Card form (mobile), clear of the bottom bar
![Card form (mobile), clear of the bottom bar](10-card-form-mobile.png)

## Review round (Codex)

`verify-fulfil.mjs.txt` (6 checks, all passing): a physical branch defaults to pick-up; an online-only branch with delivery slots defaults to delivery with no pick-up option and reserves without PICKUP_REQUIRES_PHYSICAL_BRANCH; a branch with no valid method shows a clear message and blocks reservation; with 5 + 5 units in two branches the cart maximum is 5 and quantity 6 cannot be selected for checkout; adjusting to the maximum re-selects the line and checkout quotes it.

### No valid fulfilment method
![No valid fulfilment method](fulfil-none.png)

### Two branches, 5 + 5 units: maximum is 5
![Cart maximum across branches](fulfil-cart-max.png)
