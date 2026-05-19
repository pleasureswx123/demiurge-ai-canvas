import { analyzeText, translateText } from '../services/aiService.js';

export async function translate(req, res) {
  const translated = await translateText(req.body?.text);
  res.json({ translated });
}

export async function textAnalyze(req, res) {
  const text = await analyzeText({
    prompt: req.body?.prompt,
    model: req.body?.model,
    inputImages: req.body?.input_images,
  });
  res.json({ text });
}
