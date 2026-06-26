import { Command } from 'commander';
import * as fs from 'fs';
import * as clack from '@clack/prompts';
import { wrapAction } from '../util';
import type { Response } from 'playwright';
import { launchHeadedBrowser, saveSession } from '../browser';
import { ensureDataDir, getAuthPath, getConfigPath } from '../paths';
import { readConfig } from '../config';
import { findRpcInner } from '../api';

export const authCommand = new Command('auth')
  .description('Log in to Google Photos (saves browser session for downloads)')
  .option('--fresh', 'start with a blank browser session instead of reusing the saved one')
  .action(wrapAction(async (options: { fresh?: boolean }, cmd: Command) => {
    const profile: string | undefined = cmd.parent?.opts()?.profile;
    const lmpg = (subcmd: string) => (profile ? `lmpg -p ${profile} ${subcmd}` : `lmpg ${subcmd}`);
    clack.intro('🕊️  Let My Photos Go — Auth');

    ensureDataDir();

    const authPath = getAuthPath();
    if (fs.existsSync(authPath) && !options.fresh) {
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
    const useExisting = fs.existsSync(authPath) && !options.fresh;
    const { browser, context } = await launchHeadedBrowser(useExisting ? authPath : undefined);
    const page = await context.newPage();
    spinner.stop('Browser launched.');

    // Capture the permanent numeric Google user ID and auth token from the O3G8Nd RPC,
    // which fires automatically when the main photos.google.com page loads.
    let resolveIdentity!: (id: { userId: string; userToken: string } | null) => void;
    const identityCapture = new Promise<{ userId: string; userToken: string } | null>(r => {
      resolveIdentity = r;
    });

    const onResponse = (response: Response) => {
      if (!response.url().includes('batchexecute')) return;
      if (!(new URL(response.url()).searchParams.get('rpcids') ?? '').includes('O3G8Nd')) return;
      response
        .text()
        .then(text => {
          try {
            const inner = findRpcInner(text, 'O3G8Nd') as unknown[][];
            const userToken = inner[0]?.[0];
            const userId = inner[0]?.[1];
            if (typeof userId === 'string' && /^\d+$/.test(userId) && typeof userToken === 'string')
              resolveIdentity({ userId, userToken });
          } catch {}
        })
        .catch(() => {});
    };
    context.on('response', onResponse);

    await page.goto('https://photos.google.com');
    clack.log.step('Waiting for you to finish logging in…');

    try {
      await page.waitForURL('https://photos.google.com/**', { timeout: 5 * 60 * 1000 });
    } catch {
      clack.log.error('Timed out waiting for login. Please try again.');
      await browser.close();
      process.exit(1);
    }

    const identity = await Promise.race([identityCapture, new Promise<null>(r => setTimeout(() => r(null), 10_000))]);
    context.off('response', onResponse);

    const saveSpinner = clack.spinner();
    saveSpinner.start('Saving session…');
    await saveSession(context);
    if (identity) {
      try {
        let raw: Record<string, unknown> = {};
        try {
          raw = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8')) as Record<string, unknown>;
        } catch {}
        raw.googleUserId = identity.userId;
        raw.googleUserToken = identity.userToken;
        fs.writeFileSync(getConfigPath(), JSON.stringify(raw, null, 2));
      } catch {}
    }
    saveSpinner.stop('Session saved to auth.json');

    await browser.close();

    const configExists = !!readConfig();
    clack.outro(
      configExists
        ? `Logged in! Run \`${lmpg('enumerate')}\` to scan your library.`
        : `Logged in! Run \`${lmpg('config')}\` to configure your download settings, then \`${lmpg('enumerate')}\` to scan your library.`,
    );
  }));
