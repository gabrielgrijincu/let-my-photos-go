import * as fs from 'fs';
import { getConfigPath } from './paths.js';

export interface Config {
  outputDir: string;
}

export function readConfig(): Config | null {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8')) as Config;
  } catch {
    return null;
  }
}

export function writeConfig(config: Config): void {
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}
