import * as fs from 'fs';
import { CONFIG_PATH } from './paths.js';

export interface Config {
  outputDir: string;
}

export function readConfig(): Config | null {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as Config;
  } catch {
    return null;
  }
}

export function writeConfig(config: Config): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}
