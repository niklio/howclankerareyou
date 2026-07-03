// Per-token KL scoring against hosted models via the HuggingFace Inference
// Providers router. The user's completion is a sequence of one-hot next-token
// samples; KL(user ‖ model) at each position collapses to -log p_model(token).
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

// d0 = the "generic LLM" divergence anchor (nats/token): the level at which a
// strong assistant's completion sits under this model. Text at or below d0
// scores ~100% clanker. This is the panel model's self-completion baseline
// (Llama 4.0 / DeepSeek 2.5 / Qwen 6.0) PLUS ~1.7 — because a foreign LLM's
// text (GPT, Claude, …) is more surprising to a small open model than that
// model's own output, so anchoring at self alone made any non-panel LLM score
// only ~50%. Provider pins lock a backend that returns top-20 logprobs and
// accepts an assistant-prefixed continuation.
export const MODELS = [
  { id: 'meta-llama/Llama-3.1-8B-Instruct:nscale', label: 'Llama 3.1 8B', maker: 'Meta', d0: 5.7 },
  { id: 'deepseek-ai/DeepSeek-V3-0324:novita', label: 'DeepSeek V3', maker: 'DeepSeek', d0: 4.2 },
  { id: 'Qwen/Qwen3-235B-A22B-Instruct-2507:nscale', label: 'Qwen3 235B', maker: 'Alibaba', d0: 7.7 },
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

// Re-anchored 2026-07-03 so any-LLM paste scores high: with the generic-LLM d0
// above and overall = nearest-model similarity, frontier-LLM completions land
// ~90–100% and quirky human answers ~20% (human sits ~2.2 nats past the anchor
// → exp(−2.2/1.4) ≈ 0.21). Steeper than before to force that separation, so
// clichéd human prose (which reads like an LLM) lands mid-range by design.
const LAMBDA = 1.4;

export function clankerScore(avgKL, d0) {
  return Math.round(1000 * Math.exp(-Math.max(0, avgKL - d0) / LAMBDA)) / 10;
}

export async function scoreModel(env, model, promptText, completion) {
  let consumed = promptText;
  let remaining = ' ' + completion.trim();
  const perStep = [];

  // Word spans over the (space-prefixed) completion, so we can roll the
  // per-token logprobs up into a per-word divergence for the share grid.
  // Token boundaries differ per model, but words are the user's own, so
  // per-word values align across models.
  const source = ' ' + completion.trim();
  const words = [];
  for (const m of source.matchAll(/\S+/g)) {
    words.push({ start: m.index, end: m.index + m[0].length, lps: [] });
  }
  let charPos = 0;

  for (let step = 0; step < MAX_STEPS && remaining.trim().length; step++) {
    const cands = await topLogprobs(env, model.id, promptText, consumed);
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

// Per-word divergence (nats) → heat level for the share grid.
// 0 red = clanker (predictable), 3 green = human (surprising).
export function heatLevel(kl) {
  if (kl == null) return null;
  if (kl < 2.0) return 0;
  if (kl < 4.5) return 1;
  if (kl < 7.5) return 2;
  return 3;
}

async function topLogprobs(env, modelId, promptText, assistantText, retries = 3) {
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
            { role: 'user', content: instruction(promptText) },
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
