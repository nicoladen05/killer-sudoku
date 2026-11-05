# Cagey

A calm, minimalist Killer Sudoku for desktop and touch screens. No ads, no accounts, no tracking. Plain HTML, CSS and JavaScript with no build step.

## Features

- Endless puzzles in four levels (Easy, Medium, Hard, Expert), generated in the browser in a Web Worker. Every puzzle has exactly one solution and can be solved by logic alone, with no guessing.

### How puzzles are made and graded

`js/logic.js` is a solver that works like a person with pencil marks. The generator keeps only puzzles it can finish, and the level is set by the hardest technique the puzzle needs:

| Level | Hardest technique needed |
| --- | --- |
| Easy | Singles and cage combinations (plus a few extra starting digits) |
| Medium | Rule of 45 on one row, column or box, locked candidates, pairs |
| Hard | Rule of 45 across two or three rows, columns or boxes, triples, X-wing |
| Expert | As Hard but with bigger cages, no starting digits and several hard steps; quads, swordfish and XY-wing are allowed |

When the solver gets stuck, the generator reveals a digit or splits a cage at that spot; for harder levels it then merges cages and removes digits again as long as the puzzle stays solvable. The brute-force solver in `js/engine.js` double-checks that the solution is unique.
- Board on the left, controls on the right (stacked on phones in portrait).
- Number pad with remaining counts, Undo, Erase, Notes and Hint.
- Mistake counter (three mistakes ends the game, or keep playing without a limit) and a timer that pauses when the tab is hidden.
- **Area check:** drag across a row, column or box (or click a cell and shift-click another cell in the same unit) to highlight it. The keypad then lights up the numbers that area is still missing.
- Light and dark mode (follows the system until you toggle it).
- Progress is saved locally, so a reload picks up where you left off.

### Keyboard

| Key | Action |
| --- | --- |
| `1`–`9` | Enter digit (or note in notes mode) |
| Arrows | Move selection |
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
