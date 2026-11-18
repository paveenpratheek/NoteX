/* What Claude Code's failures are called, so the page says what to do (t-6c6c00a9f7). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../engine/lib/claude.js';

test('a past-due subscription is billing, not a login, though it names an API key', () => {
  const e = classify("Claude Code can't use your Claude subscription, usually because a payment is past due · Pay or renew at https://claude.ai/settings/billing (if you just paid, try again shortly), or use an Anthropic API key instead");
  assert.equal(e.code, 'billing');
  assert.match(e.message, /claude\.ai\/settings\/billing/);
  assert.doesNotMatch(e.message, /not logged in/);
  assert.equal(classify('Invalid API key · Please run /login').code, 'not-logged-in');
  assert.equal(classify('Claude AI usage limit reached').code, 'limit');
});
