import { mediaApi, nodeApi } from './routes';

function rewritePathname(pathname) {
  if (pathname.startsWith('/api/node/') || pathname.startsWith('/api/media/')) {
    return pathname;
  }
  if (pathname.startsWith('/api/project/')) {
    return nodeApi(pathname.slice('/api'.length));
  }
  if (pathname.startsWith('/api/material-library/')) {
    return nodeApi(pathname.slice('/api'.length));
  }
  if (pathname.startsWith('/api/video-file/')) {
    return mediaApi(pathname.slice('/api'.length));
  }
  return pathname;
}

export function normalizeAssetUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return value;
  const trimmed = value.trim();

  if (trimmed.startsWith('/')) {
    const [pathname, suffix = ''] = trimmed.split(/([?#].*)/, 2);
    return `${rewritePathname(pathname)}${suffix}`;
  }

  try {
    const url = new URL(trimmed, window.location.origin);
    const nextPath = rewritePathname(url.pathname);
    if (nextPath === url.pathname) return value;
    return `${nextPath}${url.search}${url.hash}`;
  } catch {
    return value;
  }
}

function normalizeDeep(value) {
  if (typeof value === 'string') return normalizeAssetUrl(value);
  if (Array.isArray(value)) return value.map((item) => normalizeDeep(item));
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, normalizeDeep(item)])
  );
}

export function normalizeFlowAssetUrls(flow) {
  if (!flow || typeof flow !== 'object') return flow;
  return normalizeDeep(flow);
}
