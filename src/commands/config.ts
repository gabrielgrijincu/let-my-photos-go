import { Command } from 'commander';
import * as clack from '@clack/prompts';
import { wrapAction } from '../util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readConfig, writeConfig } from '../config';
import { getAuthPath, ensureDataDir } from '../paths';

const DEFAULT_OUTPUT_DIR = path.join(os.homedir(), 'Pictures', 'let-my-photos-go');

export const configCommand = new Command('config')
  .description('Set up output directory for downloaded photos')
  .action(wrapAction(async (_: Record<string, never>, cmd: Command) => {
    const profile: string | undefined = cmd.parent?.opts()?.profile;
    const lmpg = (subcmd: string) => (profile ? `lmpg -p ${profile} ${subcmd}` : `lmpg ${subcmd}`);
    clack.intro('🕊️  Let My Photos Go — Config');

    ensureDataDir();

    const existing = readConfig();

    const outputDirInput = await clack.text({
      message: 'Output directory for downloaded photos:',
      initialValue: existing?.outputDir ?? DEFAULT_OUTPUT_DIR,
      validate: v => (v?.trim() ? undefined : 'Required'),
    });
    if (clack.isCancel(outputDirInput)) {
      clack.cancel('Cancelled.');
      process.exit(0);
    }

    const outputDir = (outputDirInput?.trim() ?? existing?.outputDir ?? DEFAULT_OUTPUT_DIR).replace(/^~/, os.homedir());

    writeConfig({ outputDir });
    fs.mkdirSync(outputDir, { recursive: true });
    clack.log.success(`Config saved. Photos will download to: ${outputDir}`);

    const authExists = fs.existsSync(getAuthPath());
    clack.outro(
      authExists
        ? `All set! Run \`${lmpg('enumerate')}\` to scan your library, then \`${lmpg('flee')}\` to download. 🎉`
        : `Next: run \`${lmpg('auth')}\` to log in to Google Photos.`,
    );
  }));
