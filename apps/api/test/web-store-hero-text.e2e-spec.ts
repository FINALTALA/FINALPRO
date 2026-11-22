import { HERO_FONTS as API_FONTS } from '../src/vendors/hero-text';
import {
  DEFAULT_HERO_TEXT_STYLE,
  HERO_FONTS,
  heroTextBody,
  heroTextCss,
  heroTextFromDto,
  heroTextProblem,
  withFont,
} from '../../web/src/lib/heroText';

// The hero title / description text styling -> inline CSS
// (apps/web/src/lib/heroText.ts).
describe('Web - store hero text styling', () => {
  it('offers exactly the API fonts and weights', () => {
    expect(
      Object.fromEntries(HERO_FONTS.map((f) => [f.id, [...f.weights]])),
    ).toEqual(
      Object.fromEntries(
        Object.entries(API_FONTS).map(([id, w]) => [id, [...w]]),
      ),
    );
  });

  it('an untouched store keeps the stylesheet (no inline styles at all)', () => {
    const look = heroTextFromDto({});
    expect(look.hero_title).toEqual(DEFAULT_HERO_TEXT_STYLE);
    expect(look.bio).toEqual(DEFAULT_HERO_TEXT_STYLE);
    expect(heroTextCss(look.hero_title)).toEqual({});
    expect(heroTextCss(look.bio, true)).toEqual({});
  });

  it('title and description are read and rendered independently', () => {
    const look = heroTextFromDto({
      hero_title_color: '#4A1626',
      hero_title_font: 'REEM_KUFI',
      hero_title_weight: 600,
      bio_color: '#FFFAF6',
      bio_shadow_enabled: true,
      bio_shadow_strength: 1,
    });
    expect(heroTextCss(look.hero_title)).toEqual({
      color: '#4A1626',
      fontFamily: "'Via Reem Kufi', 'Finalpro Noto', sans-serif",
      fontWeight: 600,
    });
    // Light text gets a dark glow; dark text a light halo.
    expect(heroTextCss(look.bio)).toEqual({
      color: '#FFFAF6',
      textShadow: '0 1px 18px rgba(20, 8, 12, 0.75)',
    });
    expect(
      heroTextCss({
        ...DEFAULT_HERO_TEXT_STYLE,
        shadowEnabled: true,
        shadowStrength: 0.1,
      }),
    ).toEqual({ textShadow: '0 1px 5px rgba(255, 250, 247, 0.50)' });
  });

  it('ignores values the API would never send', () => {
    const look = heroTextFromDto({
      hero_title_color: 'red',
      hero_title_font: 'Comic Sans',
      hero_title_weight: 900,
    });
    expect(heroTextCss(look.hero_title)).toEqual({});
  });

  it("the PUT body carries only that text's keys; a font drops a weight it lacks", () => {
    const style = withFont(
      { ...DEFAULT_HERO_TEXT_STYLE, weight: 500 },
      'AMIRI',
    );
    expect(style.weight).toBeNull();
    expect(
      withFont({ ...DEFAULT_HERO_TEXT_STYLE, weight: 500 }, 'REEM_KUFI').weight,
    ).toBe(500);
    expect(heroTextBody('bio', { ...style, color: '#123456' })).toEqual({
      bio_color: '#123456',
      bio_font: 'AMIRI',
      bio_weight: null,
      bio_shadow_enabled: false,
      bio_shadow_strength: 0.5,
    });
    expect(heroTextProblem({ ...style, color: '#12' })).not.toBeNull();
    expect(heroTextProblem(style)).toBeNull();
  });
});
