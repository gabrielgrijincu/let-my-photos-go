import * as path from 'path';

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
