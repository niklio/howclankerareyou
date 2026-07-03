# how clanker are you?

A KL-divergence Turing test, reversed — live at
[howclankerareyou.nikliolios.com](https://howclankerareyou.nikliolios.com).

You finish eight sentences. For every word you type, three open-weight LLMs
(Llama 3.2 3B, Qwen 2.5 3B, Gemma 3 4B, served by Ollama on a Mac mini)
report their top-20 next-token logprobs conditioned on your actual text so
far. Your words are one-hot next-token distributions, so per-token
KL(you ‖ model) collapses to −log p_model(your token). Averaged over tokens
and questions, that's your divergence from each model.

## How scoring works

- No tokenizers client- or server-side. The Worker walks your completion
  greedily: request top-20 next tokens for the current prefix, match the
  longest candidate against your remaining text, record its logprob, append
  **your** words to the prefix, repeat (`src/scoring.js`).
- Tokens outside the top-20 are floored just below the 20th candidate.
- Per-model similarity: `100 · exp(−max(0, D − d0) / 3)` where D is mean
  nats/token and d0 is that model's measured self-completion baseline
  (each model's own sampled answers scored through the same pipeline).
- Overall score = nearest model's similarity (divergence to an ensemble is
  a min). Calibration: model-sampled text ≈ 100, generic AI-flavored answers
  ≈ 70, quirky human answers ≈ 15.
- Scores land in D1; the percentile is your rank among all finished runs.

## Architecture

```
browser ── howclankerareyou.nikliolios.com (CF Worker + assets + D1)
                │  /api/score: one call per (question, model)
                ▼
        clanker-inference.nikliolios.com (Cloudflare Tunnel)
                │  WAF rule: requires x-clanker-key header
                ▼
        ollama on the Mac mini (llama3.2:3b, qwen2.5:3b, gemma3:4b)
```

Inference is free and ~200ms/token-step on the M4, so a full 3-model scoring
round per question finishes in a few seconds, fired in the background while
the user types the next answer.

```
src/index.js     API: /api/session, /api/score, /api/finish, /api/result/:id
src/scoring.js   greedy top-k matching + KL + calibrated score mapping
src/questions.js server-side question bank
public/          landing → quiz → results SPA
```

## Dev

```
brew services start ollama
ollama pull llama3.2:3b && ollama pull qwen2.5:3b && ollama pull gemma3:4b
echo 'INFERENCE_URL=http://localhost:11434' > .dev.vars
npx wrangler d1 execute howclankerareyou --local --file schema.sql
npm run dev
```

## Deploy

```
npx wrangler d1 create howclankerareyou   # once; paste id into wrangler.toml
npx wrangler d1 execute howclankerareyou --remote --file schema.sql
npx wrangler secret put INFERENCE_KEY     # must match the WAF rule value
npm run deploy
```

The tunnel runs as a LaunchAgent (`com.nikliolios.clanker-tunnel`) created at
setup time; ollama runs as a brew service. Both survive reboots.
