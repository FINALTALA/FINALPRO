/**
 * VIA phase 5 - coordinated database + platform-media backup and restore.
 *
 *   backup:  node -r ts-node/register scripts/platform-media-backup.ts backup  --out <dir>
 *   restore: node -r ts-node/register scripts/platform-media-backup.ts restore --from <dir> --database <new_db> --media-dir <new_dir>
 *   verify:  node -r ts-node/register scripts/platform-media-backup.ts verify  --from <dir>
 *
 * Reads DATABASE_URL and PLATFORM_MEDIA_DIR like the API; PG_CONTAINER names
 * the PostgreSQL container (pg_dump/pg_restore run inside it, so no
 * credentials ever appear on a command line or in output).
 *
 * Coordination: one REPEATABLE READ transaction exports a snapshot; the
 * media manifest is read in it and pg_dump uses the SAME snapshot
 * (--snapshot), so the database copy and the file list describe one
 * moment. Platform media files are immutable (a generated key per upload)
 * and are only deleted by a purge, so copying them after the snapshot is
 * safe; a file purged meanwhile makes the backup fail loudly (re-run it, or
 * pause the PlatformMediaSweep task while backing up). Every copied file is
 * hashed and must match its recorded SHA-256.
 *
 * Restore only ever creates a NEW database (it refuses an existing one)
 * and a NEW media directory, then verifies every restored row against the
 * restored files (SHA-256 and size).
 */
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { createReadStream, createWriteStream, promises as fs } from 'fs';
import * as path from 'path';
import { Client } from 'pg';

const KEY =
  /^(homepage|trending|ads|collections)\/\d{4}\/[0-9a-f-]{36}\.(jpg|png|webp|mp4|webm)$/;
const DB_NAME = /^[a-z][a-z0-9_]{0,62}$/;

export interface ManifestAsset {
  id: string;
  storageKey: string;
  sha256: string;
  sizeBytes: number;
}
export interface Manifest {
  format: 'via-platform-media-backup/1';
  created_at: string;
  database: string;
  dump_file: 'database.dump';
  dump_sha256: string;
  assets: ManifestAsset[];
}

function container(): string {
  return process.env.PG_CONTAINER ?? 'finalpro-v1-partner-postgres-1';
}

function databaseOf(url: string): string {
  const name = new URL(url).pathname.slice(1);
  if (!DB_NAME.test(name)) throw new Error('Unexpected database name');
  return name;
}

export async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  await new Promise<void>((resolve, reject) =>
    createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('end', resolve)
      .on('error', reject),
  );
  return h.digest('hex');
}

/** Runs a shell line inside the PostgreSQL container; stdin/stdout are files. */
function inContainer(
  script: string,
  opts: { stdoutTo?: string; stdinFrom?: string } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      'exec',
      ...(opts.stdinFrom ? ['-i'] : []),
      container(),
      'sh',
      '-c',
      script,
    ];
    const p = spawn('docker', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MSYS_NO_PATHCONV: '1' },
    });
    let err = '';
    p.stderr.on('data', (d) => (err += String(d)));
    if (opts.stdoutTo) p.stdout.pipe(createWriteStream(opts.stdoutTo));
    else p.stdout.resume();
    if (opts.stdinFrom) createReadStream(opts.stdinFrom).pipe(p.stdin);
    else p.stdin.end();
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(`docker exec failed (${code}): ${err.slice(0, 300)}`),
          ),
    );
  });
}

export async function backup(
  outDir: string,
  databaseUrl = process.env.DATABASE_URL!,
  mediaDir = process.env.PLATFORM_MEDIA_DIR!,
) {
  if (!databaseUrl || !mediaDir)
    throw new Error('DATABASE_URL and PLATFORM_MEDIA_DIR are required');
  const database = databaseOf(databaseUrl);
  await fs.mkdir(outDir, { recursive: true });
  if ((await fs.readdir(outDir)).length > 0)
    throw new Error('The backup directory must be empty');
  const dumpFile = path.join(outDir, 'database.dump');

  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  let assets: ManifestAsset[];
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snap = (
      await db.query<{ s: string }>('SELECT pg_export_snapshot() AS s')
    ).rows[0].s;
    assets = (
      await db.query<ManifestAsset>(
        `SELECT id, "storageKey", sha256, "sizeBytes" FROM media_assets
          WHERE "validationState" = 'VALID' AND status <> 'PURGING' ORDER BY id`,
      )
    ).rows;
    if (!/^[0-9A-F-]+$/i.test(snap)) throw new Error('Unexpected snapshot id');
    await inContainer(
      `pg_dump -U "$POSTGRES_USER" -d ${database} -Fc --snapshot=${snap}`,
      { stdoutTo: dumpFile },
    );
    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await db.end();
  }

  for (const a of assets) {
    if (!KEY.test(a.storageKey))
      throw new Error(`Unexpected storage key for ${a.id}`);
    const src = path.join(mediaDir, ...a.storageKey.split('/'));
    const dst = path.join(outDir, 'media', ...a.storageKey.split('/'));
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(src, dst);
    const h = await sha256File(dst);
    if (h !== a.sha256)
      throw new Error(`Hash mismatch for ${a.id} - the backup is not valid`);
  }
  const manifest: Manifest = {
    format: 'via-platform-media-backup/1',
    created_at: new Date().toISOString(),
    database,
    dump_file: 'database.dump',
    dump_sha256: await sha256File(dumpFile),
    assets,
  };
  await fs.writeFile(
    path.join(outDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
  );
  return manifest;
}

/** Checks a backup directory on its own: the dump and every file against the manifest. */
export async function verifyBackup(fromDir: string): Promise<Manifest> {
  const manifest = JSON.parse(
    await fs.readFile(path.join(fromDir, 'manifest.json'), 'utf8'),
  ) as Manifest;
  if (manifest.format !== 'via-platform-media-backup/1')
    throw new Error('Unknown backup format');
  if (
    (await sha256File(path.join(fromDir, manifest.dump_file))) !==
    manifest.dump_sha256
  ) {
    throw new Error('The database dump does not match the manifest');
  }
  for (const a of manifest.assets) {
    if (!KEY.test(a.storageKey))
      throw new Error(`Unexpected storage key for ${a.id}`);
    const f = path.join(fromDir, 'media', ...a.storageKey.split('/'));
    if ((await sha256File(f)) !== a.sha256)
      throw new Error(`Media ${a.id} does not match the manifest`);
  }
  return manifest;
}

export async function restore(
  fromDir: string,
  targetDatabase: string,
  targetMediaDir: string,
  adminUrl = process.env.DATABASE_URL!,
) {
  if (!DB_NAME.test(targetDatabase))
    throw new Error('Invalid target database name');
  const manifest = await verifyBackup(fromDir);
  if (targetDatabase === manifest.database)
    throw new Error('Restore never overwrites the source database');
  try {
    if ((await fs.readdir(targetMediaDir)).length > 0)
      throw new Error('The target media directory must be new or empty');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const exists = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [targetDatabase],
    );
    if (exists.rowCount)
      throw new Error(
        'The target database already exists - restore only creates a new one',
      );
    await admin.query(`CREATE DATABASE ${targetDatabase}`);
    await admin.query(
      `COMMENT ON DATABASE ${targetDatabase} IS 'finalpro:disposable-test'`,
    );
  } finally {
    await admin.end();
  }
  await inContainer(
    `pg_restore -U "$POSTGRES_USER" -d ${targetDatabase} --no-owner --exit-on-error`,
    {
      stdinFrom: path.join(fromDir, manifest.dump_file),
    },
  );
  for (const a of manifest.assets) {
    const src = path.join(fromDir, 'media', ...a.storageKey.split('/'));
    const dst = path.join(targetMediaDir, ...a.storageKey.split('/'));
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(src, dst);
  }
  // Verify the restored instance itself: every row's file, hash and size.
  const url = new URL(adminUrl);
  url.pathname = `/${targetDatabase}`;
  const restored = new Client({ connectionString: url.toString() });
  await restored.connect();
  try {
    const rows = (
      await restored.query<ManifestAsset>(
        `SELECT id, "storageKey", sha256, "sizeBytes" FROM media_assets
          WHERE "validationState" = 'VALID' AND status <> 'PURGING' ORDER BY id`,
      )
    ).rows;
    if (rows.length !== manifest.assets.length)
      throw new Error('Restored asset count differs from the manifest');
    for (const r of rows) {
      const f = path.join(targetMediaDir, ...r.storageKey.split('/'));
      const st = await fs.stat(f);
      if (st.size !== r.sizeBytes || (await sha256File(f)) !== r.sha256) {
        throw new Error(`Restored media ${r.id} does not match its row`);
      }
    }
    return {
      database: targetDatabase,
      media_dir: targetMediaDir,
      assets: rows.length,
    };
  } finally {
    await restored.end();
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = (name: string) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (cmd === 'backup') {
    const m = await backup(arg('out')!);
    console.log(
      `backup ok: ${m.assets.length} media file(s), database ${m.database}`,
    );
  } else if (cmd === 'verify') {
    const m = await verifyBackup(arg('from')!);
    console.log(`verify ok: ${m.assets.length} media file(s)`);
  } else if (cmd === 'restore') {
    const r = await restore(arg('from')!, arg('database')!, arg('media-dir')!);
    console.log(`restore ok: ${r.assets} media file(s) into ${r.database}`);
  } else {
    console.log(
      'usage: backup --out <dir> | verify --from <dir> | restore --from <dir> --database <new_db> --media-dir <new_dir>',
    );
    process.exitCode = 2;
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`failed: ${(e as Error).message}`);
    process.exitCode = 1;
  });
}
