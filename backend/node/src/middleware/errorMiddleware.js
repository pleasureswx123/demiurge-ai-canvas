import { HttpError } from '../utils/errors.js';

export function notFoundHandler(_req, res) {
  res.status(404).json({ error: 'Not found' });
}

export function errorHandler(error, _req, res, next) {
  if (res.headersSent) {
    next(error);
    return;
  }

  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  const safeStatusCode = statusCode >= 400 && statusCode < 600 ? statusCode : 500;
  const message = error?.error?.message || error?.message || 'Internal server error';

  if (!(error instanceof HttpError) || safeStatusCode >= 500) {
    console.error('[node-api]', error);
  }

  res.status(safeStatusCode).json({ error: message });
}
