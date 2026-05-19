import express from 'express';
import { createAiRouter } from './routes/aiRoutes.js';
import { createHealthRouter } from './routes/healthRoutes.js';
import { registerProjectRoutes } from './routes/projectRoutes.js';
import { errorHandler, notFoundHandler } from './middleware/errorMiddleware.js';

export function createApp() {
  const app = express();

  registerProjectRoutes(app);

  app.use(express.json({ limit: '50mb' }));
  app.use('/api/node', createHealthRouter());
  app.use('/api/node', createAiRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
