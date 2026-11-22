import { expect, type Page } from "@playwright/test";

/**
 * TB-10: the one sideways-overflow check for every spec, phone and desktop,
 * Arabic (RTL) and English (LTR).
 *
 * Why the old `document.documentElement.scrollWidth - window.innerWidth <= 0`
 * was not enough: in a phone context (`isMobile: true`) Chromium widens the
 * layout to fit content that is too wide, and `window.innerWidth` grows with
 * it (360 -> 540 for `body { min-width: 150vw }`), so the difference stays 0
 * and the check passes while the page really scrolls sideways. Content that
 * sticks out without widening the document (an absolutely positioned badge,
 * a fixed bar) never moves `scrollWidth` at all.
 *
 * This checks three things against the real screen width
 * (`document.documentElement.clientWidth`, which stays the device width):
 *  1. the layout was not widened or zoomed out: `innerWidth` is the
 *     viewport width and the visual viewport scale is 1;
 *  2. neither `html` nor `body` scrolls sideways;
 *  3. no visible element lies outside [0, width] on either side - except
 *     inside an ancestor that scrolls or clips sideways (`overflow-x` other
 *     than `visible`: a size-guide table in its own frame, a scrolling rail),
 *     where that is the intended design. Hidden elements (display none,
 *     visibility hidden, opacity 0) and 1px screen-reader-only elements are
 *     ignored.
 * A failure lists the offending elements and their left/right edges.
 */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("expectNoHorizontalOverflow needs a page with a fixed viewport");
  await page.evaluate(() => document.fonts.ready);
  const report = await page.evaluate((viewportWidth) => {
    const html = document.documentElement;
    const width = html.clientWidth;
    const problems: string[] = [];
    const scale = window.visualViewport?.scale ?? 1;
    if (Math.abs(scale - 1) > 0.001) problems.push(`the page is zoomed out (visual viewport scale ${scale.toFixed(3)})`);
    if (window.innerWidth !== viewportWidth) problems.push(`the layout was widened: innerWidth ${window.innerWidth}px on a ${viewportWidth}px screen`);
    if (width > viewportWidth) problems.push(`clientWidth ${width}px is wider than the ${viewportWidth}px screen`);
    if (html.scrollWidth > width) problems.push(`html scrolls sideways: scrollWidth ${html.scrollWidth}px > ${width}px`);
    if (document.body.scrollWidth > width) problems.push(`body scrolls sideways: scrollWidth ${document.body.scrollWidth}px > ${width}px`);

    const clippedByAncestor = (el: Element): boolean => {
      for (let p = el.parentElement; p && p !== document.body && p !== html; p = p.parentElement) {
        if (getComputedStyle(p).overflowX !== "visible") return true;
      }
      return false;
    };
    const describe = (el: Element): string => {
      const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).join(".") : "";
      const testId = el.getAttribute("data-testid");
      return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls ? `.${cls}` : ""}${testId ? `[data-testid=${testId}]` : ""}`;
    };
    let outside = 0;
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) continue;
      if (rect.left >= -1 && rect.right <= width + 1) continue;
      if (clippedByAncestor(el)) continue;
      outside += 1;
      if (outside <= 10) {
        problems.push(`${describe(el)} is outside the screen: left ${Math.round(rect.left)}px, right ${Math.round(rect.right)}px (screen 0-${width}px, position ${style.position})`);
      }
    }
    if (outside > 10) problems.push(`... and ${outside - 10} more element(s) outside the screen`);
    return { problems, dir: getComputedStyle(html).direction, url: location.pathname + location.search };
  }, viewport.width);

  expect(
    report.problems,
    `sideways overflow on ${report.url} (${report.dir}, ${viewport.width}x${viewport.height})`,
  ).toEqual([]);
}
