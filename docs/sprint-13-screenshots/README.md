# Sprint 13 screenshots

Captured from the built app against the seeded demo data (headless Chromium; the round badge in the corner is the Next.js dev indicator).

### الرئيسية (سطح المكتب)
![الرئيسية (سطح المكتب)](01-home-desktop.png)

### الرئيسية (جوال)
![الرئيسية (جوال)](02-home-mobile.png)

### اكتشف
![اكتشف](03-discovery-desktop.png)

### فئة نساء (جوال)
![فئة نساء (جوال)](04-discovery-women-mobile.png)

### بحث
![بحث](05-search-desktop.png)

### مقارنة الأسعار
![مقارنة الأسعار](06-compare-desktop.png)

### مقارنة (جوال)
![مقارنة (جوال)](07-compare-mobile.png)

### صفحة المتجر
![صفحة المتجر](08-store-desktop.png)

### صفحة المتجر (جوال)
![صفحة المتجر (جوال)](09-store-mobile.png)

### صفحة المنتج
![صفحة المنتج](10-product-desktop.png)

### صفحة المنتج (جوال)
![صفحة المنتج (جوال)](11-product-mobile.png)

### تسجيل الدخول
![تسجيل الدخول](12-login-desktop.png)

### إنشاء حساب
![إنشاء حساب](13-register-mobile.png)

### متابعة متجر
![متابعة متجر](14-store-followed-desktop.png)

### أتابعه
![أتابعه](15-following-desktop.png)

### أتابعه (جوال)
![أتابعه (جوال)](16-following-mobile.png)

### حسابي (جوال)
![حسابي (جوال)](17-account-mobile.png)

### قائمة الحساب ومساحات العمل
![قائمة الحساب ومساحات العمل](18-account-menu-desktop.png)

### لوحة المالك
![لوحة المالك](19-owner-hub-desktop.png)

### عروض المالك
![عروض المالك](20-owner-offers-desktop.png)

### فروع المالك
![فروع المالك](21-owner-branches-desktop.png)

### إعدادات المتجر + معاينة
![إعدادات المتجر + معاينة](22-owner-storefront-desktop.png)

### الموظف: طلبات فرعه
![الموظف: طلبات فرعه](23-employee-branch-orders-desktop.png)

### السلة (جوال)
![السلة (جوال)](24-cart-mobile.png)

## Mobile bottom-navigation check (390x844, real viewport, scrolled to the end)

Headless Chromium confirms each CTA is visible, above the bottom bar, not covered (hit-test) and clickable
(Playwright trial click): product "أضيفي للسلة" and "قارني الأسعار", Following card CTA, cart "متابعة للدفع",
checkout "متابعة". The same check fails on 4 pages when the bottom padding fix is removed (negative control).

![product](mobile-product-bottom.png)
![following](mobile-following-bottom.png)
![cart](mobile-cart-bottom.png)
![checkout](mobile-checkout-bottom.png)
