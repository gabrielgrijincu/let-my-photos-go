import { chromium, Browser, BrowserContext } from 'playwright';
import { AUTH_PATH } from './paths.js';

export { AUTH_PATH };

export async function launchHeadedBrowser(storageState?: string): Promise<{ browser: Browser; context: BrowserContext }> {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext(storageState ? { storageState } : {});
  return { browser, context };
}

export async function launchHeadlessBrowser(opts: { inspect?: boolean } = {}): Promise<{ browser: Browser; context: BrowserContext }> {
  const browser = await chromium.launch({
    headless: !opts.inspect,
  });
  const context = await browser.newContext({ storageState: AUTH_PATH });
  return { browser, context };
}

export async function saveSession(context: BrowserContext): Promise<void> {
  await context.storageState({ path: AUTH_PATH });
}

export async function isSessionValid(context: BrowserContext): Promise<boolean> {
  const page = await context.newPage();
  try {
    await page.goto('https://photos.google.com', { waitUntil: 'networkidle', timeout: 15000 });
    const url = page.url();
    return url.startsWith('https://photos.google.com') && !url.includes('accounts.google.com');
  } catch {
    return false;
  } finally {
    await page.close();
  }
}
