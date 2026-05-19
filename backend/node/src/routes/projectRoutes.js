import { handleProjectApi } from '../projects-api.mjs';

function bridgeProjectApi(prefix) {
  return async (req, res) => {
    const originalUrl = req.url;
    req.url = `${prefix}${req.url}`;
    try {
      const handled = await handleProjectApi(req, res);
      if (!handled && !res.headersSent) {
        res.status(404).json({ error: 'Local API route not found', url: req.originalUrl });
      }
    } catch (err) {
      console.error('[projects-api]', err);
      if (!res.headersSent) res.status(500).json({ error: err?.message || 'Internal error' });
    } finally {
      req.url = originalUrl;
    }
  };
}

export function registerProjectRoutes(app) {
  app.use('/api/node/project', bridgeProjectApi('/api/project'));
  app.use('/api/node/material-library', bridgeProjectApi('/api/material-library'));

  // Compatibility routes for old saved URLs and any external local bookmarks.
  app.use('/api/project', bridgeProjectApi('/api/project'));
  app.use('/api/material-library', bridgeProjectApi('/api/material-library'));
}
