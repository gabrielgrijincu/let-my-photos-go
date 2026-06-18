import { chromium, Browser, BrowserContext } from 'playwright';
import { getAuthPath } from './paths.js';

export async function launchHeadedBrowser(
  storageState?: string,
): Promise<{ browser: Browser; context: BrowserContext }> {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext(storageState ? { storageState } : {});
  return { browser, context };
}

export async function launchHeadlessBrowser(
  opts: { inspect?: boolean } = {},
): Promise<{ browser: Browser; context: BrowserContext }> {
  const browser = await chromium.launch({
    headless: !opts.inspect,
    // args: opts.inspect ? ['--auto-open-devtools-for-tabs'] : [],
  });
  const context = await browser.newContext({ storageState: getAuthPath() });
  return { browser, context };
}

export async function saveSession(context: BrowserContext): Promise<void> {
  await context.storageState({ path: getAuthPath() });
}

export async function isSessionValid(context: BrowserContext): Promise<boolean> {
  // Cookie check — no navigation, no flaky URL assertions
  const cookies = await context.cookies(['https://google.com', 'https://photos.google.com']);
  return cookies.some(c => ['SID', 'SSID', '__Secure-3PSID', 'SAPISID'].includes(c.name));
}
