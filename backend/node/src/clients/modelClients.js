import OpenAI from 'openai';
import '../config/env.js';

export const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
export const ARK_BASE_URL = process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';

export const deepseekApiKey = process.env.DEEPSEEK_API_KEY;
export const arkApiKey = process.env.ARK_API_KEY || process.env.VOLCENGINE_ARK_API_KEY || process.env.DOUBAO_API_KEY;

export const deepseekClient =
  deepseekApiKey &&
  new OpenAI({
    apiKey: deepseekApiKey,
    baseURL: DEEPSEEK_BASE_URL,
  });

export const arkClient =
  arkApiKey &&
  new OpenAI({
    apiKey: arkApiKey,
    baseURL: ARK_BASE_URL,
  });
