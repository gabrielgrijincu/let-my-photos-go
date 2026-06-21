import { Command } from 'commander';
import * as clack from '@clack/prompts';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getDb } from '../db.js';
import { readConfig } from '../config.js';

async function walk(dir: string, entries: string[]): Promise<void> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await walk(full, entries);
    } else {
      entries.push(full);
    }
  }
}

export const scrubCommand = new Command('scrub')
  .description('Find and delete files on disk that have no matching record in the database')
  .option('--dry-run', 'Preview what would be deleted without making any changes')
  .action(async (opts: { dryRun?: boolean }, cmd: Command) => {
    const profile: string | undefined = cmd.parent?.opts()?.profile;
    const lmpg = (subcmd: string) => (profile ? `lmpg -p ${profile} ${subcmd}` : `lmpg ${subcmd}`);
    clack.intro('🕊️  Let My Photos Go — Scrub');

    const config = readConfig();
    if (!config?.outputDir) {
      clack.log.error(`No output directory configured. Run \`${lmpg('config')}\` first.`);
      process.exit(1);
    }
    const outputDir = config.outputDir;

    if (opts.dryRun) {
      clack.log.info('Dry run — no files will be deleted.');
    }

    const spinner = clack.spinner();
    spinner.start('Loading known paths from database…');

    const db = getDb();
    const rows = db.prepare(`
      SELECT dest_path, companion_path FROM photos
      WHERE dest_path IS NOT NULL
    `).all() as { dest_path: string; companion_path: string | null }[];

    const known = new Set<string>();
    let companionCount = 0;
    for (const row of rows) {
      known.add(row.dest_path);
      if (row.companion_path) { known.add(row.companion_path); companionCount++; }
    }

    spinner.message('Scanning files on disk…');

    const allFiles: string[] = [];
    try {
      for (const entry of await fs.readdir(outputDir, { withFileTypes: true })) {
        if (entry.name === 'Albums') continue;
        const full = path.join(outputDir, entry.name);
        if (entry.isDirectory()) {
          await walk(full, allFiles);
        } else if (!entry.isSymbolicLink()) {
          allFiles.push(full);
        }
      }
    } catch (err) {
      spinner.stop('Error scanning disk.');
      clack.log.error((err as Error).message);
      process.exit(1);
    }

    spinner.stop(
      `Scanned ${allFiles.length.toLocaleString()} files on disk — DB knows ${rows.length.toLocaleString()} photos + ${companionCount.toLocaleString()} Live Photo companions.`,
    );

    const orphans = allFiles.filter(f => !known.has(path.relative(outputDir, f)));

    if (orphans.length === 0) {
      clack.log.success('No orphaned files found — output directory is clean.');
      clack.outro('Done.');
      return;
    }

    clack.log.warn(`Found ${orphans.length.toLocaleString()} orphaned file(s):`);
    for (const f of orphans) {
      clack.log.warn(`  ${path.relative(outputDir, f)}`);
    }

    if (!opts.dryRun) {
      let deleted = 0;
      let errors = 0;
      const dirs = new Set<string>();
      for (const f of orphans) {
        try {
          await fs.unlink(f);
          deleted++;
          dirs.add(path.dirname(f));
        } catch (err) {
          clack.log.error(`ERROR  ${path.relative(outputDir, f)}: ${(err as Error).message}`);
          errors++;
        }
      }

      // Remove empty directories, deepest first
      const sortedDirs = [...dirs].sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
      let removedDirs = 0;
      for (const dir of sortedDirs) {
        if (dir === outputDir) continue;
        try {
          await fs.rmdir(dir);
          removedDirs++;
        } catch {
          // not empty or already gone — fine
        }
      }

      clack.log.success(
        `Deleted ${deleted} orphaned file(s)${removedDirs > 0 ? `, removed ${removedDirs} empty folder(s)` : ''}${errors > 0 ? `, ${errors} error(s)` : ''}.`,
      );
    } else {
      clack.log.info(`Re-run without --dry-run to delete them.`);
    }

    clack.outro('Done.');
  });
