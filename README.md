# Let My Photos Go 🕊️

> _"Let my people go."_ — Moses, ca. 1446 BC  
> _"Let my photos go."_ — You, after discovering Google Takeout strips your GPS data.

---

## The Problem

You want your photos back. The real ones. With full EXIF data, GPS coordinates, and correct timestamps. But Google makes that surprisingly hard:

- **Google Takeout** gives you the files, but silently strips GPS coordinates and corrupts dates.
- **The Google Photos Library API** also strips GPS and doesn't serve original files — it serves transcoded versions.
- **[gphotosdl](https://github.com/gilesknap/gphotos-sync)** and friends are abandoned or broken.

## The Solution

`let-my-photos-go` bypasses all of this by automating the **Google Photos web interface** directly — just like you would if you sat down and downloaded each photo by hand, but at scale. Playwright drives a real Chromium browser that uses your actual Google session, so Google sees it as a normal user download and serves the original, untouched file.

The Google Photos API is used for **enumeration** (listing all your photos and their metadata), but authenticated via the same browser session — no Google Cloud project or API credentials required.

> [!WARNING]
> This tool relies on **undocumented Google Photos internals** — keyboard shortcuts, internal API token interception, and URL structure. Google can change any of these at any time without notice, which may silently break downloads.

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

### Step 3: Scan your library (`lmpg enumerate`)

```bash
lmpg enumerate
```

Launches a headless browser, calls the Google Photos internal API to list your entire library, and saves every photo's metadata (ID, creation time, dimensions, file size) to the local SQLite database. No files are downloaded yet.

```bash
lmpg enumerate --limit 10   # stop after 10 items (useful for testing)
lmpg enumerate -l 10        # shorthand
```

Re-running `enumerate` is safe and fast — it updates existing records (dimensions, file size) and adds any newly uploaded photos without touching download state.

### Step 4: Download everything (`lmpg flee`)

```bash
lmpg flee
```

Launches a headless browser with the saved session and downloads each pending photo by triggering the "Download original" action (Shift+D) in the Google Photos web UI.

Photos are organised into subdirectories by year and month:

```
~/Pictures/let-my-photos-go/
  2023/
    06/  IMG_4821.jpg
    11/  IMG_5103.heic
         IMG_5103.mov
  2024/
    01/  IMG_5209.jpg
```

**iPhone Live Photos** are downloaded as ZIP archives by Google Photos and are automatically extracted. The `.heic` (still image) and `.mov` (video) are saved side-by-side with the same base name. The pairing is preserved — Apple's Photos app links Live Photo pairs by an embedded UUID in both files, not by filename.

**Filesystem timestamps** (Finder's "Date Created" and "Date Modified") are set to the photo's original capture time from the Google Photos API, so they reflect when the photo was actually taken, not when it was downloaded.

Progress is checkpointed to `~/.let-my-photos-go/photos.db` (SQLite). If interrupted, just run `lmpg flee` again — already-downloaded photos are skipped automatically.

```bash
lmpg flee --failed-only          # only retry photos that previously failed
lmpg flee -f                     # shorthand

lmpg flee --year 2023            # only photos from 2023
lmpg flee -y 2023                # shorthand

lmpg flee --from 2022-06         # photos from June 2022 onwards
lmpg flee --to 2023-12-31        # photos up to end of 2023
lmpg flee --from 2022 --to 2023  # date range

lmpg flee --media-type photo     # photos only, skip videos
lmpg flee --media-type video     # videos only
lmpg flee -m photo               # shorthand

lmpg flee --limit 10             # download at most 10 (useful for testing)
lmpg flee -l 10                  # shorthand

lmpg flee --concurrency 5        # 5 parallel downloads (default: 3)
lmpg flee -c 5                   # shorthand

lmpg flee --inspect              # headed browser with DevTools (for debugging)
```

> **Concurrency note:** The default of 3 is conservative on purpose. Values above 5–6 risk triggering Google's rate limiting or anti-automation detection, especially during multi-hour runs.

### Step 5: Check progress (`lmpg status`)

```bash
lmpg status
```

Shows total photos found, how many are downloaded, pending, and failed.

### Step 6: Verify your downloads (`lmpg verify`)

```bash
lmpg verify
```

Checks every downloaded file in the database and automatically resets broken records to pending so `lmpg flee` can re-download them:

- **Exists on disk** — catches missing files
- **Non-empty** — catches zero-byte files
- **Size matches** — compares actual size against Google's reported size (when available)
- **Magic bytes** — checks the file header matches the extension (catches truncated or corrupt downloads)
- **Companion .mov** — verifies Live Photo pairs are intact

```bash
lmpg verify --dry-run   # report issues without resetting records
```

---

## Profiles

Use `--profile` (or `-p`) to maintain separate databases, configs, and auth sessions — useful for multiple Google accounts:

```bash
lmpg -p work auth
lmpg -p work config
lmpg -p work enumerate
lmpg -p work flee

lmpg -p personal auth
lmpg -p personal flee
```

Each profile stores its data in `~/.let-my-photos-go-<name>/` instead of `~/.let-my-photos-go/`.

---

## How It Works

| Concern               | Method                                                                        |
| --------------------- | ----------------------------------------------------------------------------- |
| Listing your photos   | Google Photos Library API, authenticated via browser session token            |
| Downloading originals | Playwright browser (Shift+D) — serves unmodified originals with full EXIF/GPS |

1. **`lmpg auth`** saves a Playwright session to `~/.let-my-photos-go/auth.json`.
2. **`lmpg enumerate`** intercepts the Bearer token the Google Photos web app uses internally, then calls the `mediaItems.list` API with it to enumerate your library and populate the local SQLite database.
3. **`lmpg flee`** opens each photo in the browser and presses Shift+D to trigger the original-file download. Each file is saved to `<outputDir>/YYYY/MM/filename` and marked in SQLite. Duplicate filenames in the same month get a `_2`, `_3` suffix. iPhone Live Photos (downloaded as ZIPs) are extracted into a `.heic` + `.mov` pair with matching base names. Filesystem timestamps are set to the photo's original capture time.

---

## Data Directory

All persistent state lives in `~/.let-my-photos-go/` (or `~/.let-my-photos-go-<profile>/` for named profiles):

| File          | Purpose                                     |
| ------------- | ------------------------------------------- |
| `auth.json`   | Playwright browser session (Google cookies) |
| `config.json` | Output directory                            |
| `photos.db`   | SQLite download checkpoint database         |

`auth.json` contains your Google session cookies — treat it like a password. It is never in your project directory and never committed to git.

---

## Session Expiry

Google rotates session cookies aggressively — a multi-day download job will likely require re-authenticating at least once. `lmpg flee` detects an expired session mid-run, stops gracefully, and tells you what to do:

```bash
lmpg auth   # log in again
lmpg flee   # continue from where it left off
```

---

## Commands

| Command                               | Short | Description                                              |
| ------------------------------------- | ----- | -------------------------------------------------------- |
| `lmpg auth`                           |       | Log in to Google Photos (saves browser session)          |
| `lmpg config`                         |       | Set output directory                                     |
| `lmpg enumerate`                      |       | Scan library and populate database                       |
| `lmpg enumerate --limit <n>`          | `-l`  | Stop after n items (testing)                             |
| `lmpg flee`                           |       | Download all pending photos                              |
| `lmpg flee --failed-only`             | `-f`  | Only retry previously failed photos                      |
| `lmpg flee --year <year>`             | `-y`  | Filter by year                                           |
| `lmpg flee --from <date> --to <date>` |       | Filter by date range (YYYY, YYYY-MM, or YYYY-MM-DD)      |
| `lmpg flee --media-type photo\|video` | `-m`  | Filter by media type                                     |
| `lmpg flee --limit <n>`               | `-l`  | Cap number of downloads                                  |
| `lmpg flee --concurrency <n>`         | `-c`  | Parallel downloads (default: 3)                          |
| `lmpg flee --inspect`                 |       | Headed browser with DevTools                             |
| `lmpg status`                         |       | Show download progress                                   |
| `lmpg verify`                         |       | Check all downloaded files and reset broken records      |
| `lmpg verify --dry-run`               |       | Report issues only, do not reset records                 |
| `lmpg -p <name> <command>`            | `-p`  | Use a named profile (separate auth, DB, and config)      |
| `lmpg -v`                             |       | Print version                                            |

---

## License

MIT
