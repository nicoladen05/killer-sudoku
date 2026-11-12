# Killer Sudoku

A calm, minimalist Killer Sudoku for desktop and touch screens. No ads, no accounts, no tracking. Plain HTML, CSS and JavaScript with no build step, plus a few small Pages Functions for the leaderboard, streaks and moving progress between devices.

## Features

- Endless puzzles in five levels (Easy, Medium, Hard, Expert, Master), generated in the browser in a Web Worker. Every puzzle has exactly one solution and can be solved by logic alone, with no guessing.

### How puzzles are made and graded

`js/logic.js` is a solver that works like a person with pencil marks. The generator keeps only puzzles it can finish.

Easy to Expert are tuned to feel like the big killer sudoku apps. They all use the same kind of layout: about 31 to 35 small cages (mostly 2 or 3 cells, at most 5, up to 3 single cells). The base puzzle must be solvable with singles, cage combinations and the rule of 45 on one row, column or box, using at most 3 rule-of-45 and 2 locked-candidate steps. The level then only sets how many digits are shown at the start:

| Level | Digits shown |
| --- | --- |
| Easy | 31 |
| Medium | 26 |
| Hard | 10 |
| Expert | 0 (and needs the rule of 45 at least once) |
| Master | 0, with bigger cages; needs the rule of 45 across two or three houses several times, and may need triples, X-wing, quads, swordfish or XY-wing |

When the solver gets stuck, the generator splits a cage at that spot. For Master it then merges cages and removes digits again as long as the puzzle stays solvable. The brute-force solver in `js/engine.js` double-checks that the solution is unique.
- Board on the left, controls on the right (stacked on phones in portrait).
- Number pad with remaining counts, Undo, Erase, Notes and Hint.
- Mistake counter (three mistakes ends the game, or keep playing without a limit) and a timer that pauses when the tab is hidden.
- **Area check:** drag across a row, column or box (or click a cell and shift-click another cell in the same unit, or hold Shift and press the arrow keys) to highlight it. The keypad then lights up the numbers that area is still missing.
- **Leaderboard** per level (trophy button, top right). After your first solve you enter a name once; later solves are posted automatically. Everyone is in one ranking: solves with fewer mistakes always rank above solves with more, then by time plus a hint penalty. A subtle label marks where each mistake count starts. Each player appears once, with their best entry (fewest mistakes, then fastest). The first hint adds 1 minute, the second 2 more, the third 3 more and so on (5 hints = 15 minutes), so spamming Hint never pays off. Games continued past three mistakes don't count.
- **Daily challenge** (calendar button, top right): one Hard puzzle a day, the same for everyone, with its own leaderboard. A new puzzle starts at midnight German time (Europe/Berlin). You can replay it as often as you like, but only your first finished run is ranked, because a replay is mostly memory. The badge on the button shows your streak, the number of days in a row you finished the daily (any finished run counts, also replays and games past three mistakes). It turns blue while today's puzzle is still open. After solving you can share a spoiler-free result. The daily has its own saved game, so it doesn't replace a puzzle you're in the middle of ("Back to your … game" in the New game dialog).
- Light and dark mode (follows the system until you toggle it).
- Progress is saved locally, so a reload picks up where you left off.
- **Other devices, no account:** your streak is also kept on the server, so clearing site data doesn't lose it. To play on a second device, open the leaderboard, tap "Other devices" and get a code (like `EH6A-ER2R`). Enter it on the other device or open the link it gives you. That device then plays as you, with your name, times and streak, and anything it already had is added to yours. Codes work once and expire after 15 minutes. Or save a **passkey** in the same dialog: your password manager (iCloud Keychain, Google Password Manager, 1Password, ...) keeps it on all your devices, so "Sign in" gets your progress back anywhere, even when no old device is left. No email or password either way. Games in progress stay on the device they were started on.

### Keyboard

| Key | Action |
| --- | --- |
| `1`–`9` | Enter digit (or note in notes mode) |
| Arrows | Move selection |
| `Shift` + arrows | Mark the row (left/right) or column (up/down) of the selected cell; turn a corner to mark its box |
| `Backspace` / `Delete` / `0` | Erase |
| `N` | Toggle notes |
| `H` | Hint |
| `Ctrl/Cmd + Z` | Undo |
| `P` / `Space` | Pause |
| `Esc` | Clear the area highlight |

## Develop

```sh
npm run dev    # serves ./public on http://localhost:8080
npm test       # checks puzzles are valid, unique and solvable by logic

# with the leaderboard API (local D1 database):
npm run db:local   # create the tables once
npm run dev:full   # http://localhost:8788
```

Any static file server works, for example `python3 -m http.server -d public`.

## Deploy to Cloudflare Pages

The site is the `public/` folder; there is nothing to build.

**From the dashboard (Git integration):** Workers & Pages → Create → Pages → Connect to Git → pick this repo, then set

- Framework preset: `None`
- Build command: *(leave empty)*
- Build output directory: `public`

Every push to `main` then deploys automatically.

**From the command line:**

```sh
npx wrangler login
npm run deploy
```

### Leaderboard backend

`functions/api/scores.js` is a Cloudflare Pages Function backed by D1 (binding `DB`, set in `wrangler.toml`). Production uses the `cagey-leaderboard` database; preview deployments use `cagey-leaderboard-preview`. The schema is in `migrations/` (`0001_scores.sql`, `0002_daily.sql`, `0003_sync.sql`, then `0004_passkeys.sql`). Apply a new migration to both databases, e.g. `npx wrangler d1 execute cagey-leaderboard --remote --file migrations/0004_passkeys.sql` (and the same for `cagey-leaderboard-preview`).

- `GET /api/scores?level=hard&player=<id>`: top 50 (best time per player and mistake count, fewer mistakes first) and your own rank.
- `GET /api/scores?daily=2026-11-12&player=<id>`: the same for one day's daily challenge.
- `POST /api/scores`: post a solve (with `daily: "<date>"` for a daily). `PUT /api/scores`: rename a player.
- `POST /api/streak` (`functions/api/streak.js`): send the daily days the server doesn't have yet, get back all of them (days with a daily leaderboard entry count too). Accepts real dates from the last 400 days, at most 1000 new days per IP per day.
- `POST /api/sync` (`functions/api/sync.js`): make a one-time code for a player (valid 15 minutes; a new code replaces the old one). `PUT /api/sync`: use a code. The device's own times and days move to the code's player (on the same puzzle, the code player's entry wins), and it gets that player's id and name back. At most 20 codes and 10 wrong codes per IP per hour.

- `POST /api/passkey` (`functions/api/passkey.js`): passkeys, in four steps (`register-options`, `register`, `login-options`, `login`). Saving uses the public key the browser hands over (`getPublicKey()`), so there's no CBOR parsing and no library. Sign-in checks a one-time challenge (5 minutes), the origin, the relying party (the site's host name), user presence, the signature (ES256 or RS256) and the signature counter, then links the device like a sync code. At most 30 starts and 10 failed sign-ins per IP per hour. Passkeys belong to the host name, so ones saved on `*.pages.dev` won't work on a custom domain (and preview deployments have their own).

A player is just the random id in their browser. It's never shown; only a short-lived code or a passkey can hand it to another device.

How the daily works: the puzzle is generated in the browser from a seed made from the date (`js/daily.js`), so no server generation is needed. Daily entries are only accepted for today and yesterday (German time), and only at level Hard. The first puzzle hash posted for a day is stored in the `daily` table; later entries must match it, so everyone on a daily board played the same puzzle. Changing the generator in `engine.js` changes the daily puzzles too, so avoid deploying a generator change during the day (or bump `DAILY_VERSION`, which changes every day's puzzle). Daily entries don't appear on the Hard board.

The game runs in the browser, so results can't be proven. The API only keeps out junk: valid level, a minimum believable time per level, at most 2 mistakes, a cleaned name of up to 20 characters, one entry per player per puzzle, and at most 20 posts per hour (100 per day) from one IP. IPs are stored only as a hash salted with the date.

## Layout

```
public/
  index.html        markup
  css/style.css     styles and light/dark themes
  js/app.js         UI, input, persistence
  js/leaderboard.js API client: leaderboard, streak, sync codes
  js/passkey.js     passkeys in the browser (WebAuthn)
  js/daily.js       daily challenge: date, seed and streak (no DOM, also used by the API and tests)
  js/engine.js      brute-force solver and puzzle generator (no DOM, also used by tests)
  js/logic.js       human-style logic solver used to accept and grade puzzles
  js/worker.js      runs the generator off the main thread
  _headers          Cloudflare Pages response headers
functions/api/scores.js  leaderboard API (Pages Function + D1)
functions/api/streak.js  daily streak kept on the server
functions/api/sync.js    sync codes for other devices
functions/api/passkey.js passkeys (WebAuthn) for other devices
lib/server.js       helpers shared by the API functions
migrations/        D1 schema
test/               node:test suite for the engine, leaderboard, daily, sync and passkeys (the API runs against node:sqlite via test/d1.mjs)
```
