// Daily challenge: one Hard puzzle per day, the same for everyone.
//
// The day follows German time (Europe/Berlin), so the new puzzle appears at
// local midnight in Germany. The puzzle comes from a seed made from the date,
// so every browser builds the same one without asking a server.
//
// Pure functions only, so they can be shared with the API and tested in Node.

export const DAILY_LEVEL = "hard";
export const DAILY_ZONE = "Europe/Berlin";
/**
 * Part of the seed. Bump only on purpose: changing it (or changing the
 * generator in engine.js) gives every day a different puzzle.
 */
export const DAILY_VERSION = 1;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDate = (s) => typeof s === "string" && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

const fmtDay = new Intl.DateTimeFormat("en-CA", { timeZone: DAILY_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });

/** The daily date (YYYY-MM-DD) in German time. */
export function dailyDate(now = new Date()) {
  return fmtDay.format(now);
}

/** `date` moved by `days` (YYYY-MM-DD in, YYYY-MM-DD out). */
export function addDays(date, days) {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

/** 32-bit seed for a day's puzzle (FNV-1a of the date and version). */
export function dailySeed(date) {
  let h = 0x811c9dc5;
  for (const ch of `daily-v${DAILY_VERSION}:${date}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** "Thu 12 Nov" */
export function dailyLabel(date) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

/** Add a solved day to a sorted list of dates (kept to the last 400 days). */
export function addSolved(dates, date) {
  const set = new Set(Array.isArray(dates) ? dates.filter(isDate) : []);
  set.add(date);
  return [...set].sort().slice(-400);
}

/**
 * Streak from the days a daily was finished.
 * `current` counts back from today, or from yesterday while today's puzzle is
 * still open, so a streak isn't lost before the day is over.
 */
export function streak(dates, today) {
  const set = new Set(Array.isArray(dates) ? dates : []);
  const solvedToday = set.has(today);
  let current = 0;
  for (let d = solvedToday ? today : addDays(today, -1); set.has(d); d = addDays(d, -1)) current++;
  let best = 0, run = 0, prev = null;
  for (const d of [...set].filter(isDate).sort()) {
    run = prev && addDays(prev, 1) === d ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return { current, best, solvedToday };
}
