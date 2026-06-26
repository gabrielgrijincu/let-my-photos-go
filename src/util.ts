import * as path from 'path';
import { Command } from 'commander';

export function wrapAction<O extends object>(
  fn: (opts: O, cmd: Command) => Promise<void>,
): (opts: O, cmd: Command) => void {
  return (opts, cmd) => {
    fn(opts, cmd).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`\nError: ${msg}\n`);
      if (process.env.DEBUG && err instanceof Error && err.stack) {
        process.stderr.write(err.stack + '\n');
      }
      process.exit(1);
    });
  };
}

export function buildFilename(date: Date | null, filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const stem = path.basename(filename, path.extname(filename));
  if (!date || isNaN(date.getTime())) return `${stem}${ext}`;
  const DD = String(date.getUTCDate()).padStart(2, '0');
  const HH = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${DD}.${HH}.${mm}.${ss} - ${stem}${ext}`;
}

export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  async function next(): Promise<void> {
    while (i < items.length) {
      const item = items[i++];
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
}
