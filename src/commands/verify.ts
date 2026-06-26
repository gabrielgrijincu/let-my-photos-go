import { Command } from 'commander';
import * as clack from '@clack/prompts';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getDb, markVerified, resetToPending, setCompanionPath, clearAllVerified } from '../db';
import type { PhotoRecord } from '../db';
import { readConfig } from '../config';
import { runWithConcurrency } from '../util';

type IssueReason =
  | 'missing'
  | 'empty'
  | 'corrupt'
  | 'stale-zip'
  | 'missing-companion'
  | 'empty-companion'
  | 'corrupt-companion';
interface Issue {
  record: PhotoRecord;
  reason: IssueReason;
}

const STILL_IMAGE_EXTS = new Set(['.heic', '.jpg', '.jpeg', '.png', '.gif', '.webp']);

const MAGIC_BYTES: Record<string, (b: Buffer) => boolean> = {
  '.jpg': b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  '.jpeg': b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  '.png': b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  '.gif': b => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,
  '.webp': b =>
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50,
  '.heic': b => b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70,
  // MOV/QuickTime files can start with ftyp (modern) or older atoms like wide, mdat, moov, free
  '.mov': b => {
    const type = String.fromCharCode(b[4], b[5], b[6], b[7]);
    return ['ftyp', 'wide', 'mdat', 'moov', 'free', 'skip', 'pnot'].includes(type);
  },
  '.mp4': b => b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70,
  '.m4v': b => b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70,
};

function absPath(stored: string, base: string): string {
  return path.isAbsolute(stored) ? stored : path.resolve(base, stored);
}

async function fileExists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

async function fileSize(p: string): Promise<number> {
  return fs.stat(p).then(s => s.size);
}

async function checkMagicBytes(filePath: string): Promise<boolean> {
  const ext = path.extname(filePath).toLowerCase();
  const checker = MAGIC_BYTES[ext];
  if (!checker) return true;
  const buf = Buffer.alloc(12);
  const fh = await fs.open(filePath, 'r');
  try {
    await fh.read(buf, 0, 12, 0);
  } finally {
    await fh.close();
  }
  return checker(buf);
}

export const verifyCommand = new Command('verify')
  .description('Check unverified downloaded photos and reset any broken records to pending for re-download')
  .option('--dry-run', 'Report issues without resetting broken records to pending')
  .option('--reset', 'Clear all verified_at timestamps so every downloaded photo is re-checked')
  .action(async (opts: { dryRun?: boolean; reset?: boolean }, cmd: Command) => {
    const profile: string | undefined = cmd.parent?.opts()?.profile;
    const lmpg = (subcmd: string) => (profile ? `lmpg -p ${profile} ${subcmd}` : `lmpg ${subcmd}`);
    clack.intro('🕊️  Let My Photos Go — Verify');

    const config = readConfig();
    const outputDir = config?.outputDir ?? '';

    let total: number;
    try {
      const db = getDb();

      if (opts.reset) {
        const cleared = clearAllVerified();
        clack.log.info(`Reset verification status for ${cleared.toLocaleString()} photo(s).`);
      }

      const downloaded = (
        db.prepare(`SELECT COUNT(*) as count FROM photos WHERE status = 'downloaded'`).get() as { count: number }
      ).count;
      if (downloaded === 0) {
        clack.log.info(`No downloaded photos to verify.`);
        return;
      }
      total = (
        db
          .prepare(`SELECT COUNT(*) as count FROM photos WHERE status = 'downloaded' AND verified_at IS NULL`)
          .get() as { count: number }
      ).count;
      if (total === 0) {
        clack.log.success(`All ${downloaded.toLocaleString()} downloaded photos already verified.`);
        return;
      }
    } catch {
      clack.log.info(`No database found yet. Run \`${lmpg('enumerate')}\` to scan your library first.`);
      return;
    }

    const spinner = clack.spinner();
    spinner.start(`Verifying ${total.toLocaleString()} unverified photos…`);
    try {
      let stopping = false;

      process.once('SIGINT', () => {
        stopping = true;
      });

      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on('data', (key: Buffer) => {
          const k = key.toString();
          if (k === '' || k === '') stopping = true;
        });
      }

      const issues: Issue[] = [];
      let checked = 0;
      const pendingBackfills: Array<{ mediaItemId: string; companionPath: string }> = [];
      const pendingVerifies: string[] = [];

      const db = getDb();
      const records = db
        .prepare(`SELECT * FROM photos WHERE status = 'downloaded' AND verified_at IS NULL`)
        .all() as PhotoRecord[];

      await runWithConcurrency(records, 20, async record => {
        if (stopping) return;
        checked++;
        spinner.message(`Verifying ${checked.toLocaleString()} / ${total.toLocaleString()}…`);

        const issuesBefore = issues.length;

        // --- stale zip ---
        if (record.dest_path?.endsWith('.zip')) {
          issues.push({ record, reason: 'stale-zip' });
          return;
        }

        // --- primary file ---
        if (!record.dest_path) {
          issues.push({ record, reason: 'missing' });
          return;
        }
        const absFile = absPath(record.dest_path, outputDir);
        if (!(await fileExists(absFile))) {
          issues.push({ record, reason: 'missing' });
          return;
        }
        const actualSize = await fileSize(absFile);
        if (actualSize === 0) {
          issues.push({ record, reason: 'empty' });
          return;
        }
        // --- companion discovery (before size check so combined size can be tested) ---
        let companionAbs = record.companion_path ? absPath(record.companion_path, outputDir) : null;

        if (!companionAbs && STILL_IMAGE_EXTS.has(path.extname(absFile).toLowerCase())) {
          const candidate = absFile.replace(/\.[^.]+$/, '.mov');
          if (await fileExists(candidate)) {
            companionAbs = candidate;
            pendingBackfills.push({
              mediaItemId: record.media_item_id,
              companionPath: path.relative(outputDir, candidate),
            });
          }
        }

        let companionExists = false;
        let companionSize = 0;
        if (companionAbs) {
          companionExists = await fileExists(companionAbs);
          if (companionExists) companionSize = await fileSize(companionAbs);
        }

        if (!(await checkMagicBytes(absFile))) {
          issues.push({ record, reason: 'corrupt' });
          return;
        }

        // --- companion checks ---
        if (companionAbs) {
          if (!companionExists) {
            issues.push({ record, reason: 'missing-companion' });
          } else if (companionSize === 0) {
            issues.push({ record, reason: 'empty-companion' });
          } else if (!(await checkMagicBytes(companionAbs))) {
            issues.push({ record, reason: 'corrupt-companion' });
          }
        }

        if (issues.length === issuesBefore) {
          pendingVerifies.push(record.media_item_id);
        }
      });

      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
      }

      // Apply writes after the iterator is closed (can't write while iterating)
      for (const { mediaItemId, companionPath } of pendingBackfills) {
        setCompanionPath(mediaItemId, companionPath);
      }
      for (const mediaItemId of pendingVerifies) {
        markVerified(mediaItemId);
      }

      spinner.stop(
        stopping
          ? `Stopped after ${checked.toLocaleString()} / ${total.toLocaleString()} photos.`
          : `Verified ${total.toLocaleString()} photos.`,
      );

      if (pendingBackfills.length > 0) {
        clack.log.info(`Backfilled companion path for ${pendingBackfills.length.toLocaleString()} Live Photo(s).`);
      }

      if (issues.length === 0) {
        clack.log.success(
          stopping
            ? `No issues found in the ${checked.toLocaleString()} photos checked.`
            : `All ${total.toLocaleString()} photos OK.`,
        );
        return;
      }

      for (const { record, reason } of issues) {
        const label =
          reason === 'missing'
            ? 'MISSING      '
            : reason === 'empty'
              ? 'EMPTY        '
              : reason === 'corrupt'
                ? 'CORRUPT      '
                : reason === 'stale-zip'
                  ? 'STALE ZIP    '
                  : reason === 'missing-companion'
                    ? 'NO COMPANION '
                    : reason === 'empty-companion'
                      ? 'EMPTY MOV    '
                      : 'CORRUPT MOV  ';
        clack.log.warn(`${label}  ${record.dest_path ?? `(no path) id=${record.media_item_id}`}`);
      }

      clack.log.error(`${issues.length.toLocaleString()} issue(s) found out of ${checked.toLocaleString()} checked.`);

      if (!opts.dryRun) {
        for (const { record } of issues) {
          resetToPending(record.media_item_id);
        }
        clack.log.success(
          `Reset ${issues.length.toLocaleString()} record(s) to pending. Run \`${lmpg('flee')}\` or \`${lmpg('flee-albums')}\` to re-download.`,
        );
      } else {
        clack.log.info(`Run \`${lmpg('verify')}\` (without --dry-run) to reset these records for re-download.`);
      }
    } catch (err) {
      spinner.stop('Error.');
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
      }
      clack.log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
