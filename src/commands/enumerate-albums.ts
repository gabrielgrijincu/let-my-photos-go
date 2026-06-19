import { Command } from 'commander';
import * as clack from '@clack/prompts';
import * as fs from 'fs';
import { launchHeadlessBrowser, saveSession } from '../browser.js';
import { getAuthPath } from '../paths.js';
import { readConfig } from '../config.js';
import { extractBatchParams, enumerateAllAlbums, fetchAlbumPhotoSamples, type Album } from '../api.js';
import {
  upsertAlbum,
  upsertAlbumPhotos,
  upsertAlbumPhoto,
  deletePendingAlbumPhotos,
  getTimelinePhotoIds,
} from '../db.js';

type OwnerFlag = 'owned' | 'foreign-saved' | 'all';

export const enumerateAlbumsCommand = new Command('enumerate-albums')
  .description('Scan all albums and persist membership to the database')
  .option('--owned', 'only include photos you uploaded (default)')
  .option('--foreign-saved', 'include your photos + others\' photos present in the main timeline (requires `lmpg enumerate` to have been run first)')
  .option('--all', 'include all photos; download others\' photos on next `lmpg flee`')
  .action(async (options: { owned?: boolean; foreignSaved?: boolean; all?: boolean }, cmd: Command) => {
    const profile: string | undefined = cmd.parent?.opts()?.profile;
    const lmpg = (subcmd: string) => (profile ? `lmpg -p ${profile} ${subcmd}` : `lmpg ${subcmd}`);
    clack.intro('🕊️  Let My Photos Go — Enumerate Albums');

    if (!fs.existsSync(getAuthPath())) {
      clack.log.error(`No browser session found. Run \`${lmpg('auth')}\` first.`);
      process.exit(1);
    }

    const ownerFlag: OwnerFlag = options.all ? 'all' : options.foreignSaved ? 'foreign-saved' : 'owned';

    const config = readConfig();
    const googleUserToken = config?.googleUserToken ?? null;
    if (!googleUserToken && ownerFlag !== 'all') {
      clack.log.warn(`Google user token not found. Re-run \`${lmpg('auth')}\` to enable ownership detection.`);
    }

    const spinner = clack.spinner();
    spinner.start('Launching headless browser…');
    const { browser, context } = await launchHeadlessBrowser();
    spinner.stop('Browser ready.');

    spinner.start('Extracting session params…');
    let params;
    try {
      params = await extractBatchParams(context);
    } catch (err) {
      spinner.stop('Failed to extract session params.');
      clack.log.error(`${err instanceof Error ? err.message : String(err)}`);
      await browser.close();
      process.exit(1);
    }
    spinner.stop('Session ready.');

    // Clear pending album photos before re-populating
    deletePendingAlbumPhotos();

    // For --keep-saved: pre-fetch the set of media IDs already in the main timeline
    const savedIds: Set<string> = ownerFlag === 'foreign-saved' ? getTimelinePhotoIds() : new Set();

    spinner.start('Scanning album list…');
    const albums: Album[] = [];
    try {
      for await (const album of enumerateAllAlbums(context, params)) {
        albums.push(album);
        spinner.message(`Scanning album list… (${albums.length} found)`);
      }
    } catch (err) {
      spinner.stop('Failed to scan albums.');
      clack.log.error(`${err instanceof Error ? err.message : String(err)}`);
      await browser.close();
      process.exit(1);
    }
    spinner.stop(`Found ${albums.length} albums.`);

    spinner.start('Fetching photo attribution…');
    let totalPhotoPersisted = 0;
    let newPendingCount = 0;

    for (let i = 0; i < albums.length; i++) {
      const album = albums[i];
      spinner.message(`[${i + 1}/${albums.length}] ${album.title}…`);

      const samples = await fetchAlbumPhotoSamples(context, params, album);

      // Filter samples based on flag
      const filteredSamples = samples.filter(s => {
        if (ownerFlag === 'all') return true;
        if (s.uploaderToken === googleUserToken) return true;
        if (ownerFlag === 'foreign-saved') return savedIds.has(s.mediaItemId);
        return false; // --owned
      });

      upsertAlbum(album.albumId, album.title, album.photoCount);
      upsertAlbumPhotos(album.albumId, filteredSamples);
      totalPhotoPersisted += filteredSamples.length;

      // For --keep-all: upsert others' photos into photos table so flee downloads them
      if (ownerFlag === 'all') {
        for (const s of filteredSamples) {
          if (s.uploaderToken !== googleUserToken) {
            const googleUrl = `https://photos.google.com/share/${album.albumId}/photo/${s.mediaItemId}`;
            const creationTime = s.creationTime !== null ? new Date(s.creationTime).toISOString() : null;
            upsertAlbumPhoto(s.mediaItemId, googleUrl, creationTime);
            newPendingCount++;
          }
        }
      }
    }
    spinner.stop('Done.');

    await saveSession(context);
    await browser.close();

    clack.log.info(`Persisted ${albums.length} albums, ${totalPhotoPersisted} photos.`);
    if (newPendingCount > 0) {
      clack.log.info(`Added ${newPendingCount} photos from shared albums. Run \`${lmpg('flee')}\` to download them.`);
    }

    clack.outro(`Run \`${lmpg('organize')}\` to create the Albums/ folder structure.`);
  });
