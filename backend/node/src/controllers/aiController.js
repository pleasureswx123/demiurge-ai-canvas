import { analyzeText, translateText } from '../services/aiService.js';

function sendError(res, error, fallbackMessage) {
  res.status(error?.statusCode || 500).json({
    error: error?.error?.message || error?.message || fallbackMessage,
  });
}

export async function translate(req, res) {
  try {
    const translated = await translateText(req.body?.text);
    res.json({ translated });
  } catch (error) {
    console.error('[translate]', error);
    sendError(res, error, 'Translate request failed');
  }
}

export async function textAnalyze(req, res) {
  try {
    const text = await analyzeText({
      prompt: req.body?.prompt,
      model: req.body?.model,
      inputImages: req.body?.input_images,
    });
    res.json({ text });
  } catch (error) {
    console.error('[text-analyze]', error);
    sendError(res, error, 'Text analyze request failed');
  }
}
