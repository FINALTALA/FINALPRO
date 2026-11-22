import { expect, test, type Browser, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";

// TB-10: the shared sideways-overflow check must FAIL for content that leaves
// the screen and PASS for intended designs, on a real phone context
// (360x760, isMobile) and on desktop, right-to-left and left-to-right. Static
// pages only (setContent) - no app, no data. The old check
// (`scrollWidth - innerWidth <= 0`) passes every "overflows" case below.

const page = (dir: "ltr" | "rtl", body: string, css = "") => `<!doctype html>
<html lang="${dir === "rtl" ? "ar" : "en"}" dir="${dir}"><head>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>html,body{margin:0;padding:0} .card{height:40px;background:#ccc;margin:8px} ${css}</style></head>
<body><header class="card">header</header><main>${body}</main></body></html>`;

const PASSES: [string, string, string][] = [
  ["a clean page", "<div class='card'>ok</div>", ""],
  ["a wide table inside its own overflow-x:auto frame", "<div style='overflow-x:auto'><table style='width:900px'><tr><td class='card'>wide</td></tr></table></div>", ""],
  ["a closed off-canvas drawer (fixed, moved out, visibility hidden)", "<nav style='position:fixed;top:0;inset-inline-end:0;width:300px;height:100vh;transform:translateX(100%);visibility:hidden;background:red'>drawer</nav><div class='card'>ok</div>", ""],
  ["a clipped carousel (overflow:hidden frame)", "<div style='overflow:hidden'><div style='display:flex;width:1200px'><div class='card' style='width:400px'>a</div><div class='card' style='width:400px'>b</div></div></div>", ""],
  // The usual visually-hidden pattern: 1px, clipped, left in place. (Moving it
  // far off the start edge, e.g. left:-10000px, really scrolls an RTL page.)
  ["a 1px clipped screen-reader-only element", "<span style='position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap'>skip to content</span><div class='card'>ok</div>", ""],
];
const FAILS: [string, string, string][] = [
  ["TB-6: body { min-width: 150vw }", "<div class='card'>ok</div>", "body{min-width:150vw}"],
  ["one block wider than the screen", "<div class='card' style='width:500px'>wide</div>", ""],
  ["an element pushed past the end edge", "<div class='card' style='margin-inline-end:-120px'>edge</div>", ""],
  ["an absolutely positioned badge sticking out past the start edge", "<div style='position:relative' class='card'><span style='position:absolute;inset-inline-start:-80px;top:0;width:60px;height:20px;background:blue'>b</span></div>", ""],
  ["a fixed bar partly off the screen", "<div style='position:fixed;bottom:0;inset-inline-start:200px;width:300px;height:40px;background:green'>toast</div><div class='card'>ok</div>", ""],
];

const DEVICES = {
  phone: { viewport: { width: 360, height: 760 }, isMobile: true },
  desktop: { viewport: { width: 1280, height: 900 }, isMobile: false },
} as const;

async function open(browser: Browser, device: keyof typeof DEVICES): Promise<Page> {
  return (await browser.newContext(DEVICES[device])).newPage();
}

test.describe("TB-10: expectNoHorizontalOverflow", () => {
  for (const device of ["phone", "desktop"] as const) {
    for (const dir of ["rtl", "ltr"] as const) {
      test(`${device} ${dir}: passes intended layouts`, async ({ browser }) => {
        const p = await open(browser, device);
        for (const [name, body, css] of PASSES) {
          await p.setContent(page(dir, body, css));
          await test.step(name, () => expectNoHorizontalOverflow(p));
        }
        await p.context().close();
      });

      test(`${device} ${dir}: fails every kind of sideways overflow, naming the element`, async ({ browser }) => {
        const p = await open(browser, device);
        const width = DEVICES[device].viewport.width;
        for (const [name, body, css] of FAILS) {
          // Scale the wide block and the fixed bar to the device so desktop is tested too.
          const wideBody =
            device === "desktop"
              ? body.replace("width:500px", `width:${width + 140}px`).replace("inset-inline-start:200px", `inset-inline-start:${width - 160}px`)
              : body;
          await p.setContent(page(dir, wideBody, css));
          await test.step(name, async () => {
            await expect(expectNoHorizontalOverflow(p)).rejects.toThrow(/sideways overflow/);
          });
        }
        await p.context().close();
      });
    }
  }

  test("the old check misses the phone cases the new one catches (why TB-10 exists)", async ({ browser }) => {
    const p = await open(browser, "phone");
    for (const dir of ["rtl", "ltr"] as const) {
      for (const [, body, css] of FAILS) {
        await p.setContent(page(dir, body, css));
        expect(await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
        await expect(expectNoHorizontalOverflow(p)).rejects.toThrow();
      }
    }
    await p.context().close();
  });

  test("the failure names the element and its edges", async ({ browser }) => {
    const p = await open(browser, "phone");
    await p.setContent(page("rtl", "<div style='position:fixed;bottom:0;inset-inline-start:200px;width:300px;height:40px' data-testid='stray-bar'>bar</div>"));
    const error = await expectNoHorizontalOverflow(p).then(() => null, (e: Error) => e.message);
    expect(error).toContain("data-testid=stray-bar");
    expect(error).toMatch(/left -140px, right 160px/);
    await p.context().close();
  });
});
