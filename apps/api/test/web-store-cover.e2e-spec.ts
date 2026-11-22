import {
  DEFAULT_COVER_LOOK,
  coverLookBody,
  coverLookFromDto,
  coverLookProblem,
  coverOpacity,
  coverPresentation,
  fromPercent,
  toPercent,
  type CoverLook,
} from '../../web/src/lib/storeCover';

// The public store hero's independent cover layers
// (apps/web/src/lib/storeCover.ts): saved settings -> CSS variables and
// layer classes for the hero, the global layer and the product panel.
describe('Web - store cover layers', () => {
  const safe = (url: string) => /^(https?:\/\/|\/)/.test(url);
  // An existing store: cover image + colour, nothing else set.
  const existing: CoverLook = coverLookFromDto({
    cover_image_url: 'https://example.com/cover.jpg',
    cover_color: '#D6AFA4',
  });

  it('defaults reproduce the previous design: image at .2, upper wash at 30%, panel fade #4A1626 at 6%, no global layer', () => {
    const p = coverPresentation(existing, safe);
    expect(p.heroClasses).toEqual(['has-cover-image', 'has-cover-tint']);
    expect(p.heroVars).toEqual({
      '--store-cover-image': 'url("https://example.com/cover.jpg")',
      '--store-cover-image-opacity': '0.2',
      '--store-cover-tint': '#D6AFA4',
      '--store-cover-tint-strength': '30%',
    });
    expect(p.overlay).toBe(false);
    expect(p.lightText).toBe(false);
    expect(p.panelClasses).toEqual(['has-bottom-fade']);
    expect(p.panelVars).toEqual({
      '--store-bottom-fade-color': '#4A1626',
      '--store-bottom-fade-strength': '6%',
    });
  });

  it('each layer renders on its own switch, in any combination', () => {
    const on = (patch: Partial<CoverLook>) =>
      coverPresentation({ ...existing, ...patch }, safe);
    // Global layer without the upper wash, and vice versa.
    let p = on({ tintEnabled: false, overlayEnabled: true });
    expect(p.heroClasses).toEqual(['has-cover-image', 'has-cover-overlay']);
    expect(p.overlay).toBe(true);
    p = on({ tintEnabled: true, overlayEnabled: false });
    expect(p.heroClasses).toEqual(['has-cover-image', 'has-cover-tint']);
    // Everything off.
    p = on({
      imageEnabled: false,
      tintEnabled: false,
      overlayEnabled: false,
      fadeEnabled: false,
    });
    expect(p.heroClasses).toEqual([]);
    expect(p.overlay).toBe(false);
    expect(p.panelClasses).toEqual(['no-bottom-fade']);
    expect(p.panelVars).toEqual({});
    // Everything on.
    p = on({ overlayEnabled: true });
    expect(p.heroClasses).toEqual([
      'has-cover-image',
      'has-cover-tint',
      'has-cover-overlay',
    ]);
    expect(p.panelClasses).toEqual(['has-bottom-fade']);
  });

  it('a layer is not rendered at opacity 0 (or without its image/colour)', () => {
    const on = (patch: Partial<CoverLook>) =>
      coverPresentation({ ...existing, overlayEnabled: true, ...patch }, safe);
    expect(on({ imageOpacity: 0 }).heroClasses).not.toContain(
      'has-cover-image',
    );
    expect(on({ imageUrl: null }).heroClasses).not.toContain('has-cover-image');
    expect(on({ tintOpacity: 0 }).heroClasses).not.toContain('has-cover-tint');
    expect(on({ tintColor: null }).heroClasses).not.toContain('has-cover-tint');
    expect(on({ overlayOpacity: 0 }).overlay).toBe(false);
    expect(on({ fadeOpacity: 0 }).panelClasses).toEqual(['no-bottom-fade']);
    expect(
      on({ imageUrl: 'javascript:alert(1)' }).heroVars['--store-cover-image'],
    ).toBeUndefined();
  });

  it('switching a layer off keeps its saved values (they go back in the request unchanged)', () => {
    const tuned: CoverLook = {
      ...existing,
      overlayEnabled: true,
      overlayColor: '#1F2A44',
      overlayOpacity: 0.55,
      overlayBrightness: 1.3,
      fadeColor: '#813E51',
      fadeOpacity: 0.4,
    };
    const off = coverLookBody({
      ...tuned,
      tintEnabled: false,
      overlayEnabled: false,
      fadeEnabled: false,
    });
    expect(off).toMatchObject({
      cover_tint_enabled: false,
      cover_color: '#D6AFA4',
      cover_global_overlay_enabled: false,
      cover_global_overlay_color: '#1F2A44',
      cover_global_overlay_opacity: 0.55,
      cover_global_overlay_brightness: 1.3,
      cover_bottom_fade_enabled: false,
      cover_bottom_fade_color: '#813E51',
      cover_bottom_fade_opacity: 0.4,
    });
    // ... and the response round-trips back into the same look.
    expect(
      coverLookFromDto({
        cover_image_url: tuned.imageUrl,
        ...coverLookBody(tuned),
      }),
    ).toEqual(tuned);
  });

  it('global layer: colour, strength and brightness become variables; a strong dark layer switches to light text', () => {
    const p = coverPresentation(
      {
        ...existing,
        overlayEnabled: true,
        overlayColor: '#1F2A44',
        overlayOpacity: 0.8,
        overlayBrightness: 0.9,
      },
      safe,
    );
    expect(p.heroVars['--store-cover-overlay-color']).toBe('#1F2A44');
    expect(p.heroVars['--store-cover-overlay-opacity']).toBe('0.8');
    expect(p.heroVars['--store-cover-overlay-brightness']).toBe('0.9');
    expect(p.lightText).toBe(true);
    expect(p.heroClasses).toContain('has-light-cover-text');
    // A subtle or light layer keeps the dark text.
    expect(
      coverPresentation(
        {
          ...existing,
          overlayEnabled: true,
          overlayColor: '#1F2A44',
          overlayOpacity: 0.15,
        },
        safe,
      ).lightText,
    ).toBe(false);
    expect(
      coverPresentation(
        {
          ...existing,
          overlayEnabled: true,
          overlayColor: '#F2E6DF',
          overlayOpacity: 1,
        },
        safe,
      ).lightText,
    ).toBe(false);
  });

  it('older/partial responses fall back to the defaults; bad values clamp; invalid colours are reported', () => {
    expect(
      coverLookFromDto({ cover_image_url: null, cover_color: null }),
    ).toEqual(DEFAULT_COVER_LOOK);
    expect(
      coverLookFromDto({
        cover_image_url: null,
        cover_color: 'pink',
        cover_global_overlay_brightness: 9,
      }).overlayBrightness,
    ).toBe(1.5);
    expect(toPercent(0.06)).toBe(6);
    expect(fromPercent(46)).toBe(0.46);
    expect(fromPercent(140)).toBe(1);
    expect(coverOpacity(Number.NaN, 0.3)).toBe(0.3);
    expect(coverLookProblem(existing)).toBeNull();
    expect(coverLookProblem({ ...existing, overlayColor: '#12' })).toMatch(
      /الطبقة العامة/,
    );
    expect(coverLookProblem({ ...existing, fadeColor: 'red' })).toMatch(
      /تدرج البانيل/,
    );
    expect(coverLookProblem({ ...existing, tintColor: 'x' })).toMatch(
      /العلوية/,
    );
  });
});
