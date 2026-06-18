import { Command } from 'commander';
import * as clack from '@clack/prompts';
import * as fs from 'fs';
import { getDb, resetToPending } from '../db.js';
import type { PhotoRecord } from '../db.js';

type IssueReason = 'missing' | 'empty' | 'stale-zip';
interface Issue { record: PhotoRecord; reason: IssueReason }

export const verifyCommand = new Command('verify')
  .description('Check all downloaded photos exist on disk and are non-empty')
  .option('--fix', 'Reset broken records to pending so `flee --resume` can re-download them')
  .action((opts: { fix?: boolean }) => {
    clack.intro('🕊️  Let My Photos Go — Verify');

    let total: number;
    try {
      const db = getDb();
      total = (db.prepare(`SELECT COUNT(*) as count FROM photos WHERE status = 'downloaded'`).get() as { count: number }).count;
    } catch {
      clack.log.info('No database found yet. Run `lmpg flee` to start downloading.');
      clack.outro('');
      return;
    }

    if (total === 0) {
      clack.log.info('No downloaded photos to verify.');
      clack.outro('');
      return;
    }

    const spinner = clack.spinner();
    spinner.start(`Verifying ${total.toLocaleString()} downloaded photos…`);

    const issues: Issue[] = [];
    let checked = 0;

    const db = getDb();
    for (const record of db.prepare(`SELECT * FROM photos WHERE status = 'downloaded'`).iterate() as Iterable<PhotoRecord>) {
      checked++;
      if (checked % 1000 === 0) {
        spinner.message(`Verifying ${checked.toLocaleString()} / ${total.toLocaleString()}…`);
      }

      if (!record.dest_path || !fs.existsSync(record.dest_path)) {
        issues.push({ record, reason: 'missing' });
        continue;
      }
      if (fs.statSync(record.dest_path).size === 0) {
        issues.push({ record, reason: 'empty' });
      }
    }

    spinner.stop(`Verified ${total.toLocaleString()} photos.`);

    // Second pass: records that were marked downloaded but still point at a .zip
    for (const record of db.prepare(
      `SELECT * FROM photos WHERE status = 'downloaded' AND dest_path LIKE '%.zip'`
    ).iterate() as Iterable<PhotoRecord>) {
      issues.push({ record, reason: 'stale-zip' });
    }

    if (issues.length === 0) {
      clack.log.success(`All ${total.toLocaleString()} photos OK.`);
      clack.outro('');
      return;
    }

    for (const { record, reason } of issues) {
      const label =
        reason === 'missing'   ? 'MISSING  ' :
        reason === 'stale-zip' ? 'STALE ZIP' :
                                 'EMPTY    ';
      clack.log.warn(`${label}  ${record.dest_path ?? `(no path) id=${record.media_item_id}`}`);
    }

    clack.log.error(`${issues.length.toLocaleString()} issue(s) found out of ${total.toLocaleString()} checked.`);

    if (opts.fix) {
      for (const { record } of issues) {
        resetToPending(record.media_item_id);
      }
      clack.log.success(`Reset ${issues.length.toLocaleString()} record(s) to pending. Run \`lmpg flee --resume\` to re-download.`);
    } else {
      clack.log.info('Run `lmpg verify --fix` to reset broken records for re-download.');
    }

    clack.outro('');
  });
