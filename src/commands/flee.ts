import { Command } from 'commander';
import * as clack from '@clack/prompts';
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { utimes } from 'utimes';
import { launchHeadlessBrowser, saveSession } from '../browser.js';
import { getAuthPath } from '../paths.js';
import { markDownloaded, markFailed, getPendingPhotos, hasAnyPhotos, getDestPathOwner, getStats } from '../db.js';
import { readConfig } from '../config.js';
import { runWithConcurrency, buildFilename } from '../util.js';
import type { PhotoRecord, PhotoFilter } from '../db.js';

// --- helpers ---

function relPath(abs: string, base: string): string {
  return path.relative(base, abs);
}

function absPath(stored: string, base: string): string {
  return path.isAbsolute(stored) ? stored : path.resolve(base, stored);
}

function resolveDestPath(
  outputDir: string,
  photo: PhotoRecord,
  filename: string,
  reserved: Set<string>,
): string {
  const date = photo.creation_time ? new Date(photo.creation_time) : null;
  const valid = date && !isNaN(date.getTime());
  const year = valid ? String(date!.getUTCFullYear()) : 'unknown';
  const month = valid ? String(date!.getUTCMonth() + 1).padStart(2, '0') : 'unknown';
  const dir = path.join(outputDir, year, month);
  fs.mkdirSync(dir, { recursive: true });

  const newFilename = buildFilename(date, filename);
  const ext = path.extname(newFilename);
  const base = path.basename(newFilename, ext);
  let candidate = path.join(dir, newFilename);
  let rel = relPath(candidate, outputDir);
  let counter = 1;

  // Check both filesystem (already downloaded) and in-memory set (in-flight downloads).
  // No await between check and add — atomic in JS's single-threaded event loop.
  while (fs.existsSync(candidate) || reserved.has(rel)) {
    const owner = getDestPathOwner(rel);
    if (owner === photo.media_item_id) break;
    candidate = path.join(dir, `${base}_${counter}${ext}`);
    rel = relPath(candidate, outputDir);
    counter++;
  }

  reserved.add(rel);
  return candidate;
}

function parseDateArg(value: string, endOfDay = false): Date {
  const parts = value.split('-').map(Number);
  const [y, m = endOfDay ? 12 : 1, d = endOfDay ? 31 : 1] = parts;
  const date = new Date(Date.UTC(y, m - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0));
  if (isNaN(date.getTime())) throw new Error(`Invalid date: "${value}"`);
  return date;
}


async function probeNetwork(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), 5000);
    await fetch('https://www.google.com', { method: 'HEAD', signal: ctrl.signal });
    clearTimeout(id);
    return true;
  } catch {
    return false;
  }
}

// --- command ---

export const fleeCommand = new Command('flee')
  .description('Download all pending photos from the local database')
  .option('-f, --failed-only', 'Only retry photos that previously failed')
  .option('-y, --year <year>', 'Only download photos from a specific year (e.g. 2023)')
  .option('--from <date>', 'Only download photos on or after this date (YYYY, YYYY-MM, or YYYY-MM-DD)')
  .option('--to <date>', 'Only download photos on or before this date (YYYY, YYYY-MM, or YYYY-MM-DD)')
  .option('-l, --limit <n>', 'Maximum number of photos to download', parseInt)
  .option('-c, --concurrency <n>', 'Number of parallel downloads', parseInt)
  .option('--inspect', 'Open a visible browser with DevTools for each download (for debugging)')
  .action(
    async (
      options: {
        failedOnly?: boolean;
        year?: string;
        from?: string;
        to?: string;
        limit?: number;
        concurrency?: number;
        inspect?: boolean;
      },
      cmd: Command,
    ) => {
      const profile: string | undefined = cmd.parent?.opts()?.profile;
      const lmpg = (subcmd: string) => (profile ? `lmpg -p ${profile} ${subcmd}` : `lmpg ${subcmd}`);
      clack.intro('🕊️  Let My Photos Go — Flee!');

      const config = readConfig();
      if (!config) {
        clack.log.error(`No config found. Run \`${lmpg('config')}\` first.`);
        process.exit(1);
      }
      if (!fs.existsSync(getAuthPath())) {
        clack.log.error(`No browser session found. Run \`${lmpg('auth')}\` first.`);
        process.exit(1);
      }

      let fromDate: Date | undefined;
      let toDate: Date | undefined;
      try {
        if (options.year) {
          fromDate = parseDateArg(options.year);
          toDate = new Date(Date.UTC(Number(options.year) + 1, 0, 1));
        }
        if (options.from) fromDate = parseDateArg(options.from);
        if (options.to) toDate = parseDateArg(options.to, true);
      } catch (err) {
        clack.log.error(String(err));
        process.exit(1);
      }

      const concurrency = options.concurrency ?? 3;
      const outputDir = config.outputDir;
      fs.mkdirSync(outputDir, { recursive: true });

      if (!hasAnyPhotos()) {
        clack.log.error(`No photos in database. Run \`${lmpg('enumerate')}\` first.`);
        process.exit(1);
      }

      const BROWSER_RESTART_EVERY = 500;

      const spinner = clack.spinner();
      spinner.start(options.inspect ? 'Launching browser in inspect mode…' : 'Launching headless browser…');
      let { browser, context } = await launchHeadlessBrowser({ inspect: options.inspect });
      spinner.stop('Browser ready.');

      const filter: PhotoFilter = {
        failedOnly: options.failedOnly,
        from: fromDate,
        to: toDate,
        limit: options.limit,
        source: 'timeline',
      };
      const pending = getPendingPhotos(filter);

      if (pending.length === 0) {
        const { downloaded } = getStats();
        clack.log.success(`All ${downloaded.toLocaleString()} photos are already downloaded!`);
        await browser.close();
        clack.outro('Nothing left to do. 🎉');
        return;
      }

      const filterDesc = [
        fromDate && `from ${fromDate.toISOString().slice(0, 10)}`,
        toDate && `to ${toDate.toISOString().slice(0, 10)}`,
        options.limit && `limit=${options.limit}`,
      ]
        .filter(Boolean)
        .join(', ');

      clack.log.info(
        `Downloading ${pending.length} photos${filterDesc ? ` (${filterDesc})` : ''} to ${outputDir} (concurrency: ${concurrency})…`,
      );

      let downloaded = 0;
      let failed = 0;
      const total = pending.length;
      const { downloaded: prevDownloaded, total: grandTotal } = getStats();
      const downloadSpinner = clack.spinner();
      downloadSpinner.start(`[0/${total}] Starting downloads…`);
      let sessionExpired = false;
      let shuttingDown = false;
      let networkDown = false;
      let networkMonitorRunning = false;
      const networkRestoredCallbacks: Array<() => void> = [];

      function waitForNetwork(): Promise<void> {
        if (!networkDown) return Promise.resolve();
        return new Promise(resolve => networkRestoredCallbacks.push(resolve));
      }

      function unblockNetworkWaiters(): void {
        for (const cb of networkRestoredCallbacks.splice(0)) cb();
      }

      async function startNetworkMonitor(): Promise<void> {
        if (networkMonitorRunning) return;
        networkMonitorRunning = true;
        while (networkDown && !shuttingDown && !sessionExpired) {
          await new Promise(r => setTimeout(r, 5000));
          if (!networkDown || shuttingDown || sessionExpired) break;
          if (await probeNetwork()) {
            networkDown = false;
            clack.log.info('Network restored, resuming downloads…');
            unblockNetworkWaiters();
          }
        }
        networkMonitorRunning = false;
      }

      async function isNetworkIssue(err: Error): Promise<boolean> {
        const msg = err.message;
        if (
          msg.includes('ERR_INTERNET_DISCONNECTED') ||
          msg.includes('ERR_NETWORK_CHANGED') ||
          msg.includes('ERR_NAME_NOT_RESOLVED') ||
          msg.includes('ERR_CONNECTION_TIMED_OUT')
        )
          return true;
        if (msg.toLowerCase().includes('timeout')) return !(await probeNetwork());
        return false;
      }

      const reserved = new Set<string>();

      const worker = async (photo: PhotoRecord) => {
        if (sessionExpired || shuttingDown) return;

        // Reconcile: file already on disk at recorded path
        const absDestPath0 = photo.dest_path ? absPath(photo.dest_path, outputDir) : null;
        if (absDestPath0 && fs.existsSync(absDestPath0)) {
          const filename = path.basename(absDestPath0);
          markDownloaded(photo.media_item_id, photo.dest_path!, filename);
          downloaded++;
          downloadSpinner.message(
            `[${prevDownloaded + downloaded + failed}/${grandTotal}] ✓ ${filename} (already on disk)`,
          );
          return;
        }

        while (true) {
          const page = await context.newPage();
          let shouldRetry = false;

          try {
            const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
            downloadPromise.catch(() => {}); // prevent unhandled rejection if page closes before download fires

            await page.goto(photo.google_url ?? `https://photos.google.com/photo/${photo.media_item_id}`, {
              waitUntil: 'load',
              timeout: 30000,
            });
            await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

            if (!page.url().startsWith('https://photos.google.com/')) {
              if (!sessionExpired) {
                sessionExpired = true;
                clack.log.error(`Session expired — run \`${lmpg('auth')}\` to sign in again.`);
              }
              return;
            }

            await page.keyboard.press('Shift+KeyD');

            const download = await downloadPromise;
            const filename = download.suggestedFilename() || `${photo.media_item_id}.jpg`;
            const destPath = resolveDestPath(outputDir, photo, filename, reserved);
            await download.saveAs(destPath);
            await download.delete();

            const tsMs = photo.creation_time ? new Date(photo.creation_time).getTime() : Date.now();
            const applyTimestamps = (p: string) => utimes(p, { btime: tsMs, mtime: tsMs, atime: tsMs });

            let actualDestPath = destPath;
            let actualFilename = filename;

            if (filename.toLowerCase().endsWith('.zip')) {
              const extractedPaths: string[] = [];
              try {
                const zip = new AdmZip(destPath);
                const stillEntry = zip.getEntries().find(e => /\.(heic|jpg|jpeg|png)$/i.test(e.entryName));

                if (stillEntry) {
                  const resolvedStillPath = resolveDestPath(outputDir, photo, stillEntry.entryName, reserved);
                  const resolvedBase = resolvedStillPath.replace(/\.[^.]+$/, '');

                  for (const entry of zip.getEntries()) {
                    const ext = path.extname(entry.entryName).toLowerCase();
                    const outPath = resolvedBase + ext;
                    fs.writeFileSync(outPath, entry.getData());
                    extractedPaths.push(outPath);
                    await applyTimestamps(outPath);
                  }

                  actualFilename = path.basename(resolvedStillPath);
                  actualDestPath = resolvedStillPath;
                }
              } catch (zipErr) {
                for (const p of extractedPaths) {
                  try {
                    fs.unlinkSync(p);
                  } catch {
                    /* ignore */
                  }
                }
                throw zipErr;
              } finally {
                for (let attempt = 0; attempt < 3; attempt++) {
                  try {
                    fs.unlinkSync(destPath);
                    break;
                  } catch (e) {
                    if ((e as NodeJS.ErrnoException).code === 'ENOENT') break;
                    if (attempt < 2) await new Promise(r => setTimeout(r, 500));
                    else clack.log.warn(`Could not delete ZIP ${destPath}: ${(e as Error).message}`);
                  }
                }
              }

              const companionPath = extractedPaths.find(p => p !== actualDestPath);
              markDownloaded(
                photo.media_item_id,
                relPath(actualDestPath, outputDir),
                actualFilename,
                companionPath ? relPath(companionPath, outputDir) : undefined,
              );
            } else {
              await applyTimestamps(destPath);
              markDownloaded(photo.media_item_id, relPath(actualDestPath, outputDir), actualFilename);
            }

            downloaded++;
            downloadSpinner.message(`[${prevDownloaded + downloaded + failed}/${grandTotal}] ✓ ${actualFilename}`);
            return;
          } catch (err) {
            if (!shuttingDown && !sessionExpired && (await isNetworkIssue(err as Error))) {
              shouldRetry = true;
              if (!networkDown) {
                networkDown = true;
                clack.log.warn('Network unavailable — waiting to reconnect…');
                startNetworkMonitor();
              }
            } else {
              markFailed(photo.media_item_id);
              failed++;
              clack.log.warn(
                `[${prevDownloaded + downloaded + failed}/${grandTotal}] ✗ ${photo.media_item_id}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          } finally {
            await page.close();
          }
          if (shouldRetry) {
            await waitForNetwork();
            if (shuttingDown || sessionExpired) return;
          } else {
            return;
          }
        }
      };

      let inDownloadPhase = true;

      process.once('SIGINT', () => {
        if (inDownloadPhase) {
          shuttingDown = true;
          unblockNetworkWaiters();
          clack.log.warn('Stopping after current downloads complete — saving session…');
        } else {
          process.exit(0);
        }
      });

      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on('data', (key: Buffer) => {
          const k = key.toString();
          if (k === '' || k === '') {
            shuttingDown = true;
            unblockNetworkWaiters();
            clack.log.warn('Stopping after current downloads complete — saving session…');
          }
        });
      }

      for (let chunkStart = 0; chunkStart < pending.length; chunkStart += BROWSER_RESTART_EVERY) {
        if (chunkStart > 0) {
          downloadSpinner.message(`[${prevDownloaded + downloaded + failed}/${grandTotal}] Restarting browser to free memory…`);
          await saveSession(context);
          await browser.close();
          ({ browser, context } = await launchHeadlessBrowser({ inspect: options.inspect }));
        }
        await runWithConcurrency(pending.slice(chunkStart, chunkStart + BROWSER_RESTART_EVERY), concurrency, worker);
        if (sessionExpired || shuttingDown) break;
      }

      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
      }
      inDownloadPhase = false;

      await saveSession(context);
      await browser.close();

      if (sessionExpired) {
        downloadSpinner.stop(`Stopped at [${prevDownloaded + downloaded + failed}/${grandTotal}].`);
        clack.outro(`Session expired. Run \`${lmpg('auth')}\`, then \`${lmpg('flee')}\` to continue.`);
        return;
      }

      if (shuttingDown) {
        downloadSpinner.stop(`Paused at [${prevDownloaded + downloaded + failed}/${grandTotal}].`);
        clack.outro(`Run \`${lmpg('flee')}\` to continue.`);
        return;
      }

      downloadSpinner.stop(
        `Downloaded ${downloaded} photos.${failed > 0 ? ` ${failed} failed (run again to retry).` : ' 🎉'}`,
      );
      clack.outro(failed > 0 ? `Run \`${lmpg('flee')}\` to retry failed downloads.` : `Run \`${lmpg('verify')}\` to check your downloads.`);
    },
  );
