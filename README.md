# Cagey

A calm, minimalist Killer Sudoku for desktop and touch screens. No ads, no accounts, no tracking. Plain HTML, CSS and JavaScript with no build step.

## Features

- Endless puzzles in four levels (Easy, Medium, Hard, Expert), generated in the browser in a Web Worker. Every puzzle has exactly one solution.
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
npm test       # checks the generator produces valid, uniquely solvable puzzles
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
  js/engine.js      solver and puzzle generator (no DOM, also used by tests)
  js/worker.js      runs the generator off the main thread
  _headers          Cloudflare Pages response headers
test/               node:test suite for the engine
```
