import { generate } from "./engine.js";

self.onmessage = (e) => {
  const { id, difficulty } = e.data;
  try {
    self.postMessage({ id, puzzle: generate(difficulty) });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
