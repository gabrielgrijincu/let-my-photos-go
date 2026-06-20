import { Command } from 'commander';
import * as clack from '@clack/prompts';
import * as fs from 'fs/promises';
import * as path from 'path';
import { readConfig } from '../config.js';
import { getOrganizeData } from '../db.js';
import { runWithConcurrency } from '../util.js';

function sanitizeTitle(title: string): string {
  return title.replace(/[/\\:*?"<>|]/g, '-').trim();
}


export const organizeCommand = new Command('organize')
  .description('Create Albums/ folder structure with symlinks to downloaded photos')
  .action(async (_options: Record<string, unknown>, cmd: Command) => {
    const profile: string | undefined = cmd.parent?.opts()?.profile;
    const lmpg = (subcmd: string) => (profile ? `lmpg -p ${profile} ${subcmd}` : `lmpg ${subcmd}`);
    clack.intro('🕊️  Let My Photos Go — Organize');

    const config = readConfig();
    if (!config?.outputDir) {
      clack.log.error(`No output directory configured. Run \`${lmpg('config')}\` first.`);
      process.exit(1);
    }
    const outputDir = config.outputDir;

    const spinner = clack.spinner();
    spinner.start('Loading album data…');

    const albums = getOrganizeData();
    if (albums.length === 0) {
      spinner.stop('No album data found.');
      clack.log.error(`Run \`${lmpg('enumerate-albums')}\` first.`);
      process.exit(1);
    }

    spinner.message('Organizing albums…');

    let symlinked = 0;
    let skipped = 0;
    let fixed = 0;
    let notDownloaded = 0;
    const failedAlbums: { title: string; error: string }[] = [];

    const totalPhotos = albums.reduce((sum, a) => sum + a.photos.length, 0);
    let processedPhotos = 0;

    await runWithConcurrency(albums, 20, async (album) => {
      const safeTitle = sanitizeTitle(album.title);
      const albumDir = path.join(outputDir, 'Albums', safeTitle);
      await fs.mkdir(albumDir, { recursive: true });

      notDownloaded += album.totalInAlbum - album.photos.length;

      // Track filenames used within this album to handle collisions
      const usedNames = new Set<string>();
      let albumFailed = false;

      for (const photo of album.photos) {
        const src = path.join(outputDir, photo.destPath);

        // Resolve collision: if filename already used, append _N
        let { name, ext } = path.parse(photo.filename);
        let candidate = photo.filename;
        let counter = 1;
        while (usedNames.has(candidate)) {
          candidate = `${name}_${counter}${ext}`;
          counter++;
        }
        usedNames.add(candidate);

        const linkPath = path.join(albumDir, candidate);

        const expectedRel = path.relative(path.dirname(linkPath), src);
        let replacing = false;

        try {
          const stat = await fs.lstat(linkPath);
          if (!stat.isSymbolicLink()) {
            clack.log.warn(`Skipping ${candidate} in "${album.title}" — a non-symlink file already exists at that path.`);
            skipped++;
            continue;
          }
          const actual = await fs.readlink(linkPath);
          if (actual === expectedRel) {
            skipped++;
            continue;
          }
          await fs.unlink(linkPath);
          replacing = true;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            albumFailed = true;
            failedAlbums.push({ title: album.title, error: (err as NodeJS.ErrnoException).message });
            break;
          }
        }

        try {
          await fs.symlink(expectedRel, linkPath);
          if (replacing) fixed++; else symlinked++;
        } catch (err) {
          albumFailed = true;
          failedAlbums.push({ title: album.title, error: (err as NodeJS.ErrnoException).message });
          break;
        }
      }

      processedPhotos += album.photos.length;
      if (!albumFailed) {
        const pct = totalPhotos > 0 ? Math.round(processedPhotos / totalPhotos * 100) : 100;
        spinner.message(`Organizing… ${pct}% ${album.title}`);
      }
    });

    spinner.stop('Done.');

    const parts = [
      `${symlinked} symlinked`,
      fixed > 0 ? `${fixed} fixed` : null,
      `${skipped} already exist`,
      `${notDownloaded} not yet downloaded`,
    ].filter(Boolean).join(', ');
    clack.log.info(`${albums.length} albums — ${parts}.`);

    if (notDownloaded > 0) {
      clack.log.warn(
        `Run \`${lmpg('flee')}\` to download missing photos, then re-run \`${lmpg('organize')}\`.`,
      );
    }

    if (failedAlbums.length > 0) {
      clack.log.error(`${failedAlbums.length} album(s) failed to organize (symlink error):`);
      for (const { title, error } of failedAlbums) {
        clack.log.error(`  • ${title}: ${error}`);
      }
      process.exit(1);
    }

    clack.outro(`Albums written to ${path.join(outputDir, 'Albums')}`);
  });
