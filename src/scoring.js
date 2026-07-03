// Per-token KL scoring against hosted models via OpenRouter. The user's
// completion is a sequence of one-hot next-token samples; KL(user ‖ model) at
// each position collapses to -log p_model(user's token).
//
// We never tokenize the user's text ourselves. Instead we walk it greedily:
// ask the model for its top-20 next tokens given (prompt + text consumed so
// far), take the longest candidate that prefixes the remaining text, record
// its logprob, and advance. If nothing matches, the token is outside the
// model's top-20 and gets floored just below the least likely candidate.
// The assistant prefix always grows by the user's actual words, so every
// step is conditioned on what the human really wrote.
//
// Until OpenRouter credits are funded, env.MOCK_INFERENCE routes topLogprobs
// through a deterministic pseudo-distribution (./mock.js) so the full site is
// live and playable. Flip MOCK_INFERENCE off + set OPENROUTER_API_KEY to go
// real; d0 baselines should be re-measured against the real models then.
import { mockTopLogprobs } from './mock.js';

const ROUTER = 'https://openrouter.ai/api/v1/chat/completions';

// d0 = self-completion divergence baseline (nats/token): each model's own
// sampled completions scored through this same pipeline. Scores are relative
// to that baseline, so peakier models don't punish everyone equally. The
// values below are provisional (mock era) — recalibrate once inference is live.
export const MODELS = [
  { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini', maker: 'OpenAI', d0: 0.9 },
  { id: 'meta-llama/llama-3.1-8b-instruct', label: 'Llama 3.1 8B', maker: 'Meta', d0: 0.8 },
  { id: 'deepseek/deepseek-chat', label: 'DeepSeek V3', maker: 'DeepSeek', d0: 0.7 },
  { id: 'mistralai/mistral-nemo', label: 'Mistral Nemo', maker: 'Mistral', d0: 0.8 },
];

export function isMock(env) {
  return env.MOCK_INFERENCE === '1' || !env.OPENROUTER_API_KEY;
}

// Anchors every model on the same task; tuned so first-token mass lands on
// content words instead of '...' (qwen), '.' (qwen), or ' **' (gemma).
const instruction = (prompt) =>
  `Finish this sentence with a natural completion of about 3 to 10 words. ` +
  `Plain text only, no formatting, no quotes: "${prompt}"`;
const MAX_STEPS = 10;
const FLOOR_MARGIN = 2; // unmatched token: min(top-20) - margin, in nats
const FLOOR_MIN = -14;

// Calibrated 2026-07-03: model-sampled text ≈ 100, generic AI-flavored
// answers ≈ 70, quirky human answers ≈ 15.
const LAMBDA = 3.0;

export function clankerScore(avgKL, d0) {
  return Math.round(1000 * Math.exp(-Math.max(0, avgKL - d0) / LAMBDA)) / 10;
}

export async function scoreModel(env, model, promptText, completion) {
  let consumed = promptText;
  let remaining = ' ' + completion.trim();
  const perStep = [];

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
    consumed += chunk;
    remaining = remaining.slice(chunk.length);
  }

  if (!perStep.length) return null;
  const avgKL = round(-perStep.reduce((s, t) => s + t.logprob, 0) / perStep.length);
  return { avgKL, steps: perStep.length, perStep };
}

async function topLogprobs(env, modelId, promptText, assistantText, retries = 1) {
  if (isMock(env)) return mockTopLogprobs(modelId, assistantText);
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(ROUTER, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          'content-type': 'application/json',
          'http-referer': 'https://howclankerareyou.nikliolios.com',
          'x-title': 'how clanker are you',
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
