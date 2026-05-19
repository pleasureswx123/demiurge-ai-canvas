import { arkApiKey, arkClient, deepseekApiKey, deepseekClient } from '../clients/modelClients.js';
import { badRequest, internalError } from '../utils/errors.js';

const TRANSLATE_SYSTEM_PROMPT =
  '你是一个专业的翻译助手。请自动识别用户输入的语言。如果是中文，请将其翻译成适合作为 AI 绘画提示词的英文；如果是英文，请将其翻译成流畅的中文。请只返回翻译后的纯文本结果，绝对不要包含任何解释、引号或多余的对话。';
const ANALYZE_SYSTEM_PROMPT =
  '你是一个视觉内容分析助手。请结合用户提供的图片和文字要求，直接给出准确、清晰、结构化的中文分析结果。不要寒暄，不要解释你的工作流程，不要输出与任务无关的内容。';
const ANALYZE_FALLBACK_MODEL = process.env.DEEPSEEK_ANALYSIS_MODEL || 'deepseek-chat';
const SEED_ANALYSIS_MODEL = process.env.SEED_ANALYSIS_MODEL || 'doubao-seed-2-0-lite-260215';

export function getModelHealth() {
  return {
    hasDeepSeekApiKey: Boolean(deepseekApiKey),
    hasArkApiKey: Boolean(arkApiKey),
  };
}

export async function translateText(text) {
  const normalizedText = String(text || '').trim();
  if (!normalizedText) {
    throw badRequest('Text is required');
  }

  if (!deepseekApiKey || !deepseekClient) {
    throw internalError('Missing DEEPSEEK_API_KEY. Please set it in backend/node/.env.local');
  }

  const completion = await deepseekClient.chat.completions.create({
    model: 'deepseek-chat',
    temperature: 0.2,
    messages: [
      { role: 'system', content: TRANSLATE_SYSTEM_PROMPT },
      { role: 'user', content: normalizedText },
    ],
  });

  return completion.choices?.[0]?.message?.content?.trim() || '';
}

export async function analyzeText({ prompt, model: requestedModel, inputImages = [] }) {
  const normalizedPrompt = String(prompt || '').trim();
  if (!normalizedPrompt) {
    throw badRequest('Prompt is required');
  }

  const selectedModel = String(requestedModel || '').trim() || 'Seed-2.0-lite';
  const normalizedImages = Array.isArray(inputImages)
    ? inputImages.filter((item) => typeof item === 'string' && item.trim()).slice(0, 4)
    : [];

  let client;
  let model;

  if (selectedModel === 'Seed-2.0-lite') {
    if (!arkApiKey || !arkClient) {
      throw internalError('Missing ARK_API_KEY. Please set it in backend/node/.env.local');
    }
    client = arkClient;
    model = SEED_ANALYSIS_MODEL;
  } else {
    if (!deepseekApiKey || !deepseekClient) {
      throw internalError('Missing DEEPSEEK_API_KEY. Please set it in backend/node/.env.local');
    }
    client = deepseekClient;
    model = ANALYZE_FALLBACK_MODEL;
  }

  const completion = await client.chat.completions.create({
    model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: ANALYZE_SYSTEM_PROMPT },
      {
        role: 'user',
        content: normalizedImages.length
          ? [
              { type: 'text', text: normalizedPrompt },
              ...normalizedImages.map((url) => ({ type: 'image_url', image_url: { url } })),
            ]
          : normalizedPrompt,
      },
    ],
  });

  return completion.choices?.[0]?.message?.content?.trim() || '';
}
