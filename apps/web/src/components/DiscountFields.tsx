"use client";

import { useId } from "react";
import { fromLocalInput, priceAfterPercent, toLocalInput, type DraftDiscount } from "@/lib/discountWindow";
import { fill } from "@/lib/offerWizardText";
import "@/lib/offerWizardText";

/**
 * Phase A++ (item 7): the ONE discount control, used by the wizard (step 4)
 * and the product page's «السعر والخصم» card - the system's two existing
 * modes: «سعر بعد الخصم» (immediate, no dates) or «خصم بنسبة لفترة»
 * (percentage + start + end, in the browser's local time).
 */
export function DiscountFields({
  price,
  value,
  onChange,
  t,
  disabled,
  error,
}: {
  price: number | null;
  value: DraftDiscount | null;
  onChange: (next: DraftDiscount | null) => void;
  t: (key: string) => string;
  disabled?: boolean;
  error?: string | null;
}) {
  const uid = useId();
  const mode = value?.mode ?? "none";
  const num = (v: string) => (v === "" || Number.isNaN(Number(v)) ? null : Number(v));
  const after =
    value?.mode === "sale"
      ? value.sale_price
      : value?.mode === "window" && price && value.percent !== null && value.percent > 0 && value.percent < 100
        ? priceAfterPercent(price, value.percent)
        : null;

  return (
    <fieldset className="wz-field wz-discount" disabled={disabled} data-testid="discount-fields">
      <legend>
        {t("discount.title")} <span className="wz-opt">({t("wz.optional")})</span>
      </legend>
      <div className="wz-choice-row" role="radiogroup" aria-label={t("discount.title")}>
        {(["none", "sale", "window"] as const).map((m) => (
          <label key={m} className={`wz-choice${mode === m ? " wz-choice-on" : ""}`} data-testid={`discount-mode-${m}`}>
            <input
              type="radio"
              name={`${uid}-mode`}
              checked={mode === m}
              onChange={() =>
                onChange(
                  m === "none"
                    ? null
                    : m === "sale"
                      ? { mode: "sale", sale_price: value?.mode === "sale" ? value.sale_price : null }
                      : { mode: "window", percent: null, start_at: null, end_at: null },
                )
              }
            />
            {t(`discount.mode.${m}`)}
          </label>
        ))}
      </div>
      {value?.mode === "sale" && (
        <div className="wz-field">
          <label htmlFor={`${uid}-sale`}>{t("discount.sale_price")}</label>
          <input
            id={`${uid}-sale`}
            type="number"
            inputMode="decimal"
            min={0}
            step="0.5"
            value={value.sale_price ?? ""}
            onChange={(e) => onChange({ mode: "sale", sale_price: num(e.target.value) })}
            data-testid="discount-sale-price"
          />
          <p className="wz-hint">{t("discount.sale_note")}</p>
        </div>
      )}
      {value?.mode === "window" && (
        <div className="wz-discount-window">
          <div className="wz-field">
            <label htmlFor={`${uid}-pct`}>{t("discount.percent")}</label>
            <input
              id={`${uid}-pct`}
              type="number"
              inputMode="decimal"
              min={1}
              max={99}
              value={value.percent ?? ""}
              onChange={(e) => onChange({ ...value, percent: num(e.target.value) })}
              data-testid="discount-percent"
            />
          </div>
          <div className="wz-field">
            <label htmlFor={`${uid}-from`}>{t("discount.from")}</label>
            <input
              id={`${uid}-from`}
              type="datetime-local"
              value={toLocalInput(value.start_at)}
              onChange={(e) => onChange({ ...value, start_at: e.target.value ? fromLocalInput(e.target.value) : null })}
              data-testid="discount-from"
            />
          </div>
          <div className="wz-field">
            <label htmlFor={`${uid}-to`}>{t("discount.to")}</label>
            <input
              id={`${uid}-to`}
              type="datetime-local"
              value={toLocalInput(value.end_at)}
              onChange={(e) => onChange({ ...value, end_at: e.target.value ? fromLocalInput(e.target.value) : null })}
              data-testid="discount-to"
            />
          </div>
          <p className="wz-hint">{t("discount.window_note")}</p>
        </div>
      )}
      {after !== null && price ? (
        <p className="wz-hint" data-testid="discount-after">{fill(t("discount.after"), { from: price, to: after })}</p>
      ) : null}
      {error && (
        <p className="wz-field-error" role="alert" data-testid="discount-error">
          {error}
        </p>
      )}
    </fieldset>
  );
}
