import Database from 'better-sqlite3';
import { DB_PATH } from './paths.js';

export type PhotoStatus = 'pending' | 'downloaded' | 'failed';

export interface PhotoRecord {
  media_item_id: string;
  filename: string;
  mime_type: string | null;
  status: PhotoStatus;
  downloaded_at: string | null;
  google_url: string | null;
  creation_time: string | null;
  dest_path: string | null;
  companion_path: string | null;
  created_at: string;
}

export interface PhotoFilter {
  failedOnly?: boolean;
  from?: Date;
  to?: Date;
  mimeTypePrefix?: string;
  limit?: number;
}

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    migrate(_db);
  }
  return _db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS photos (
      media_item_id TEXT PRIMARY KEY,
      filename TEXT NOT NULL DEFAULT '',
      mime_type TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      downloaded_at TEXT,
      google_url TEXT,
      creation_time TEXT,
      dest_path TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const cols = (db.prepare(`PRAGMA table_info(photos)`).all() as { name: string }[]).map(r => r.name);
  if (!cols.includes('creation_time'))  db.exec(`ALTER TABLE photos ADD COLUMN creation_time TEXT`);
  if (!cols.includes('dest_path'))      db.exec(`ALTER TABLE photos ADD COLUMN dest_path TEXT`);
  if (!cols.includes('mime_type'))      db.exec(`ALTER TABLE photos ADD COLUMN mime_type TEXT`);
  if (!cols.includes('companion_path')) db.exec(`ALTER TABLE photos ADD COLUMN companion_path TEXT`);
}

export function upsertPhoto(
  mediaItemId: string,
  googleUrl: string | null,
  creationTime: string | null,
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO photos (media_item_id, google_url, creation_time)
    VALUES (?, ?, ?)
    ON CONFLICT (media_item_id) DO NOTHING
  `).run(mediaItemId, googleUrl, creationTime);
}

export function markDownloaded(mediaItemId: string, destPath: string, filename: string, companionPath?: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE photos
    SET status = 'downloaded', downloaded_at = datetime('now'), dest_path = ?, filename = ?, companion_path = ?
    WHERE media_item_id = ?
  `).run(destPath, filename, companionPath ?? null, mediaItemId);
}

export function markFailed(mediaItemId: string): void {
  const db = getDb();
  db.prepare(`UPDATE photos SET status = 'failed' WHERE media_item_id = ?`).run(mediaItemId);
}

export function resetToPending(mediaItemId: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE photos
    SET status = 'pending', dest_path = NULL, downloaded_at = NULL, filename = '', companion_path = NULL
    WHERE media_item_id = ?
  `).run(mediaItemId);
}

export function setCompanionPath(mediaItemId: string, companionPath: string): void {
  const db = getDb();
  db.prepare(`UPDATE photos SET companion_path = ? WHERE media_item_id = ?`).run(companionPath, mediaItemId);
}

export function getDestPathOwner(destPath: string): string | null {
  const db = getDb();
  const row = db.prepare(`SELECT media_item_id FROM photos WHERE dest_path = ?`).get(destPath) as { media_item_id: string } | undefined;
  return row?.media_item_id ?? null;
}

export function hasAnyPhotos(): boolean {
  const db = getDb();
  const row = db.prepare(`SELECT COUNT(*) as count FROM photos`).get() as { count: number };
  return row.count > 0;
}

export function getPendingPhotos(filter: PhotoFilter = {}): PhotoRecord[] {
  const db = getDb();
  const conditions: string[] = [filter.failedOnly ? `status = 'failed'` : `status != 'downloaded'`];
  const params: unknown[] = [];

  if (filter.from) {
    conditions.push('creation_time >= ?');
    params.push(filter.from.toISOString());
  }
  if (filter.to) {
    conditions.push('creation_time < ?');
    params.push(filter.to.toISOString());
  }
  if (filter.mimeTypePrefix) {
    conditions.push('mime_type LIKE ?');
    params.push(`${filter.mimeTypePrefix}%`);
  }

  let sql = `SELECT * FROM photos WHERE ${conditions.join(' AND ')} ORDER BY creation_time ASC`;
  if (filter.limit) {
    sql += ` LIMIT ?`;
    params.push(filter.limit);
  }

  return db.prepare(sql).all(...params) as PhotoRecord[];
}

export function getStats(): { total: number; downloaded: number; failed: number; pending: number } {
  const db = getDb();
  const rows = db.prepare(`SELECT status, COUNT(*) as count FROM photos GROUP BY status`).all() as { status: string; count: number }[];
  const stats = { total: 0, downloaded: 0, failed: 0, pending: 0 };
  for (const row of rows) {
    stats.total += row.count;
    if (row.status === 'downloaded') stats.downloaded = row.count;
    else if (row.status === 'failed') stats.failed = row.count;
    else if (row.status === 'pending') stats.pending = row.count;
  }
  return stats;
}
