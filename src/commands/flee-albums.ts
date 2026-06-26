import { Command } from 'commander';
import * as clack from '@clack/prompts';
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { utimes } from 'utimes';
import { launchHeadlessBrowser, saveSession } from '../browser';
import { getAuthPath } from '../paths';
import { markDownloaded, markFailed, getAlbumPhotosForFlee } from '../db';
import type { AlbumPhotoRow } from '../db';
import { readConfig } from '../config';
import { runWithConcurrency, buildFilename } from '../util';

function sanitizeTitle(title: string): string {
  return title.replace(/[/\\:*?"<>|]/g, '-').trim();
}

function resolveAlbumFilename(filename: string, usedNames: Set<string>): string {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = filename;
  let counter = 1;
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${base}_${counter}${ext}`;
    counter++;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

async function createOrUpdateSymlink(linkPath: string, targetRel: string): Promise<'created' | 'skipped' | 'fixed' | 'blocked'> {
  try {
    const stat = await fs.promises.lstat(linkPath);
    if (!stat.isSymbolicLink()) return 'blocked';
    const actual = await fs.promises.readlink(linkPath);
    if (actual === targetRel) return 'skipped';
    await fs.promises.unlink(linkPath);
    await fs.promises.symlink(targetRel, linkPath);
    return 'fixed';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    await fs.promises.symlink(targetRel, linkPath);
    return 'created';
  }
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

function relPath(abs: string, base: string): string {
  return path.relative(base, abs);
}

export const fleeAlbumsCommand = new Command('flee-albums')
  .description('Download album photos directly into albums/ folders, symlinking timeline photos that are already on disk')
  .option('-f, --failed-only', 'Only retry photos that previously failed (still creates symlinks for downloaded ones)')
  .option('-l, --limit <n>', 'Maximum number of photos to download', parseInt)
  .option('-c, --concurrency <n>', 'Number of parallel downloads within each album', parseInt)
  .option('--inspect', 'Open a visible browser with DevTools for each download (for debugging)')
  .action(
    async (
      options: {
        failedOnly?: boolean;
        limit?: number;
        concurrency?: number;
        inspect?: boolean;
      },
      cmd: Command,
    ) => {
      const profile: string | undefined = cmd.parent?.opts()?.profile;
      const lmpg = (subcmd: string) => (profile ? `lmpg -p ${profile} ${subcmd}` : `lmpg ${subcmd}`);
      clack.intro('🕊️  Let My Photos Go — Flee Albums!');

      const config = readConfig();
      if (!config) {
        clack.log.error(`No config found. Run \`${lmpg('config')}\` first.`);
        process.exit(1);
      }
      if (!fs.existsSync(getAuthPath())) {
        clack.log.error(`No browser session found. Run \`${lmpg('auth')}\` first.`);
        process.exit(1);
      }

      const concurrency = options.concurrency ?? 3;
      const outputDir = config.outputDir;
      fs.mkdirSync(outputDir, { recursive: true });

      const spinner = clack.spinner();
      spinner.start('Loading album data…');
      const rows = getAlbumPhotosForFlee();

      if (rows.length === 0) {
        spinner.stop('No album data found.');
        clack.log.error(`Run \`${lmpg('enumerate-albums')}\` first.`);
        process.exit(1);
      }

      // Group rows into ordered albums
      const albumMap = new Map<string, { title: string; photos: AlbumPhotoRow[] }>();
      for (const row of rows) {
        if (!albumMap.has(row.albumId)) {
          albumMap.set(row.albumId, { title: row.albumTitle, photos: [] });
        }
        albumMap.get(row.albumId)!.photos.push(row);
      }

      // Pre-populate downloaded map from DB state
      const downloaded = new Map<string, { destPath: string; filename: string }>();
      for (const row of rows) {
        if (row.status === 'downloaded' && row.dest_path && row.filename) {
          downloaded.set(row.mediaItemId, { destPath: row.dest_path, filename: row.filename });
        }
      }

      const totalPhotos = rows.length;
      const pendingCount = rows.filter(r => r.status !== 'downloaded').length;
      spinner.stop(
        `${albumMap.size} albums, ${totalPhotos} photos total (${pendingCount} not yet downloaded).`,
      );

      if (pendingCount === 0 && !options.failedOnly) {
        // All downloaded — still need to create/update symlinks
        clack.log.info('All photos already downloaded — creating/updating symlinks…');
      }

      spinner.start(options.inspect ? 'Launching browser in inspect mode…' : 'Launching headless browser…');
      let { browser, context } = await launchHeadlessBrowser({ inspect: options.inspect });
      spinner.stop('Browser ready.');

      const BROWSER_RESTART_EVERY = 500;
      let downloadCount = 0;
      let symlinked = 0;
      let symlinkFixed = 0;
      let symlinkBlocked = 0;
      let downloadedThisRun = 0;
      let failed = 0;
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
          if (k === '\x03' || k === '\x1a') {
            shuttingDown = true;
            unblockNetworkWaiters();
            clack.log.warn('Stopping after current downloads complete — saving session…');
          }
        });
      }

      const albumProgressSpinner = clack.spinner();
      albumProgressSpinner.start('Processing albums…');

      let albumIndex = 0;
      for (const [, album] of albumMap) {
        if (sessionExpired || shuttingDown) break;
        albumIndex++;
        const safeTitle = sanitizeTitle(album.title);
        const albumDir = path.join(outputDir, 'albums', safeTitle);
        fs.mkdirSync(albumDir, { recursive: true });

        albumProgressSpinner.message(`[${albumIndex}/${albumMap.size}] ${album.title}…`);

        // Per-album filename collision tracker
        const usedNames = new Set<string>();

        // Pre-reserve filenames for photos that will become symlinks
        for (const photo of album.photos) {
          const entry = downloaded.get(photo.mediaItemId);
          if (entry && fs.existsSync(path.join(outputDir, entry.destPath))) {
            // Reserve the name (but don't add to usedNames yet — resolveAlbumFilename does that)
            resolveAlbumFilename(entry.filename, usedNames);
          }
        }
        // Reset usedNames — pre-reservation pass just populated it; now reset to replay during actual work
        usedNames.clear();

        // Two passes: symlinks first (synchronous, no concurrency issues), then downloads
        // Pass 1: symlinks (synchronous to keep usedNames consistent)
        for (const photo of album.photos) {
          if (sessionExpired || shuttingDown) break;
          const entry = downloaded.get(photo.mediaItemId);
          if (!entry) continue;

          const srcAbs = path.join(outputDir, entry.destPath);
          if (!fs.existsSync(srcAbs)) continue; // target missing — download pass will handle it

          const linkFilename = resolveAlbumFilename(entry.filename, usedNames);
          const linkPath = path.join(albumDir, linkFilename);
          const targetRel = path.relative(albumDir, srcAbs);

          try {
            const result = await createOrUpdateSymlink(linkPath, targetRel);
            if (result === 'created' || result === 'skipped') symlinked++;
            else if (result === 'fixed') symlinkFixed++;
            else if (result === 'blocked') {
              clack.log.warn(`Skipping ${linkFilename} in "${album.title}" — a non-symlink file already exists.`);
              symlinkBlocked++;
            }
          } catch (err) {
            clack.log.warn(`Symlink error for ${linkFilename} in "${album.title}": ${(err as Error).message}`);
            symlinkBlocked++;
          }
        }

        // Pass 2: downloads (concurrent)
        const toDownload = album.photos.filter(p => {
          if (downloaded.has(p.mediaItemId) && fs.existsSync(path.join(outputDir, downloaded.get(p.mediaItemId)!.destPath))) return false;
          if (options.failedOnly && p.status === 'pending') return false;
          return true;
        });

        await runWithConcurrency(toDownload, concurrency, async (photo) => {
          if (sessionExpired || shuttingDown) return;
          if (options.limit && downloadedThisRun >= options.limit) return;

          // Browser restart check
          if (downloadCount > 0 && downloadCount % BROWSER_RESTART_EVERY === 0) {
            albumProgressSpinner.message(`Restarting browser to free memory…`);
            await saveSession(context);
            await browser.close();
            ({ browser, context } = await launchHeadlessBrowser({ inspect: options.inspect }));
          }

          while (true) {
            const page = await context.newPage();
            let shouldRetry = false;

            try {
              const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
              downloadPromise.catch(() => {});

              await page.goto(photo.google_url ?? `https://photos.google.com/photo/${photo.mediaItemId}`, {
                waitUntil: 'load',
                timeout: 30000,
              });
              await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

              if (!page.url().startsWith('https://photos.google.com/')) {
                if (!sessionExpired) {
                  sessionExpired = true;
                  clack.log.error(`Session expired — run \`${lmpg('auth')}\`, then \`${lmpg('flee-albums')}\` to continue.`);
                }
                return;
              }

              await page.keyboard.press('Shift+KeyD');

              const dl = await downloadPromise;
              const suggestedFilename = dl.suggestedFilename() || `${photo.mediaItemId}.jpg`;
              const date = photo.creation_time ? new Date(photo.creation_time) : null;
              const built = buildFilename(date, suggestedFilename);

              const tsMs = date ? date.getTime() : Date.now();
              const applyTimestamps = (p: string) => utimes(p, { btime: tsMs, mtime: tsMs, atime: tsMs });

              if (suggestedFilename.toLowerCase().endsWith('.zip')) {
                // Save zip to a temp location, then extract into albumDir
                const tmpZip = path.join(albumDir, `__tmp_${photo.mediaItemId}.zip`);
                await dl.saveAs(tmpZip);
                await dl.delete();

                const extractedPaths: string[] = [];
                try {
                  const zip = new AdmZip(tmpZip);
                  const stillEntry = zip.getEntries().find(e => /\.(heic|jpg|jpeg|png)$/i.test(e.entryName));

                  if (stillEntry) {
                    const builtStill = buildFilename(date, stillEntry.entryName);
                    // Resolve filename collision synchronously (single-threaded between awaits)
                    const stillFilename = resolveAlbumFilename(builtStill, usedNames);
                    const resolvedBase = path.join(albumDir, stillFilename).replace(/\.[^.]+$/, '');

                    for (const entry of zip.getEntries()) {
                      const ext = path.extname(entry.entryName).toLowerCase();
                      const outPath = resolvedBase + ext;
                      fs.writeFileSync(outPath, entry.getData());
                      extractedPaths.push(outPath);
                      await applyTimestamps(outPath);
                    }

                    const stillAbs = path.join(albumDir, stillFilename);
                    const companionAbs = extractedPaths.find(p => p !== stillAbs);
                    markDownloaded(
                      photo.mediaItemId,
                      relPath(stillAbs, outputDir),
                      stillFilename,
                      companionAbs ? relPath(companionAbs, outputDir) : undefined,
                    );
                    downloaded.set(photo.mediaItemId, { destPath: relPath(stillAbs, outputDir), filename: stillFilename });
                  }
                } catch (zipErr) {
                  for (const p of extractedPaths) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
                  throw zipErr;
                } finally {
                  for (let attempt = 0; attempt < 3; attempt++) {
                    try { fs.unlinkSync(tmpZip); break; }
                    catch (e) {
                      if ((e as NodeJS.ErrnoException).code === 'ENOENT') break;
                      if (attempt < 2) await new Promise(r => setTimeout(r, 500));
                      else clack.log.warn(`Could not delete ZIP ${tmpZip}: ${(e as Error).message}`);
                    }
                  }
                }
              } else {
                // Resolve filename collision synchronously
                const destFilename = resolveAlbumFilename(built, usedNames);
                const destAbs = path.join(albumDir, destFilename);
                await dl.saveAs(destAbs);
                await dl.delete();
                await applyTimestamps(destAbs);
                markDownloaded(photo.mediaItemId, relPath(destAbs, outputDir), destFilename);
                downloaded.set(photo.mediaItemId, { destPath: relPath(destAbs, outputDir), filename: destFilename });
              }

              downloadCount++;
              downloadedThisRun++;
              albumProgressSpinner.message(`[${albumIndex}/${albumMap.size}] ${album.title} — downloaded ${downloadedThisRun}`);
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
                markFailed(photo.mediaItemId);
                failed++;
                clack.log.warn(`✗ ${photo.mediaItemId}: ${err instanceof Error ? err.message : String(err)}`);
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
        });
      }

      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
      }
      inDownloadPhase = false;

      await saveSession(context);
      await browser.close();

      albumProgressSpinner.stop('Done.');

      const parts = [
        `${symlinked} symlinked`,
        symlinkFixed > 0 ? `${symlinkFixed} symlinks updated` : null,
        symlinkBlocked > 0 ? `${symlinkBlocked} symlinks blocked (non-symlink file exists)` : null,
        `${downloadedThisRun} downloaded`,
        failed > 0 ? `${failed} failed` : null,
      ].filter(Boolean).join(', ');
      clack.log.info(parts);

      if (sessionExpired) {
        clack.outro(`Session expired. Run \`${lmpg('auth')}\`, then \`${lmpg('flee-albums')}\` to continue.`);
        return;
      }
      if (shuttingDown) {
        clack.outro(`Paused. Run \`${lmpg('flee-albums')}\` to continue.`);
        return;
      }

      clack.outro(
        failed > 0
          ? `${failed} failed — run \`${lmpg('flee-albums')}\` to retry.`
          : `Albums written to ${path.join(outputDir, 'albums')}`,
      );
    },
  );
