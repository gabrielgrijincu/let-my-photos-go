import { Command } from 'commander';
import * as clack from '@clack/prompts';
import * as fs from 'fs';
import { launchHeadlessBrowser, saveSession } from '../browser.js';
import { getAuthPath } from '../paths.js';
import { enumerateAllMediaItems } from '../api.js';
import { upsertPhoto } from '../db.js';

export const enumerateCommand = new Command('enumerate')
  .description('Scan Google Photos and populate the local database with photo metadata')
  .option('-l, --limit <n>', 'Stop after this many photos (for testing)', parseInt)
  .action(async (options: { limit?: number }) => {
    clack.intro('🕊️  Let My Photos Go — Enumerate');

    if (!fs.existsSync(getAuthPath())) {
      clack.log.error('No browser session found. Run `lmpg auth` first.');
      process.exit(1);
    }

    const spinner = clack.spinner();
    spinner.start('Launching headless browser…');
    const { browser, context } = await launchHeadlessBrowser();
    spinner.stop('Browser ready.');

    spinner.start('Scanning your photos…');
    let enumCount = 0;
    try {
      for await (const item of enumerateAllMediaItems(context, n => {
        spinner.message(`Scanning your photos… (${n} found so far)`);
        enumCount = n;
      })) {
        const creationTime = item.creationTime ? new Date(item.creationTime).toISOString() : null;
        upsertPhoto(item.id, item.productUrl, creationTime, item.width, item.height, item.expectedSize);
        if (options.limit && enumCount >= options.limit) break;
      }
    } catch (err) {
      spinner.stop('Failed to scan photos.');
      clack.log.error(`API error: ${err instanceof Error ? err.message : String(err)}`);
      await browser.close();
      process.exit(1);
    }
    spinner.stop(`Found and indexed ${enumCount.toLocaleString()} photos.`);

    await saveSession(context);
    await browser.close();

    clack.outro('Done. Run `lmpg flee` to download.');
  });
