"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { BarcodeScanner, type BarcodeScannerHandle } from "@/components/pos/BarcodeScanner";
import { ErrorBanner } from "@/components/States";
import { ApiError, apiFetch, newIdempotencyKey } from "@/lib/api";
import { isUnauthorized } from "@/lib/apiErrors";
import { loginRedirectHref } from "@/lib/loginRedirect";
import { fillPos, formatIls, posErrorText } from "@/lib/storePosText";
import { useLang, useT } from "@/lib/useLang";
import { useHydrated, useSessionToken } from "@/lib/useSession";
import { useSessionExpiredRedirect } from "@/lib/useSessionExpiredRedirect";

interface StartDto {
  role: "OWNER" | "BRANCH_EMPLOYEE";
  branches: { id: string; name: string }[];
  can_void: boolean;
  can_link_barcodes: boolean;
}
interface OptionDto {
  offer_variant_id: string;
  color_key: string | null;
  color_name_ar: string | null;
  color_name_en: string | null;
  color_hex: string | null;
  size_code: string | null;
  size_label: string | null;
  unit_price: string;
  available: number;
  image_url: string | null;
}
interface CardDto {
  matched_by: "PRODUCT_BARCODE" | "LEGACY_VARIANT_CODE";
  code: string;
  offer: { id: string; title_ar: string; title_en: string; status: string; image_url: string | null };
  options: OptionDto[];
  preselect_variant_id: string | null;
}
type LineProblem = { kind: "short"; available: number } | { kind: "price" } | { kind: "not_sellable" };
/** One basket line = one colour x size of one product at this branch (the basket is the branch's). */
interface BasketLine {
  offer_variant_id: string;
  offer_id: string;
  title_ar: string;
  title_en: string;
  color_name_ar: string | null;
  color_name_en: string | null;
  color_hex: string | null;
  size_label: string | null;
  unit_price: string;
  quantity: number;
  available: number;
  scanned_code: string | null;
  problem?: LineProblem;
}
interface SaleDto {
  id: string;
  sale_label: string;
  total: string;
}
interface OwnerOfferDto {
  id: string;
  title_ar: string;
  title_en: string;
  status: string;
}
type Payment = "CASH" | "CARD";

const branchKey = (vendorId: string) => `fp.cashier.branch.${vendorId}`;
const basketKey = (vendorId: string) => `fp.cashier.basket.${vendorId}`;
const cents = (v: string | number) => Math.round(Number(v) * 100);

function readStorage<T>(store: "local" | "session", key: string): T | null {
  try {
    const raw = (store === "local" ? window.localStorage : window.sessionStorage).getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function writeStorage(store: "local" | "session", key: string, value: unknown) {
  try {
    const s = store === "local" ? window.localStorage : window.sessionStorage;
    if (value === null) s.removeItem(key);
    else s.setItem(key, JSON.stringify(value));
  } catch {
    // private window / blocked storage: the screen works, it just won't remember
  }
}

function subscribeOnline(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}
function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
}

/**
 * «بيع من المحل» - an operating screen, not a shop page:
 *  1. scan (store scanner / camera / typing) at the top, always ready;
 *  2. the product's colour, size (this branch's stock; sold out shown and
 *     disabled) and quantity in the middle, «إضافة إلى السلة»; then another
 *     colour or size, or another product;
 *  3. the sale's basket always in view: one line per product x colour x size
 *     (the same one again only adds to its quantity), each with − / + / ×;
 *     the payment method and ONE small confirmation.
 * The sale takes each line from its own colour x size x branch, or nothing
 * at all. No sale while offline (the basket stays on this device); a retry
 * after a lost answer reuses its key, so a sale is never recorded twice.
 */
export default function CashierPage() {
  const params = useParams<{ vendorId: string }>();
  const vendorId = params.vendorId;
  const router = useRouter();
  const t = useT();
  const lang = useLang();
  const hydrated = useHydrated();
  const token = useSessionToken();
  const onExpired = useSessionExpiredRedirect();
  const online = useOnline();
  const scanRef = useRef<BarcodeScannerHandle>(null);
  const basketRef = useRef<HTMLElement>(null);

  const [start, setStart] = useState<StartDto | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [branchId, setBranchId] = useState("");
  const [basket, setBasket] = useState<BasketLine[]>([]);
  const [payment, setPayment] = useState<Payment>("CASH");
  const [restored, setRestored] = useState(false);

  const [looking, setLooking] = useState(false);
  const [card, setCard] = useState<CardDto | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [unknownCode, setUnknownCode] = useState<string | null>(null);
  const [colorKey, setColorKey] = useState<string | null>(null);
  const [variantId, setVariantId] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState<string | null>(null);

  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saleError, setSaleError] = useState<string | null>(null);
  const [attemptKey, setAttemptKey] = useState<string | null>(null);
  const [done, setDone] = useState<SaleDto | null>(null);

  const [linking, setLinking] = useState(false);
  const [offers, setOffers] = useState<OwnerOfferDto[] | null>(null);
  const [linkQuery, setLinkQuery] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  const name = useCallback((ar: string | null, en: string | null) => (lang === "en" ? en || ar : ar) ?? "", [lang]);

  // who may sell where; then this device's remembered branch and basket
  useEffect(() => {
    if (!hydrated) return;
    if (!token) {
      router.replace(loginRedirectHref());
      return;
    }
    apiFetch<StartDto>(`/vendors/${vendorId}/cashier`)
      .then((s) => {
        setStart(s);
        const saved = readStorage<{ branchId: string; lines: BasketLine[]; payment: Payment }>("session", basketKey(vendorId));
        const remembered = readStorage<string>("local", branchKey(vendorId));
        const valid = (id: string | null | undefined) => Boolean(id && s.branches.some((b) => b.id === id));
        if (saved && valid(saved.branchId) && saved.lines?.length) {
          setBranchId(saved.branchId);
          setBasket(saved.lines);
          setPayment(saved.payment === "CARD" ? "CARD" : "CASH");
        } else {
          setBranchId(valid(remembered) ? remembered! : s.branches[0]?.id ?? "");
        }
        setRestored(true);
      })
      .catch((err) => {
        if (isUnauthorized(err)) onExpired();
        else if (err instanceof ApiError && err.code === "FEATURE_DISABLED") setDisabled(true);
        else setFatal(posErrorText(err, lang));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, token, vendorId]);

  // the basket survives a reload or a lost connection on this device (sent nowhere until confirmed)
  useEffect(() => {
    if (!restored) return;
    writeStorage("session", basketKey(vendorId), basket.length ? { branchId, lines: basket, payment } : null);
  }, [restored, vendorId, branchId, basket, payment]);

  const branch = start?.branches.find((b) => b.id === branchId) ?? null;
  const inBasket = useCallback((id: string) => basket.find((l) => l.offer_variant_id === id)?.quantity ?? 0, [basket]);

  async function lookup(code: string) {
    if (!branchId) return;
    setLooking(true);
    setScanError(null);
    setUnknownCode(null);
    setAdded(null);
    setLinking(false);
    setDone(null);
    try {
      const c = await apiFetch<CardDto>(`/vendors/${vendorId}/branches/${branchId}/cashier/lookup?code=${encodeURIComponent(code)}`);
      setCard(c);
      const pre = c.preselect_variant_id ? c.options.find((o) => o.offer_variant_id === c.preselect_variant_id) : null;
      const colourKeys = [...new Set(c.options.map((o) => o.color_key))];
      const only = c.options.length === 1 ? c.options[0] : null;
      setColorKey(pre?.color_key ?? only?.color_key ?? (colourKeys.length === 1 ? colourKeys[0] : null));
      setVariantId(pre?.offer_variant_id ?? only?.offer_variant_id ?? null);
      setQty(1);
    } catch (err) {
      setCard(null);
      if (isUnauthorized(err)) {
        onExpired();
        return;
      }
      if (err instanceof ApiError && err.code === "BARCODE_UNKNOWN") {
        setUnknownCode((err.details[0] as { code?: string } | undefined)?.code ?? code.trim());
      } else {
        setScanError(posErrorText(err, lang));
      }
    } finally {
      setLooking(false);
    }
  }

  const colours = useMemo(() => {
    if (!card) return [];
    const seen = new Map<string | null, { option: OptionDto; available: number }>();
    for (const o of card.options) {
      const left = Math.max(0, o.available - inBasket(o.offer_variant_id));
      const s = seen.get(o.color_key);
      if (s) s.available += left;
      else seen.set(o.color_key, { option: o, available: left });
    }
    return [...seen.values()];
  }, [card, inBasket]);
  const sizes = useMemo(() => (card ? card.options.filter((o) => o.color_key === colorKey) : []), [card, colorKey]);
  const chosen = card?.options.find((o) => o.offer_variant_id === variantId) ?? null;
  const remaining = chosen ? Math.max(0, chosen.available - inBasket(chosen.offer_variant_id)) : 0;

  /** The same product x colour x size again only adds to its line; anything else is a new line. */
  function addToBasket() {
    if (!card || !chosen || remaining <= 0) return;
    const amount = Math.min(qty, remaining);
    setBasket((lines) => {
      const existing = lines.find((l) => l.offer_variant_id === chosen.offer_variant_id);
      if (existing) {
        return lines.map((l) =>
          l === existing ? { ...l, quantity: l.quantity + amount, available: chosen.available, unit_price: chosen.unit_price, problem: undefined } : l,
        );
      }
      return [
        ...lines,
        {
          offer_variant_id: chosen.offer_variant_id,
          offer_id: card.offer.id,
          title_ar: card.offer.title_ar,
          title_en: card.offer.title_en,
          color_name_ar: chosen.color_name_ar,
          color_name_en: chosen.color_name_en,
          color_hex: chosen.color_hex,
          size_label: chosen.size_label,
          unit_price: chosen.unit_price,
          quantity: amount,
          available: chosen.available,
          scanned_code: card.code,
        },
      ];
    });
    setAttemptKey(null);
    setAdded(
      fillPos(t("pos.added_line"), {
        color: name(chosen.color_name_ar, chosen.color_name_en) || t("pos.color.none"),
        size: chosen.size_label ?? t("pos.size.none"),
        n: amount,
      }),
    );
    // ready for another size of this colour, or the next product
    setVariantId(null);
    setQty(1);
  }

  function changeLine(id: string, delta: number) {
    setBasket((lines) =>
      lines.map((l) => (l.offer_variant_id === id ? { ...l, quantity: Math.max(1, Math.min(l.available, l.quantity + delta)), problem: undefined } : l)),
    );
    setAttemptKey(null);
  }

  const total = basket.reduce((sum, l) => sum + cents(l.unit_price) * l.quantity, 0) / 100;
  const units = basket.reduce((n, l) => n + l.quantity, 0);
  const blocked = basket.some((l) => l.problem?.kind === "short" || l.problem?.kind === "not_sellable");

  async function confirmSale() {
    if (!basket.length || !branchId || !online) return;
    const key = attemptKey ?? newIdempotencyKey(`store-sale-${branchId}`);
    setAttemptKey(key);
    setSaving(true);
    setSaleError(null);
    try {
      const sale = await apiFetch<SaleDto>(`/vendors/${vendorId}/branches/${branchId}/store-sales`, {
        method: "POST",
        idempotencyKey: key,
        body: {
          payment_method: payment,
          lines: basket.map((l) => ({
            offer_variant_id: l.offer_variant_id,
            quantity: l.quantity,
            expected_unit_price: Number(l.unit_price),
            ...(l.scanned_code ? { scanned_code: l.scanned_code } : {}),
          })),
        },
      });
      setDone(sale);
      setBasket([]);
      setCard(null);
      setAdded(null);
      setConfirming(false);
      setAttemptKey(null);
      setPayment("CASH");
      scanRef.current?.focus();
    } catch (err) {
      setConfirming(false);
      if (isUnauthorized(err)) {
        onExpired();
        return;
      }
      if (!(err instanceof ApiError)) {
        // the answer was lost: the same key is kept, so trying again never records a second sale
        setSaleError(t("pos.network"));
        return;
      }
      setAttemptKey(null);
      const details = err.details as { offer_variant_id?: string; available?: number; unit_price?: string }[];
      if (err.code === "INSUFFICIENT_STOCK") {
        setBasket((lines) =>
          lines.map((l) => {
            const d = details.find((x) => x.offer_variant_id === l.offer_variant_id);
            return d ? { ...l, available: d.available ?? 0, problem: { kind: "short", available: d.available ?? 0 } } : { ...l, problem: undefined };
          }),
        );
      } else if (err.code === "PRICE_CHANGED") {
        setBasket((lines) =>
          lines.map((l) => {
            const d = details.find((x) => x.offer_variant_id === l.offer_variant_id);
            return d?.unit_price ? { ...l, unit_price: d.unit_price, problem: { kind: "price" } } : { ...l, problem: undefined };
          }),
        );
      } else if (err.code === "PRODUCT_NOT_SELLABLE") {
        setBasket((lines) => lines.map((l) => (details.some((x) => x.offer_variant_id === l.offer_variant_id) ? { ...l, problem: { kind: "not_sellable" } } : l)));
      }
      setSaleError(posErrorText(err, lang));
    } finally {
      setSaving(false);
    }
  }

  async function openLinking() {
    setLinking(true);
    setLinkError(null);
    if (offers) return;
    try {
      const all = await apiFetch<OwnerOfferDto[]>(`/vendors/${vendorId}/offers`);
      setOffers(all.filter((o) => o.status !== "ARCHIVED"));
    } catch (err) {
      setLinkError(posErrorText(err, lang));
    }
  }

  async function link(offer: OwnerOfferDto) {
    if (!unknownCode) return;
    setLinkBusy(true);
    setLinkError(null);
    try {
      await apiFetch(`/vendors/${vendorId}/offers/${offer.id}/barcodes`, { method: "POST", body: { code: unknownCode } });
      const code = unknownCode;
      setLinking(false);
      setUnknownCode(null);
      await lookup(code);
      setAdded(fillPos(t("pos.link.done"), { title: name(offer.title_ar, offer.title_en) }));
    } catch (err) {
      setLinkError(posErrorText(err, lang));
    } finally {
      setLinkBusy(false);
    }
  }

  if (disabled) {
    return (
      <div className="page-shell pos-ui pos-cashier">
        <h1 className="pos-screen-title pos-own-title">{t("pos.title")}</h1>
        <p className="muted" data-testid="pos-disabled">{t("pos.disabled")}</p>
      </div>
    );
  }
  if (fatal) {
    return (
      <div className="page-shell pos-ui pos-cashier">
        <ErrorBanner message={fatal} />
      </div>
    );
  }
  if (!start) {
    return (
      <div className="page-shell pos-ui pos-cashier" aria-busy="true">
        <div className="skeleton" style={{ height: 220, maxWidth: 720 }} />
      </div>
    );
  }

  const filteredOffers = (offers ?? []).filter((o) => {
    const q = linkQuery.trim().toLowerCase();
    return !q || o.title_ar.toLowerCase().includes(q) || o.title_en.toLowerCase().includes(q);
  });
  const image = chosen?.image_url ?? card?.offer.image_url ?? null;

  return (
    <div className="page-shell pos-ui pos-cashier" data-testid="pos-page">
      <header className="pos-cashier-bar">
        <h1 className="pos-screen-title pos-own-title">{t("pos.title")}</h1>
        <div className="pos-branch-pick">
          {start.branches.length === 0 ? (
            <p className="pos-inline-error">{t("pos.branch.none")}</p>
          ) : start.role === "OWNER" && start.branches.length > 1 ? (
            <>
              <label htmlFor="pos-branch">{t("pos.branch")}</label>
              <select
                id="pos-branch"
                value={branchId}
                disabled={basket.length > 0 || saving}
                aria-describedby={basket.length ? "pos-branch-locked" : undefined}
                data-testid="pos-branch"
                onChange={(e) => {
                  setBranchId(e.target.value);
                  writeStorage("local", branchKey(vendorId), e.target.value);
                  setCard(null);
                  setDone(null);
                }}
              >
                {start.branches.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
              {basket.length > 0 && <small id="pos-branch-locked">{t("pos.branch.locked")}</small>}
            </>
          ) : (
            <p>
              <span>{t("pos.branch")}: </span>
              <strong data-testid="pos-branch-name">{branch?.name}</strong>
            </p>
          )}
        </div>
        <span className={`pos-online${online ? "" : " is-off"}`} role="status">{online ? t("pos.online") : t("pos.offline_short")}</span>
      </header>
      {!online && <div className="pos-offline" role="alert" data-testid="pos-offline">{t("pos.offline")}</div>}

      {branch && (
        <div className="pos-cashier-grid">
          <div className="pos-cashier-main">
            {/* 1. scan */}
            <section className="pos-panel pos-scan-panel" aria-label={t("pos.scan.label")}>
              <BarcodeScanner
                ref={scanRef}
                id="pos-scan"
                label={t("pos.scan.label")}
                hint={t("pos.scan.hint")}
                submitLabel={looking ? t("pos.searching") : t("pos.scan.find")}
                busy={looking}
                autoFocus
                keepReady
                testId="pos-scan"
                onSubmit={lookup}
              />
              <div aria-live="polite">
                {scanError && <p className="pos-inline-error" role="alert" data-testid="pos-scan-error">{scanError}</p>}
                {unknownCode && (
                  <div className="pos-unknown" data-testid="pos-unknown">
                    <p className="pos-inline-error" role="alert">{fillPos(t("pos.unknown"), { code: unknownCode })}</p>
                    {start.can_link_barcodes && !linking && (
                      <button type="button" className="pos-btn pos-btn-secondary" onClick={openLinking} data-testid="pos-link-open">
                        {t("pos.unknown.link")}
                      </button>
                    )}
                  </div>
                )}
              </div>
              {linking && unknownCode && (
                <div className="pos-link" data-testid="pos-link">
                  <h2 className="pos-subtitle">{fillPos(t("pos.link.title"), { code: unknownCode })}</h2>
                  <label htmlFor="pos-link-search" className="pos-field-label">{t("pos.link.search")}</label>
                  <input id="pos-link-search" className="pos-text" value={linkQuery} onChange={(e) => setLinkQuery(e.target.value)} autoFocus />
                  {linkError && <p className="pos-inline-error" role="alert">{linkError}</p>}
                  {!offers ? (
                    !linkError && <div className="skeleton" style={{ height: 60 }} />
                  ) : filteredOffers.length === 0 ? (
                    <p className="pos-empty-line">{t("pos.link.none")}</p>
                  ) : (
                    <ul className="pos-link-list">
                      {filteredOffers.slice(0, 30).map((o) => (
                        <li key={o.id}>
                          <span>{name(o.title_ar, o.title_en)}</span>
                          <button type="button" className="pos-btn pos-btn-quiet" disabled={linkBusy} onClick={() => link(o)}>
                            {t("pos.link.do")}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <button type="button" className="pos-link-btn" onClick={() => setLinking(false)}>{t("pos.link.cancel")}</button>
                </div>
              )}
            </section>

            {/* 2. colour, size, quantity */}
            {card ? (
              <section className="pos-panel pos-picker" aria-labelledby="pos-card-title" data-testid="pos-card">
                <div className="pos-picker-head">
                  {image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={image} alt="" className="pos-picker-image" />
                  ) : (
                    <span className="pos-picker-image pos-picker-image-empty" aria-hidden="true" />
                  )}
                  <div className="pos-picker-title">
                    <h2 id="pos-card-title">{name(card.offer.title_ar, card.offer.title_en)}</h2>
                    <p className="pos-price">{formatIls(chosen?.unit_price ?? card.options[0]?.unit_price ?? 0, lang)}</p>
                    <div className="pos-tags">
                      {card.offer.status === "INACTIVE" && <span className="pos-tag pos-tag-sand">{t("pos.card.hidden")}</span>}
                      {card.matched_by === "LEGACY_VARIANT_CODE" && <span className="pos-tag pos-tag-quiet">{t("pos.card.legacy")}</span>}
                      <span className="pos-tag pos-tag-quiet" dir="ltr">{card.code}</span>
                    </div>
                  </div>
                </div>

                <div className="pos-step">
                  <p className="pos-step-label" id="pos-color-label"><span className="pos-step-n">1</span>{t("pos.color")}</p>
                  <div className="pos-options" role="group" aria-labelledby="pos-color-label">
                    {colours.map(({ option: c, available }) => (
                      <button
                        key={c.color_key ?? "none"}
                        type="button"
                        className={`pos-option${colorKey === c.color_key ? " is-selected" : ""}${available <= 0 ? " is-empty" : ""}`}
                        aria-pressed={colorKey === c.color_key}
                        onClick={() => {
                          setColorKey(c.color_key);
                          setVariantId(null);
                          setQty(1);
                        }}
                        data-testid={`pos-color-${c.color_name_ar ?? "none"}`}
                      >
                        {c.color_hex && <span className="pos-swatch" style={{ background: c.color_hex }} aria-hidden="true" />}
                        <span>{name(c.color_name_ar, c.color_name_en) || t("pos.color.none")}</span>
                        <small>{available > 0 ? available : t("pos.sold_out_short")}</small>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="pos-step">
                  <p className="pos-step-label" id="pos-size-label"><span className="pos-step-n">2</span>{t("pos.size")}</p>
                  {sizes.length === 0 ? (
                    <p className="pos-empty-line">{t("pos.pick_color_first")}</p>
                  ) : (
                    <div className="pos-options" role="group" aria-labelledby="pos-size-label">
                      {sizes.map((o) => {
                        const left = Math.max(0, o.available - inBasket(o.offer_variant_id));
                        const label = o.size_label ?? t("pos.size.none");
                        return (
                          <button
                            key={o.offer_variant_id}
                            type="button"
                            className={`pos-option pos-option-size${variantId === o.offer_variant_id ? " is-selected" : ""}${left <= 0 ? " is-sold-out" : ""}`}
                            aria-pressed={variantId === o.offer_variant_id}
                            disabled={left <= 0}
                            aria-label={left <= 0 ? fillPos(t("pos.sold_out_choice"), { label }) : `${label} — ${fillPos(t("pos.available"), { n: left })}`}
                            data-testid={`pos-size-${o.size_code ?? o.size_label ?? "none"}`}
                            onClick={() => {
                              setVariantId(o.offer_variant_id);
                              setQty(1);
                            }}
                          >
                            <span>{label}</span>
                            <small>{left <= 0 ? t("pos.sold_out_short") : left}</small>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="pos-step pos-step-qty">
                  <p className="pos-step-label"><span className="pos-step-n">3</span>{t("pos.qty")}</p>
                  <div className="pos-qty-row">
                    <div className="pos-stepper" role="group" aria-label={t("pos.qty")}>
                      <button type="button" onClick={() => setQty((q) => Math.max(1, q - 1))} disabled={!chosen || qty <= 1} aria-label={t("pos.qty.less")}>−</button>
                      <output aria-live="polite" data-testid="pos-qty">{qty}</output>
                      <button type="button" onClick={() => setQty((q) => Math.min(remaining, q + 1))} disabled={!chosen || qty >= remaining} aria-label={t("pos.qty.more")}>+</button>
                    </div>
                    <p className="pos-available" data-testid="pos-available">
                      {!chosen ? t("pos.pick_size") : remaining > 0 ? fillPos(t("pos.available"), { n: remaining }) : t("pos.sold_out")}
                    </p>
                  </div>
                  <button type="button" className="pos-btn pos-btn-primary pos-add" onClick={addToBasket} disabled={!chosen || remaining <= 0} data-testid="pos-add">
                    {t("pos.add")}
                  </button>
                  {added && <p className="pos-inline-notice" role="status" data-testid="pos-added">{added}</p>}
                </div>
              </section>
            ) : (
              !unknownCode && !linking && (
                <section className="pos-panel pos-picker-empty">
                  <p>{t("pos.scan.first")}</p>
                </section>
              )
            )}
          </div>

          {/* 3. the sale */}
          <aside ref={basketRef} className="pos-panel pos-basket" aria-labelledby="pos-basket-title" data-testid="pos-basket" tabIndex={-1}>
            <div className="pos-panel-head">
              <h2 id="pos-basket-title">{t("pos.basket")}</h2>
              <span className="pos-count">{fillPos(t("pos.basket.count"), { lines: basket.length, n: units })}</span>
            </div>
            {done && (
              <div className="pos-done" role="status" data-testid="pos-done">
                <p>{fillPos(t("pos.done"), { label: done.sale_label, total: formatIls(done.total, lang) })}</p>
                <div className="pos-done-actions">
                  <button
                    type="button"
                    className="pos-btn pos-btn-quiet"
                    onClick={() => {
                      setDone(null);
                      scanRef.current?.focus();
                    }}
                  >
                    {t("pos.done.new")}
                  </button>
                  <Link href={`/vendor/${vendorId}/store-sales`} className="pos-link-btn">{t("pos.done.view")}</Link>
                </div>
              </div>
            )}
            {basket.length === 0 ? (
              !done && <p className="pos-empty-line">{t("pos.basket.empty")}</p>
            ) : (
              <>
                <div className="pos-basket-body">
                <ul className="pos-lines">
                  {basket.map((l) => {
                    const title = name(l.title_ar, l.title_en);
                    const colour = name(l.color_name_ar, l.color_name_en) || t("pos.color.none");
                    const size = l.size_label ?? t("pos.size.none");
                    return (
                      <li key={l.offer_variant_id} className={`pos-line${l.problem ? " has-problem" : ""}`} data-testid="pos-line">
                        <div className="pos-line-main">
                          <strong className="pos-line-title">{title}</strong>
                          <span className="pos-line-variant">
                            {l.color_hex && <span className="pos-swatch" style={{ background: l.color_hex }} aria-hidden="true" />}
                            {colour} · {size}
                          </span>
                          <span className="pos-line-unit">{formatIls(l.unit_price, lang)}</span>
                          {l.problem?.kind === "short" && <span className="pos-inline-error">{fillPos(t("pos.line.short"), { n: l.problem.available })}</span>}
                          {l.problem?.kind === "price" && <span className="pos-inline-error">{t("pos.line.price")}</span>}
                          {l.problem?.kind === "not_sellable" && <span className="pos-inline-error">{t("pos.line.not_sellable")}</span>}
                        </div>
                        <div className="pos-line-side">
                          <div className="pos-stepper pos-stepper-sm" role="group" aria-label={fillPos(t("pos.line.qty"), { title, color: colour, size })}>
                            <button type="button" onClick={() => changeLine(l.offer_variant_id, -1)} disabled={saving || l.quantity <= 1} aria-label={t("pos.qty.less")}>−</button>
                            <output data-testid="pos-line-qty">{l.quantity}</output>
                            <button type="button" onClick={() => changeLine(l.offer_variant_id, 1)} disabled={saving || l.quantity >= l.available} aria-label={t("pos.qty.more")}>+</button>
                          </div>
                          <strong className="pos-line-total">{formatIls((cents(l.unit_price) * l.quantity) / 100, lang)}</strong>
                          <button
                            type="button"
                            className="pos-line-remove"
                            disabled={saving}
                            aria-label={fillPos(t("pos.basket.remove"), { title: `${title} ${colour} ${size}` })}
                            onClick={() => {
                              setBasket((lines) => lines.filter((x) => x !== l));
                              setAttemptKey(null);
                            }}
                          >
                            ×
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
                </div>
                <div className="pos-basket-foot">
                <div className="pos-total">
                  <span>{t("pos.total")}</span>
                  <strong data-testid="pos-total">{formatIls(total, lang)}</strong>
                </div>
                <fieldset className="pos-pay">
                  <legend>{t("pos.payment")}</legend>
                  <div className="pos-choices-row">
                    {(["CASH", "CARD"] as const).map((p) => (
                      <label key={p} className={`pos-choice pos-choice-sm${payment === p ? " is-selected" : ""}`}>
                        <input type="radio" name="pos-payment" value={p} checked={payment === p} onChange={() => setPayment(p)} />
                        <span>{t(`pos.pay.${p}`)}</span>
                      </label>
                    ))}
                  </div>
                  <p className="pos-note">{t("pos.pay.note")}</p>
                </fieldset>
                {saleError && <p className="pos-inline-error" role="alert" data-testid="pos-sale-error">{saleError}</p>}
                <button
                  type="button"
                  className="pos-btn pos-btn-primary pos-confirm"
                  disabled={!online || saving || blocked}
                  onClick={() => setConfirming(true)}
                  data-testid="pos-confirm"
                >
                  <span>{saving ? t("pos.saving") : t("pos.confirm")}</span>
                  {!saving && <span className="pos-confirm-sum">{fillPos(t("pos.confirm.sum"), { n: units, total: formatIls(total, lang) })}</span>}
                </button>
                </div>
              </>
            )}
          </aside>
        </div>
      )}

      {/* on a phone: the sale stays in view at the bottom */}
      {branch && basket.length > 0 && (
        <div className="pos-mobile-bar">
          <button type="button" className="pos-mobile-summary" onClick={() => basketRef.current?.scrollIntoView({ block: "start", behavior: "smooth" })}>
            {fillPos(t("pos.basket.count"), { lines: basket.length, n: units })} · <strong>{formatIls(total, lang)}</strong>
          </button>
          <button type="button" className="pos-btn pos-btn-primary" disabled={!online || saving || blocked} onClick={() => setConfirming(true)}>
            {t("pos.confirm")}
          </button>
        </div>
      )}

      {confirming && (
        <div className="store-quick-edit-overlay" role="presentation" onClick={() => !saving && setConfirming(false)}>
          <section
            className="store-quick-edit-dialog pos-confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="pos-confirm-title"
            aria-describedby="pos-confirm-text"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="pos-confirm-title">{t("pos.confirm.title")}</h2>
            <p id="pos-confirm-text">
              {fillPos(t("pos.confirm.text"), { n: units, lines: basket.length, total: formatIls(total, lang), pay: t(`pos.pay.${payment}`), branch: branch?.name ?? "" })}
            </p>
            <div className="store-quick-edit-actions">
              <button type="button" onClick={() => setConfirming(false)} disabled={saving}>{t("pos.confirm.back")}</button>
              <button type="button" onClick={confirmSale} disabled={saving || !online} autoFocus data-testid="pos-confirm-yes">
                {saving ? t("pos.saving") : t("pos.confirm.yes")}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
