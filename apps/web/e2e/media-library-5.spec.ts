import { spawn } from "child_process";
import { readdirSync, readFileSync, rmSync } from "fs";
import * as os from "os";
import * as path from "path";
import { expect, test, type Page } from "@playwright/test";
import { call, unique, uniquePhone } from "./helpers/api";
import { prisma } from "./helpers/db";
import { enterWorkspace, loginAs } from "./helpers/session";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp = require("sharp") as typeof import("sharp");

// VIA phase 5 - the Media Library through the real screens: upload an
// image and a REAL video (a VP8 WebM encoded by Playwright's own ffmpeg,
// see below) - validated by the server - see them in the grid, open the
// video and play it (byte ranges), usage blocks archiving, archive and
// restore with confirmations, a reviewer is refused, English at phone
// width. The server rules are proven by
// apps/api/test/media-library-5.e2e-spec.ts.

const PASSWORD = "a-strong-password";
const PASSWORD_HASH =
  "$2a$10$PAr1SNMRMrv30BZ3vjW1Oe6wDOdYZAZeu9bQ/wPNm1VRt0okkanAq";
// A valid 1x1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

async function user(
  platformRole: "PLATFORM_ADMIN" | "VERIFICATION_REVIEWER" | null,
  lang: "ar" | "en" = "ar",
) {
  const phone = uniquePhone();
  const u = await prisma.user.create({
    data: {
      phone,
      passwordHash: PASSWORD_HASH,
      phoneVerifiedAt: new Date(),
      platformRole,
      languagePref: lang,
    },
  });
  await prisma.customerProfile.create({
    data: { userId: u.id, displayName: "مديرة الوسائط" },
  });
  const login = await call<{ session_token: string }>("/auth/login", {
    method: "POST",
    body: { phone, password: PASSWORD },
  });
  return { id: u.id, token: login.body.session_token };
}

async function asAdmin(page: Page, token: string, lang: "ar" | "en" = "ar") {
  await page.addInitScript(
    (l) => localStorage.setItem("finalpro_lang_pref", l),
    lang,
  );
  await loginAs(page, token);
  await enterWorkspace(page, token, { type: "platform" });
}

/**
 * A real, playable VP8 WebM (3 s, 320x180, colour frames) encoded by the
 * ffmpeg build Playwright itself ships (pinned with the Playwright
 * install; used here only to make the fixture - the server validates the
 * result with its own probe). Headless Chrome's MediaRecorder produced no
 * data in this environment, so it is not used.
 */
async function makeWebm(): Promise<Buffer> {
  const root = path.join(os.homedir(), "AppData", "Local", "ms-playwright");
  const dir = readdirSync(root)
    .filter((d) => d.startsWith("ffmpeg-"))
    .sort()
    .pop();
  if (!dir) throw new Error("Playwright ffmpeg not installed");
  const exe = readdirSync(path.join(root, dir)).find((f) =>
    f.startsWith("ffmpeg"),
  )!;
  const out = path.join(os.tmpdir(), `via-fixture-${Date.now()}.webm`);
  const frames: Buffer[] = [];
  for (let i = 0; i < 75; i++) {
    frames.push(
      await sharp({
        create: {
          width: 320,
          height: 180,
          channels: 3,
          background: { r: (i * 7) % 255, g: 90, b: 255 - ((i * 5) % 255) },
        },
      })
        .jpeg()
        .toBuffer(),
    );
  }
  await new Promise<void>((resolve, reject) => {
    const p = spawn(path.join(root, dir, exe), [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "image2pipe",
      "-c:v",
      "mjpeg",
      "-r",
      "25",
      "-i",
      "pipe:0",
      "-c:v",
      "libvpx",
      "-b:v",
      "400k",
      out,
    ]);
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)),
    );
    for (const fr of frames) p.stdin.write(fr);
    p.stdin.end();
  });
  const buf = readFileSync(out);
  rmSync(out, { force: true });
  return buf;
}

test.describe("Phase 5: media library", () => {
  test("upload an image and a real recorded video, see them, play the video, protect a used file, archive and restore", async ({
    page,
  }) => {
    test.setTimeout(60_000); // includes encoding a 3 s fixture video
    const admin = await user("PLATFORM_ADMIN");
    await asAdmin(page, admin.token);
    await page.goto("/admin/media");
    await expect(
      page.getByRole("heading", { name: "مكتبة الوسائط" }),
    ).toBeVisible();

    const imgName = unique("غلاف");
    await page
      .locator("#ml-file")
      .setInputFiles({ name: "cover.png", mimeType: "image/png", buffer: PNG });
    await page.locator("#ml-up-category").selectOption("HOMEPAGE");
    await page.locator("#ml-name").fill(imgName);
    await page.getByTestId("ml-upload-submit").click();
    await expect(page.getByTestId("ml-upload-notice")).toBeVisible();

    const video = await makeWebm();
    const vidName = unique("مقطع");
    await page.locator("#ml-file").setInputFiles({
      name: "clip.webm",
      mimeType: "video/webm",
      buffer: video,
    });
    await page.locator("#ml-up-category").selectOption("TRENDING");
    await page.locator("#ml-name").fill(vidName);
    await page.getByTestId("ml-upload-submit").click();
    await expect(page.getByTestId("ml-upload-notice")).toBeVisible({
      timeout: 15_000,
    });

    // A spoofed file is refused with the server's reason.
    await page.locator("#ml-file").setInputFiles({
      name: "fake.png",
      mimeType: "image/png",
      buffer: Buffer.from("not an image at all"),
    });
    await page.getByTestId("ml-upload-submit").click();
    await expect(page.locator(".error-banner")).toContainText(
      "UNSUPPORTED_TYPE",
    );

    await page.locator("#ml-q").fill(vidName);
    await page.getByTestId("ml-apply").click();
    await expect(page.getByTestId("ml-item")).toHaveCount(1);
    await page.getByTestId("ml-item").getByRole("link").click();
    await expect(page.getByTestId("ml-status")).toHaveText("نشط");

    // Real playback: metadata loads, time advances (served with byte ranges).
    const played = await page.getByTestId("ml-preview").evaluate(async (el) => {
      const v = el as HTMLVideoElement;
      v.muted = true;
      if (v.readyState < 1)
        await new Promise((r) =>
          v.addEventListener("loadedmetadata", r, { once: true }),
        );
      await v.play();
      await new Promise((r) => setTimeout(r, 1200));
      return {
        w: v.videoWidth,
        h: v.videoHeight,
        t: v.currentTime,
        err: v.error?.code ?? null,
      };
    });
    expect(played).toMatchObject({ w: 320, h: 180, err: null });
    expect(played.t).toBeGreaterThan(0.3);

    // A use blocks archiving.
    const asset = await prisma.mediaAsset.findFirstOrThrow({
      where: { name: vidName },
    });
    expect(asset).toMatchObject({ kind: "VIDEO", width: 320, height: 180 });
    const usage = await prisma.mediaUsage.create({
      data: {
        assetId: asset.id,
        ownerType: "TRENDING_REEL",
        ownerId: unique("reel"),
        state: "DRAFT",
      },
    });
    await page.reload();
    await expect(page.getByTestId("ml-usages")).toContainText("TRENDING_REEL");
    await expect(page.getByTestId("ml-archive")).toBeDisabled();
    await expect(page.getByTestId("ml-archive-blocked")).toBeVisible();
    await prisma.mediaUsage.delete({ where: { id: usage.id } });
    await page.reload();

    await page.getByTestId("ml-archive").click();
    await page
      .getByTestId("small-confirm")
      .getByRole("button", { name: "تراجع" })
      .click();
    expect(
      (await prisma.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } }))
        .status,
    ).toBe("ACTIVE");
    await page.getByTestId("ml-archive").click();
    await page.getByTestId("small-confirm-ok").click();
    await expect(page.getByTestId("ml-status")).toHaveText("مؤرشف");
    await expect(page.getByTestId("ml-purge")).toBeDisabled();
    await expect(page.getByTestId("ml-purge-when")).toBeVisible();
    await page.getByTestId("ml-restore").click();
    await page.getByTestId("small-confirm-ok").click();
    await expect(page.getByTestId("ml-status")).toHaveText("نشط");
  });

  test("a reviewer cannot open the media library", async ({ page }) => {
    const reviewer = await user("VERIFICATION_REVIEWER");
    await asAdmin(page, reviewer.token);
    await page.goto("/admin/media");
    await expect(page.getByText("هذه الصفحة لمدير المنصة فقط")).toBeVisible();
  });

  test("English, phone width: left-to-right, no sideways scroll on the library and a file", async ({
    page,
  }) => {
    const admin = await user("PLATFORM_ADMIN", "en");
    await page.setViewportSize({ width: 390, height: 844 });
    await asAdmin(page, admin.token, "en");
    await page.goto("/admin/media");
    await expect(
      page.getByRole("heading", { name: "Media Library" }),
    ).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await page
      .locator("#ml-file")
      .setInputFiles({ name: "p.png", mimeType: "image/png", buffer: PNG });
    const name = unique("phone");
    await page.locator("#ml-name").fill(name);
    await page.getByTestId("ml-upload-submit").click();
    await expect(page.getByTestId("ml-upload-notice")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    const a = await prisma.mediaAsset.findFirstOrThrow({ where: { name } });
    await page.goto(`/admin/media/${a.id}`);
    await expect(page.getByRole("heading", { name: "Details" })).toBeVisible();
    await expect(page.getByTestId("ml-preview")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
});
