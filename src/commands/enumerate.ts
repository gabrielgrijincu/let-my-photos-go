import { Command } from 'commander';
import * as clack from '@clack/prompts';
import * as fs from 'fs';
import { launchHeadlessBrowser, saveSession } from '../browser.js';
import { getAuthPath } from '../paths.js';
import { enumerateAllMediaItems } from '../api.js';
import { upsertPhoto, getStats } from '../db.js';

export const enumerateCommand = new Command('enumerate')
  .description('Scan Google Photos and populate the local database with photo metadata')
  .option('-l, --limit <n>', 'Stop after this many photos (for testing)', parseInt)
  .action(async (options: { limit?: number }, cmd: Command) => {
    const profile: string | undefined = cmd.parent?.opts()?.profile;
    const lmpg = (subcmd: string) => (profile ? `lmpg -p ${profile} ${subcmd}` : `lmpg ${subcmd}`);
    clack.intro('🕊️  Let My Photos Go — Enumerate');

    if (!fs.existsSync(getAuthPath())) {
      clack.log.error(`No browser session found. Run \`${lmpg('auth')}\` first.`);
      process.exit(1);
    }

    const spinner = clack.spinner();
    spinner.start('Launching headless browser…');
    const { browser, context } = await launchHeadlessBrowser();
    spinner.stop('Browser ready.');

    spinner.start('Scanning your photos…');
    let apiCount = 0;
    try {
      for await (const item of enumerateAllMediaItems(context, n => {
        spinner.message(`Scanning your photos… (${n} found so far)`);
        apiCount = n;
      })) {
        const creationTime = item.creationTime ? new Date(item.creationTime).toISOString() : null;
        upsertPhoto(item.id, item.productUrl, creationTime, item.width, item.height);
        if (options.limit && apiCount >= options.limit) break;
      }
    } catch (err) {
      spinner.stop('Failed to scan photos.');
      clack.log.error(`API error: ${err instanceof Error ? err.message : String(err)}`);
      await browser.close();
      process.exit(1);
    }
    const { total } = getStats();
    const dupes = apiCount - total;
    spinner.stop(
      `Found and indexed ${total.toLocaleString()} photos.${dupes > 0 ? ` (${dupes.toLocaleString()} duplicates skipped)` : ''}`,
    );

    await saveSession(context);
    await browser.close();

    clack.outro(`Done. Run \`${lmpg('flee')}\` to download your photos.`);
  });
