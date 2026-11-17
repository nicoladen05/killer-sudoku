# Killer Sudoku

A calm, minimalist Killer Sudoku for desktop and touch screens. No ads, no accounts, no tracking. Plain HTML, CSS and JavaScript with no build step, plus a few small Pages Functions for the leaderboard, streaks and moving progress between devices, and a Durable Object for duels.

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
- **Replays:** the circular-arrow button next to a time on a level board starts that exact board (rebuilt from its generator seed). A replay is ranked on its own: it never shows on the level board, only in that entry's replay list, opened with the people button and count next to it. The list ranks the original and every replay together. Times posted before seeds were kept have no replay button, and a board made by an older generator says it can't be replayed (the rebuilt puzzle's hash must match). Daily boards have no replay buttons.
- **Daily challenge** (calendar button, top right): one Hard puzzle a day, the same for everyone, with its own leaderboard. A new puzzle starts at midnight German time (Europe/Berlin). You can replay it as often as you like, but only your first finished run is ranked, because a replay is mostly memory. The badge on the button shows your streak, the number of days in a row you finished the daily (any finished run counts, also replays and games past three mistakes). It turns blue while today's puzzle is still open. After solving you can share a spoiler-free result. The daily has its own saved game, so it doesn't replace a puzzle you're in the middle of ("Back to your … game" in the New game dialog).
- **Duels** (New game → Duel a friend): play a friend live, in one of two modes.
  - **Race:** you each get the same board. The first to solve it wins; three mistakes and you're out. You see how many cells your opponent has filled, but not which.
  - **Chess clock:** one shared board, and a clock each (3 + 2, 5 + 3 or 10 + 5: minutes, plus seconds added for every right digit). Who moves first is random. On your turn you place 1, 2 or 3 digits, as set when creating the duel ("Digits per turn", 1 by default). A right digit stays, and the turn passes once you've placed them all; your clock runs for the whole turn. A wrong one is rejected, costs 15 seconds and ends your turn at once. When the board is full, whoever has more time left wins (the last digit adds no time; equal clocks are a draw). If your clock runs out, you lose. Notes are your own and work any time, also during the other player's turn. When it's your move, the board gets a blue frame, and the digits the other player placed in their last turn keep an orange ring until you place yours. Their moves also play a short tick (a low tone for a rejected digit), and phones that support it buzz when the turn comes back to you (Android; iPhones' browsers don't). The speaker button under the clocks turns the sound and buzz off. Browsers only allow sound after you've tapped or pressed a key on the page, so the very first alert after a reload can be silent.

  Create an invite to get a code (like `ABC-DEF`) and a link to send. The duel starts with a 3-second countdown once your friend joins, and the board stays hidden until then. Both browsers build the board from the same seed. The server checks every digit and runs the clocks, so a slow connection doesn't change who wins (each move gets 0.25 s free for network lag). There are no hints or pauses, and you can resign. A reload or a dropped connection picks the duel up again, and a chess clock keeps running meanwhile. After the end you can offer a rematch with the same settings. Duels don't go on the leaderboards. Invites nobody joins expire after an hour.
- Light and dark mode (follows the system until you toggle it).
- Progress is saved locally, so a reload picks up where you left off.
- **Other devices, no account:** your streak is also kept on the server, so clearing site data doesn't lose it. To play on a second device, open the leaderboard and tap "Other devices": it shows your code (like `EH6A-ER2R`) with a countdown, and buttons to copy the code or a link. Enter the code on the other device or open the link there. Before anything changes, it shows what will be merged (both devices' leaderboard times and streak days, and the total) and asks you to confirm. That device then plays as you, with your name, times and streak, and anything it already had is added to yours. Codes work once and expire after 15 minutes. Or save a **passkey** in the same dialog: your password manager (iCloud Keychain, Google Password Manager, 1Password, ...) keeps it on all your devices, so "Sign in" gets your progress back anywhere, even when no old device is left. No email or password either way. Games in progress stay on the device they were started on.

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

In a duel, Hint and Pause are off.

## Develop

```sh
npm run dev    # serves ./public on http://localhost:8080
npm test       # checks puzzles are valid, unique and solvable by logic

# with the leaderboard API (local D1 database):
npm run db:local   # create the tables once
npm run dev:full   # http://localhost:8788

# duels too: run the duel Worker in a second terminal first
npm run dev:duel   # Durable Object on :8790; dev:full finds it on its own
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

**Duels** need one more deploy, once and whenever `duel-worker/` or `lib/duel.js` changes. Do it before the site, because the site's `DUELS` binding points at this Worker:

```sh
npm run deploy:duel   # deploys the "cagey-duel" Worker with the Duel Durable Object
```

The Git integration only builds the site, so deploy the Worker yourself. It uses SQLite-backed Durable Objects, which the free plan includes. The Worker has to exist before any site deploy, preview deployments included (they bind the same Worker): otherwise Cloudflare refuses to publish the site's Functions with `Script cagey-duel not found`. (Without a `DUELS` binding at all, as in `npm run dev`, `/api/duel` answers 503 and the rest of the site works.)

### Leaderboard backend

`functions/api/scores.js` is a Cloudflare Pages Function backed by D1 (binding `DB`, set in `wrangler.toml`). Production uses the `cagey-leaderboard` database; preview deployments use `cagey-leaderboard-preview`. The schema is in `migrations/` (`0001_scores.sql`, `0002_daily.sql`, `0003_sync.sql`, `0004_passkeys.sql`, then `0005_replays.sql`). Apply a new migration to both databases, e.g. `npx wrangler d1 execute cagey-leaderboard --remote --file migrations/0005_replays.sql` (and the same for `cagey-leaderboard-preview`).

- `GET /api/scores?level=hard&player=<id>`: top 50 (best time per player and mistake count, fewer mistakes first) and your own rank.
- `GET /api/scores?daily=2026-11-12&player=<id>`: the same for one day's daily challenge.
- `GET /api/scores?replays=<puzzle hash>&player=<id>`: one board's original entry and all its replays, ranked. Level board entries carry `puzzle`, `seed` and `replays` (the count).
- `POST /api/scores`: post a solve (with `daily: "<date>"` for a daily, `seed` for the generator seed, `replay: true` for a replay of a board on a level board). `PUT /api/scores`: rename a player.
- `POST /api/streak` (`functions/api/streak.js`): send the daily days the server doesn't have yet, get back all of them (days with a daily leaderboard entry count too). Accepts real dates from the last 400 days, at most 1000 new days per IP per day.
- `POST /api/sync` (`functions/api/sync.js`): a one-time code for a player (valid 15 minutes). The current code comes back while it has more than a minute left, so reopening the dialog or reloading costs nothing; `renew: true` (the refresh button, e.g. after the code was used) makes a new one and cancels the old one. `PUT /api/sync` with `preview: true`: what using a code would do, as counts (the code stays valid). `PUT /api/sync`: use a code. The device's own times and days move to the code's player (on the same puzzle, the code player's entry wins), and it gets that player's id and name back. At most 60 new codes and 10 wrong codes per IP per hour (generous because a household, school or mobile carrier can share one IP; handing back the current code doesn't count).

- `POST /api/passkey` (`functions/api/passkey.js`): passkeys, in four steps (`register-options`, `register`, `login-options`, `login`). Saving uses the public key the browser hands over (`getPublicKey()`), so there's no CBOR parsing and no library. Sign-in checks a one-time challenge (5 minutes), the origin, the relying party (the site's host name), user presence, the signature (ES256 or RS256) and the signature counter, then links the device like a sync code. At most 30 starts and 10 failed sign-ins per IP per hour. Passkeys belong to the host name, so ones saved on `*.pages.dev` won't work on a custom domain (and preview deployments have their own).

- `/api/duel` (`functions/api/duel/[[path]].js`): duels. Each duel is a Durable Object in the `cagey-duel` Worker (`duel-worker/index.js`), named by its code. The rules are a pure state machine in `lib/duel.js`, tested without the Workers runtime.
  - `POST /api/duel` `{ player, name, mode, level[, clock] }`: a new invite. Returns `{ code, token, seat }`. The token is that player's secret for the socket, so the player id never leaves the server and the other player never sees it.
  - `GET /api/duel/<code>`: what the invite is (mode, level, clock, host name, whether it's full).
  - `POST /api/duel/<code>/join` `{ player, name }`: take the second seat. The same player joining again gets their seat back.
  - `GET /api/duel/<code>/ws?token=…`: the WebSocket. The server sends each player their view of the duel after every change: the shared board and both clocks in chess mode, or your own board and both progress counts in a race. The solution is never sent. Browsers send `ready` (the board they built and its hash), `move`, `resign` and `rematch`. The first board is checked to be a valid killer sudoku, and both hashes must match, or the duel ends ("built different boards"). An alarm flags a clock that runs out even with nobody connected. Sockets hibernate between messages, and keep-alive pings are answered without waking the object.
  - Limits: 30 new duels and 30 lookups of codes that don't exist per IP per hour (counted in `sync_tries`, so no new tables). Finished duels are deleted after 6 hours.

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
  js/duel.js        duels in the browser: API calls and the live connection
  js/daily.js       daily challenge: date, seed and streak (no DOM, also used by the API and tests)
  js/engine.js      brute-force solver and puzzle generator (no DOM, also used by tests)
  js/logic.js       human-style logic solver used to accept and grade puzzles
  js/worker.js      runs the generator off the main thread
  _headers          Cloudflare Pages response headers
functions/api/scores.js  leaderboard API (Pages Function + D1)
functions/api/streak.js  daily streak kept on the server
functions/api/sync.js    sync codes for other devices
functions/api/passkey.js passkeys (WebAuthn) for other devices
functions/api/duel/[[path]].js  duels API, in front of the Durable Object
duel-worker/        the cagey-duel Worker: the Duel Durable Object (own wrangler.toml)
lib/duel.js         duel rules as a pure state machine (modes, clocks, views)
lib/server.js       helpers shared by the API functions
migrations/        D1 schema
test/               node:test suite for the engine, leaderboard, replays, daily, sync, passkeys and duels (the API runs against node:sqlite via test/d1.mjs; duels against a fake Durable Object runtime)
```
