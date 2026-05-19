import { NODE_API_PORT } from './config/env.js';
import { createApp } from './app.js';

const app = createApp();

app.listen(NODE_API_PORT, '127.0.0.1', () => {
  console.log(`Node API running at http://127.0.0.1:${NODE_API_PORT}`);
});
