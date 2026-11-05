# Cagey

A calm, minimalist Killer Sudoku for desktop and touch screens. No ads, no accounts, no tracking. Plain HTML, CSS and JavaScript with no build step.

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

## Layout

```
public/
  index.html        markup
  css/style.css     styles and light/dark themes
  js/app.js         UI, input, persistence
  js/engine.js      brute-force solver and puzzle generator (no DOM, also used by tests)
  js/logic.js       human-style logic solver used to accept and grade puzzles
  js/worker.js      runs the generator off the main thread
  _headers          Cloudflare Pages response headers
test/               node:test suite for the engine
```
