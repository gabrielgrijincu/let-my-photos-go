import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

let _profile: string | undefined;

export function setProfile(name: string | undefined): void {
  _profile = name;
}

export function getDataDir(): string {
  return _profile
    ? path.join(os.homedir(), `.let-my-photos-go-${_profile}`)
    : path.join(os.homedir(), '.let-my-photos-go');
}

export function getAuthPath(): string {
  return path.join(getDataDir(), 'auth.json');
}
export function getConfigPath(): string {
  return path.join(getDataDir(), 'config.json');
}
export function getDbPath(): string {
  return path.join(getDataDir(), 'photos.db');
}

export function ensureDataDir(): void {
  fs.mkdirSync(getDataDir(), { recursive: true });
}
