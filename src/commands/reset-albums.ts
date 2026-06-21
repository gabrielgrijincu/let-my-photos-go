import { Command } from 'commander';
import * as clack from '@clack/prompts';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getDb } from '../db.js';
import { readConfig } from '../config.js';
import { runWithConcurrency } from '../util.js';

type AlbumPhoto = {
  media_item_id: string;
  dest_path: string;
  companion_path: string | null;
};

export const resetAlbumsCommand = new Command('reset-albums')
  .description('Delete album-only downloaded files from disk and remove their DB records entirely')
  .option('--fix', 'Actually delete files and remove records (default: dry run)')
  .action(async (opts: { fix?: boolean }, cmd: Command) => {
    const profile: string | undefined = cmd.parent?.opts()?.profile;
    const lmpg = (subcmd: string) => (profile ? `lmpg -p ${profile} ${subcmd}` : `lmpg ${subcmd}`);
    clack.intro('🕊️  Let My Photos Go — Reset Albums');

    const config = readConfig();
    if (!config?.outputDir) {
      clack.log.error(`No output directory configured. Run \`${lmpg('config')}\` first.`);
      process.exit(1);
    }
    const outputDir = config.outputDir;

    if (!opts.fix) {
      clack.log.info('Dry run — pass --fix to actually delete files and remove records.');
    }

    const db = getDb();

    const photos = db.prepare(`
      SELECT media_item_id, dest_path, companion_path
      FROM photos
      WHERE source    = 'album'
        AND status    = 'downloaded'
        AND dest_path IS NOT NULL
        AND dest_path NOT IN (
          SELECT dest_path FROM photos
          WHERE source = 'timeline' AND dest_path IS NOT NULL
        )
    `).all() as AlbumPhoto[];

    if (photos.length === 0) {
      clack.log.success('No album-only downloaded files found.');
      clack.outro('Done.');
      return;
    }

    clack.log.info(`Found ${photos.length} album-only file(s).`);

    const spinner = clack.spinner();
    spinner.start('Purging…');

    let deleted = 0;
    let missing = 0;
    let errors = 0;
    let processed = 0;

    const deleteAlbumPhotos = db.prepare(`DELETE FROM album_photos WHERE media_item_id = ?`);
    const deletePhoto = db.prepare(`DELETE FROM photos WHERE media_item_id = ?`);
    const deleteEmptyAlbums = db.prepare(`
      DELETE FROM albums WHERE album_id NOT IN (SELECT DISTINCT album_id FROM album_photos)
    `);

    await runWithConcurrency(photos, 20, async (photo) => {
      if (opts.fix) {
        let wasDeleted = false;
        let wasMissing = false;
        try {
          await fs.unlink(path.resolve(outputDir, photo.dest_path));
          wasDeleted = true;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            wasMissing = true;
          } else {
            clack.log.error(`ERROR  ${photo.dest_path}: ${(err as Error).message}`);
            errors++;
          }
        }

        if (wasDeleted || wasMissing) {
          if (photo.companion_path) {
            await fs.unlink(path.resolve(outputDir, photo.companion_path)).catch(() => {});
          }
          deleteAlbumPhotos.run(photo.media_item_id);
          deletePhoto.run(photo.media_item_id);
          if (wasDeleted) deleted++; else missing++;
        }
      } else {
        clack.log.info(`WOULD DELETE  ${photo.dest_path}`);
        deleted++;
      }

      processed++;
      const pct = Math.round(processed / photos.length * 100);
      spinner.message(`Purging… ${pct}%`);
    });

    let albumsRemoved = 0;
    if (opts.fix) {
      albumsRemoved = (deleteEmptyAlbums.run() as { changes: number }).changes;
    }

    spinner.stop('Done.');

    const verb = opts.fix ? 'Deleted' : 'Would delete';
    clack.log.info(`${verb} ${deleted} file(s), ${missing} already missing, ${errors} error(s).`);
    if (opts.fix && albumsRemoved > 0) {
      clack.log.info(`Removed ${albumsRemoved} now-empty album(s) from the database.`);
    }

    if (!opts.fix && deleted > 0) {
      clack.log.info(`Re-run with --fix to apply.`);
    }

    clack.outro('Done.');
  });
