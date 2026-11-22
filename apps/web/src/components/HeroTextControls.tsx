"use client";

import { ColorField, Range } from "@/components/StoreCoverControls";
import {
  HERO_FONTS,
  HERO_TEXT_FALLBACK,
  HERO_TEXT_PRESETS,
  HERO_WEIGHTS,
  weightsFor,
  withFont,
  type HeroFont,
  type HeroTextField,
  type HeroTextStyle,
} from "@/lib/heroText";

// The hero title / description pencils' text styling: colour, font,
// weight and an optional readability shadow - for one text only (the
// other keeps its own settings). Same compact sections as the cover
// layer controls.
export default function HeroTextControls({
  field,
  style,
  onChange,
  disabled,
}: {
  field: HeroTextField;
  style: HeroTextStyle;
  onChange: (style: HeroTextStyle) => void;
  disabled?: boolean;
}) {
  const subject = field === "hero_title" ? "العنوان" : "الوصف";
  const weights = weightsFor(style.font);
  return (
    <div className="cover-layers hero-text-controls">
      <section className={`cover-layer${style.color ? " is-on" : ""}`}>
        <header className="cover-layer-head">
          <h3>لون {subject}</h3>
          {style.color && (
            <button type="button" className="hero-text-reset" disabled={disabled} onClick={() => onChange({ ...style, color: null })}>
              اللون الافتراضي
            </button>
          )}
        </header>
        <div className="cover-layer-body">
          <ColorField
            label={`لون ${subject}`}
            value={style.color ?? ""}
            fallback={HERO_TEXT_FALLBACK[field]}
            presets
            presetColors={HERO_TEXT_PRESETS}
            disabled={disabled}
            onChange={(value) => onChange({ ...style, color: value.trim() === "" ? null : value.trim() })}
          />
        </div>
      </section>

      <section className={`cover-layer${style.font || style.weight !== null ? " is-on" : ""}`}>
        <header className="cover-layer-head">
          <h3>خط {subject}</h3>
        </header>
        <div className="cover-layer-body">
          <div className="hero-text-options" role="group" aria-label={`خط ${subject}`}>
            <button type="button" aria-pressed={style.font === null} disabled={disabled} onClick={() => onChange(withFont(style, null))}>
              الافتراضي
            </button>
            {HERO_FONTS.map((font) => (
              <button
                key={font.id}
                type="button"
                data-font={font.id}
                aria-pressed={style.font === font.id}
                disabled={disabled}
                style={{ fontFamily: font.family, fontWeight: font.id === "AMIRI" ? 700 : undefined }}
                onClick={() => onChange(withFont(style, font.id as HeroFont))}
              >
                {font.label}
              </button>
            ))}
          </div>
          <div className="hero-text-options" role="group" aria-label={`سماكة ${subject}`}>
            <button type="button" aria-pressed={style.weight === null} disabled={disabled} onClick={() => onChange({ ...style, weight: null })}>
              الافتراضية
            </button>
            {HERO_WEIGHTS.filter((w) => weights.includes(w.value)).map((w) => (
              <button
                key={w.value}
                type="button"
                data-weight={w.value}
                aria-pressed={style.weight === w.value}
                disabled={disabled}
                style={{ fontWeight: w.value }}
                onClick={() => onChange({ ...style, weight: w.value })}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className={`cover-layer${style.shadowEnabled ? " is-on" : ""}`}>
        <header className="cover-layer-head">
          <h3>ظل {subject}</h3>
          <label className="cover-layer-switch">
            <input
              type="checkbox"
              role="switch"
              checked={style.shadowEnabled}
              disabled={disabled}
              onChange={(event) => onChange({ ...style, shadowEnabled: event.target.checked })}
            />
            <span>ظل لوضوح النص فوق الغلاف</span>
          </label>
        </header>
        {style.shadowEnabled && (
          <div className="cover-layer-body">
            <Range
              label="قوة الظل"
              value={Math.round(style.shadowStrength * 100)}
              min={10}
              max={100}
              disabled={disabled}
              onChange={(v) => onChange({ ...style, shadowStrength: v / 100 })}
            />
          </div>
        )}
      </section>
    </div>
  );
}
