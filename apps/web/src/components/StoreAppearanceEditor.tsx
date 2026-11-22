"use client";

import { useState } from "react";
import { ColorField, Range } from "@/components/StoreCoverControls";
import {
  APPEARANCE_RANGES,
  DEFAULT_APPEARANCE,
  readabilityHint,
  type ButtonStyle,
  type Department,
  type PanelStyle,
  type StoreAppearance,
  type SubcategoryStyle,
} from "@/lib/storeAppearance";
import { fromPercent, toPercent } from "@/lib/storeCover";

// The product panel's appearance editor (the panel pencil on the public
// store page): the panel, the smart buttons, the main department buttons
// and the detailed subcategory chips - styling only.

type Section = "panel" | "smart" | "departments" | "subcategories";
type State = "default" | "active";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "panel", label: "لوحة المنتجات" },
  { id: "smart", label: "الأزرار الذكية" },
  { id: "departments", label: "الأقسام الرئيسية" },
  { id: "subcategories", label: "التصنيفات التفصيلية" },
];
const DEPARTMENT_LABELS: Record<"all" | Department, string> = { all: "الكل", women: "نساء", men: "رجال", kids: "أطفال" };
const STATE_LABELS: Record<State, string> = { default: "عادي", active: "عند التحديد" };

function Segmented<T extends string>(props: { label: string; value: T; options: { id: T; label: string }[]; onChange: (id: T) => void }) {
  return (
    <div className="appearance-segmented" role="group" aria-label={props.label}>
      {props.options.map((option) => (
        <button key={option.id} type="button" aria-pressed={props.value === option.id} onClick={() => props.onChange(option.id)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** "Text may be hard to read" + a one-click readable colour. */
function ReadabilityHint({ suggestion, onUse }: { suggestion: string | null; onUse: (color: string) => void }) {
  if (!suggestion) return null;
  return (
    <p className="appearance-hint" role="status">
      النص قد لا يكون واضحًا على هذه الخلفية.
      <button type="button" onClick={() => onUse(suggestion)}>
        استخدام {suggestion === "#FFFFFF" ? "نص فاتح" : "نص داكن"}
      </button>
    </p>
  );
}

const radiusToSlider = (r: number) => (r >= APPEARANCE_RANGES.buttonRadius.pill ? APPEARANCE_RANGES.buttonRadius.max : Math.min(r, APPEARANCE_RANGES.buttonRadius.max - 1));
const sliderToRadius = (v: number) => (v >= APPEARANCE_RANGES.buttonRadius.max ? APPEARANCE_RANGES.buttonRadius.pill : v);

function RadiusRange({ label, value, onChange }: { label: string; value: number; onChange: (r: number) => void }) {
  const slider = radiusToSlider(value);
  return (
    <Range
      label={label}
      value={slider}
      min={APPEARANCE_RANGES.buttonRadius.min}
      max={APPEARANCE_RANGES.buttonRadius.max}
      unit="px"
      display={slider >= APPEARANCE_RANGES.buttonRadius.max ? "دائري" : `${slider}px`}
      onChange={(v) => onChange(sliderToRadius(v))}
    />
  );
}

function ButtonFields<S extends ButtonStyle>(props: { style: S; under: string; onChange: (patch: Partial<S>) => void; radius?: boolean }) {
  const { style: s, onChange } = props;
  const set = (patch: Partial<ButtonStyle>) => onChange(patch as Partial<S>);
  return (
    <div className="appearance-fields">
      <ColorField showLabel label="لون الخلفية" value={s.background} fallback="#FFFFFF" presets onChange={(v) => set({ background: v })} />
      <Range label="شفافية الخلفية" value={toPercent(s.background_opacity)} min={0} max={100} onChange={(v) => set({ background_opacity: fromPercent(v) })} />
      <ColorField showLabel label="لون النص" value={s.text} fallback="#1C1416" onChange={(v) => set({ text: v })} />
      <ReadabilityHint suggestion={readabilityHint(s.text, s.background, s.background_opacity, props.under)} onUse={(v) => set({ text: v })} />
      <ColorField showLabel label="لون الإطار" value={s.border} fallback="#EADFDA" onChange={(v) => set({ border: v })} />
      <Range label="وضوح الإطار" value={toPercent(s.border_opacity)} min={0} max={100} onChange={(v) => set({ border_opacity: fromPercent(v) })} />
      <ColorField showLabel label="لون اللمعة" value={s.glow} fallback="#FFFFFF" presets onChange={(v) => set({ glow: v })} />
      <Range label="قوة اللمعة" value={toPercent(s.glow_strength)} min={0} max={100} onChange={(v) => set({ glow_strength: fromPercent(v) })} />
      <ColorField showLabel label="لون الظل" value={s.shadow_color} fallback="#4A1626" onChange={(v) => set({ shadow_color: v })} />
      <Range label="قوة الظل" value={toPercent(s.shadow_opacity)} min={0} max={100} onChange={(v) => set({ shadow_opacity: fromPercent(v) })} />
      <Range label="نعومة الظل" value={s.shadow_blur} min={APPEARANCE_RANGES.shadowBlur.min} max={APPEARANCE_RANGES.shadowBlur.max} unit="px" onChange={(v) => set({ shadow_blur: v })} />
      {props.radius && (
        <RadiusRange label="استدارة الزوايا" value={(s as unknown as SubcategoryStyle).radius} onChange={(r) => onChange({ radius: r } as unknown as Partial<S>)} />
      )}
    </div>
  );
}

function PanelFields({ panel, onChange }: { panel: PanelStyle; onChange: (patch: Partial<PanelStyle>) => void }) {
  return (
    <div className="appearance-fields">
      <ColorField showLabel label="لون خلفية اللوحة" value={panel.background} fallback="#FFFDFC" presets onChange={(v) => onChange({ background: v })} />
      <Range label="شفافية الخلفية" value={toPercent(panel.background_opacity)} min={0} max={100} onChange={(v) => onChange({ background_opacity: fromPercent(v) })} />
      <ColorField showLabel label="لون النص الأساسي" value={panel.text} fallback="#1C1416" onChange={(v) => onChange({ text: v })} />
      <ReadabilityHint suggestion={readabilityHint(panel.text, panel.background, panel.background_opacity, "#F8F2EF")} onUse={(v) => onChange({ text: v })} />
      <ColorField showLabel label="لون النص الثانوي" value={panel.muted_text} fallback="#6B5F5A" onChange={(v) => onChange({ muted_text: v })} />
      <ReadabilityHint suggestion={readabilityHint(panel.muted_text, panel.background, panel.background_opacity, "#F8F2EF", 3)} onUse={(v) => onChange({ muted_text: v })} />
      <ColorField showLabel label="لون الفاصل" value={panel.divider} fallback="#B28962" onChange={(v) => onChange({ divider: v })} />
      <Range label="سطوع الفاصل" value={toPercent(panel.divider_opacity)} min={0} max={100} onChange={(v) => onChange({ divider_opacity: fromPercent(v) })} />
      <ColorField showLabel label="لون إطار اللوحة" value={panel.border} fallback="#EADFDA" onChange={(v) => onChange({ border: v })} />
      <Range label="وضوح الإطار" value={toPercent(panel.border_opacity)} min={0} max={100} onChange={(v) => onChange({ border_opacity: fromPercent(v) })} />
      <Range label="استدارة الزوايا" value={panel.radius} min={APPEARANCE_RANGES.panelRadius.min} max={APPEARANCE_RANGES.panelRadius.max} unit="px" onChange={(v) => onChange({ radius: v })} />
      <ColorField showLabel label="لون الظل" value={panel.shadow_color} fallback="#4A1626" onChange={(v) => onChange({ shadow_color: v })} />
      <Range label="قوة الظل" value={toPercent(panel.shadow_opacity)} min={0} max={100} onChange={(v) => onChange({ shadow_opacity: fromPercent(v) })} />
      <Range label="نعومة الظل" value={panel.shadow_blur} min={APPEARANCE_RANGES.panelShadowBlur.min} max={APPEARANCE_RANGES.panelShadowBlur.max} unit="px" onChange={(v) => onChange({ shadow_blur: v })} />
      <Range label="إزاحة الظل عموديًا" value={panel.shadow_offset_y} min={APPEARANCE_RANGES.panelShadowOffset.min} max={APPEARANCE_RANGES.panelShadowOffset.max} unit="px" onChange={(v) => onChange({ shadow_offset_y: v })} />
    </div>
  );
}

export default function StoreAppearanceEditor(props: {
  value: StoreAppearance;
  onChange: (next: StoreAppearance) => void;
  disabled?: boolean;
}) {
  const { value: a, onChange } = props;
  const [section, setSection] = useState<Section>("panel");
  const [state, setState] = useState<State>("default");
  const [department, setDepartment] = useState<"all" | Department>("all");
  const [subDepartment, setSubDepartment] = useState<Department>("women");
  const panelBg = a.panel.background;
  const states = (["default", "active"] as const).map((id) => ({ id, label: STATE_LABELS[id] }));

  return (
    <fieldset className="cover-layers store-appearance-editor" disabled={props.disabled}>
      <Segmented label="أقسام المحرر" value={section} options={SECTIONS} onChange={setSection} />

      <section className="cover-layer is-on" aria-label={SECTIONS.find((item) => item.id === section)?.label}>
        <header className="cover-layer-head">
          <h3>{SECTIONS.find((item) => item.id === section)?.label}</h3>
          <button type="button" className="appearance-reset" onClick={() => onChange({ ...a, [section]: DEFAULT_APPEARANCE[section] })}>
            استعادة الافتراضي لهذا القسم
          </button>
        </header>

        {section === "panel" && <PanelFields panel={a.panel} onChange={(patch) => onChange({ ...a, panel: { ...a.panel, ...patch } })} />}

        {section === "smart" && (
          <>
            <p className="appearance-note">ينطبق على «وصل حديثاً» و«تخفيضات» و«الترند» معًا.</p>
            <RadiusRange label="استدارة الأزرار" value={a.smart.radius} onChange={(r) => onChange({ ...a, smart: { ...a.smart, radius: r } })} />
            <Segmented label="حالة الزر" value={state} options={states} onChange={setState} />
            <ButtonFields
              key={`smart-${state}`}
              style={a.smart[state]}
              under={panelBg}
              onChange={(patch) => onChange({ ...a, smart: { ...a.smart, [state]: { ...a.smart[state], ...patch } } })}
            />
          </>
        )}

        {section === "departments" && (
          <>
            <Segmented
              label="القسم"
              value={department}
              options={(["all", "women", "men", "kids"] as const).map((id) => ({ id, label: DEPARTMENT_LABELS[id] }))}
              onChange={setDepartment}
            />
            <Segmented label="حالة الزر" value={state} options={states} onChange={setState} />
            <ButtonFields
              key={`dept-${department}-${state}`}
              style={a.departments[department][state]}
              under="#F8F2EF"
              onChange={(patch) =>
                onChange({
                  ...a,
                  departments: {
                    ...a.departments,
                    [department]: { ...a.departments[department], [state]: { ...a.departments[department][state], ...patch } },
                  },
                })
              }
            />
          </>
        )}

        {section === "subcategories" && (
          <>
            <Segmented
              label="القسم"
              value={subDepartment}
              options={(["women", "men", "kids"] as const).map((id) => ({ id, label: DEPARTMENT_LABELS[id] }))}
              onChange={setSubDepartment}
            />
            <Segmented label="حالة الزر" value={state} options={states} onChange={setState} />
            <ButtonFields
              key={`sub-${subDepartment}-${state}`}
              style={a.subcategories[subDepartment][state]}
              under="#F8F2EF"
              radius
              onChange={(patch) =>
                onChange({
                  ...a,
                  subcategories: {
                    ...a.subcategories,
                    [subDepartment]: { ...a.subcategories[subDepartment], [state]: { ...a.subcategories[subDepartment][state], ...patch } },
                  },
                })
              }
            />
          </>
        )}
      </section>
    </fieldset>
  );
}
