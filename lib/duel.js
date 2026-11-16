// Duel rules: a pure state machine with no I/O, no clock and no randomness.
// The Durable Object in duel-worker/ feeds it events with the current time and
// sends each player the view that comes out. Tests drive it directly with fake times.
//
// Two modes on the same puzzle (generated in both browsers from the server's seed):
//
//   classic  Each player solves their own copy. The server checks every digit
//            against the solution. First to fill the board wins; three wrong
//            digits lose.
//   chess    One shared board and a chess clock each. Players take turns placing
//            one digit. A right digit stays and adds the increment; a wrong one
//            is rejected, costs WRONG_PENALTY and passes the turn. When the board
//            is full, whoever has more time left wins (equal time is a draw).
//            Running out of time loses.
//
// Life of a duel: lobby (host waiting) -> preparing (both joined, building the
// board) -> playing (startAt may still be in the future: the countdown) -> over.

export const MODES = ["classic", "chess"];
export const LEVELS = ["easy", "medium", "hard", "expert", "master"];
/** Chess time controls: minutes + seconds added per placed digit. */
export const CLOCKS = {
  "3+2": { base: 180, inc: 2 },
  "5+3": { base: 300, inc: 3 },
  "10+5": { base: 600, inc: 5 },
};
export const DEFAULT_CLOCK = "5+3";
export const MAX_MISTAKES = 3; // classic
export const WRONG_PENALTY = 15_000; // chess, ms
/** Not charged per move, so network lag doesn't eat a player's clock. */
export const LAG_GRACE = 250;
export const COUNTDOWN = 3000;
/** A duel nobody joins (or that never gets going) expires after this long. */
export const LOBBY_TTL = 60 * 60_000;
/** A classic race still going after this long ends without a winner. */
export const MAX_RACE = 24 * 60 * 60_000;
/** A finished duel stays around this long (for rematches and reloads), then is deleted. */
export const KEEP = 6 * 60 * 60_000;

/** No 0/O, 1/I/L, so a code is easy to read out and type (same as sync codes). */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LEN = 6;

export function newDuelCode() {
  let out = "";
  while (out.length < CODE_LEN) {
    for (const b of crypto.getRandomValues(new Uint8Array(CODE_LEN * 2))) {
      // 248 = 8 * 31: drop the top values so every character is equally likely.
      if (b < 248 && out.length < CODE_LEN) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
    }
  }
  return out;
}

/** A typed or pasted code in canonical form (ABCDEF), or "" if it can't be one. */
export function normDuelCode(raw) {
  if (typeof raw !== "string") return "";
  const c = raw.toUpperCase().replace(/[\s-]/g, "");
  return c.length === CODE_LEN && [...c].every((ch) => CODE_ALPHABET.includes(ch)) ? c : "";
}

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const other = (seat) => 1 - seat;

/**
 * True when `solution` is a full, valid sudoku that agrees with the givens and
 * every cage (distinct digits adding up to its sum), and the cages cover the
 * board exactly once. Uniqueness isn't checked here: both browsers built the
 * puzzle from the same seed, and the generator only makes unique puzzles.
 */
export function validPuzzle(p) {
  if (!p || typeof p !== "object") return false;
  const { cages, givens, solution } = p;
  if (!Array.isArray(givens) || givens.length !== 81 || !givens.every((v) => isInt(v, 0, 9))) return false;
  if (!Array.isArray(solution) || solution.length !== 81 || !solution.every((v) => isInt(v, 1, 9))) return false;
  if (givens.some((v, i) => v && v !== solution[i])) return false;
  for (let u = 0; u < 9; u++) {
    const row = new Set(), col = new Set(), box = new Set();
    for (let k = 0; k < 9; k++) {
      row.add(solution[u * 9 + k]);
      col.add(solution[k * 9 + u]);
      box.add(solution[(Math.floor(u / 3) * 3 + Math.floor(k / 3)) * 9 + (u % 3) * 3 + (k % 3)]);
    }
    if (row.size !== 9 || col.size !== 9 || box.size !== 9) return false;
  }
  if (!Array.isArray(cages) || cages.length < 9 || cages.length > 81) return false;
  const seen = new Set();
  for (const c of cages) {
    if (!c || !Array.isArray(c.cells) || !c.cells.length || c.cells.length > 9 || !isInt(c.sum, 1, 45)) return false;
    const digits = new Set();
    let sum = 0;
    for (const i of c.cells) {
      if (!isInt(i, 0, 80) || seen.has(i)) return false;
      seen.add(i);
      digits.add(solution[i]);
      sum += solution[i];
    }
    if (digits.size !== c.cells.length || sum !== c.sum) return false;
  }
  return seen.size === 81;
}

/**
 * A new duel waiting for a second player. `seed` is the generator seed both
 * browsers build the board from; `token` is the host's secret for connecting.
 */
export function createDuel({ code, mode, level, clock, player, name, token, seed, now }) {
  if (!MODES.includes(mode)) throw new Error("bad mode");
  if (!LEVELS.includes(level)) throw new Error("bad level");
  return {
    v: 1,
    code,
    mode,
    level,
    clock: mode === "chess" ? (CLOCKS[clock] ? clock : DEFAULT_CLOCK) : null,
    seed,
    status: "lobby",
    created: now,
    seats: [seat(player, name, token)],
    puzzle: null, // { hash, cages, givens } once the first browser has built it
    solution: null, // server only, never sent
    startAt: null,
    result: null, // { winner: 0 | 1 | null, reason, time? }
    endedAt: null,
  };
}

const seat = (player, name, token) => ({ player, name, token, hash: null, mistakes: 0 });

/** The seat a token belongs to, or -1. */
export const seatOfToken = (s, token) => s.seats.findIndex((p) => p.token === token);

/**
 * Take the second seat. The same player joining again (another tab) gets their
 * seat back, so `token` may be ignored in favour of the existing one.
 * @returns {{state, seat, token} | {error, status}}
 */
export function joinDuel(state, { player, name, token }) {
  const mine = state.seats.findIndex((p) => p.player === player);
  if (mine === 0 && state.seats.length === 1) return { error: "That's your own invite. Send the link to a friend.", status: 409 };
  if (mine >= 0) return { state, seat: mine, token: state.seats[mine].token };
  if (state.status !== "lobby") return { error: state.status === "over" ? "This duel has ended." : "This duel already has two players.", status: 409 };
  const s = structuredClone(state);
  s.seats.push(seat(player, name, token));
  s.status = "preparing";
  return { state: s, seat: 1, token };
}

function end(s, winner, reason, now, extra = {}) {
  s.status = "over";
  s.result = { winner, reason, ...extra };
  s.endedAt = now;
}

function start(s, first, now) {
  s.status = "playing";
  s.startAt = now + COUNTDOWN;
  if (s.mode === "chess") {
    const ms = CLOCKS[s.clock].base * 1000;
    s.values = s.puzzle.givens.slice();
    s.owner = s.puzzle.givens.map((v) => (v ? -1 : null)); // -1 given, 0/1 placed by that seat
    s.turn = first;
    s.turnStart = s.startAt;
    s.left = [ms, ms];
    s.last = null;
  } else {
    for (const p of s.seats) p.values = s.puzzle.givens.slice();
  }
}

/**
 * Charge the player to move for the time since their turn started.
 * Returns false (and ends the duel) when their clock ran out.
 */
function charge(s, now) {
  const spent = Math.max(0, now - s.turnStart - LAG_GRACE);
  s.left[s.turn] -= spent;
  if (s.left[s.turn] > 0) return true;
  s.left[s.turn] = 0;
  end(s, other(s.turn), "timeout", now);
  return false;
}

function classicMove(s, me, cell, digit, now) {
  const p = s.seats[me];
  if (p.values[cell]) return; // already solved there (e.g. sent again after a reconnect)
  if (digit === s.solution[cell]) {
    p.values[cell] = digit;
    if (p.values.every((v, i) => v === s.solution[i])) end(s, me, "solved", now, { time: now - s.startAt });
  } else {
    p.mistakes++;
    if (p.mistakes >= MAX_MISTAKES) end(s, other(me), "mistakes", now);
  }
}

function chessMove(s, me, cell, digit, now) {
  if (s.turn !== me) return "It's not your turn.";
  if (s.values[cell]) return "That cell is already filled.";
  if (!charge(s, now)) return;
  const ok = digit === s.solution[cell];
  s.last = { seat: me, cell, digit, ok, at: now };
  if (ok) {
    s.values[cell] = digit;
    s.owner[cell] = me;
    // The last digit gets no increment, so finishing the board doesn't buy time.
    if (s.values.every(Boolean)) {
      const winner = s.left[0] === s.left[1] ? null : s.left[0] > s.left[1] ? 0 : 1;
      end(s, winner, "complete", now);
      return;
    }
    s.left[me] += CLOCKS[s.clock].inc * 1000;
  } else {
    s.seats[me].mistakes++;
    s.left[me] -= WRONG_PENALTY;
    if (s.left[me] <= 0) { s.left[me] = 0; end(s, other(me), "timeout", now); return; }
  }
  s.turn = other(me);
  s.turnStart = now;
}

/**
 * Apply one event. Never mutates `state`.
 *   { type: "ready", seat, hash, puzzle, first }  the seat built the board; `puzzle`
 *        ({ cages, givens, solution }) must already hash to `hash`; `first` is who moves first in chess
 *   { type: "move", seat, cell, digit }
 *   { type: "resign", seat }                     before the start this cancels the duel
 *   { type: "alarm" }                            timeouts and expiry
 * @returns {{state, error?: string, gone?: true}} `error` goes back to the sender only;
 *   `gone` means the duel can be deleted.
 */
export function step(state, ev, now) {
  const s = structuredClone(state);
  const me = ev.seat;

  if (ev.type === "alarm") {
    if (s.status === "over") return now >= s.endedAt + KEEP ? { state: s, gone: true } : { state: s };
    if (s.status === "lobby" || s.status === "preparing") {
      if (now >= s.created + LOBBY_TTL) end(s, null, "expired", now);
    } else if (s.mode === "chess") {
      if (now >= s.turnStart + s.left[s.turn] + LAG_GRACE) charge(s, now);
    } else if (now >= s.startAt + MAX_RACE) {
      end(s, null, "abandoned", now);
    }
    return { state: s };
  }

  if (!isInt(me, 0, s.seats.length - 1)) return { state, error: "bad seat" };

  if (ev.type === "resign") {
    if (s.status === "over") return { state };
    if (s.status === "lobby" || s.status === "preparing") end(s, null, "cancelled", now);
    else end(s, other(me), "resign", now);
    return { state: s };
  }

  if (ev.type === "ready") {
    if (s.status !== "preparing") return { state }; // a late or repeated ready: nothing to do
    if (!s.puzzle) {
      if (!validPuzzle(ev.puzzle)) return { state, error: "That board isn't valid." };
      s.puzzle = { hash: ev.hash, cages: ev.puzzle.cages, givens: ev.puzzle.givens };
      s.solution = ev.puzzle.solution;
    } else if (ev.hash !== s.puzzle.hash) {
      // Different generator versions built different boards from the same seed.
      end(s, null, "mismatch", now);
      return { state: s };
    }
    s.seats[me].hash = ev.hash;
    if (s.seats.length === 2 && s.seats.every((p) => p.hash)) start(s, ev.first === 1 ? 1 : 0, now);
    return { state: s };
  }

  if (ev.type === "move") {
    if (s.status !== "playing") return { state, error: s.status === "over" ? "The duel is over." : "The duel hasn't started yet." };
    if (now < s.startAt) return { state, error: "The duel hasn't started yet." };
    if (!isInt(ev.cell, 0, 80) || !isInt(ev.digit, 1, 9)) return { state, error: "bad move" };
    if (s.puzzle.givens[ev.cell]) return { state };
    const error = s.mode === "chess" ? chessMove(s, me, ev.cell, ev.digit, now) : classicMove(s, me, ev.cell, ev.digit, now);
    return error ? { state, error } : { state: s };
  }

  return { state, error: "unknown event" };
}

/** When the Durable Object should next wake up for this duel. */
export function nextAlarm(s) {
  if (s.status === "over") return s.endedAt + KEEP;
  if (s.status === "lobby" || s.status === "preparing") return s.created + LOBBY_TTL;
  if (s.mode === "chess") return s.turnStart + s.left[s.turn] + LAG_GRACE;
  return s.startAt + MAX_RACE;
}

const label = (s) => ({ mode: s.mode, level: s.level, clock: s.clock });

/** What anyone with the code may see before joining. */
export function info(s) {
  return { code: s.code, ...label(s), status: s.status, host: s.seats[0].name, full: s.seats.length > 1 };
}

const filledOf = (s, p) => p.values.reduce((n, v, i) => n + (v && !s.puzzle.givens[i] ? 1 : 0), 0);

/**
 * The state as one seat sees it. No player ids, tokens or solution; in a race
 * the opponent's progress is only a count, never which cells.
 * @param {boolean[]} online whether each seat has a live connection
 */
export function view(s, me, now, online = [false, false]) {
  const v = {
    type: "state",
    code: s.code,
    ...label(s),
    seed: s.seed,
    status: s.status,
    you: me,
    now,
    startAt: s.startAt,
    result: s.result,
    endedAt: s.endedAt,
    hash: s.puzzle?.hash ?? null,
    players: s.seats.map((p, i) => ({ name: p.name, online: !!online[i], ready: !!p.hash, mistakes: p.mistakes })),
  };
  if (s.startAt == null) return v;
  if (s.mode === "chess") {
    Object.assign(v, { values: s.values, owner: s.owner, turn: s.turn, turnStart: s.turnStart, left: s.left, last: s.last });
  } else {
    v.total = s.puzzle.givens.filter((g) => !g).length;
    s.seats.forEach((p, i) => (v.players[i].filled = filledOf(s, p)));
    v.mine = s.seats[me].values;
  }
  return v;
}

