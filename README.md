# how clanker are you?

A KL-divergence Turing test, reversed — live at
**[howclankerareyou.com](https://howclankerareyou.com)**.

You finish eight sentences. For every word you type, three LLMs
(Llama 3.1 8B, DeepSeek V3, Qwen3 235B) report their top-20 next-token
logprobs conditioned on your actual text so far. Your words are one-hot
next-token distributions, so per-token KL(you ‖ model) collapses to
−log p_model(your token). Averaged over tokens and questions, that's your
divergence from each model — and your **clanker score** is how close you got.

## How scoring works

- **No tokenizers, client or server.** The Worker walks your completion
  greedily: request the top-20 next tokens for the current prefix, match the
  longest candidate against your remaining text, record its logprob, append
  **your** words to the prefix, repeat (`src/scoring.js`). Tokens outside the
  top-20 are floored just below the 20th candidate.
- **Score mapping.** `100 · exp(−max(0, D − d0) / 1.4)`, where D is your mean
  nats/token under a model and `d0` is that model's "generic-LLM" anchor (its
  self-completion baseline + ~1.7, the level a *foreign* frontier LLM's text
  sits at). Overall score = your nearest model's (divergence to an ensemble is
  a min). Calibration: any-LLM paste ≈ 100%, quirky human answers ≈ 20%.
- **Per-word heat grid.** The same per-token logprobs roll up into a per-word
  divergence, colored green (human/surprising) → red (clanker/predictable),
  and shared as a Wordle-style emoji grid.

## Stack

Cloudflare Worker (vanilla JS) + static assets + D1. No framework, no build.
Inference via the HuggingFace Inference Providers router (HF PRO), with each
model pinned to a backend that returns logprobs and accepts an assistant
prefix. `src/mock.js` is a deterministic fallback used when `HF_TOKEN` is unset.

```
src/index.js      API: /api/session, /api/score, /api/finish, /api/result/:id, /api/status
src/scoring.js    greedy top-k matching, KL, per-word heat, calibrated score mapping
src/mock.js       deterministic stand-in for the logprobs endpoint
src/questions.js  server-side question bank
public/           landing → quiz → results SPA, favicon/OG/SEO assets
schema.sql        D1 tables (sessions, answers, results, usage)
```

## Abuse protection

- Per-IP rate limits on `/api/session` (20/min) and `/api/score` (40/min) via
  Cloudflare rate-limit bindings.
- A global daily scoring-call cap (`DAILY_CALL_CAP`, D1-counted) as a backstop
  against distributed abuse that per-IP limits miss.
- Input bounds: fixed question/model lists, 80-char completion cap, ≤10 greedy
  steps per answer.
- The real dollar ceiling is HuggingFace's own spending limit — set one.

## Dev

```
echo 'MOCK_INFERENCE=0'          > .dev.vars   # or MOCK_INFERENCE=1 for the mock
echo "HF_TOKEN=hf_…"            >> .dev.vars
npx wrangler d1 execute howclankerareyou-wnam --local --file schema.sql
npm run dev
```

## Deploy

```
npx wrangler d1 execute howclankerareyou-wnam --remote --file schema.sql
npx wrangler secret put HF_TOKEN
npm run deploy
```

The D1 database lives in the WNAM region (moved off ENAM during a Cloudflare
Durable-Objects incident); the previous ENAM id is noted in `wrangler.toml`.
