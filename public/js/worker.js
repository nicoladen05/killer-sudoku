import { generate } from "./engine.js";

self.onmessage = (e) => {
  const { id, difficulty, seed } = e.data;
  try {
    self.postMessage({ id, puzzle: seed == null ? generate(difficulty) : generate(difficulty, seed) });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
