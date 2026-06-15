import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

export const DATA_DIR    = path.join(os.homedir(), '.let-my-photos-go');
export const AUTH_PATH   = path.join(DATA_DIR, 'auth.json');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
export const DB_PATH     = path.join(DATA_DIR, 'photos.db');

export function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
