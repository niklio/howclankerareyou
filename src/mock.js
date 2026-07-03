// Deterministic stand-in for a real logprobs endpoint, used while OpenRouter
// credits are unfunded. It returns a plausible top-20 next-token distribution
// so the scoring pipeline — greedy matching, surprisal, calibration, percentiles —
// runs end-to-end and the site is fully playable.
//
// It is NOT a language model. It qualitatively mimics one: common English
// continuation tokens sit near the top with high probability, so answers built
// from ordinary words match and read as "clanker", while unusual words fall
// outside the top-20 and get floored, reading as "human". The distribution is
// seeded on (model, context) so it's stable per input and varies by model —
// giving each model a different opinion of you, like the real thing.
//
// When inference goes live this file is bypassed entirely (see isMock()).

// Frequency-ordered common continuations. Leading spaces mark word boundaries,
// matching how real tokenizers emit mid-sentence tokens.
const COMMON = [
  ' the', ' a', ' to', ' and', ' of', ' is', ' in', ' that', ' it', ' for',
  ' you', ' with', ' on', ' be', ' my', ' I', ' we', ' this', ' not', ' are',
  ' your', ' as', ' at', ' by', ' from', ' just', ' more', ' all', ' one', ' when',
  ' about', ' up', ' out', ' me', ' they', ' what', ' our', ' who', ' being', ' having',
  ' getting', ' feeling', ' losing', ' making', ' finding', ' knowing', ' the way',
  ' people', ' time', ' life', ' love', ' world', ' day', ' things', ' work',
  ' every', ' really', ' always', ' never', ' probably', ' definitely', ' maybe',
  ' good', ' better', ' best', ' new', ' own', ' able', ' willing', ' free',
  ' coffee', ' sunshine', ' family', ' friends', ' home', ' money', ' control',
  ' able to', ' going to', ' the fact', ' a good', ' a lot', ' each other',
  '.', ',', ' and the', ' to be', ' of the', ' in the', ' that I', ' that we',
];

// Non-boundary continuations, so a match can land mid-word too.
const SUFFIX = ['s', 'ing', 'ed', 'e', 'ly', 'er', 'ion', 'y', 'ness', 'ment'];

function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mockTopLogprobs(modelId, assistantText) {
  const rnd = mulberry32(hash(modelId + '|' + assistantText));

  // Per-(model, context) noisy re-rank of the common vocabulary, then take the
  // top 20. Adding SUFFIX candidates lets the greedy matcher chew mid-word.
  // Light re-rank: the jitter (±~4 places) reshuffles locally per model/context
  // but keeps the most frequent tokens reliably inside the top-20, so ordinary
  // words match and read as clanker while rare words fall out and read human.
  const pool = COMMON.concat(assistantText.endsWith(' ') ? [] : SUFFIX);
  const ranked = pool
    .map((text, i) => ({ text, key: i + rnd() * 6 }))
    .sort((a, b) => a.key - b.key)
    .slice(0, 20);

  // Zipf-ish decay with jitter: top token ≈ -0.25 nats, 20th ≈ -4.6 nats.
  return ranked.map((c, i) => ({
    text: c.text,
    logprob: -(0.25 + i * 0.22 + rnd() * 0.3),
  }));
}
