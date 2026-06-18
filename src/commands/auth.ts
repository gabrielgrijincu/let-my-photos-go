import { Command } from 'commander';
import * as fs from 'fs';
import * as clack from '@clack/prompts';
import { launchHeadedBrowser, saveSession } from '../browser.js';
import { ensureDataDir, getAuthPath } from '../paths.js';

export const authCommand = new Command('auth')
  .description('Log in to Google Photos (saves browser session for downloads)')
  .action(async () => {
    clack.intro('🕊️  Let My Photos Go — Auth');

    ensureDataDir();

    const authPath = getAuthPath();
    if (fs.existsSync(authPath)) {
      clack.log.warn('An existing session was found in auth.json. Re-authenticating will overwrite it.');
      const confirm = await clack.confirm({ message: 'Continue and log in again?' });
      if (clack.isCancel(confirm) || !confirm) {
        clack.cancel('Aborted.');
        process.exit(0);
      }
    }

    clack.log.info('Opening a browser window. Log in to Google Photos, then come back here.');

    const spinner = clack.spinner();
    spinner.start('Launching browser…');
    const { browser, context } = await launchHeadedBrowser(fs.existsSync(authPath) ? authPath : undefined);
    const page = await context.newPage();
    spinner.stop('Browser launched.');

    await page.goto('https://photos.google.com');
    clack.log.step('Waiting for you to finish logging in…');

    try {
      await page.waitForURL('https://photos.google.com/**', { timeout: 5 * 60 * 1000 });
    } catch {
      clack.log.error('Timed out waiting for login. Please try again.');
      await browser.close();
      process.exit(1);
    }

    const saveSpinner = clack.spinner();
    saveSpinner.start('Saving session…');
    await saveSession(context);
    saveSpinner.stop('Session saved to auth.json');

    await browser.close();

    clack.outro('Logged in! Run `lmpg config` to configure your download settings.');
  });
