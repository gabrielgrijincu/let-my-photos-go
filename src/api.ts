import type { BrowserContext } from 'playwright';

export interface MediaItem {
  id: string;
  filename: string;
  productUrl: string;
  baseUrl: string;
  mimeType: string;
  mediaMetadata: {
    creationTime: string;
    width: string;
    height: string;
    photo?: Record<string, unknown>;
    video?: Record<string, unknown>;
  };
}

interface MediaItemsResponse {
  mediaItems?: MediaItem[];
  nextPageToken?: string;
}

export async function extractSessionToken(context: BrowserContext): Promise<string> {
  return new Promise(async (resolve, reject) => {
    const page = await context.newPage();

    const timer = setTimeout(() => {
      page.close().catch(() => {});
      reject(new Error(
        'Timed out waiting for a session token from the browser.\n' +
        'Make sure you are logged in — run `lmpg auth` if needed.'
      ));
    }, 30_000);

    page.on('request', request => {
      const auth = request.headers()['authorization'];
      if (auth?.startsWith('Bearer ') && request.url().includes('googleapis.com')) {
        clearTimeout(timer);
        page.close().catch(() => {});
        resolve(auth.slice(7));
      }
    });

    await page.goto('https://photos.google.com', { waitUntil: 'domcontentloaded' }).catch(reject);
  });
}

export async function* enumerateAllMediaItems(
  context: BrowserContext,
  onProgress?: (count: number) => void
): AsyncGenerator<MediaItem> {
  let token = await extractSessionToken(context);
  let pageToken: string | undefined;
  let totalFetched = 0;

  do {
    const params = new URLSearchParams({ pageSize: '100' });
    if (pageToken) params.set('pageToken', pageToken);

    const response = await fetch(
      `https://photoslibrary.googleapis.com/v1/mediaItems?${params}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    // Re-extract token and retry once on 401 (session token expired mid-enumeration)
    if (response.status === 401) {
      token = await extractSessionToken(context);
      continue;
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Google Photos API error ${response.status}: ${body}`);
    }

    const data: MediaItemsResponse = await response.json();

    for (const item of data.mediaItems ?? []) {
      totalFetched++;
      onProgress?.(totalFetched);
      yield item;
    }

    pageToken = data.nextPageToken;
  } while (pageToken);
}
