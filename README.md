# Let My Photos Go 🕊️

> *"Let my people go."* — Moses, ca. 1446 BC  
> *"Let my photos go."* — You, after discovering Google Takeout strips your GPS data.

---

## The Problem

You want your photos back. The real ones. With full EXIF data, GPS coordinates, and correct timestamps. But Google makes that surprisingly hard:

- **Google Takeout** gives you the files, but silently strips GPS coordinates and corrupts dates.
- **The Google Photos Library API** also strips GPS and doesn't serve original files — it serves transcoded versions.
- **[gphotosdl](https://github.com/gilesknap/gphotos-sync)** and friends are abandoned or broken.

## The Solution

`let-my-photos-go` bypasses all of this by automating the **Google Photos web interface** directly — just like you would if you sat down and downloaded each photo by hand, but at scale. Playwright drives a real Chromium browser that uses your actual Google session, so Google sees it as a normal user download and serves the original, untouched file.

The Google Photos API is used for **enumeration** (listing all your photos and their metadata), but authenticated via the same browser session — no Google Cloud project or API credentials required.

---

## Prerequisites

Node.js and a Playwright Chromium browser:

```bash
yarn install
npx playwright install chromium
```

---

## Installation

```bash
# From npm (once published)
npm install -g let-my-photos-go
npx playwright install chromium
```

Or run directly from source:

```bash
git clone https://github.com/gabrielgrijincu/let-my-photos-go
cd let-my-photos-go
yarn install
npx playwright install chromium
yarn build
yarn link  # makes `lmpg` available globally
```

---

## Usage

### Step 1: Log in to Google Photos (`lmpg auth`)

```bash
lmpg auth
```

Opens a visible Chromium browser window and navigates to `https://photos.google.com`. Log in to your Google account normally. Once you're in, come back to the terminal — the session is saved to `~/.let-my-photos-go/auth.json`.

### Step 2: Set output directory (`lmpg config`)

```bash
lmpg config
```

Prompts for the directory where photos will be downloaded (default: `~/Pictures/let-my-photos-go`). That's it — no API credentials needed.

### Step 3: Download everything (`lmpg flee`)

```bash
lmpg flee
```

Launches a headless browser with the saved session, enumerates all your photos, then downloads each one by triggering the "Download original" action (Shift+D) in the Google Photos web UI.

Photos are organised into subdirectories by year and month:

```
~/Pictures/let-my-photos-go/
  2023/
    06/  IMG_4821.jpg
    11/  IMG_5103.heic
  2024/
    01/  IMG_5209.jpg
```

Progress is checkpointed to `~/.let-my-photos-go/photos.db` (SQLite). If interrupted, just run again — already-downloaded photos are skipped.

```bash
lmpg flee --resume          # skip re-enumeration if DB already has entries
lmpg flee --year 2023       # only photos from 2023
lmpg flee --from 2022-06    # photos from June 2022 onwards
lmpg flee --media-type photo # photos only, skip videos
lmpg flee --limit 10        # download at most 10 (useful for testing)
lmpg flee --concurrency 5   # 5 parallel downloads (default: 3)
lmpg flee --inspect         # headed browser with DevTools (for debugging)
```

### Step 4: Check progress (`lmpg status`)

```bash
lmpg status
```

Shows total photos found, how many are downloaded, pending, and failed.

---

## How It Works

| Concern | Method |
|---|---|
| Listing your photos | Google Photos Library API, authenticated via browser session token |
| Downloading originals | Playwright browser (Shift+D) — serves unmodified originals with full EXIF/GPS |

1. **`lmpg auth`** saves a Playwright session to `~/.let-my-photos-go/auth.json`.
2. **`lmpg flee`** intercepts the Bearer token the Google Photos web app uses internally, then calls the `mediaItems.list` API with it to enumerate your library. Downloads go through the browser session directly.
3. Each file is saved to `<outputDir>/YYYY/MM/filename` and marked in SQLite. Re-runs skip completed photos. Duplicate filenames in the same month get a `_2`, `_3` suffix.

---

## Data Directory

All persistent state lives in `~/.let-my-photos-go/`:

| File | Purpose |
|---|---|
| `auth.json` | Playwright browser session (Google cookies) |
| `config.json` | Output directory |
| `photos.db` | SQLite download checkpoint database |

`auth.json` contains your Google session cookies — treat it like a password. It is never in your project directory and never committed to git.

---

## Session Expiry

`auth.json` expires periodically. When `lmpg flee` detects an invalid session, it will tell you to run `lmpg auth` again.

---

## Commands

| Command | Description |
|---|---|
| `lmpg auth` | Log in to Google Photos (saves browser session) |
| `lmpg config` | Set output directory |
| `lmpg flee [options]` | Enumerate and download all photos |
| `lmpg flee --resume` | Skip re-enumeration; skip already-downloaded photos |
| `lmpg flee --failed-only` | Only retry previously failed photos |
| `lmpg flee --year <year>` | Filter by year |
| `lmpg flee --from <date> --to <date>` | Filter by date range |
| `lmpg flee --media-type photo\|video` | Filter by media type |
| `lmpg flee --limit <n>` | Cap number of downloads |
| `lmpg flee --concurrency <n>` | Parallel downloads (default: 3) |
| `lmpg flee --inspect` | Headed browser with DevTools |
| `lmpg status` | Show download progress |
| `lmpg -v` | Print version |

---

## License

MIT
