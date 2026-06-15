import { Command } from 'commander';
import * as clack from '@clack/prompts';
import * as fs from 'fs';
import * as path from 'path';
import { launchHeadlessBrowser, isSessionValid, AUTH_PATH } from '../browser.js';
import { enumerateAllMediaItems } from '../api.js';
import { upsertPhoto, markDownloaded, markFailed, getPendingPhotos, hasAnyPhotos, getDestPathOwner } from '../db.js';
import { readConfig } from '../config.js';
import type { PhotoRecord, PhotoFilter } from '../db.js';

// --- helpers ---

function resolveDestPath(outputDir: string, photo: PhotoRecord): string {
  const date = photo.creation_time ? new Date(photo.creation_time) : null;
  const year  = date && !isNaN(date.getTime()) ? String(date.getUTCFullYear()) : 'unknown';
  const month = date && !isNaN(date.getTime()) ? String(date.getUTCMonth() + 1).padStart(2, '0') : 'unknown';
  const dir = path.join(outputDir, year, month);
  fs.mkdirSync(dir, { recursive: true });

  const ext  = path.extname(photo.filename);
  const base = path.basename(photo.filename, ext);
  let candidate = path.join(dir, photo.filename);
  let counter = 1;

  while (fs.existsSync(candidate)) {
    const owner = getDestPathOwner(candidate);
    if (owner === photo.media_item_id) break;
    candidate = path.join(dir, `${base}_${counter}${ext}`);
    counter++;
  }

  return candidate;
}

function parseDateArg(value: string, endOfDay = false): Date {
  // Accept YYYY, YYYY-MM, or YYYY-MM-DD
  const parts = value.split('-').map(Number);
  const [y, m = endOfDay ? 12 : 1, d = endOfDay ? 31 : 1] = parts;
  const date = new Date(Date.UTC(y, m - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0));
  if (isNaN(date.getTime())) throw new Error(`Invalid date: "${value}"`);
  return date;
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  async function next(): Promise<void> {
    while (i < items.length) {
      const item = items[i++];
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
}

// --- command ---

export const fleeCommand = new Command('flee')
  .description('Download all your Google Photos with full metadata')
  .option('--resume',              'Skip already-downloaded photos; skip re-enumeration if DB has entries')
  .option('--failed-only',         'Only retry photos that previously failed')
  .option('--year <year>',         'Only download photos from a specific year (e.g. 2023)')
  .option('--from <date>',         'Only download photos on or after this date (YYYY, YYYY-MM, or YYYY-MM-DD)')
  .option('--to <date>',           'Only download photos on or before this date (YYYY, YYYY-MM, or YYYY-MM-DD)')
  .option('--media-type <type>',   'Filter by media type: photo or video', 'all')
  .option('--limit <n>',           'Maximum number of photos to download', parseInt)
  .option('--concurrency <n>',     'Number of parallel downloads', parseInt)
  .option('--inspect',             'Open a visible browser with DevTools for each download (for debugging)')
  .action(async (options: {
    resume?: boolean;
    failedOnly?: boolean;
    year?: string;
    from?: string;
    to?: string;
    mediaType: string;
    limit?: number;
    concurrency?: number;
    inspect?: boolean;
  }) => {
    clack.intro('🕊️  Let My Photos Go — Flee!');

    const config = readConfig();
    if (!config) {
      clack.log.error('No config found. Run `lmpg config` first.');
      process.exit(1);
    }
    if (!fs.existsSync(AUTH_PATH)) {
      clack.log.error('No browser session found. Run `lmpg auth` first.');
      process.exit(1);
    }

    // Parse date filters
    let fromDate: Date | undefined;
    let toDate: Date | undefined;
    try {
      if (options.year) {
        fromDate = parseDateArg(options.year);
        toDate   = new Date(Date.UTC(Number(options.year) + 1, 0, 1)); // start of next year
      }
      if (options.from) fromDate = parseDateArg(options.from);
      if (options.to)   toDate   = parseDateArg(options.to, true);
    } catch (err) {
      clack.log.error(String(err));
      process.exit(1);
    }

    const mimeTypePrefix =
      options.mediaType === 'photo' ? 'image/' :
      options.mediaType === 'video' ? 'video/' :
      undefined;

    const concurrency = options.concurrency ?? 3;
    const outputDir = config.outputDir;
    fs.mkdirSync(outputDir, { recursive: true });

    const spinner = clack.spinner();
    spinner.start(options.inspect ? 'Launching browser in inspect mode…' : 'Launching headless browser…');
    const { browser, context } = await launchHeadlessBrowser({ inspect: options.inspect });
    spinner.stop('Browser ready.');

    spinner.start('Checking session validity…');
    const valid = await isSessionValid(context);
    if (!valid) {
      spinner.stop('Session expired or invalid.');
      clack.log.error('Your session has expired. Run `lmpg auth` to log in again.');
      await browser.close();
      process.exit(1);
    }
    spinner.stop('Session is valid.');

    // Enumeration
    const skipEnum = options.resume && hasAnyPhotos();
    if (skipEnum) {
      clack.log.info('Resuming — skipping enumeration (DB already has entries).');
    } else {
      spinner.start('Enumerating your photos from Google Photos API…');
      let enumCount = 0;
      try {
        for await (const item of enumerateAllMediaItems(context, (n) => {
          spinner.message(`Enumerating photos… (${n} found so far)`);
          enumCount = n;
        })) {
          upsertPhoto(item.id, item.filename, item.productUrl, item.mediaMetadata.creationTime ?? null, item.mimeType);
        }
      } catch (err) {
        spinner.stop('Failed to enumerate photos.');
        clack.log.error(`API error: ${err instanceof Error ? err.message : String(err)}`);
        await browser.close();
        process.exit(1);
      }
      spinner.stop(`Found ${enumCount} photos total.`);
    }

    const filter: PhotoFilter = { failedOnly: options.failedOnly, from: fromDate, to: toDate, mimeTypePrefix, limit: options.limit };
    const pending = getPendingPhotos(filter);

    if (pending.length === 0) {
      clack.log.success('All photos are already downloaded!');
      await browser.close();
      clack.outro('Nothing left to do. 🎉');
      return;
    }

    const filterDesc = [
      fromDate && `from ${fromDate.toISOString().slice(0, 10)}`,
      toDate   && `to ${toDate.toISOString().slice(0, 10)}`,
      mimeTypePrefix && `type=${options.mediaType}`,
      options.limit  && `limit=${options.limit}`,
    ].filter(Boolean).join(', ');

    clack.log.info(`Downloading ${pending.length} photos${filterDesc ? ` (${filterDesc})` : ''} to ${outputDir} (concurrency: ${concurrency})…`);

    let downloaded = 0;
    let failed = 0;
    const total = pending.length;

    await runWithConcurrency(pending, concurrency, async (photo) => {
      // Reconcile: file already on disk at recorded path
      if (photo.dest_path && fs.existsSync(photo.dest_path)) {
        markDownloaded(photo.media_item_id, photo.dest_path);
        downloaded++;
        clack.log.step(`[${downloaded + failed}/${total}] ✓ ${photo.filename} (already on disk)`);
        return;
      }

      const page = await context.newPage();
      try {
        const downloadPromise = page.waitForEvent('download', { timeout: 60000 });

        await page.goto(photo.google_url ?? `https://photos.google.com/photo/${photo.media_item_id}`, {
          waitUntil: 'networkidle',
          timeout: 30000,
        });

        await page.keyboard.press('Shift+KeyD');

        const download = await downloadPromise;
        const destPath = resolveDestPath(outputDir, photo);
        await download.saveAs(destPath);

        markDownloaded(photo.media_item_id, destPath);
        downloaded++;
        clack.log.step(`[${downloaded + failed}/${total}] ✓ ${photo.filename}`);
      } catch (err) {
        markFailed(photo.media_item_id);
        failed++;
        clack.log.warn(`[${downloaded + failed}/${total}] ✗ ${photo.filename}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        await page.close();
      }
    });

    await browser.close();

    clack.outro(`Done! Downloaded ${downloaded} photos.${failed > 0 ? ` ${failed} failed (run again to retry).` : ' 🎉'}`);
  });
