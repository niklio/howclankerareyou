# Scorer eval

ROC-AUC of the production clanker scorer (echo-surprisal panel) on three
public AI-text detection benchmarks. Results at
`staging.howclankerareyou.com/eval`.

## Design (v1 — public benchmarks, per Nik 2026-07-06)

- **Data:** 250 AI + 250 human per benchmark, sampled via the HF
  datasets-server API (no bulk downloads):
  - **RAID** (liamdugan/raid) — balanced across 11 generators, `attack='none'`
  - **MAGE** (yaful/MAGE) — test split across its testbeds
  - **HC3** (Hello-SimpleAI/HC3) — paired human/ChatGPT answers, same questions
  Texts truncated to their last 120 words; production's ≥11-word rule applies.
- **Scoring:** imports `scorePostEcho`/`clankerScoreText` from
  `src/scoring.js` — the literal production path (3-model panel, last-8-words
  window, overall = nearest model). 3 calls/sample. **HF spend is shared with
  prod** — size runs accordingly and get sign-off before scoring runs.
- **Metrics:** rank-based AUC per benchmark + pooled, bootstrap CIs,
  per-generator/per-domain/per-panel-model breakdowns, and a "simulated
  account" AUC (5 random same-class samples aggregated production-style).

## Known caveats

These benchmarks predate 2024: human text is likely in the panel models'
weights (memorization → humans skew clanker → AUC underestimates), and
generators are older than what people actually paste. The fresh-human
condition (collect_human.mjs — parked) would isolate the memorization effect.

## Files

| file | role |
|---|---|
| `fetch_datasets.mjs` | sample RAID/MAGE/HC3 → `data/samples.json` |
| `score.mjs` | resumable scoring runner → `data/scores.json` (3 calls/sample!) |
| `analyze.mjs` | AUC/ROC/CI analysis → `../public/eval-data.json` |
| `collect_human.mjs` | PARKED — fresh-human collection (reddit/HN) |
| `gen_ai.mjs` | PARKED — local ollama AI generation |

`data/` is gitignored; only aggregate results are published.

## Rerun

```bash
node fetch_datasets.mjs   # free (HF datasets-server)
node score.mjs            # PAID: 3 HF echo calls per sample — get approval
node analyze.mjs          # free, local
npx wrangler deploy --env staging
```
