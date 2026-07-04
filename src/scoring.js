// Per-token surprisal scoring against hosted models via the HuggingFace
// Inference Providers router. Each token the user typed has a surprisal
// −log p_model(token) under the model's distribution — how unexpected it was.
// (Equivalently, the KL from the user's one-hot next-token choice to the
// model's distribution collapses to exactly that surprisal.) Field names in
// the schema/API keep the historical `avg_kl` label; only the framing changed.
//
// We never tokenize the user's text ourselves. Instead we walk it greedily:
// ask the model for its top-20 next tokens given (prompt + text consumed so
// far), take the longest candidate that prefixes the remaining text, record
// its logprob, and advance. If nothing matches, the token is outside the
// model's top-20 and gets floored just below the least likely candidate.
// The assistant prefix always grows by the user's actual words, so every
// step is conditioned on what the human really wrote.
//
// If env.HF_TOKEN is unset (or MOCK_INFERENCE=1), topLogprobs falls back to a
// deterministic pseudo-distribution (./mock.js) so the site stays playable.
import { mockTopLogprobs } from './mock.js';

const ROUTER = 'https://router.huggingface.co/v1/chat/completions';

// d0 = the "generic LLM" surprisal anchor (nats/token): the level at which a
// strong assistant's completion sits under this model. Text at or below d0
// scores ~100% clanker. This is the panel model's self-completion baseline
// (Llama 4.0 / DeepSeek 2.5 / Qwen 6.0) PLUS ~1.7 — because a foreign LLM's
// text (GPT, Claude, …) is more surprising to a small open model than that
// model's own output, so anchoring at self alone made any non-panel LLM score
// only ~50%. Provider pins lock a backend that returns top-20 logprobs and
// accepts an assistant-prefixed continuation.
// d0     — anchor for the anchored self-test (sentence completion).
// d0text — anchor for free-form post scoring (see TEXT_PRIME); higher because
//          an unanchored post is more surprising token-for-token than a
//          completion continuing a shared stem. Calibrated 2026-07-03 on AI
//          vs human sample posts across all three models.
export const MODELS = [
  { id: 'meta-llama/Llama-3.1-8B-Instruct:nscale', label: 'Llama 3.1 8B', maker: 'Meta', d0: 5.7, d0text: 6.2 },
  { id: 'deepseek-ai/DeepSeek-V3-0324:novita', label: 'DeepSeek V3', maker: 'DeepSeek', d0: 4.2, d0text: 5.0 },
  { id: 'Qwen/Qwen3-235B-A22B-Instruct-2507:nscale', label: 'Qwen3 235B', maker: 'Alibaba', d0: 7.7, d0text: 8.0 },
];

export function isMock(env) {
  return env.MOCK_INFERENCE === '1' || !env.HF_TOKEN;
}

// Anchors every model on the same task; tuned so first-token mass lands on
// content words instead of '...' (qwen), '.' (qwen), or ' **' (gemma).
const instruction = (prompt) =>
  `Finish this sentence with a natural completion of about 3 to 10 words. ` +
  `Plain text only, no formatting, no quotes: "${prompt}"`;
const MAX_STEPS = 10;
const FLOOR_MARGIN = 2; // unmatched token: min(top-20) - margin, in nats
const FLOOR_MIN = -14;

// --- free-form text scoring (the "diagnose an X account" feature) -----------
// The self-test scores a sentence *completion* anchored by a shared stem. A
// tweet has no stem, so we frame the model as composing a post from scratch and
// walk the real text token-by-token. Empirically the AI↔human surprisal gap on
// a single unanchored post is smaller than on an anchored completion, but it
// averages out over many posts, and the free-form d0/λ below are calibrated for
// this regime (see scoreText). Longer step budget since posts run past a stem.
const TEXT_PRIME =
  `Write a single short, natural social media post. ` +
  `Plain text only, no quotation marks, no hashtags.`;
// Fallback step budget; the diagnose endpoint passes an explicit cap
// (DROP_K + GRID_COLS = 18) so per-post compute is fixed.
const MAX_STEPS_TEXT = 45;

// Re-anchored 2026-07-03 so any-LLM paste scores high: with the generic-LLM d0
// above and overall = nearest-model similarity, frontier-LLM completions land
// ~90–100% and quirky human answers ~20% (human sits ~2.2 nats past the anchor
// → exp(−2.2/1.4) ≈ 0.21). Steeper than before to force that separation, so
// clichéd human prose (which reads like an LLM) lands mid-range by design.
const LAMBDA = 1.4;

export function clankerScore(avgKL, d0) {
  return Math.round(1000 * Math.exp(-Math.max(0, avgKL - d0) / LAMBDA)) / 10;
}

// Free-form posts separate less per-token than anchored completions, so the
// free-form curve is gentler (smaller λ would over-punish the small AI↔human
// gap into all-or-nothing). Calibrated alongside d0text.
const LAMBDA_TEXT = 1.1;

export function clankerScoreText(avgKL, d0text) {
  return Math.round(1000 * Math.exp(-Math.max(0, avgKL - d0text) / LAMBDA_TEXT)) / 10;
}

// Anchored self-test: a shared sentence stem primes the model, and the user's
// completion is the assistant prefix we walk. seed = the stem, so every step is
// conditioned on "stem + words so far".
export async function scoreModel(env, model, promptText, completion) {
  return walk(env, model.id, instruction(promptText), completion, {
    maxSteps: MAX_STEPS,
    seed: promptText,
  });
}

// Free-form post: no stem. The model is primed to compose a post (TEXT_PRIME)
// and we walk the real post text from an empty prefix. Same greedy machinery,
// empty seed. Callers cap maxSteps (drop window + scored window) so a long
// post costs the same as a short one.
export async function scoreText(env, model, text, maxSteps = MAX_STEPS_TEXT) {
  return walk(env, model.id, TEXT_PRIME, text, { maxSteps, seed: '' });
}

// Fast free-form scorer: score the post's last `count` words CONCURRENTLY
// instead of walking tokens sequentially. Each word's conditioning prefix
// (everything before it) is known upfront, so there is no chain — one round
// trip of `count` parallel calls replaces up to 18 serial ones. A word's
// surprisal is the logprob of the best top-20 candidate that prefixes the
// remaining text at that point (its first token), floored when outside the
// top-20 — same matching and floor rules as the walk. Everything before the
// window is warmup context (≥3 words via the sampling minimum), which buys
// the old DROP_K cold-start correction for free: unissued calls cost nothing.
export async function scoreWordWindow(env, model, text, count = 8) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const start = Math.max(0, words.length - count);

  const perStep = await Promise.all(
    words.slice(start).map(async (word, i) => {
      const pos = start + i;
      const prefix = words.slice(0, pos).join(' ');
      const cands = await topLogprobs(env, model.id, TEXT_PRIME, prefix);
      if (!cands) return null;
      const remaining = ' ' + words.slice(pos).join(' ');
      const match = bestMatch(cands, remaining, 1); // no first-letter forgiveness
      let logprob;
      if (match) {
        logprob = match.logprob;
      } else {
        const minLp = Math.min(...cands.map((c) => c.logprob));
        logprob = Math.max(FLOOR_MIN, minLp - FLOOR_MARGIN);
      }
      return { chunk: word, logprob: round(logprob), matched: !!match };
    })
  );

  const kept = perStep.filter(Boolean);
  if (!kept.length) return null;
  const avgKL = round(-kept.reduce((s, t) => s + t.logprob, 0) / kept.length);
  // perStep keeps positional nulls so grid cells stay word-aligned.
  return { avgKL, steps: kept.length, perStep };
}

// Greedy top-20 token walk shared by both scorers. `userMsg` is the fixed user
// turn; `text` is the human text whose surprisal we measure; `seed` is the
// assistant prefix already "written" before the text (a stem for the self-test,
// empty for free-form). Returns { avgKL, steps, perStep, perWord } or null if
// the provider never produced usable logprobs.
async function walk(env, modelId, userMsg, text, { maxSteps, seed = '' }) {
  let consumed = seed;
  let remaining = ' ' + text.trim();
  const perStep = [];

  // Word spans over the (space-prefixed) text, so we can roll the per-token
  // logprobs up into a per-word surprisal for the share grid. Token boundaries
  // differ per model, but words are the human's own, so per-word values align.
  const source = ' ' + text.trim();
  const words = [];
  for (const m of source.matchAll(/\S+/g)) {
    words.push({ start: m.index, end: m.index + m[0].length, lps: [] });
  }
  let charPos = 0;

  for (let step = 0; step < maxSteps && remaining.trim().length; step++) {
    const cands = await topLogprobs(env, modelId, userMsg, consumed);
    if (!cands) {
      if (perStep.length >= 2) break; // provider flaked mid-answer; keep what we have
      return null;
    }
    const match = bestMatch(cands, remaining, step);
    let logprob, chunk;
    if (match) {
      ({ consumed: chunk, logprob } = match);
    } else {
      const minLp = Math.min(...cands.map((c) => c.logprob));
      logprob = Math.max(FLOOR_MIN, minLp - FLOOR_MARGIN);
      chunk = nextWord(remaining);
    }
    if (!chunk.length) break;
    perStep.push({ chunk: chunk.trim(), logprob: round(logprob), matched: !!match });
    // Attribute this token's logprob to every word it overlaps.
    const segEnd = charPos + chunk.length;
    for (const w of words) if (w.start < segEnd && w.end > charPos) w.lps.push(logprob);
    charPos = segEnd;
    consumed += chunk;
    remaining = remaining.slice(chunk.length);
  }

  if (!perStep.length) return null;
  const perWord = words.map((w) =>
    w.lps.length ? round(-w.lps.reduce((a, b) => a + b, 0) / w.lps.length) : null
  );
  const avgKL = round(-perStep.reduce((s, t) => s + t.logprob, 0) / perStep.length);
  return { avgKL, steps: perStep.length, perStep, perWord };
}

// Per-word surprisal (nats) → heat level for the share grid.
// 0 red = clanker (predictable), 3 green = human (surprising).
export function heatLevel(kl) {
  if (kl == null) return null;
  if (kl < 2.0) return 0;
  if (kl < 4.5) return 1;
  if (kl < 7.5) return 2;
  return 3;
}

// Same idea for free-form post tokens, shifted for that regime: unanchored
// text runs ~2.5 nats hotter than a stem-anchored completion (the d0→d0text
// shift), so the self-test buckets paint every account green. These buckets
// center on the observed account range (avgKL ~5–10).
export function heatLevelText(kl) {
  if (kl == null) return null;
  if (kl < 4.5) return 0;
  if (kl < 6.5) return 1;
  if (kl < 8.5) return 2;
  return 3;
}

async function topLogprobs(env, modelId, userMsg, assistantText, retries = 3) {
  if (isMock(env)) return mockTopLogprobs(modelId, assistantText);
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(ROUTER, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.HF_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: modelId,
          messages: [
            { role: 'user', content: userMsg },
            { role: 'assistant', content: assistantText },
          ],
          max_tokens: 1,
          logprobs: true,
          top_logprobs: 20,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const raw = await res.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        data = JSON.parse(sanitizeJson(raw));
      }
      const entry = data.choices?.[0]?.logprobs?.content?.[0];
      if (!entry?.top_logprobs?.length) throw new Error('no logprobs in response');
      return entry.top_logprobs.map((t) => ({ text: tokenText(t), logprob: t.logprob }));
    } catch (err) {
      console.log(`topLogprobs ${modelId} attempt ${attempt}: ${err}`);
      if (attempt === retries) return null;
    }
  }
  return null;
}

// Some providers emit bare backslashes / raw control chars inside token
// strings, which breaks strict JSON parsing.
function sanitizeJson(raw) {
  return raw
    .replace(/\\(?![\\/"bfnrtu])/g, '\\\\')
    .replace(/[\u0000-\u001f]/g, '');
}

function tokenText(t) {
  if (Array.isArray(t.bytes) && t.bytes.length) {
    try {
      return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(t.bytes));
    } catch {}
  }
  return t.token ?? '';
}

function bestMatch(cands, remaining, step) {
  let best = null;
  for (const c of cands) {
    if (!c.text) continue;
    let chunk = matchOne(c.text, remaining);
    if (!chunk && step === 0) {
      // Forgive a case mismatch on the very first letter (mobile autocapitalize).
      const alt = matchOne(c.text, flipFirstLetter(remaining));
      if (alt) chunk = remaining.slice(0, alt.length);
    }
    if (
      chunk &&
      chunk.trim().length &&
      (!best ||
        chunk.length > best.consumed.length ||
        (chunk.length === best.consumed.length && c.logprob > best.logprob))
    ) {
      best = { consumed: chunk, logprob: c.logprob };
    }
  }
  return best;
}

// Providers disagree on whether tokens at the message boundary keep their
// leading space, so matching is lenient about a single space on either side.
// Always returns a literal prefix of `remaining` (or null).
function matchOne(token, remaining) {
  if (remaining.startsWith(token)) return token;
  if (token.startsWith(' ') && remaining.startsWith(token.slice(1))) return token.slice(1);
  if (remaining.startsWith(' ') && remaining.slice(1).startsWith(token)) return ' ' + token;
  return null;
}

function flipFirstLetter(s) {
  const i = s.search(/[a-zA-Z]/);
  if (i < 0) return s;
  const ch = s[i];
  const flipped = ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase();
  return s.slice(0, i) + flipped + s.slice(i + 1);
}

function nextWord(remaining) {
  const m = remaining.match(/^\s*\S+/);
  return m ? m[0] : remaining;
}

function round(x, places = 4) {
  const f = 10 ** places;
  return Math.round(x * f) / f;
}
