import { NODE_API_HOST, NODE_API_PORT } from './config/env.js';
import { createApp } from './app.js';

const app = createApp();

app.listen(NODE_API_PORT, NODE_API_HOST, () => {
  console.log(`Node API running at http://${NODE_API_HOST}:${NODE_API_PORT}`);
});
