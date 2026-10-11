"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import Footer from "@/components/Footer";
import ProductCard from "@/components/ProductCard";
import { EmptyState, ErrorBanner, SkeletonGrid } from "@/components/States";
import StoreCircle from "@/components/StoreCircle";
import { useFetch } from "@/lib/useFetch";
import { CardsPageDto, ComparisonCardDto } from "@/lib/types";

const WOMEN_PRODUCTS_PATH = "/discovery/all?segment=women&page_size=50";
const EMPTY_CARDS: ComparisonCardDto[] = [];

type SortOption = "newest" | "price-asc" | "price-desc";

function amount(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function uniqueValues(values: (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort(
    (a, b) => a.localeCompare(b, "ar"),
  );
}

function matchesFilters(
  card: ComparisonCardDto,
  filters: {
    category: string;
    brand: string;
    color: string;
    size: string;
    availability: string;
    store: string;
    minPrice: string;
    maxPrice: string;
  },
): boolean {
  const price = amount(card.lowest_price);
  if (filters.category && card.category_name !== filters.category) return false;
  if (filters.brand && card.brand_name !== filters.brand) return false;
  if (filters.color && !card.colors.includes(filters.color)) return false;
  if (filters.size && !card.sizes.includes(filters.size)) return false;
  if (filters.availability && card.lowest_price_availability !== filters.availability) return false;
  if (filters.store && !card.store_logos.some((store) => store.vendor_slug === filters.store)) return false;
  if (filters.minPrice && price < Number(filters.minPrice)) return false;
  if (filters.maxPrice && price > Number(filters.maxPrice)) return false;
  return true;
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="women-filter-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">الكل</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function WomenPage() {
  const products = useFetch<CardsPageDto>(WOMEN_PRODUCTS_PATH, false);
  const [category, setCategory] = useState("");
  const [brand, setBrand] = useState("");
  const [color, setColor] = useState("");
  const [size, setSize] = useState("");
  const [availability, setAvailability] = useState("");
  const [store, setStore] = useState("");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [sort, setSort] = useState<SortOption>("newest");
  const [filtersOpen, setFiltersOpen] = useState(false);

  const cards = products.data?.items ?? EMPTY_CARDS;
  const categories = useMemo(
    () =>
      uniqueValues(cards.map((card) => card.category_name)).map((name) => ({
        name,
        image: cards.find((card) => card.category_name === name && card.image_url)?.image_url ?? null,
      })),
    [cards],
  );
  const brands = uniqueValues(cards.map((card) => card.brand_name));
  const colors = uniqueValues(cards.flatMap((card) => card.colors));
  const sizes = uniqueValues(cards.flatMap((card) => card.sizes));
  const stores = useMemo(
    () =>
      [...new Map(cards.flatMap((card) => card.store_logos).map((item) => [item.vendor_slug, item] as const)).values()]
        .sort((a, b) => a.display_name.localeCompare(b.display_name, "ar")),
    [cards],
  );

  const filteredCards = useMemo(() => {
    const filtered = cards.filter((card) =>
      matchesFilters(card, { category, brand, color, size, availability, store, minPrice, maxPrice }),
    );
    if (sort === "price-asc") return filtered.sort((a, b) => amount(a.lowest_price) - amount(b.lowest_price));
    if (sort === "price-desc") return filtered.sort((a, b) => amount(b.lowest_price) - amount(a.lowest_price));
    return filtered;
  }, [cards, category, brand, color, size, availability, store, minPrice, maxPrice, sort]);

  const latestCards = cards.slice(0, 4);
  const comparisonCard = cards.find((card) => card.store_count > 1);
  const activeFilterCount = [
    category,
    brand,
    color,
    size,
    availability,
    store,
    minPrice,
    maxPrice,
  ].filter(Boolean).length;

  function clearFilters() {
    setCategory("");
    setBrand("");
    setColor("");
    setSize("");
    setAvailability("");
    setStore("");
    setMinPrice("");
    setMaxPrice("");
  }

  const filterControls = (
    <>
      {categories.length > 0 && (
        <FilterSelect
          label="التصنيف"
          value={category}
          options={categories.map(({ name }) => ({ value: name, label: name }))}
          onChange={setCategory}
        />
      )}
      {brands.length > 0 && (
        <FilterSelect
          label="الماركة"
          value={brand}
          options={brands.map((value) => ({ value, label: value }))}
          onChange={setBrand}
        />
      )}
      {colors.length > 0 && (
        <FilterSelect
          label="اللون"
          value={color}
          options={colors.map((value) => ({ value, label: value }))}
          onChange={setColor}
        />
      )}
      {sizes.length > 0 && (
        <FilterSelect
          label="المقاس"
          value={size}
          options={sizes.map((value) => ({ value, label: value }))}
          onChange={setSize}
        />
      )}
      <FilterSelect
        label="التوفر"
        value={availability}
        options={[
          { value: "available", label: "متوفر" },
          { value: "low_stock", label: "كمية محدودة" },
          { value: "sold_out", label: "غير متوفر" },
        ]}
        onChange={setAvailability}
      />
      {stores.length > 0 && (
        <FilterSelect
          label="المحل"
          value={store}
          options={stores.map((item) => ({ value: item.vendor_slug, label: item.display_name }))}
          onChange={setStore}
        />
      )}
      <fieldset className="women-price-filter">
        <legend>السعر بالشيكل</legend>
        <div>
          <label>
            <span className="visually-hidden">أقل سعر</span>
            <input
              type="number"
              min="0"
              inputMode="decimal"
              placeholder="من"
              value={minPrice}
              onChange={(event) => setMinPrice(event.target.value)}
            />
          </label>
          <label>
            <span className="visually-hidden">أعلى سعر</span>
            <input
              type="number"
              min="0"
              inputMode="decimal"
              placeholder="إلى"
              value={maxPrice}
              onChange={(event) => setMaxPrice(event.target.value)}
            />
          </label>
        </div>
      </fieldset>
    </>
  );

  return (
    <div className="women-page">
      <nav className="women-segment-nav" aria-label="تصفحي أقسام المنصة">
        <Link href="/discovery">كل المنتجات</Link>
        <Link href="/women" aria-current="page">النساء</Link>
        <Link href="/discovery?segment=men">الرجال</Link>
        <Link href="/discovery?segment=kids">الأطفال</Link>
        <Link href="/discovery?segment=accessories">الإكسسوارات</Link>
      </nav>

      <section className="women-hero" aria-labelledby="women-hero-title">
        {/* Decorative campaign image; product imagery and details come from the API. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="women-hero-image"
          src="/images/home-promo-women.webp"
          alt=""
          fetchPriority="high"
          width={1360}
          height={1520}
        />
        <div className="women-hero-copy">
          <span className="women-eyebrow">تشكيلة النساء</span>
          <h1 id="women-hero-title">أسلوبكِ، على طريقتكِ</h1>
          <p>اكتشفي منتجات محلات الضفة، قارني أسعار المنتج نفسه واختاري ما يناسبكِ.</p>
          <span className="women-hero-rule" aria-hidden="true" />
          <span className="women-hero-note">أزياء من متاجر محلية، في مكان واحد</span>
        </div>
      </section>

      <div className="women-ticker" aria-label="اكتشفي وقارني واختاري">
        <div className="women-ticker-track">
          {[0, 1].map((copy) => (
            <span className="women-ticker-group" key={copy} aria-hidden={copy === 1}>
              <span>اكتشفي أزياء من محلات فلسطينية</span>
              <i aria-hidden="true">✦</i>
              <span>قارني أسعار المنتج نفسه</span>
              <i aria-hidden="true">✦</i>
              <span>السعر والتوفر حسب بيانات المتاجر</span>
              <i aria-hidden="true">✦</i>
            </span>
          ))}
        </div>
      </div>

      <div className="women-content">
        {products.error && (
          <>
            <ErrorBanner message={products.error} />
            <button className="button-link" onClick={() => window.location.reload()}>إعادة المحاولة</button>
          </>
        )}
        <section className="women-section" aria-labelledby="women-latest-title">
          <div className="women-section-heading">
            <div>
              <span className="women-section-kicker">من المتاجر</span>
              <h2 id="women-latest-title">وصل حديثًا</h2>
              <p>أحدث المنتجات المنشورة في تشكيلة النساء.</p>
            </div>
            <Link href="/discovery?segment=women" className="women-text-link">
              جميع المنتجات <span aria-hidden="true">←</span>
            </Link>
          </div>
          {products.loading && <SkeletonGrid count={4} />}
          {products.data && latestCards.length > 0 && (
            <div className="women-product-grid women-latest-grid">
              {latestCards.map((card) => (
                <ProductCard key={card.canonical_product_id} card={card} editorial />
              ))}
            </div>
          )}
          {products.data && latestCards.length === 0 && (
            <EmptyState
              title="لا توجد منتجات نسائية متاحة حاليًا"
              message="ستظهر المنتجات هنا عند نشر المتاجر لعروضها."
            />
          )}
        </section>

        {categories.length > 0 && (
          <section className="women-categories" aria-labelledby="women-categories-title">
            <div className="women-section-heading">
              <div>
                <span className="women-section-kicker">اختاري ما تبحثين عنه</span>
                <h2 id="women-categories-title">تصفحي حسب التصنيف</h2>
              </div>
              <div className="women-category-controls" aria-hidden="true">
                <span>اسحبي للتصفح</span><b>←</b>
              </div>
            </div>
            <div className="women-category-list">
              {categories.slice(0, 10).map((item) => (
                <button
                  className={`women-category-card${category === item.name ? " selected" : ""}`}
                  key={item.name}
                  onClick={() => {
                    setCategory(category === item.name ? "" : item.name);
                    document.getElementById("women-products-title")?.scrollIntoView({ behavior: "smooth" });
                  }}
                  aria-pressed={category === item.name}
                >
                  {item.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.image} alt="" loading="lazy" />
                  ) : (
                    <span className="women-category-placeholder" aria-hidden="true">{item.name.slice(0, 1)}</span>
                  )}
                  <span>{item.name}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {comparisonCard && (
          <section className="women-comparison" aria-labelledby="women-comparison-title">
            <div className="women-comparison-copy">
              <span className="women-section-kicker">المنتج نفسه، عروض متعددة</span>
              <h2 id="women-comparison-title">قارني قبل ما تختاري</h2>
              <p>
                {comparisonCard.canonical_name_ar} متوفر لدى {comparisonCard.store_count} محلات.
                شاهدي الأسعار والمقاسات والألوان للعروض المؤهلة.
              </p>
              <Link href={`/compare/${comparisonCard.canonical_product_id}`} className="button">
                قارني الأسعار
              </Link>
            </div>
            <div className="women-comparison-card">
              {comparisonCard.image_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={comparisonCard.image_url} alt={comparisonCard.canonical_name_ar} loading="lazy" />
              ) : (
                <div className="women-comparison-placeholder" aria-hidden="true">Via</div>
              )}
              <div className="women-comparison-details">
                <strong>{comparisonCard.canonical_name_ar}</strong>
                <span>يبدأ من {comparisonCard.lowest_price} ₪</span>
                <div className="women-comparison-stores" aria-label="المحلات ذات الأسعار الأقل">
                  {comparisonCard.store_logos.map((item) => (
                    <StoreCircle
                      key={item.vendor_id}
                      name={item.display_name}
                      logoUrl={item.logo_url}
                      href={`/store/${item.vendor_slug}/products/${item.offer_id}`}
                      size={36}
                    />
                  ))}
                </div>
              </div>
            </div>
          </section>
        )}

        <section className="women-discovery" aria-labelledby="women-products-title" id="women-products">
          <div className="women-section-heading">
            <div>
              <span className="women-section-kicker">اكتشفي التشكيلة</span>
              <h2 id="women-products-title">منتجات النساء</h2>
              <p>منتجات موحدة للمقارنة، وعروض المتاجر المرتبطة بها.</p>
            </div>
            <label className="women-sort">
              <span>ترتيب حسب</span>
              <select value={sort} onChange={(event) => setSort(event.target.value as SortOption)}>
                <option value="newest">الأحدث</option>
                <option value="price-asc">السعر: من الأقل للأعلى</option>
                <option value="price-desc">السعر: من الأعلى للأقل</option>
              </select>
            </label>
          </div>

          <div className="women-results-toolbar">
            <button
              className="women-mobile-filter-button"
              type="button"
              onClick={() => setFiltersOpen((open) => !open)}
              aria-expanded={filtersOpen}
              aria-controls="women-filter-panel"
            >
              الفلاتر {activeFilterCount > 0 && <span>{activeFilterCount}</span>}
            </button>
            <p>
              {products.data
                ? `عرض ${filteredCards.length} من ${products.data.total} نتيجة ضمن أحدث النتائج المحمّلة`
                : "الأسعار والتوفر وفق بيانات المتاجر"}
            </p>
            {activeFilterCount > 0 && (
              <button className="women-clear-filters" type="button" onClick={clearFilters}>
                مسح الفلاتر
              </button>
            )}
          </div>

          <div className="women-results-layout">
            <aside
              className={`women-filter-panel${filtersOpen ? " is-open" : ""}`}
              id="women-filter-panel"
              aria-label="فلاتر المنتجات"
            >
              <div className="women-filter-heading">
                <h3>تصفية النتائج</h3>
                <span>ضمن أحدث 50 نتيجة</span>
              </div>
              {filterControls}
            </aside>

            <div className="women-results">
              {products.loading && <SkeletonGrid />}
              {products.data && filteredCards.length === 0 && (
                <EmptyState
                  title={cards.length ? "لا توجد منتجات بهذه المواصفات" : "لا توجد منتجات نسائية متاحة حاليًا"}
                  message={cards.length ? "غيّري الفلاتر أو امسحيها لعرض نتائج أخرى." : "ستظهر المنتجات هنا عند نشر المتاجر لعروضها."}
                >
                  {cards.length > 0 && (
                    <button className="button-link" type="button" onClick={clearFilters}>مسح الفلاتر</button>
                  )}
                </EmptyState>
              )}
              {products.data && filteredCards.length > 0 && (
                <div className="women-product-grid">
                  {filteredCards.map((card) => (
                    <ProductCard key={card.canonical_product_id} card={card} />
                  ))}
                </div>
              )}
              {products.data && products.data.total > cards.length && (
                <div className="women-more-results">
                  <p>للبحث في كامل تشكيلة النساء، انتقلي إلى صفحة الاكتشاف.</p>
                  <Link href="/discovery?segment=women" className="button button-secondary">
                    عرض جميع النتائج
                  </Link>
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
      <Footer />
    </div>
  );
}
