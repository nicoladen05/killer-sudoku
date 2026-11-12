# Killer Sudoku

A calm, minimalist Killer Sudoku for desktop and touch screens. No ads, no accounts, no tracking. Plain HTML, CSS and JavaScript with no build step, plus one small Pages Function for the leaderboard.

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
- **Leaderboard** per level (trophy button, top right). After your first solve you enter a name once; later solves are posted automatically. The board is split into collapsible sections by mistake count (none, 1, 2); each player shows with their best time in each section they have a solve in, ranked by time plus a hint penalty. The first hint adds 1 minute, the second 2 more, the third 3 more and so on (5 hints = 15 minutes), so spamming Hint never pays off. Games continued past three mistakes don't count.
- Light and dark mode (follows the system until you toggle it).
- Progress is saved locally, so a reload picks up where you left off.

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
npm run db:local   # create the table once
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

`functions/api/scores.js` is a Cloudflare Pages Function backed by D1 (binding `DB`, set in `wrangler.toml`). Production uses the `cagey-leaderboard` database; preview deployments use `cagey-leaderboard-preview`. The schema is `migrations/0001_scores.sql`.

- `GET /api/scores?level=hard&player=<id>`: one section per mistake count, each with the top 50 (best time per player) and your own rank.
- `POST /api/scores`: post a solve. `PUT /api/scores`: rename a player.

The game runs in the browser, so results can't be proven. The API only keeps out junk: valid level, a minimum believable time per level, at most 2 mistakes, a cleaned name of up to 20 characters, one entry per player per puzzle, and at most 20 posts per hour (100 per day) from one IP. IPs are stored only as a hash salted with the date.

## Layout

```
public/
  index.html        markup
  css/style.css     styles and light/dark themes
  js/app.js         UI, input, persistence
  js/leaderboard.js leaderboard API client
  js/engine.js      brute-force solver and puzzle generator (no DOM, also used by tests)
  js/logic.js       human-style logic solver used to accept and grade puzzles
  js/worker.js      runs the generator off the main thread
  _headers          Cloudflare Pages response headers
functions/api/scores.js  leaderboard API (Pages Function + D1)
migrations/        D1 schema
test/               node:test suite for the engine
```
