/* The models NoteX's agent answers with - Claude's and, through Antigravity,
 * Gemini's (t-bdcb28547b) - and which one runs an ask.
 *
 * The chat picks the model, and a canvas keeps the model of its last
 * message: asks that name none - a phone's queued message with no model,
 * a drop placed on the canvas - use it.
 */
import { runClaude } from './claude.js';
import { runGemini, isGemini, GEMINI_MODELS } from './gemini.js';

export const CLAUDE_MODELS = ['sonnet', 'opus', 'haiku'];
export const MODELS = [...CLAUDE_MODELS, ...GEMINI_MODELS];
export { isGemini, GEMINI_MODELS };

/* One prompt to whichever runs the model. */
export function runAgent(opts) {
  return isGemini(opts.model) ? runGemini(opts) : runClaude(opts);
}

/* The model of the canvas's last message that named one NoteX offers, or null. */
export function canvasModel(agent, canvas) {
  let turns = [];
  try { turns = agent.chat(canvas, 50); } catch (_) { return null; }
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t && t.who === 'user' && MODELS.includes(t.model)) return t.model;
  }
  return null;
}
