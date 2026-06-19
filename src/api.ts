import type { BrowserContext, Request } from 'playwright';

export interface MediaItem {
  id: string;
  productUrl: string;
  creationTime: number | null; // Unix ms timestamp
  width: number | null;
  height: number | null;
}

export interface AlbumMember {
  token: string;   // stable per-user auth token (AF1Qip…)
  userId: string;  // numeric Google user ID
  displayName: string | null;
}

export interface Album {
  albumId: string;
  title: string;
  viewToken: string;
  photoCount: number;
  members: AlbumMember[]; // all members including the logged-in user
}

export interface PhotoSample {
  mediaItemId: string;
  uploaderToken: string | null; // uploader auth token from snAcKc photo[6][0]
  creationTime: number | null;  // ms timestamp from snAcKc photo[2]
}

export interface BatchParams {
  sid: string;
  bl: string;
  at: string;
  hl: string;
}

export async function extractBatchParams(context: BrowserContext): Promise<BatchParams> {
  return new Promise((resolve, reject) => {
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        context.off('request', onRequest);
        reject(new Error('Timed out waiting for a Google Photos session. Run `lmpg auth` to log in.'));
      }
    }, 30_000);

    const onRequest = (request: Request) => {
      if (resolved) return;
      const url = request.url();
      if (!url.includes('/_/PhotosUi/data/batchexecute')) return;

      const params = new URL(url).searchParams;
      const sid = params.get('f.sid');
      const bl = params.get('bl');
      const hl = params.get('hl') ?? 'en';

      const body = request.postData() ?? '';
      const atMatch = body.match(/(?:^|&)at=([^&]+)/);

      if (sid && bl && atMatch) {
        resolved = true;
        clearTimeout(timer);
        context.off('request', onRequest);
        resolve({ sid, bl, at: decodeURIComponent(atMatch[1]), hl });
      }
    };

    context.on('request', onRequest);

    context
      .newPage()
      .then(page => {
        page
          .goto('https://photos.google.com', { waitUntil: 'networkidle', timeout: 28_000 })
          .catch(() => {})
          .finally(() => page.close().catch(() => {}));
      })
      .catch(reject);
  });
}

// Generic helper: finds the wrb.fr entry for any RPC key across all chunks.
export function findRpcInner(text: string, rpcKey: string): unknown[] {
  const prefixEnd = text.indexOf('\n\n');
  const body = prefixEnd >= 0 ? text.slice(prefixEnd + 2) : text;
  const chunks = body.split(/\n\d+\n/).map(c => c.replace(/^\d+\n/, ''));

  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    try {
      const outer = JSON.parse(chunk) as Array<unknown[]>;
      const entry = outer.find(
        (e): e is [string, string, string] => Array.isArray(e) && e[0] === 'wrb.fr' && e[1] === rpcKey,
      );
      if (entry) {
        const inner = JSON.parse(entry[2]);
        if (!Array.isArray(inner)) throw new Error(`Unexpected inner type for ${rpcKey}: ${typeof inner}`);
        return inner as unknown[];
      }
    } catch {
      // try next chunk
    }
  }
  throw new Error(`${rpcKey} RPC entry not found in batchexecute response`);
}

function parseBatchResponse(text: string): {
  items: unknown[][];
  continuationToken: string | null;
  lastTimestamp: string | null;
} {
  // Strip )]}'\n\n anti-hijacking prefix
  const prefixEnd = text.indexOf('\n\n');
  const body = prefixEnd >= 0 ? text.slice(prefixEnd + 2) : text;

  // Response is SIZE\nJSON\nSIZE\nJSON\n... — split on \nNUM\n boundaries
  const firstChunk = body.split(/\n\d+\n/)[0].replace(/^\d+\n/, '');

  const outer = JSON.parse(firstChunk) as Array<unknown[]>;
  const lcxiM = outer.find(
    (e): e is [string, string, string] => Array.isArray(e) && e[0] === 'wrb.fr' && e[1] === 'lcxiM',
  );
  if (!lcxiM) throw new Error('Expected lcxiM RPC entry not found in batchexecute response');

  const inner = JSON.parse(lcxiM[2]);
  if (!Array.isArray(inner)) {
    throw new Error(
      `Unexpected batchexecute inner response (type=${typeof inner}): ${JSON.stringify(inner)?.slice(0, 300)}`,
    );
  }
  return {
    items: (Array.isArray(inner[0]) ? inner[0] : []) as unknown[][],
    continuationToken: (inner[1] as string | null) ?? null,
    lastTimestamp: (inner[2] as string | null) ?? null,
  };
}

export async function* enumerateAllMediaItems(
  context: BrowserContext,
  onProgress?: (count: number) => void,
): AsyncGenerator<MediaItem> {
  const params = await extractBatchParams(context);

  let lastTimestamp: string | null = null;
  let hasMore = true;
  let totalFetched = 0;

  while (hasMore) {
    // Position [2] must always be null — the HAR confirms the continuation token
    // from the response is informational only and never echoed back in requests.
    // Position [1] is the timestamp cursor: Date.now() for first page,
    // then last photo's timestamp + 1 for subsequent pages.
    const ts = lastTimestamp !== null ? Number(lastTimestamp) + 1 : Date.now();
    const innerJson = JSON.stringify([null, ts, null, null, 1, 1, null]);

    const freqBody = JSON.stringify([[['lcxiM', innerJson, null, 'generic']]]);

    const url = new URL('https://photos.google.com/_/PhotosUi/data/batchexecute');
    url.searchParams.set('rpcids', 'lcxiM');
    url.searchParams.set('source-path', '/');
    url.searchParams.set('f.sid', params.sid);
    url.searchParams.set('bl', params.bl);
    url.searchParams.set('hl', params.hl);
    url.searchParams.set('soc-app', '165');
    url.searchParams.set('soc-platform', '1');
    url.searchParams.set('soc-device', '1');
    url.searchParams.set('rt', 'c');

    const response = await context.request.post(url.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
        'X-Same-Domain': '1',
        Origin: 'https://photos.google.com',
        Referer: 'https://photos.google.com/',
      },
      form: {
        'f.req': freqBody,
        at: params.at,
      },
    });

    if (!response.ok()) {
      throw new Error(`batchexecute failed (${response.status()}): ${await response.text()}`);
    }

    const { items, continuationToken: nextToken, lastTimestamp: nextTs } = parseBatchResponse(await response.text());

    for (const item of items) {
      const arr = item as unknown[];
      const id = arr[0] as string;
      const meta = Array.isArray(arr[1]) ? (arr[1] as unknown[]) : null;
      const creationTime = arr[2] as number | null;

      totalFetched++;
      onProgress?.(totalFetched);

      yield {
        id,
        productUrl: `https://photos.google.com/photo/${id}`,
        creationTime: creationTime ?? null,
        width: meta ? ((meta[1] as number | null) ?? null) : null,
        height: meta ? ((meta[2] as number | null) ?? null) : null,
      };
    }

    lastTimestamp = nextTs;
    hasMore = items.length > 0 && nextToken !== null;
  }
}

function makeBatchUrl(params: BatchParams, rpcids: string, sourcePath: string): string {
  const url = new URL('https://photos.google.com/_/PhotosUi/data/batchexecute');
  url.searchParams.set('rpcids', rpcids);
  url.searchParams.set('source-path', sourcePath);
  url.searchParams.set('f.sid', params.sid);
  url.searchParams.set('bl', params.bl);
  url.searchParams.set('hl', params.hl);
  url.searchParams.set('soc-app', '165');
  url.searchParams.set('soc-platform', '1');
  url.searchParams.set('soc-device', '1');
  url.searchParams.set('rt', 'c');
  return url.toString();
}

const BATCH_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
  'X-Same-Domain': '1',
  Origin: 'https://photos.google.com',
};

// RPC F2A0H: paginated list of all albums with full member identity.
// album[1]=title, album[3]=photoCount, album[6]=albumId, album[7]=viewToken
// album[9]=members array: member[0]=token, member[1]=userId, member[11]=[displayName,...]
export async function* enumerateAllAlbums(context: BrowserContext, params: BatchParams): AsyncGenerator<Album> {
  let continuationToken: string | null = null;

  while (true) {
    const payload = continuationToken ? [continuationToken, null, 2] : [null, null, 2];
    const freqBody = JSON.stringify([[['F2A0H', JSON.stringify(payload), null, 'generic']]]);

    const response = await context.request.post(makeBatchUrl(params, 'F2A0H', '/albums'), {
      headers: { ...BATCH_HEADERS, Referer: 'https://photos.google.com/albums' },
      form: { 'f.req': freqBody, at: params.at },
    });
    if (!response.ok()) throw new Error(`F2A0H failed (${response.status()}): ${await response.text()}`);

    const inner = findRpcInner(await response.text(), 'F2A0H') as unknown[][];
    const albums = (Array.isArray(inner[0]) ? inner[0] : []) as unknown[][];
    const nextToken = (inner[1] as unknown as string | null) ?? null;

    for (const album of albums) {
      const a = album as unknown[];
      const membersRaw = (Array.isArray(a[9]) ? a[9] : []) as unknown[][];
      const members: AlbumMember[] = membersRaw.map(m => {
        const ma = m as unknown[];
        const nameArr = Array.isArray(ma[11]) ? (ma[11] as unknown[]) : null;
        return {
          token: ma[0] as string,
          userId: ma[1] as string,
          displayName: nameArr ? (nameArr[0] as string | null) : null,
        };
      });
      const title = a[1] as string | null;
      if (title === null) continue; // type-4 chat-shared photos — not real albums
      yield {
        albumId: a[6] as string,
        title,
        photoCount: a[3] as number,
        viewToken: a[7] as string,
        members,
      };
    }

    if (nextToken === null || albums.length === 0) break;
    continuationToken = nextToken;
  }
}

// RPC snAcKc: all photos in an album with per-photo uploader token at photo[6][0].
// Paginates until all photos are returned.
export async function fetchAlbumPhotoSamples(
  context: BrowserContext,
  params: BatchParams,
  album: Album,
): Promise<PhotoSample[]> {
  const samples: PhotoSample[] = [];
  let continuationToken: string | null = null;

  while (true) {
    const payload = [album.albumId, continuationToken, null, album.viewToken];
    const freqBody = JSON.stringify([[['snAcKc', JSON.stringify(payload), null, 'generic']]]);

    const response = await context.request.post(makeBatchUrl(params, 'snAcKc', `/share/${album.albumId}`), {
      headers: { ...BATCH_HEADERS, Referer: `https://photos.google.com/share/${album.albumId}` },
      form: { 'f.req': freqBody, at: params.at },
    });
    if (!response.ok()) return samples;

    const inner = findRpcInner(await response.text(), 'snAcKc') as unknown[][];
    const photos = (Array.isArray(inner[1]) ? inner[1] : []) as unknown[][];
    const nextToken = (inner[2] as unknown as string | null) ?? null;

    for (const photo of photos) {
      const p = photo as unknown[];
      const mediaItemId = p[0] as string;
      const creationTime = (p[2] as number | null) ?? null;
      const uploaderArr = Array.isArray(p[6]) ? (p[6] as unknown[]) : null;
      const uploaderToken = uploaderArr ? (uploaderArr[0] as string | null) : null;
      samples.push({ mediaItemId, uploaderToken, creationTime });
    }

    if (!nextToken || photos.length === 0) break;
    continuationToken = nextToken;
  }

  return samples;
}

// RPC snAcKc: paginated list of mediaItemIds within a single album.
export async function* enumerateAlbumItems(
  context: BrowserContext,
  params: BatchParams,
  album: Album,
): AsyncGenerator<string> {
  let continuationToken: string | null = null;

  while (true) {
    const payload = [album.albumId, continuationToken, null, album.viewToken];
    const freqBody = JSON.stringify([[['snAcKc', JSON.stringify(payload), null, 'generic']]]);

    const response = await context.request.post(makeBatchUrl(params, 'snAcKc', `/share/${album.albumId}`), {
      headers: { ...BATCH_HEADERS, Referer: `https://photos.google.com/share/${album.albumId}` },
      form: { 'f.req': freqBody, at: params.at },
    });
    if (!response.ok()) throw new Error(`snAcKc failed (${response.status()}): ${await response.text()}`);

    const inner = findRpcInner(await response.text(), 'snAcKc');
    const photos = (Array.isArray(inner[1]) ? inner[1] : []) as unknown[][];
    const nextToken = (inner[2] as string) ?? '';

    for (const photo of photos) {
      yield (photo as unknown[])[0] as string;
    }

    if (!nextToken || photos.length === 0) break;
    continuationToken = nextToken;
  }
}
