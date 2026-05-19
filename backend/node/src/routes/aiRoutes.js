import { Router } from 'express';
import { textAnalyze, translate } from '../controllers/aiController.js';

export function createAiRouter() {
  const router = Router();
  router.post('/translate', translate);
  router.post('/text-analyze', textAnalyze);
  return router;
}
