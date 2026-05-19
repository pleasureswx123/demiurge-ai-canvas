export const NODE_API_BASE = import.meta.env.VITE_NODE_API_BASE || '/api/node';
export const MEDIA_API_BASE = import.meta.env.VITE_MEDIA_API_BASE || '/api/media';

export function nodeApi(path) {
  return `${NODE_API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
}

export function mediaApi(path) {
  return `${MEDIA_API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
}
