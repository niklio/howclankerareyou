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
export const MODELS = [
  { id: 'meta-llama/Llama-3.1-8B-Instruct:nscale', label: 'Llama 3.1 8B', maker: 'Meta', d0: 5.7 },
  { id: 'deepseek-ai/DeepSeek-V3-0324:novita', label: 'DeepSeek V3', maker: 'DeepSeek', d0: 4.2 },
  { id: 'Qwen/Qwen3-235B-A22B-Instruct-2507:nscale', label: 'Qwen3 235B', maker: 'Alibaba', d0: 7.7 },
];

// Account-diagnosis panel (separate from the self-test panel above): the only
// HF-router-reachable models whose serving stack supports `echo` + logprobs on
// the completions endpoint — one call returns the exact logprob of every token
// in a post (audited all 28 deepinfra text-gen models, 2026-07-04; every Llama
// and DeepSeek deployment 500s on that path). One provider-direct call per
// (post × model) replaces the old 8-40 chat calls: ~10× faster and cheaper,
// and exact (no top-20 truncation/floor).
// d0text — anchor (nats/word over the scored window): at or below it scores
// ~100% clanker. Calibrated 2026-07-04 on the 8-account panel via Qwen
// (BillGates 2.06 ↔ ~85%, sama 5.01 ↔ ~20%).
export const TEXT_MODELS = [
  { id: 'Qwen/Qwen3-235B-A22B-Instruct-2507', label: 'Qwen3 235B', maker: 'Alibaba', d0text: 1.7 },
  { id: 'stepfun-ai/Step-3.5-Flash', label: 'Step 3.5 Flash', maker: 'StepFun', d0text: 1.7 },
  { id: 'Qwen/Qwen3-235B-A22B-Thinking-2507', label: 'Qwen3 Thinking', maker: 'Alibaba', d0text: 1.7 },
];
const ECHO_URL = 'https://router.huggingface.co/deepinfra/v1/openai/completions';

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
// tweet has no stem, so its surprisal is the plain LM probability of the text
// itself, taken from a single echo call per (post × model). The scored window
// is the post's LAST `window` words — everything before is conditioning
// context, which is the cold-start drop for free.

// Re-anchored 2026-07-03 so any-LLM paste scores high: with the generic-LLM d0
// above and overall = nearest-model similarity, frontier-LLM completions land
// ~90–100% and quirky human answers ~20% (human sits ~2.2 nats past the anchor
// → exp(−2.2/1.4) ≈ 0.21). Steeper than before to force that separation, so
// clichéd human prose (which reads like an LLM) lands mid-range by design.
const LAMBDA = 1.4;

export function clankerScore(avgKL, d0) {
  return Math.round(1000 * Math.exp(-Math.max(0, avgKL - d0) / LAMBDA)) / 10;
}

// Exact full-context word surprisals run lower and tighter than the old
// top-20-walk numbers, so the curve is re-fit for that scale: with d0text=1.7,
// λ=2.0 puts the calibration panel at BillGates(2.06)→84%, pmarca(3.17)→48%,
// dril(4.13)→30%, sama(5.01)→19%. Calibrated alongside d0text.
const LAMBDA_TEXT = 2.0;

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

// Echo scorer: ONE completions call returns the exact logprob of every token
// in the post (echo=true + logprobs). Tokens are rolled up into per-word
// surprisals via text_offset, and the post's last `window` words become the
// scored window (perStep, one entry per word — logprob is the word's mean
// token logprob, so downstream -logprob math is unchanged). deepinfra
// occasionally answers 429 "engine_overloaded"; retries back off and the
// caller treats null as a missing panel member.
export async function scorePostEcho(env, model, text, window = 8, retries = 3) {
  if (isMock(env)) return mockEcho(model.id, text, window);
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(ECHO_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.HF_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: model.id,
          prompt: text,
          max_tokens: 1, // provider rejects 0; the 1 generated token is sliced off below
          echo: true,
          logprobs: 1,
        }),
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) throw new Error(`echo ${res.status}`);
      const data = await res.json();
      const lp = data.choices?.[0]?.logprobs;
      if (!lp?.tokens?.length || !lp.token_logprobs || !lp.text_offset) {
        throw new Error('no prompt logprobs in response');
      }

      // Word spans over the post; each word's surprisal is the mean -logprob
      // of the prompt tokens overlapping it (the generated tail — offsets at
      // or past the prompt's end — is excluded, as is the first token, whose
      // logprob is null).
      const words = [];
      for (const m of String(text).matchAll(/\S+/g)) {
        words.push({ chunk: m[0], start: m.index, end: m.index + m[0].length, lps: [] });
      }
      for (let i = 0; i < lp.tokens.length; i++) {
        const logprob = lp.token_logprobs[i];
        const off = lp.text_offset[i];
        if (logprob == null || off >= text.length) continue;
        const end = off + lp.tokens[i].length;
        for (const w of words) if (w.start < end && w.end > off) w.lps.push(logprob);
      }

      const scored = words.slice(-window);
      const perStep = scored.map((w) =>
        w.lps.length
          ? { chunk: w.chunk, logprob: round(w.lps.reduce((a, b) => a + b, 0) / w.lps.length) }
          : null
      );
      const kept = perStep.filter(Boolean);
      if (!kept.length) throw new Error('no scored words');
      const avgKL = round(-kept.reduce((s, t) => s + t.logprob, 0) / kept.length);
      return { avgKL, steps: kept.length, perStep };
    } catch (err) {
      console.log(`scorePostEcho ${model.id} attempt ${attempt}: ${err}`);
      if (attempt < retries) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
  }
  return null;
}

// Deterministic stand-in for demo mode: pseudo-surprisal from a word hash,
// same output shape as scorePostEcho.
function mockEcho(modelId, text, window) {
  const words = String(text).trim().split(/\s+/).filter(Boolean).slice(-window);
  if (!words.length) return null;
  const perStep = words.map((w) => {
    let h = 0x811c9dc5;
    for (const c of modelId + '|' + w) {
      h ^= c.charCodeAt(0);
      h = Math.imul(h, 0x01000193);
    }
    return { chunk: w, logprob: -round(0.3 + ((h >>> 0) % 600) / 100) };
  });
  const avgKL = round(-perStep.reduce((s, t) => s + t.logprob, 0) / perStep.length);
  return { avgKL, steps: perStep.length, perStep };
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

// Same idea for free-form post words, on the exact-echo scale: full-context
// word surprisals run much lower than the old top-20-walk numbers. Buckets
// sit near the calibration panel's word-surprisal quartiles (p25 0.94 /
// p50 2.9 / p75 4.9), so grids average one of each color instead of washing
// out to a single hue.
export function heatLevelText(kl) {
  if (kl == null) return null;
  if (kl < 1.0) return 0;
  if (kl < 3.0) return 1;
  if (kl < 5.0) return 2;
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
