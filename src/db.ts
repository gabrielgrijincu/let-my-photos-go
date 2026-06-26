import Database from 'better-sqlite3';
import { getDbPath } from './paths';

export type PhotoStatus = 'pending' | 'downloaded' | 'failed';
export type PhotoSource = 'timeline' | 'album';

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
  width: number | null;
  height: number | null;
  created_at: string;
  verified_at: string | null;
}

export interface PhotoFilter {
  failedOnly?: boolean;
  limit?: number;
  source?: PhotoSource;
}

let _db: Database.Database | null = null;
let _dbPath: string | null = null;

export function getDb(): Database.Database {
  const currentPath = getDbPath();
  if (!_db || _dbPath !== currentPath) {
    _db = new Database(currentPath);
    _dbPath = currentPath;
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
  if (!cols.includes('creation_time')) db.exec(`ALTER TABLE photos ADD COLUMN creation_time TEXT`);
  if (!cols.includes('dest_path')) db.exec(`ALTER TABLE photos ADD COLUMN dest_path TEXT`);
  if (!cols.includes('mime_type')) db.exec(`ALTER TABLE photos ADD COLUMN mime_type TEXT`);
  if (!cols.includes('companion_path')) db.exec(`ALTER TABLE photos ADD COLUMN companion_path TEXT`);
  if (!cols.includes('width')) db.exec(`ALTER TABLE photos ADD COLUMN width INTEGER`);
  if (!cols.includes('height')) db.exec(`ALTER TABLE photos ADD COLUMN height INTEGER`);
  if (!cols.includes('verified_at')) db.exec(`ALTER TABLE photos ADD COLUMN verified_at TEXT`);
  if (!cols.includes('source')) db.exec(`ALTER TABLE photos ADD COLUMN source TEXT NOT NULL DEFAULT 'timeline'`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS albums (
      album_id      TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      photo_count   INTEGER NOT NULL DEFAULT 0,
      enumerated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS album_photos (
      album_id        TEXT NOT NULL,
      media_item_id   TEXT NOT NULL,
      uploader_token  TEXT,
      PRIMARY KEY (album_id, media_item_id)
    )
  `);
}

export function upsertPhoto(
  mediaItemId: string,
  googleUrl: string | null,
  creationTime: string | null,
  width: number | null = null,
  height: number | null = null,
): void {
  const db = getDb();
  db.prepare(
    `
    INSERT INTO photos (media_item_id, google_url, creation_time, width, height)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (media_item_id) DO UPDATE SET
      google_url = excluded.google_url,
      creation_time = excluded.creation_time,
      width = excluded.width,
      height = excluded.height
  `,
  ).run(mediaItemId, googleUrl, creationTime, width, height);
}

export function markDownloaded(mediaItemId: string, destPath: string, filename: string, companionPath?: string): void {
  const db = getDb();
  db.prepare(
    `
    UPDATE photos
    SET status = 'downloaded', downloaded_at = datetime('now'), dest_path = ?, filename = ?, companion_path = ?
    WHERE media_item_id = ?
  `,
  ).run(destPath, filename, companionPath ?? null, mediaItemId);
}

export function markFailed(mediaItemId: string): void {
  const db = getDb();
  db.prepare(`UPDATE photos SET status = 'failed' WHERE media_item_id = ?`).run(mediaItemId);
}

export function clearAllVerified(): number {
  const db = getDb();
  return (db.prepare(`UPDATE photos SET verified_at = NULL WHERE verified_at IS NOT NULL`).run() as { changes: number })
    .changes;
}

export function markVerified(mediaItemId: string): void {
  const db = getDb();
  db.prepare(`UPDATE photos SET verified_at = datetime('now') WHERE media_item_id = ?`).run(mediaItemId);
}

export function resetToPending(mediaItemId: string): void {
  const db = getDb();
  db.prepare(
    `
    UPDATE photos
    SET status = 'pending', dest_path = NULL, downloaded_at = NULL, filename = '', companion_path = NULL, verified_at = NULL
    WHERE media_item_id = ?
  `,
  ).run(mediaItemId);
}

export function setCompanionPath(mediaItemId: string, companionPath: string): void {
  const db = getDb();
  db.prepare(`UPDATE photos SET companion_path = ? WHERE media_item_id = ?`).run(companionPath, mediaItemId);
}

export function getDestPathOwner(destPath: string): string | null {
  const db = getDb();
  const row = db.prepare(`SELECT media_item_id FROM photos WHERE dest_path = ?`).get(destPath) as
    | { media_item_id: string }
    | undefined;
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

  if (filter.source) {
    conditions.push('source = ?');
    params.push(filter.source);
  }

  let sql = `SELECT * FROM photos WHERE ${conditions.join(' AND ')} ORDER BY creation_time ASC`;
  if (filter.limit) {
    sql += ` LIMIT ?`;
    params.push(filter.limit);
  }

  return db.prepare(sql).all(...params) as PhotoRecord[];
}

export function upsertAlbum(albumId: string, title: string, photoCount: number): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO albums (album_id, title, photo_count, enumerated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT (album_id) DO UPDATE SET title = excluded.title, photo_count = excluded.photo_count, enumerated_at = excluded.enumerated_at`,
  ).run(albumId, title, photoCount);
}

export function upsertAlbumPhotos(
  albumId: string,
  photos: { mediaItemId: string; uploaderToken: string | null }[],
): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(`DELETE FROM album_photos WHERE album_id = ?`).run(albumId);
    const insert = db.prepare(
      `INSERT OR IGNORE INTO album_photos (album_id, media_item_id, uploader_token) VALUES (?, ?, ?)`,
    );
    for (const s of photos) insert.run(albumId, s.mediaItemId, s.uploaderToken);
  })();
}

export function ensurePhotoRecord(mediaItemId: string, creationTime: string | null): void {
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO photos (media_item_id, creation_time, source) VALUES (?, ?, 'album')`).run(
    mediaItemId,
    creationTime,
  );
}

export function upsertAlbumPhoto(mediaItemId: string, googleUrl: string, creationTime: string | null): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO photos (media_item_id, google_url, creation_time, source)
     VALUES (?, ?, ?, 'album')
     ON CONFLICT (media_item_id) DO UPDATE SET
       google_url = excluded.google_url
     WHERE photos.status IN ('pending', 'failed')`,
  ).run(mediaItemId, googleUrl, creationTime);
}

export interface AlbumPhotoRow {
  albumId: string;
  albumTitle: string;
  mediaItemId: string;
  status: PhotoStatus;
  dest_path: string | null;
  filename: string | null;
  google_url: string | null;
  creation_time: string | null;
}

export function getAlbumPhotosForFlee(): AlbumPhotoRow[] {
  return getDb()
    .prepare(
      `
    SELECT a.album_id      AS albumId,
           a.title         AS albumTitle,
           p.media_item_id AS mediaItemId,
           p.status,
           p.dest_path,
           p.filename,
           p.google_url,
           p.creation_time
    FROM albums a
    JOIN album_photos ap ON ap.album_id = a.album_id
    JOIN photos p ON p.media_item_id = ap.media_item_id
    ORDER BY a.title, p.creation_time, p.media_item_id
  `,
    )
    .all() as AlbumPhotoRow[];
}

export function getStats(): { total: number; downloaded: number; failed: number; pending: number } {
  const db = getDb();
  const rows = db.prepare(`SELECT status, COUNT(*) as count FROM photos GROUP BY status`).all() as {
    status: string;
    count: number;
  }[];
  const stats = { total: 0, downloaded: 0, failed: 0, pending: 0 };
  for (const row of rows) {
    stats.total += row.count;
    if (row.status === 'downloaded') stats.downloaded = row.count;
    else if (row.status === 'failed') stats.failed = row.count;
    else if (row.status === 'pending') stats.pending = row.count;
  }
  return stats;
}
