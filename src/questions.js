// The question bank lives server-side so /api/score can't be pointed at
// arbitrary prompts (each score request costs real model calls).
export const QUESTIONS = [
  { id: 'wake', prompt: 'The best part of waking up is' },
  { id: 'fear', prompt: 'My biggest fear is' },
  { id: 'internet', prompt: 'The internet would be a better place if' },
  { id: 'ai', prompt: 'In five years, AI will' },
  { id: 'life', prompt: 'The secret to a good life is' },
];
