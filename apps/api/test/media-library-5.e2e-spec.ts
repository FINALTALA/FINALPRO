import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { promises as fs } from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { SessionService } from './../src/auth/session.service';
import { HttpExceptionFilter } from './../src/common/filters/http-exception.filter';
import { MediaLibraryService } from './../src/platform-media/media-library.service';
import { PrismaService } from './../src/prisma/prisma.service';
import {
  backup,
  restore,
  verifyBackup,
} from './../scripts/platform-media-backup';
import { image, mp4, noisyPng, webm } from './helpers/media-fixtures';
import { uniqueTestPhone } from './helpers/test-phone';

// VIA phase 5 - the platform Media Library: PLATFORM_ADMIN only; real
// content validation (images by sharp, videos by the bounded probe) with
// the approved size / pixel / codec / dimension / duration limits;
// streaming with a hard cap and clean-up of interrupted uploads; signed
// previews and immutable published URLs with byte ranges and nosniff;
// usage protection, archive / restore, purge (30 days, retryable); the
// sweeper; and a coordinated backup restored into a new database.

const MEDIA_DIR = path.join(
  os.tmpdir(),
  `via-media-test-${process.pid}-${Date.now()}`,
);
let seq = 0;
const unique = (l: string) => `${l}-${Date.now()}-${++seq}`;

describe('Phase 5 - Media Library (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: { id: string; token: string };
  let base: string;

  beforeAll(async () => {
    process.env.PLATFORM_MEDIA_DIR = MEDIA_DIR;
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
    admin = await account('PLATFORM_ADMIN');
  });

  afterAll(async () => {
    await app?.close();
    await fs.rm(MEDIA_DIR, { recursive: true, force: true });
  });

  const srv = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function account(
    platformRole: 'PLATFORM_ADMIN' | 'VERIFICATION_REVIEWER' | null = null,
  ) {
    const phone = uniqueTestPhone();
    const user = await prisma.user.create({
      data: {
        phone,
        passwordHash: 'x',
        phoneVerifiedAt: new Date(),
        platformRole,
      },
    });
    await prisma.customerProfile.create({ data: { userId: user.id } });
    const token = await app.get(SessionService).create({
      userId: user.id,
      phone,
      phoneVerifiedAt: user.phoneVerifiedAt!.toISOString(),
      sessionVersion: user.sessionVersion,
    });
    return { id: user.id, token };
  }

  const upload = (
    buf: Buffer,
    filename: string,
    category = 'HOMEPAGE',
    name?: string,
    token = admin.token,
  ) =>
    request(srv())
      .post('/api/v1/admin/media')
      .query({ category, ...(name ? { name } : {}) })
      .set(auth(token))
      .attach('file', buf, {
        filename,
        contentType: 'application/octet-stream',
      });

  const tmpFiles = async () =>
    (await fs.readdir(path.join(MEDIA_DIR, '.tmp')).catch(() => [])).length;
  const post = (p: string) =>
    request(srv())
      .post(`/api/v1/admin/media/${p}`)
      .set(auth(admin.token))
      .set('Idempotency-Key', unique('k'))
      .send({});

  it('PLATFORM_ADMIN only: list, upload, detail and the lifecycle actions', async () => {
    const reviewer = await account('VERIFICATION_REVIEWER');
    const customer = await account();
    const ok = (await upload(await image('png'), 'a.png').expect(201)).body;
    for (const who of [reviewer, customer]) {
      await request(srv())
        .get('/api/v1/admin/media')
        .set(auth(who.token))
        .expect(403);
      await request(srv())
        .get(`/api/v1/admin/media/${ok.id}`)
        .set(auth(who.token))
        .expect(403);
      await upload(
        await image('png'),
        'b.png',
        'HOMEPAGE',
        undefined,
        who.token,
      ).expect(403);
      for (const a of ['archive', 'restore', 'purge']) {
        await request(srv())
          .post(`/api/v1/admin/media/${ok.id}/${a}`)
          .set(auth(who.token))
          .set('Idempotency-Key', unique('k'))
          .send({})
          .expect(403);
      }
    }
    await request(srv()).get('/api/v1/admin/media').expect(401);
    await request(srv())
      .post('/api/v1/admin/media?category=HOMEPAGE')
      .attach('file', await image('png'), 'c.png')
      .expect(401);
    expect(
      await prisma.mediaAsset.count({
        where: { uploadedById: { in: [reviewer.id, customer.id] } },
      }),
    ).toBe(0);
  });

  it('images: JPEG, PNG and WebP by their real content; metadata stored; generated key, never the filename', async () => {
    for (const [fmt, mime] of [
      ['jpeg', 'image/jpeg'],
      ['png', 'image/png'],
      ['webp', 'image/webp'],
    ] as const) {
      const buf = await image(fmt, 320, 200);
      // A misleading extension does not matter: the bytes decide.
      const r = (
        await upload(
          buf,
          `../../evil-${fmt}.exe`,
          'TRENDING',
          'صورة الغلاف',
        ).expect(201)
      ).body;
      expect(r).toMatchObject({
        kind: 'IMAGE',
        mime_type: mime,
        width: 320,
        height: 200,
        size_bytes: buf.length,
        category: 'TRENDING',
        validation_state: 'VALID',
        status: 'ACTIVE',
        name: 'صورة الغلاف',
      });
      const row = await prisma.mediaAsset.findUniqueOrThrow({
        where: { id: r.id },
      });
      expect(row.storageKey).toMatch(
        new RegExp(`^trending/\\d{4}/${r.id}\\.(jpg|png|webp)$`),
      );
      expect(JSON.stringify(r)).not.toContain(row.storageKey!);
      expect(JSON.stringify(r)).not.toContain(MEDIA_DIR);
      const onDisk = await fs.readFile(
        path.join(MEDIA_DIR, ...row.storageKey!.split('/')),
      );
      expect(onDisk.equals(buf)).toBe(true);
    }
  });

  it('refuses what is not allowed: spoofed files, GIF, over 10 MiB, over 40 MP, bad category, no file', async () => {
    const before = await prisma.mediaAsset.count();
    const reason = async (buf: Buffer, name: string, status = 400) =>
      (await upload(buf, name).expect(status)).body.error;
    expect(
      (
        await reason(
          Buffer.from('<html><script>alert(1)</script></html>'),
          'photo.jpg',
        )
      ).details[0].reason,
    ).toBe('UNSUPPORTED_TYPE');
    expect(
      (await reason(Buffer.from('GIF89a' + 'x'.repeat(50)), 'a.gif')).details[0]
        .reason,
    ).toBe('UNSUPPORTED_TYPE');
    // a JPEG signature with garbage after it
    expect(
      (
        await reason(
          Buffer.concat([
            Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
            Buffer.alloc(200, 1),
          ]),
          'x.jpg',
        )
      ).details[0].reason,
    ).toBe('IMAGE_UNREADABLE');
    expect(
      (await reason(await noisyPng(11 * 1024 * 1024), 'big.png', 413)).code,
    ).toBe('MEDIA_TOO_LARGE');
    expect(
      (await reason(await image('png', 7000, 6000), 'huge.png')).details[0]
        .reason,
    ).toBe('IMAGE_TOO_MANY_PIXELS');
    await upload(await image('png'), 'a.png', 'PROFILE').expect(400);
    await request(srv())
      .post('/api/v1/admin/media?category=HOMEPAGE')
      .set(auth(admin.token))
      .send({ x: 1 })
      .expect(400);
    expect(await prisma.mediaAsset.count()).toBe(before);
    expect(await tmpFiles()).toBe(0);
  });

  it('videos: MP4 H.264 (+AAC) and WebM VP8/VP9 (+Opus) accepted with codec, size and duration; everything else refused', async () => {
    const okMp4 = (
      await upload(
        mp4({ audioCodec: 'mp4a', width: 1920, height: 1080, seconds: 120 }),
        'a.mp4',
        'ADS',
      ).expect(201)
    ).body;
    expect(okMp4).toMatchObject({
      kind: 'VIDEO',
      mime_type: 'video/mp4',
      width: 1920,
      height: 1080,
      duration_ms: 120000,
      video_codec: 'avc1',
      audio_codec: 'mp4a',
    });
    const portrait = (
      await upload(
        mp4({ width: 1080, height: 1920, seconds: 10 }),
        'p.mp4',
      ).expect(201)
    ).body;
    expect(portrait).toMatchObject({
      width: 1080,
      height: 1920,
      audio_codec: null,
    });
    for (const codec of ['V_VP8', 'V_VP9']) {
      const r = (
        await upload(
          webm({ videoCodec: codec, audioCodec: 'A_OPUS', seconds: 30 }),
          'a.webm',
          'COLLECTIONS',
        ).expect(201)
      ).body;
      expect(r).toMatchObject({
        mime_type: 'video/webm',
        video_codec: codec,
        audio_codec: 'A_OPUS',
        duration_ms: 30000,
        width: 640,
        height: 360,
      });
    }
    // A recording without a Duration element (MediaRecorder) is measured
    // from its block timecodes; an unknown-size Segment is read too.
    const rec = (
      await upload(
        webm({ noDuration: true, unknownSizeSegment: true, seconds: 7 }),
        'r.webm',
      ).expect(201)
    ).body;
    expect(rec.duration_ms).toBe(7000);

    const refused = async (buf: Buffer) =>
      (await upload(buf, 'v.mp4').expect(400)).body.error.details[0].reason;
    expect(await refused(mp4({ videoCodec: 'hvc1' }))).toBe(
      'VIDEO_CODEC_NOT_ALLOWED',
    );
    expect(await refused(mp4({ audioCodec: 'ac-3' }))).toBe(
      'AUDIO_CODEC_NOT_ALLOWED',
    );
    expect(await refused(mp4({ seconds: 121 }))).toBe('VIDEO_TOO_LONG');
    expect(await refused(mp4({ width: 2560, height: 1440 }))).toBe(
      'VIDEO_TOO_LARGE_DIMENSIONS',
    );
    expect(await refused(mp4({ width: 1200, height: 1200 }))).toBe(
      'VIDEO_TOO_LARGE_DIMENSIONS',
    );
    expect(await refused(mp4({ seconds: 0 }))).toBe('VIDEO_DURATION_UNKNOWN');
    expect(await refused(webm({ videoCodec: 'V_AV1' }))).toBe(
      'VIDEO_CODEC_NOT_ALLOWED',
    );
    expect(await refused(webm({ audioCodec: 'A_VORBIS' }))).toBe(
      'AUDIO_CODEC_NOT_ALLOWED',
    );
    expect(await refused(webm({ docType: 'matroska' }))).toBe(
      'VIDEO_UNREADABLE',
    );
    expect(await refused(mp4({}).subarray(0, 60))).toBe('VIDEO_UNREADABLE');
    expect(await tmpFiles()).toBe(0);
  });

  it('streaming: over 100 MiB is cut off while streaming (413) and nothing stays; an interrupted upload leaves nothing', async () => {
    const before = await prisma.mediaAsset.count();
    const big = mp4({ padBytes: 100 * 1024 * 1024 + 10 });
    const r = await upload(big, 'big.mp4');
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe('MEDIA_TOO_LARGE');

    // Interrupted: half a multipart body, then the connection drops.
    await new Promise<void>((resolve) => {
      const boundary = 'xxBOUNDARYxx';
      const req = http.request(`${base}/api/v1/admin/media?category=HOMEPAGE`, {
        method: 'POST',
        headers: {
          ...auth(admin.token),
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(5_000_000),
        },
      });
      req.on('error', () => resolve());
      req.write(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.mp4"\r\nContent-Type: video/mp4\r\n\r\n`,
      );
      req.write(mp4({ padBytes: 1_000_000 }));
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 400);
    });
    for (let i = 0; i < 20 && (await tmpFiles()) > 0; i++)
      await new Promise((r2) => setTimeout(r2, 100));
    expect(await tmpFiles()).toBe(0);
    expect(await prisma.mediaAsset.count()).toBe(before);
  });

  it('delivery: signed admin preview with byte ranges and nosniff; published immutable URL only with a PUBLISHED usage', async () => {
    const buf = webm({ seconds: 3 });
    const a = (await upload(buf, 'clip.webm', 'TRENDING').expect(201)).body;
    const preview = a.preview_url as string;
    expect(preview).toMatch(
      new RegExp(`^/media/preview/${a.id}\\?exp=\\d+&sig=`),
    );

    const full = await request(srv()).get(`/api/v1${preview}`).expect(200);
    expect(full.headers['content-type']).toBe('video/webm');
    expect(full.headers['x-content-type-options']).toBe('nosniff');
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.headers['cache-control']).toBe('private, no-store');
    const part = await request(srv())
      .get(`/api/v1${preview}`)
      .set('Range', 'bytes=10-49')
      .expect(206);
    expect(part.headers['content-range']).toBe(`bytes 10-49/${buf.length}`);
    expect(part.headers['content-length']).toBe('40');
    const tail = await request(srv())
      .get(`/api/v1${preview}`)
      .set('Range', 'bytes=-16')
      .expect(206);
    expect(tail.headers['content-range']).toBe(
      `bytes ${buf.length - 16}-${buf.length - 1}/${buf.length}`,
    );
    await request(srv())
      .get(`/api/v1${preview}`)
      .set('Range', `bytes=${buf.length + 10}-`)
      .expect(416);

    // Tampered, expired or for another asset: not found.
    await request(srv())
      .get(`/api/v1${preview.replace(/sig=.{4}/, 'sig=AAAA')}`)
      .expect(404);
    await request(srv())
      .get(`/api/v1/media/preview/${a.id}?exp=1&sig=x`)
      .expect(404);
    const other = (await upload(await image('png'), 'o.png').expect(201)).body;
    await request(srv())
      .get(`/api/v1${preview.replace(a.id, other.id)}`)
      .expect(404);

    const row = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: a.id },
    });
    const publicPath = `/api/v1/media/p/${a.id}/${row.sha256!.slice(0, 16)}.webm`;
    await request(srv()).get(publicPath).expect(404); // not published yet
    await prisma.mediaUsage.create({
      data: {
        assetId: a.id,
        ownerType: 'TRENDING_REEL',
        ownerId: unique('o'),
        state: 'PUBLISHED',
      },
    });
    const pub = await request(srv())
      .get(publicPath)
      .set('Range', 'bytes=0-9')
      .expect(206);
    expect(pub.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(pub.headers['x-content-type-options']).toBe('nosniff');
    await request(srv())
      .get(`/api/v1/media/p/${a.id}/0000000000000000.webm`)
      .expect(404);
    const d = (
      await request(srv())
        .get(`/api/v1/admin/media/${a.id}`)
        .set(auth(admin.token))
        .expect(200)
    ).body;
    expect(d.public_url).toBe(publicPath.replace('/api/v1', ''));
  });

  it('usage protection, archive / restore, search and filters, purge after 30 days with retryable clean-up', async () => {
    const name = unique('غلاف');
    const a = (
      await upload(await image('jpeg'), 'x.jpg', 'COLLECTIONS', name).expect(
        201,
      )
    ).body;
    const usage = await prisma.mediaUsage.create({
      data: {
        assetId: a.id,
        ownerType: 'COLLECTION',
        ownerId: unique('c'),
        state: 'DRAFT',
      },
    });
    let r = await post(`${a.id}/archive`).expect(409);
    expect(r.body.error.code).toBe('MEDIA_IN_USE');
    for (const state of ['SCHEDULED', 'REVISION'] as const) {
      await prisma.mediaUsage.update({
        where: { id: usage.id },
        data: { state },
      });
      expect((await post(`${a.id}/archive`).expect(409)).body.error.code).toBe(
        'MEDIA_IN_USE',
      );
    }
    await prisma.mediaUsage.delete({ where: { id: usage.id } });

    await post(`${a.id}/archive`).expect(201);
    const listActive = (
      await request(srv())
        .get('/api/v1/admin/media')
        .query({ q: name })
        .set(auth(admin.token))
        .expect(200)
    ).body;
    expect(listActive.items).toHaveLength(0);
    const listArchived = (
      await request(srv())
        .get('/api/v1/admin/media')
        .query({
          q: name,
          status: 'ARCHIVED',
          category: 'COLLECTIONS',
          kind: 'IMAGE',
        })
        .set(auth(admin.token))
        .expect(200)
    ).body;
    expect(listArchived.items.map((x: { id: string }) => x.id)).toEqual([a.id]);
    await post(`${a.id}/restore`).expect(201);
    await post(`${a.id}/restore`).expect(409);
    await post(`${a.id}/archive`).expect(201);

    // Too early, then 31 days later - but a usage still blocks it.
    expect((await post(`${a.id}/purge`).expect(409)).body.error.code).toBe(
      'MEDIA_PURGE_TOO_EARLY',
    );
    await prisma.mediaAsset.update({
      where: { id: a.id },
      data: { archivedAt: new Date(Date.now() - 31 * 86_400_000) },
    });
    await prisma.mediaUsage.create({
      data: {
        assetId: a.id,
        ownerType: 'COLLECTION',
        ownerId: unique('c'),
        revisionId: 'rev-1',
        state: 'REVISION',
      },
    });
    expect((await post(`${a.id}/purge`).expect(409)).body.error.code).toBe(
      'MEDIA_IN_USE',
    );
    await prisma.mediaUsage.deleteMany({ where: { assetId: a.id } });
    let d = (
      await request(srv())
        .get(`/api/v1/admin/media/${a.id}`)
        .set(auth(admin.token))
        .expect(200)
    ).body;
    expect(d.actions).toEqual({
      can_archive: false,
      can_restore: true,
      can_purge: true,
    });

    // The physical delete fails (a directory where the file was): PURGING stays, retried by the sweep.
    const row = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: a.id },
    });
    const file = path.join(MEDIA_DIR, ...row.storageKey!.split('/'));
    await fs.rm(file);
    await fs.mkdir(file);
    await fs.writeFile(path.join(file, 'keep'), 'x');
    r = await post(`${a.id}/purge`).expect(201);
    expect(r.body).toMatchObject({ purged: false, status: 'PURGING' });
    expect(
      (await prisma.mediaAsset.findUniqueOrThrow({ where: { id: a.id } }))
        .status,
    ).toBe('PURGING');
    await request(srv())
      .get(`/api/v1/admin/media/${a.id}`)
      .set(auth(admin.token))
      .expect(200);
    await fs.rm(file, { recursive: true });
    const sweep = await app.get(MediaLibraryService).sweepOnce();
    expect(sweep.purges_finished).toBeGreaterThanOrEqual(1);
    expect(await prisma.mediaAsset.count({ where: { id: a.id } })).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: {
          entityId: a.id,
          action: {
            in: [
              'media.archived',
              'media.restored',
              'media.purge_requested',
              'media.purged',
            ],
          },
        },
      }),
    ).toBe(5);

    // A clean purge in one go: file and row gone.
    const b = (await upload(await image('png'), 'y.png').expect(201)).body;
    await post(`${b.id}/archive`).expect(201);
    await prisma.mediaAsset.update({
      where: { id: b.id },
      data: { archivedAt: new Date(Date.now() - 40 * 86_400_000) },
    });
    const bRow = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: b.id },
    });
    expect((await post(`${b.id}/purge`).expect(201)).body).toMatchObject({
      purged: true,
    });
    await expect(
      fs.access(path.join(MEDIA_DIR, ...bRow.storageKey!.split('/'))),
    ).rejects.toThrow();
    d = (
      await request(srv())
        .get(`/api/v1/admin/media/${b.id}`)
        .set(auth(admin.token))
        .expect(404)
    ).body;
  });

  it('sweep: stale temporary files and stale PENDING rows are removed; fresh ones are left alone', async () => {
    const tmp = path.join(MEDIA_DIR, '.tmp');
    await fs.mkdir(tmp, { recursive: true });
    const old = path.join(tmp, 'old.part');
    const fresh = path.join(tmp, 'fresh.part');
    await fs.writeFile(old, 'x');
    await fs.writeFile(fresh, 'x');
    const past = new Date(Date.now() - 2 * 3600_000);
    await fs.utimes(old, past, past);
    const pending = await prisma.mediaAsset.create({
      data: {
        name: 'stale',
        category: 'ADS',
        kind: 'IMAGE',
        uploadedById: admin.id,
        createdAt: past,
      },
    });
    const r = await app.get(MediaLibraryService).sweepOnce();
    expect(r.tmp_removed).toBe(1);
    expect(r.pending_removed).toBeGreaterThanOrEqual(1);
    await expect(fs.access(old)).rejects.toThrow();
    await fs.access(fresh);
    await fs.rm(fresh);
    expect(await prisma.mediaAsset.count({ where: { id: pending.id } })).toBe(
      0,
    );
  });

  it('backup: database and media from one snapshot, hashes verified; restored into a NEW database and directory and verified there', async () => {
    const a = (await upload(await image('webp'), 'b.webp', 'ADS').expect(201))
      .body;
    const out = path.join(
      os.tmpdir(),
      `via-media-backup-${process.pid}-${Date.now()}`,
    );
    const target = `via_media_restore_${process.pid}_${Date.now() % 100000}`;
    const targetDir = path.join(
      os.tmpdir(),
      `via-media-restored-${process.pid}-${Date.now()}`,
    );
    try {
      const m = await backup(out, process.env.DATABASE_URL!, MEDIA_DIR);
      expect(m.assets.map((x) => x.id)).toContain(a.id);
      await verifyBackup(out);
      // A corrupted copy is caught.
      const one = m.assets[0];
      const copy = path.join(out, 'media', ...one.storageKey.split('/'));
      const original = await fs.readFile(copy);
      await fs.writeFile(copy, Buffer.concat([original, Buffer.from('x')]));
      await expect(verifyBackup(out)).rejects.toThrow(/does not match/);
      await fs.writeFile(copy, original);

      const restored = await restore(
        out,
        target,
        targetDir,
        process.env.DATABASE_URL!,
      );
      expect(restored.assets).toBe(m.assets.length);
      await expect(
        restore(
          out,
          target,
          path.join(targetDir, 'again'),
          process.env.DATABASE_URL!,
        ),
      ).rejects.toThrow(/already exists/);
      const src = new URL(process.env.DATABASE_URL!).pathname.slice(1);
      await expect(
        restore(out, src, path.join(targetDir, 'x'), process.env.DATABASE_URL!),
      ).rejects.toThrow();
    } finally {
      await prisma
        .$executeRawUnsafe(`DROP DATABASE IF EXISTS ${target}`)
        .catch(() => undefined);
      await fs.rm(out, { recursive: true, force: true });
      await fs.rm(targetDir, { recursive: true, force: true });
    }
  }, 120_000);
});
