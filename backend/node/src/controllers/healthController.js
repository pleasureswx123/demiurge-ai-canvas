import { getModelHealth } from '../services/aiService.js';

export function health(_req, res) {
  res.json({
    ok: true,
    service: 'node-api',
    ...getModelHealth(),
  });
}
