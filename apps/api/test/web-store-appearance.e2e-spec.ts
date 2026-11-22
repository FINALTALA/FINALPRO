import { APPEARANCE_DEFAULTS } from '../src/vendors/storefront-appearance';
import {
  DEFAULT_APPEARANCE,
  appearanceColorsValid,
  appearancePatch,
  appearanceVars,
  readabilityHint,
  readableText,
  resolveAppearance,
  type StoreAppearance,
} from '../../web/src/lib/storeAppearance';

// The panel pencil's appearance -> CSS custom properties
// (apps/web/src/lib/storeAppearance.ts).
describe('Web - store panel appearance', () => {
  const clone = (): StoreAppearance =>
    JSON.parse(JSON.stringify(DEFAULT_APPEARANCE)) as StoreAppearance;

  it("the web defaults are exactly the API's defaults", () => {
    expect(DEFAULT_APPEARANCE).toEqual(APPEARANCE_DEFAULTS);
  });

  it("defaults render the stylesheet's original values exactly", () => {
    const v = appearanceVars(DEFAULT_APPEARANCE);
    // Product panel: #fffdfc, 28px, no own shadow/border, original text.
    expect(v['--pa-panel-bg']).toBe('#FFFDFC');
    expect(v['--pa-panel-radius-n']).toBe('28');
    expect(v['--pa-panel-text']).toBe('#1C1416');
    expect(v['--pa-panel-muted']).toBe('#6B5F5A');
    expect(v['--pa-panel-shadow']).toBe('0 0 0 transparent');
    expect(v['--pa-panel-border']).toBe('inset 0 0 0 0 transparent');
    // The two-tone divider keeps its original CSS (no override at all).
    expect(v['--pa-divider-bg']).toBeUndefined();
    expect(v['--pa-divider-glow']).toBeUndefined();
    for (const d of ['all', 'women', 'men', 'kids']) {
      // .store-chip
      expect(v[`--pa-dept-${d}-default-bg`]).toBe('#FFFFFF');
      expect(v[`--pa-dept-${d}-default-fg`]).toBe('#1C1416');
      expect(v[`--pa-dept-${d}-default-border`]).toBe('#EADFDA');
      expect(v[`--pa-dept-${d}-default-shadow`]).toBe(
        '0 1px 2px rgba(74, 22, 38, 0.04), 0 4px 12px rgba(74, 22, 38, 0.05)',
      );
      // .store-chip.active
      expect(v[`--pa-dept-${d}-active-bg`]).toBe(
        'linear-gradient(135deg, #7A2E3A, #4A1626)',
      );
      expect(v[`--pa-dept-${d}-active-fg`]).toBe('#FFFFFF');
      expect(v[`--pa-dept-${d}-active-border`]).toBe('rgba(74, 22, 38, 0)');
      expect(v[`--pa-dept-${d}-active-shadow`]).toBe(
        '0 6px 18px rgba(74, 22, 38, 0.3)',
      );
    }
    // .store-chip-smart / .active
    expect(v['--pa-smart-default-bg']).toBe(
      'linear-gradient(180deg, #FFFAF0, #FFFFFF)',
    );
    expect(v['--pa-smart-default-fg']).toBe('#7A5520');
    expect(v['--pa-smart-default-border']).toBe('rgba(201, 154, 69, 0.6)');
    expect(v['--pa-smart-active-bg']).toBe(
      'linear-gradient(135deg, #D8AC57, #B5832F)',
    );
    expect(v['--pa-smart-active-shadow']).toBe(
      '0 6px 18px rgba(181, 131, 47, 0.32)',
    );
    expect(v['--pa-smart-radius']).toBe('999px');
    // .store-subcategory-chip / .active
    for (const d of ['women', 'men', 'kids']) {
      expect(v[`--pa-sub-${d}-default-bg`]).toBe('rgba(255, 253, 251, 0.68)');
      expect(v[`--pa-sub-${d}-default-fg`]).toBe('#704755');
      expect(v[`--pa-sub-${d}-default-border`]).toBe('rgba(129, 62, 81, 0.18)');
      expect(v[`--pa-sub-${d}-default-shadow`]).toBe('none');
      expect(v[`--pa-sub-${d}-active-bg`]).toBe('#F7E8E4');
      expect(v[`--pa-sub-${d}-active-border`]).toBe('#A96173');
      expect(v[`--pa-sub-${d}-default-radius`]).toBe('999px');
    }
  });

  it('changed settings become the CSS of that group only', () => {
    const a = clone();
    a.panel.background_opacity = 0.9;
    a.panel.shadow_opacity = 0.2;
    a.panel.border_opacity = 0.5;
    a.panel.divider = '#336699';
    a.departments.women.active = {
      ...a.departments.women.active,
      background: '#1F2A44',
      glow: '#3B4A70',
      glow_strength: 0.5,
    };
    a.subcategories.kids.active.radius = 6;
    const v = appearanceVars(a);
    expect(v['--pa-panel-bg']).toBe('rgba(255, 253, 252, 0.9)');
    expect(v['--pa-panel-shadow']).toBe('0 -10px 30px rgba(74, 22, 38, 0.2)');
    expect(v['--pa-panel-border']).toBe(
      'inset 0 0 0 1px rgba(234, 223, 218, 0.5)',
    );
    expect(v['--pa-divider-bg']).toContain('rgba(51, 102, 153, 0.62)');
    expect(v['--pa-dept-women-active-bg']).toBe(
      'linear-gradient(135deg, #2D3A5A, #1F2A44)',
    );
    expect(v['--pa-dept-men-active-bg']).toBe(
      'linear-gradient(135deg, #7A2E3A, #4A1626)',
    );
    expect(v['--pa-sub-kids-active-radius']).toBe('6px');
    expect(v['--pa-sub-women-active-radius']).toBe('999px');
  });

  it('builds a minimal partial PUT; a section back at its defaults is sent as null', () => {
    const saved = clone();
    expect(appearancePatch(clone(), saved)).toBeNull();
    const next = clone();
    next.departments.men.default.text = '#222222';
    expect(appearancePatch(next, saved)).toEqual({
      departments: { men: { default: { text: '#222222' } } },
    });
    const tuned = clone();
    tuned.panel.radius = 12;
    expect(appearancePatch(clone(), tuned)).toEqual({ panel: null });
  });

  it('suggests light text on dark backgrounds (and dark on light)', () => {
    expect(readableText('#1F2A44')).toBe('#FFFFFF');
    expect(readableText('#F7E8E4')).toBe('#1C1416');
    expect(readabilityHint('#1C1416', '#1F2A44', 1)).toBe('#FFFFFF');
    expect(readabilityHint('#FFFFFF', '#1F2A44', 1)).toBeNull();
    // A see-through dark background over the light panel reads as light.
    expect(readabilityHint('#1C1416', '#1F2A44', 0.1)).toBeNull();
    // Every default pairs readable text with its background.
    const d = DEFAULT_APPEARANCE;
    expect(
      readabilityHint(
        d.departments.all.active.text,
        d.departments.all.active.background,
        1,
      ),
    ).toBeNull();
    expect(
      readabilityHint(d.smart.default.text, d.smart.default.background, 1),
    ).toBeNull();
  });

  it('missing parts of a response fall back to the defaults; colours are validated', () => {
    expect(resolveAppearance(undefined)).toEqual(DEFAULT_APPEARANCE);
    expect(resolveAppearance({ panel: { radius: 10 } }).panel.radius).toBe(10);
    expect(resolveAppearance({ panel: { radius: '10' } }).panel.radius).toBe(
      28,
    );
    expect(appearanceColorsValid(DEFAULT_APPEARANCE)).toBe(true);
    const bad = clone();
    bad.smart.active.glow = '#12';
    expect(appearanceColorsValid(bad)).toBe(false);
  });
});
