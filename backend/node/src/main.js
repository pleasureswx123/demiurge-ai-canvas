import express from 'express';
import { NODE_API_PORT } from './config/env.js';
import { createAiRouter } from './routes/aiRoutes.js';
import { createHealthRouter } from './routes/healthRoutes.js';
import { registerProjectRoutes } from './routes/projectRoutes.js';

const app = express();

registerProjectRoutes(app);

app.use(express.json({ limit: '50mb' }));
app.use('/api/node', createHealthRouter());
app.use('/api/node', createAiRouter());

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(NODE_API_PORT, '127.0.0.1', () => {
  console.log(`Node API running at http://127.0.0.1:${NODE_API_PORT}`);
});
