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

## Installation

```bash
npm install -g let-my-photos-go
```

The Chromium browser is downloaded automatically during install.

---

## Usage

### Step 1: Log in to Google Photos (`lmpg auth`)

```bash
lmpg auth
```

Opens a visible Chromium browser window and navigates to `https://photos.google.com`. Log in to your Google account normally. Once you're in, come back to the terminal — the session is saved to `~/.let-my-photos-go/auth.json`.

```bash
lmpg auth --fresh   # start with a blank browser session instead of reusing the saved one
```

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

Re-running `enumerate` is safe and fast — it updates existing records (dimensions, file size) and adds any newly uploaded photos without touching download state.

### Step 4: Download your timeline (`lmpg flee`)

```bash
lmpg flee
```

Launches a headless browser with the saved session and downloads each pending **timeline** photo by triggering the "Download original" action (Shift+D) in the Google Photos web UI.

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

Checks every **unverified** downloaded file and reports any problems. Already-verified photos are skipped, so repeated runs are fast — only newly downloaded photos are checked each time.

- **Exists on disk** — catches missing files
- **Non-empty** — catches zero-byte files
- **Magic bytes** — checks the file header matches the extension (catches truncated or corrupt downloads)
- **Companion .mov** — verifies Live Photo pairs are intact

By default, `verify` automatically resets broken records to pending so they can be re-downloaded. Add `--dry-run` to report issues without making any changes:

```bash
lmpg verify --dry-run   # report issues only, no changes
lmpg verify --reset     # clear all verified_at timestamps so every downloaded photo is re-checked
```

After verifying, run `lmpg flee` (for timeline photos) or `lmpg flee-albums` (for album photos) to re-download any reset records.

### Optional: Enumerate albums (`lmpg enumerate-albums`)

```bash
lmpg enumerate-albums
```

Scans your Google Photos albums and saves album membership to the database. Safe to re-run — adds new albums and photos without touching download state.

```bash
lmpg enumerate-albums          # only include photos you uploaded (default)
lmpg enumerate-albums --owned  # same as above, explicit
lmpg enumerate-albums --all    # also include photos uploaded by others in shared albums
```

### Optional: Download and organise by album (`lmpg flee-albums`)

```bash
lmpg flee-albums
```

Downloads album photos directly into per-album subfolders inside `albums/`. Run `enumerate-albums` first.

- **Photos already downloaded by `flee`** (timeline photos) are **symlinked** into the album folder — no file is duplicated on disk.
- **Album-only photos** (photos in a shared album you never saved to your library) are downloaded directly into the album folder.
- A photo that appears in **multiple albums** is downloaded or symlinked once; every other album gets a symlink pointing at that first copy.

```
~/Pictures/let-my-photos-go/
  albums/
    Egypt 2021/
      28.14.35.22 - IMG_0089.heic -> ../../2021/03/28.14.35.22 - IMG_0089.heic
      28.14.35.22 - IMG_0092.mov  -> ../../2021/03/28.14.35.22 - IMG_0092.mov
    Shared trip/
      15.09.22.00 - photo_from_friend.jpg   ← downloaded here (not in your timeline)
      28.14.35.22 - IMG_0089.heic -> ../../2021/03/28.14.35.22 - IMG_0089.heic
  2021/
    03/  28.14.35.22 - IMG_0089.heic
         28.14.35.22 - IMG_0092.mov
```

Re-running `flee-albums` is safe — symlinks that already point to the right file are skipped, and only photos not yet downloaded are fetched.

```bash
lmpg flee-albums --failed-only   # only retry photos that previously failed
lmpg flee-albums -f              # shorthand

lmpg flee-albums --concurrency 5 # parallel downloads per album (default: 3)
lmpg flee-albums -c 5            # shorthand

lmpg flee-albums --inspect       # headed browser with DevTools (for debugging)
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
3. **`lmpg flee`** opens each **timeline** photo in the browser and presses Shift+D to trigger the original-file download. Each file is saved to `<outputDir>/YYYY/MM/filename` and marked in SQLite. Duplicate filenames in the same month get a `_2`, `_3` suffix. iPhone Live Photos (downloaded as ZIPs) are extracted into a `.heic` + `.mov` pair with matching base names. Filesystem timestamps are set to the photo's original capture time.
4. **`lmpg enumerate-albums`** scans your albums and saves membership to the database.
5. **`lmpg flee-albums`** downloads album-only photos directly into `<outputDir>/albums/<title>/` and creates symlinks there for timeline photos already on disk.

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

Google rotates session cookies aggressively — a multi-day download job will likely require re-authenticating at least once. Both `lmpg flee` and `lmpg flee-albums` detect an expired session mid-run, stop gracefully, and tell you what to do:

```bash
lmpg auth          # log in again
lmpg flee          # continue timeline downloads from where it left off
lmpg flee-albums   # continue album downloads from where it left off
```

---

## Known quirks

### Enumerate count vs your Android library count

`lmpg enumerate` may report more photos than the total shown in the Google Photos Android app. Two reasons:

- **Pagination duplicates** — the Google Photos timeline API occasionally returns the same item on consecutive pages (a pagination overlap artifact). These are deduplicated in the database automatically; `enumerate` reports them as "(N duplicates skipped)".
- **Archived and shared-album items** — photos you've archived, or photos you've saved from a shared album to your library, appear in the API timeline but may not be counted in Android's main library view.

### `lmpg flee` says "nothing to do" despite enumerate reporting a higher count

If `lmpg enumerate` reports more items than `lmpg status` shows as the database total, those extras are pagination duplicates (see above) — they were returned by the API more than once but only stored once. `lmpg flee` operates on the database, so the behaviour is correct.

---

## Commands

| Command                                | Short | Description                                              |
| -------------------------------------- | ----- | -------------------------------------------------------- |
| `lmpg auth`                            |       | Log in to Google Photos (saves browser session)          |
| `lmpg auth --fresh`                    |       | Start with a blank browser session                       |
| `lmpg config`                          |       | Set output directory                                     |
| `lmpg enumerate`                       |       | Scan library and populate database                       |
| `lmpg enumerate-albums`                |       | Scan albums and save membership to database              |
| `lmpg enumerate-albums --all`          |       | Include photos uploaded by others in shared albums       |
| `lmpg flee`                            |       | Download all pending timeline photos                     |
| `lmpg flee --failed-only`              | `-f`  | Only retry previously failed photos                      |
| `lmpg flee --limit <n>`                | `-l`  | Cap number of downloads                                  |
| `lmpg flee --concurrency <n>`          | `-c`  | Parallel downloads (default: 3)                          |
| `lmpg flee --inspect`                  |       | Headed browser with DevTools                             |
| `lmpg flee-albums`                     |       | Download album photos into `albums/`; symlink timeline   |
| `lmpg flee-albums --failed-only`       | `-f`  | Only retry previously failed album photos                |
| `lmpg flee-albums --limit <n>`         | `-l`  | Cap number of downloads                                  |
| `lmpg flee-albums --concurrency <n>`   | `-c`  | Parallel downloads per album (default: 3)                |
| `lmpg flee-albums --inspect`           |       | Headed browser with DevTools                             |
| `lmpg status`                          |       | Show download progress                                   |
| `lmpg verify`                          |       | Check unverified photos, reset broken records to pending |
| `lmpg verify --dry-run`                |       | Report issues only, without resetting records            |
| `lmpg verify --reset`                  |       | Re-check all downloaded photos, not just unverified ones |
| `lmpg scrub`                           |       | Delete files on disk with no matching database record    |
| `lmpg scrub --dry-run`                 |       | Preview what scrub would delete                          |
| `lmpg -p <name> <command>`             | `-p`  | Use a named profile (separate auth, DB, and config)      |
| `lmpg -v`                              |       | Print version                                            |

---

## License

MIT
