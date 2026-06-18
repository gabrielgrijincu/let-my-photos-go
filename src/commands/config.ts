import { Command } from 'commander';
import * as clack from '@clack/prompts';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readConfig, writeConfig } from '../config.js';
import { getAuthPath, ensureDataDir } from '../paths.js';

const DEFAULT_OUTPUT_DIR = path.join(os.homedir(), 'Pictures', 'let-my-photos-go');

export const configCommand = new Command('config')
  .description('Set up output directory for downloaded photos')
  .action(async () => {
    clack.intro('🕊️  Let My Photos Go — Config');

    ensureDataDir();

    const existing = readConfig();

    const outputDirInput = await clack.text({
      message: 'Output directory for downloaded photos:',
      initialValue: existing?.outputDir ?? DEFAULT_OUTPUT_DIR,
      validate: (v) => (v?.trim() ? undefined : 'Required'),
    });
    if (clack.isCancel(outputDirInput)) { clack.cancel('Cancelled.'); process.exit(0); }

    const outputDir = (outputDirInput?.trim() ?? existing?.outputDir ?? DEFAULT_OUTPUT_DIR)
      .replace(/^~/, os.homedir());

    writeConfig({ outputDir });
    fs.mkdirSync(outputDir, { recursive: true });
    clack.log.success(`Config saved. Photos will download to: ${outputDir}`);

    const authExists = fs.existsSync(getAuthPath());
    clack.outro(authExists
      ? 'All set! Run `lmpg flee` to start downloading your photos. 🎉'
      : 'Next: run `lmpg auth` to log in to Google Photos.'
    );
  });
