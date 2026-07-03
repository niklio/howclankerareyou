// The question bank lives server-side so /api/score can't be pointed at
// arbitrary prompts (each score request costs real model calls).
export const QUESTIONS = [
  { id: 'wake', prompt: 'The best part of waking up is' },
  { id: 'fear', prompt: 'My biggest fear is' },
  { id: 'internet', prompt: 'The internet would be a better place if' },
  { id: 'ai', prompt: 'In five years, AI will' },
  { id: 'life', prompt: 'The secret to a good life is' },
  { id: 'waste', prompt: 'My favorite way to waste an afternoon is' },
  { id: 'advice', prompt: 'If I could tell my younger self one thing, it would be' },
  { id: 'overrated', prompt: 'The most overrated thing in modern life is' },
];
