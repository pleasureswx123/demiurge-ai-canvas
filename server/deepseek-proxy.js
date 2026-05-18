import http from 'node:http';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { handleProjectApi } from './projects-api.mjs';

// 先读 .env.local，再回退到 .env
dotenv.config({ path: ['.env.local', '.env'] });

const PORT = 8787;
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const ARK_BASE_URL = process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';
const TRANSLATE_SYSTEM_PROMPT =
  '你是一个专业的翻译助手。请自动识别用户输入的语言。如果是中文，请将其翻译成适合作为 AI 绘画提示词的英文；如果是英文，请将其翻译成流畅的中文。请只返回翻译后的纯文本结果，绝对不要包含任何解释、引号或多余的对话。';
const ANALYZE_SYSTEM_PROMPT =
  '你是一个视觉内容分析助手。请结合用户提供的图片和文字要求，直接给出准确、清晰、结构化的中文分析结果。不要寒暄，不要解释你的工作流程，不要输出与任务无关的内容。';
const ANALYZE_FALLBACK_MODEL = process.env.DEEPSEEK_ANALYSIS_MODEL || 'deepseek-chat';
const SEED_ANALYSIS_MODEL = process.env.SEED_ANALYSIS_MODEL || 'doubao-seed-2-0-lite-260215';

const deepseekApiKey = process.env.DEEPSEEK_API_KEY;
const arkApiKey = process.env.ARK_API_KEY || process.env.VOLCENGINE_ARK_API_KEY || process.env.DOUBAO_API_KEY;

const deepseekClient =
  deepseekApiKey &&
  new OpenAI({
    apiKey: deepseekApiKey,
    baseURL: DEEPSEEK_BASE_URL,
  });

const arkClient =
  arkApiKey &&
  new OpenAI({
    apiKey: arkApiKey,
    baseURL: ARK_BASE_URL,
  });

const sendJson = (res, statusCode, body) => {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  (async () => {
    /** 本地工程 / 素材库 API（定义在 server/projects-api.mjs） */
    if (req.url && (req.url.startsWith('/api/project') || req.url.startsWith('/api/material-library'))) {
      const handled = await handleProjectApi(req, res);
      if (handled) return;
      // 禁止落入下方通用 404「Not found」，否则前端只看到莫名提示
      return sendJson(res, 404, {
        error: 'Local API 未命中路由',
        method: req.method,
        url: req.url,
        hint: '请确认已用最新代码启动 node server/deepseek-proxy.js（端口 8787）',
      });
    }

    if (req.method === 'GET' && req.url === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        hasDeepSeekApiKey: Boolean(deepseekApiKey),
        hasArkApiKey: Boolean(arkApiKey),
      });
    }

    if (req.method !== 'POST' || !['/api/translate', '/api/text-analyze'].includes(req.url)) {
      return sendJson(res, 404, { error: 'Not found' });
    }

    let rawBody = '';
    req.on('data', (chunk) => {
      rawBody += chunk;
    });

    req.on('end', async () => {
      try {
        const body = JSON.parse(rawBody || '{}');

        if (req.url === '/api/translate') {
          if (!deepseekApiKey || !deepseekClient) {
            return sendJson(res, 500, {
              error: 'Missing DEEPSEEK_API_KEY. Please set it in .env.local',
            });
          }

          const { text } = body;
          if (!text || !String(text).trim()) {
            return sendJson(res, 400, { error: 'Text is required' });
          }

          const completion = await deepseekClient.chat.completions.create({
            model: 'deepseek-chat',
            temperature: 0.2,
            messages: [
              {
                role: 'system',
                content: TRANSLATE_SYSTEM_PROMPT,
              },
              {
                role: 'user',
                content: String(text),
              },
            ],
          });

          const translated =
            completion.choices?.[0]?.message?.content?.trim() || '';

          return sendJson(res, 200, {
            translated,
          });
        }

        const { prompt, input_images: inputImages = [] } = body;
        if (!prompt || !String(prompt).trim()) {
          return sendJson(res, 400, { error: 'Prompt is required' });
        }

        const selectedModel = String(body?.model || '').trim() || 'Seed-2.0-lite';
        const normalizedImages = Array.isArray(inputImages)
          ? inputImages.filter((item) => typeof item === 'string' && item.trim()).slice(0, 4)
          : [];

        let client;
        let model;

        if (selectedModel === 'Seed-2.0-lite') {
          if (!arkApiKey || !arkClient) {
            return sendJson(res, 500, {
              error: 'Missing ARK_API_KEY. Please set it in .env.local for Seed-2.0-lite',
            });
          }
          client = arkClient;
          model = SEED_ANALYSIS_MODEL;
        } else {
          if (!deepseekApiKey || !deepseekClient) {
            return sendJson(res, 500, {
              error: 'Missing DEEPSEEK_API_KEY. Please set it in .env.local',
            });
          }
          client = deepseekClient;
          model = ANALYZE_FALLBACK_MODEL;
        }

        const completion = await client.chat.completions.create({
          model,
          temperature: 0.2,
          messages: [
            {
              role: 'system',
              content: ANALYZE_SYSTEM_PROMPT,
            },
            {
              role: 'user',
              content: normalizedImages.length
                ? [
                    {
                      type: 'text',
                      text: String(prompt),
                    },
                    ...normalizedImages.map((url) => ({
                      type: 'image_url',
                      image_url: {
                        url,
                      },
                    })),
                  ]
                : String(prompt),
            },
          ],
        });

        const text = completion.choices?.[0]?.message?.content?.trim() || '';

        return sendJson(res, 200, {
          text,
        });
      } catch (error) {
        console.error(req.url === '/api/translate' ? 'DeepSeek translate failed:' : 'DeepSeek text analyze failed:', error);
        return sendJson(res, 500, {
          error:
            error?.error?.message ||
            error?.message ||
            (req.url === '/api/translate' ? 'Translate request failed' : 'Text analyze request failed'),
        });
      }
    });
  })().catch((err) => {
    console.error(err);
    sendJson(res, 500, { error: err?.message || 'Internal error' });
  });
});

server
  .listen(PORT, '127.0.0.1', () => {
    console.log(`DeepSeek + projects API running at http://127.0.0.1:${PORT}`);
  })
  .on('error', (err) => {
    if (err?.code === 'EADDRINUSE') {
      console.error(
        `\n[端口被占用] ${PORT} 已被其他程序使用，工程 API 无法启动。\n` +
          `请先关掉之前开的「node server/deepseek-proxy.js」窗口，或在 PowerShell 执行：\n` +
          `  netstat -ano | findstr :${PORT}\n` +
          `记下最后一列 PID，再执行：taskkill /PID <PID> /F\n`
      );
    } else {
      console.error('[server listen]', err);
    }
    process.exit(1);
  });
