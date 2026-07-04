// The question bank lives server-side so /api/score can't be pointed at
// arbitrary prompts (each score request costs real model calls). Each session
// gets QUESTIONS_PER_SESSION drawn at random from the bank — repeat visits get
// a fresh mix. All stems share the same shape (mid-sentence completions) so
// the anchored-scoring calibration (d0) carries across the whole bank.
export const QUESTIONS = [
  { id: 'wake', prompt: 'The best part of waking up is' },
  { id: 'fear', prompt: 'My biggest fear is' },
  { id: 'internet', prompt: 'The internet would be a better place if' },
  { id: 'ai', prompt: 'In five years, AI will' },
  { id: 'life', prompt: 'The secret to a good life is' },
  { id: 'controversial', prompt: 'My most controversial opinion is' },
  { id: 'purchase', prompt: 'The best purchase I ever made was' },
  { id: 'nobody', prompt: 'Nobody talks about how' },
  { id: 'decree', prompt: 'If I ruled the world, my first decree would be' },
  { id: 'overrated', prompt: 'The most overrated thing in the world is' },
  { id: 'speech', prompt: 'I could give a 20-minute speech with no prep on' },
  { id: 'meal', prompt: 'My last meal on earth would be' },
  { id: 'weird', prompt: 'The weirdest thing I believe is' },
  { id: 'peak', prompt: 'Humanity peaked when' },
  { id: 'toxic', prompt: 'My toxic trait is' },
  { id: 'smell', prompt: 'The smell that takes me back is' },
  { id: 'robots', prompt: 'If robots take over, I will be spared because' },
  { id: 'hill', prompt: 'The hill I will die on is' },
  { id: 'threeam', prompt: 'At 3am I am usually' },
  { id: 'human', prompt: 'The most human thing a person can do is' },
];

export const QUESTIONS_PER_SESSION = 5;

// Fisher–Yates over a copy, take the first n.
export function pickQuestions(n = QUESTIONS_PER_SESSION) {
  const pool = [...QUESTIONS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}
