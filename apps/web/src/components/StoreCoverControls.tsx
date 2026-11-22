"use client";

import { ReactNode, useId } from "react";
import {
  COVER_COLOR_PRESETS,
  DEFAULT_COVER_TINT_COLOR,
  MAX_OVERLAY_BRIGHTNESS,
  MIN_OVERLAY_BRIGHTNESS,
  fromPercent,
  isCoverColor,
  toPercent,
  type CoverLook,
} from "@/lib/storeCover";

// The storefront cover's layer controls - one component for the cover
// pencil popup on the public store page AND the storefront settings page,
// so the two never offer different options. Each layer has its own
// switch and shows its controls only while on; switching it off keeps
// its colour and strength (they are simply not rendered).

interface StoreCoverControlsProps {
  look: CoverLook;
  onChange: (patch: Partial<CoverLook>) => void;
  disabled?: boolean;
  /** The image's upload / URL inputs (each screen keeps its own). */
  imageSource?: ReactNode;
}

function Section(props: {
  title: string;
  switchLabel: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: (checked: boolean) => void;
  alwaysShown?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className={`cover-layer${props.checked ? " is-on" : ""}`} aria-labelledby={`${id}-title`}>
      <header className="cover-layer-head">
        <h3 id={`${id}-title`}>{props.title}</h3>
        <label className="cover-layer-switch">
          <input
            type="checkbox"
            role="switch"
            checked={props.checked}
            disabled={props.disabled}
            onChange={(event) => props.onToggle(event.target.checked)}
          />
          <span>{props.switchLabel}</span>
        </label>
      </header>
      {props.alwaysShown}
      {props.checked && <div className="cover-layer-body">{props.children}</div>}
    </section>
  );
}

/** A labelled slider (also used by the panel appearance editor). */
export function Range(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  /** Shown after the value; "%" by default. */
  unit?: string;
  /** Replaces the shown value (e.g. "دائري" for a full radius). */
  display?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const unit = props.unit ?? "%";
  const shown = props.display ?? `${props.value}${unit}`;
  return (
    <label className="cover-layer-range">
      <span>
        {props.label} <output>{shown}</output>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={1}
        value={props.value}
        disabled={props.disabled}
        aria-valuetext={shown}
        onChange={(event) => props.onChange(Number(event.target.value))}
      />
    </label>
  );
}

/** Colour picker + hex input (+ the preset colours). */
export function ColorField(props: {
  label: string;
  value: string;
  fallback: string;
  presets?: boolean;
  /** The preset swatches (the cover colours by default). */
  presetColors?: readonly string[];
  /** Show the label above the field (the panel editor has several
   * colours per group; the cover sections have one each). */
  showLabel?: boolean;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const selected = props.value.toLowerCase();
  return (
    <div className="cover-layer-color">
      {props.showLabel && <span className="cover-layer-color-label">{props.label}</span>}
      <div className="cover-layer-color-row">
        <input
          type="color"
          aria-label={`اختيار ${props.label}`}
          value={isCoverColor(props.value) ? props.value : props.fallback}
          disabled={props.disabled}
          onChange={(event) => props.onChange(event.target.value)}
        />
        <input
          aria-label={`رمز ${props.label}`}
          value={props.value}
          placeholder={props.fallback}
          dir="ltr"
          disabled={props.disabled}
          onChange={(event) => props.onChange(event.target.value)}
        />
      </div>
      {props.presets && (
        <div className="cover-layer-presets" role="group" aria-label={`ألوان مقترحة لـ${props.label}`}>
          {(props.presetColors ?? COVER_COLOR_PRESETS).map((color) => (
            <button
              key={color}
              type="button"
              className={selected === color.toLowerCase() ? "is-selected" : ""}
              style={{ backgroundColor: color }}
              aria-label={`اختيار اللون ${color}`}
              aria-pressed={selected === color.toLowerCase()}
              disabled={props.disabled}
              onClick={() => props.onChange(color)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function StoreCoverControls({ look, onChange, disabled, imageSource }: StoreCoverControlsProps) {
  return (
    <div className="cover-layers">
      <Section
        title="صورة الغلاف"
        switchLabel="إظهار صورة الغلاف"
        checked={look.imageEnabled}
        disabled={disabled}
        onToggle={(checked) => onChange({ imageEnabled: checked })}
        alwaysShown={imageSource}
      >
        <Range
          label="وضوح صورة الغلاف"
          value={toPercent(look.imageOpacity)}
          min={0}
          max={100}
          disabled={disabled}
          onChange={(v) => onChange({ imageOpacity: fromPercent(v) })}
        />
      </Section>

      <Section
        title="طبقة لونية علوية"
        switchLabel="إضافة طبقة لونية علوية"
        checked={look.tintEnabled && look.tintColor !== null}
        disabled={disabled}
        onToggle={(checked) =>
          onChange({ tintEnabled: checked, ...(checked && look.tintColor === null ? { tintColor: DEFAULT_COVER_TINT_COLOR } : {}) })
        }
      >
        <ColorField
          label="لون الطبقة العلوية"
          value={look.tintColor ?? ""}
          fallback={DEFAULT_COVER_TINT_COLOR}
          presets
          disabled={disabled}
          onChange={(value) => onChange({ tintColor: value })}
        />
        <Range
          label="شفافية الطبقة اللونية"
          value={toPercent(look.tintOpacity)}
          min={0}
          max={100}
          disabled={disabled}
          onChange={(v) => onChange({ tintOpacity: fromPercent(v) })}
        />
      </Section>

      <Section
        title="طبقة لون عامة"
        switchLabel="إضافة لون عام فوق الغلاف"
        checked={look.overlayEnabled}
        disabled={disabled}
        onToggle={(checked) => onChange({ overlayEnabled: checked })}
      >
        <ColorField
          label="لون الطبقة العامة"
          value={look.overlayColor}
          fallback="#D6AFA4"
          presets
          disabled={disabled}
          onChange={(value) => onChange({ overlayColor: value })}
        />
        <Range
          label="شفافية الطبقة العامة"
          value={toPercent(look.overlayOpacity)}
          min={0}
          max={100}
          disabled={disabled}
          onChange={(v) => onChange({ overlayOpacity: fromPercent(v) })}
        />
        <Range
          label="سطوع الطبقة العامة"
          value={toPercent(look.overlayBrightness)}
          min={toPercent(MIN_OVERLAY_BRIGHTNESS)}
          max={toPercent(MAX_OVERLAY_BRIGHTNESS)}
          disabled={disabled}
          onChange={(v) => onChange({ overlayBrightness: Math.min(MAX_OVERLAY_BRIGHTNESS, Math.max(MIN_OVERLAY_BRIGHTNESS, v / 100)) })}
        />
      </Section>

      <Section
        title="تدرج البانيل السفلي"
        switchLabel="إظهار تدرج البانيل السفلي"
        checked={look.fadeEnabled}
        disabled={disabled}
        onToggle={(checked) => onChange({ fadeEnabled: checked })}
      >
        <ColorField
          label="لون التدرج"
          value={look.fadeColor}
          fallback="#4A1626"
          disabled={disabled}
          onChange={(value) => onChange({ fadeColor: value })}
        />
        <Range
          label="قوة التدرج"
          value={toPercent(look.fadeOpacity)}
          min={0}
          max={100}
          disabled={disabled}
          onChange={(v) => onChange({ fadeOpacity: fromPercent(v) })}
        />
      </Section>
    </div>
  );
}
