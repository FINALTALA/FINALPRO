"use client";

import { translate } from "@/lib/i18n";
import "@/lib/storeText";
import { useLang } from "@/lib/useLang";

/**
 * The store page while it loads: the page's own layout (its cover band,
 * identity, intro, category chips and product grid) with quiet placeholders
 * in the places of the content - never another header, logo or a wide empty
 * page. Shared by the store page itself and the old /vendor/<id> address that
 * only redirects to it (2026-11-24), so the wait looks like the store page.
 */
export default function StoreSkeleton() {
  const lang = useLang();
  return (
    <div className="store-view" aria-busy="true" data-testid="store-skeleton">
      {/* what a screen reader hears while it loads (the placeholders themselves say nothing) */}
      <p className="visually-hidden" role="status">{translate(lang, "store.loading")}</p>
      <section className="store-hero" aria-hidden="true">
        <div className="store-shell">
          <div className="store-topbar">
            <div className="store-identity">
              <span className="store-skel store-skel-logo" />
              <div className="store-identity-text">
                <span className="store-skel" style={{ width: 170, height: 16 }} />
                <span className="store-skel" style={{ width: 120, height: 11 }} />
              </div>
            </div>
            <span className="store-skel" style={{ width: 46, height: 46, borderRadius: 14 }} />
          </div>
          <div className="store-intro">
            <span className="store-skel" style={{ width: "60%", height: 30, margin: "0 auto" }} />
            <span className="store-skel" style={{ width: "80%", height: 13, margin: "22px auto 0" }} />
          </div>
          <div className="store-chips" aria-hidden="true">
            {[78, 96, 84, 70].map((w, i) => (
              <span key={i} className="store-skel" style={{ width: w, height: 40, borderRadius: 999 }} />
            ))}
          </div>
        </div>
      </section>
      <section className="store-products" aria-hidden="true">
        <div className="store-shell">
          <div className="product-grid store-product-grid">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i}>
                <span className="store-skel" style={{ display: "block", aspectRatio: "4 / 5", borderRadius: 18 }} />
                <span className="store-skel" style={{ width: "70%", height: 12, marginTop: 12 }} />
                <span className="store-skel" style={{ width: "40%", height: 12, marginTop: 8 }} />
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
