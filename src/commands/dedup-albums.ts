import { Command } from 'commander';
import * as clack from '@clack/prompts';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';
import { getDb } from '../db.js';
import { readConfig } from '../config.js';
import { runWithConcurrency } from '../util.js';

type Pair = {
  media_item_id: string;
  dest_path: string;
  filename: string;
  companion_path: string | null;
  t_id: string;
  t_dest: string;
  t_filename: string;
  t_companion: string | null;
};

function sha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export const dedupAlbumsCommand = new Command('dedup-albums')
  .description('Find album-source files that are byte-identical to a timeline file and remove the duplicate')
  .option('--fix', 'Actually delete files and redirect DB records (default: dry run)')
  .action(async (opts: { fix?: boolean }, cmd: Command) => {
    const profile: string | undefined = cmd.parent?.opts()?.profile;
    const lmpg = (subcmd: string) => (profile ? `lmpg -p ${profile} ${subcmd}` : `lmpg ${subcmd}`);
    clack.intro('🕊️  Let My Photos Go — Dedup Albums');

    const config = readConfig();
    if (!config?.outputDir) {
      clack.log.error(`No output directory configured. Run \`${lmpg('config')}\` first.`);
      process.exit(1);
    }
    const outputDir = config.outputDir;

    if (!opts.fix) {
      clack.log.info('Dry run — pass --fix to actually delete files and update the database.');
    }

    const db = getDb();

    const candidates = db.prepare(`
      SELECT
        a.media_item_id,  a.dest_path,  a.filename,  a.companion_path,
        t.media_item_id AS t_id,
        t.dest_path     AS t_dest,
        t.filename      AS t_filename,
        t.companion_path AS t_companion
      FROM photos a
      JOIN photos t
        ON  t.creation_time       = a.creation_time
        AND LOWER(t.filename)    = LOWER(a.filename)
        AND t.source             = 'timeline'
        AND t.status             = 'downloaded'
        AND t.dest_path          IS NOT NULL
      WHERE a.source    = 'album'
        AND a.status    = 'downloaded'
        AND a.dest_path IS NOT NULL
        AND a.dest_path != t.dest_path
      GROUP BY a.media_item_id
    `).all() as Pair[];

    if (candidates.length === 0) {
      clack.log.success('No candidate duplicates found.');
      clack.outro('Done.');
      return;
    }

    clack.log.info(`Found ${candidates.length} candidate pair(s) with matching creation_time — hashing…`);

    const spinner = clack.spinner();
    spinner.start('Hashing files…');

    let matched = 0;
    let mismatch = 0;
    let skipped = 0;
    let errors = 0;
    let processed = 0;

    const updateStmt = db.prepare(`
      UPDATE photos
      SET dest_path = ?, filename = ?, companion_path = ?
      WHERE media_item_id = ?
    `);

    await runWithConcurrency(candidates, 8, async (pair) => {
      const albumAbs = path.resolve(outputDir, pair.dest_path);
      const timelineAbs = path.resolve(outputDir, pair.t_dest);

      if (!fs.existsSync(timelineAbs)) {
        clack.log.warn(`SKIP  ${pair.dest_path} — timeline copy missing on disk`);
        skipped++;
      } else if (!fs.existsSync(albumAbs)) {
        clack.log.warn(`SKIP  ${pair.dest_path} — album file missing on disk`);
        skipped++;
      } else {
        try {
          const albumSize = fs.statSync(albumAbs).size;
          const timelineSize = fs.statSync(timelineAbs).size;
          if (albumSize !== timelineSize) {
            mismatch++;
          } else {
            const [albumHash, timelineHash] = await Promise.all([sha256(albumAbs), sha256(timelineAbs)]);
            if (albumHash !== timelineHash) {
              mismatch++;
            } else {
              matched++;
              if (!opts.fix) {
                clack.log.info(`WOULD DELETE  ${pair.dest_path}  (kept: ${pair.t_dest})`);
              } else {
                fs.unlinkSync(albumAbs);
                if (pair.companion_path) {
                  try { fs.unlinkSync(path.resolve(outputDir, pair.companion_path)); } catch { /* best effort */ }
                }
                updateStmt.run(pair.t_dest, pair.t_filename, pair.t_companion ?? null, pair.media_item_id);
              }
            }
          }
        } catch (err) {
          clack.log.error(`ERROR  ${pair.dest_path}: ${(err as Error).message}`);
          errors++;
        }
      }

      processed++;
      const pct = Math.round(processed / candidates.length * 100);
      spinner.message(`Hashing… ${pct}% ${pair.dest_path}`);
    });

    spinner.stop('Done hashing.');

    const verb = opts.fix ? 'Deleted' : 'Would delete';
    clack.log.info(
      `${verb} ${matched} duplicate(s), ${mismatch} hash mismatch(es) kept, ${skipped} skipped (missing file), ${errors} error(s).`,
    );

    if (!opts.fix && matched > 0) {
      clack.log.info(`Re-run with --fix to apply.`);
    }
    if (opts.fix && matched > 0) {
      clack.log.info(`Run \`${lmpg('organize')}\` to rebuild album symlinks pointing to the deduplicated files.`);
    }

    clack.outro('Done.');
  });
