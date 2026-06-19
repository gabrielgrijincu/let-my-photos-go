import { Command } from 'commander';
import * as clack from '@clack/prompts';
import * as fs from 'fs';
import * as path from 'path';
import { readConfig } from '../config.js';
import { getOrganizeData } from '../db.js';

function sanitizeTitle(title: string): string {
  return title.replace(/[/\\:*?"<>|]/g, '-').trim();
}

function symlinkRelative(target: string, linkPath: string): void {
  const rel = path.relative(path.dirname(linkPath), target);
  fs.symlinkSync(rel, linkPath);
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

    const albums = getOrganizeData();
    if (albums.length === 0) {
      clack.log.error(`No album data found. Run \`${lmpg('enumerate-albums')}\` first.`);
      process.exit(1);
    }

    const spinner = clack.spinner();
    spinner.start('Organizing albums…');

    let symlinked = 0;
    let skipped = 0;
    let notDownloaded = 0;

    for (const album of albums) {
      const safeTitle = sanitizeTitle(album.title);
      const albumDir = path.join(outputDir, 'Albums', safeTitle);
      fs.mkdirSync(albumDir, { recursive: true });

      notDownloaded += album.totalInAlbum - album.photos.length;

      // Track filenames used within this album to handle collisions
      const usedNames = new Set<string>();

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

        if (fs.existsSync(linkPath)) {
          skipped++;
          continue;
        }

        try {
          symlinkRelative(src, linkPath);
          symlinked++;
        } catch {
          // Fallback to copy if symlinks fail
          fs.copyFileSync(src, linkPath);
          symlinked++;
        }
      }

      spinner.message(`Organizing… ${album.title}`);
    }

    spinner.stop('Done.');

    clack.log.info(
      `${albums.length} albums — ${symlinked} symlinked, ${skipped} already exist, ${notDownloaded} not yet downloaded.`,
    );

    if (notDownloaded > 0) {
      clack.log.warn(
        `Run \`${lmpg('flee')}\` to download missing photos, then re-run \`${lmpg('organize')}\`.`,
      );
    }

    clack.outro(`Albums written to ${path.join(outputDir, 'Albums')}`);
  });
