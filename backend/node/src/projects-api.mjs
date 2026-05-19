/**
 * 本地「工程 / 项目」文件系统 API（运行在 Node API 服务，默认端口 3200）。
 *
 * 目录约定（相对仓库根目录）:
 *   projects/
 *     <slug>/
 *       project_data.json   ← 画布序列化存档
 *       assets/             ← 该工程专属生成素材（由 Python 服务写入）
 *
 * 添加位置：由 Express 入口在收到 /api/node/project* 时转发到本模块。
 */
import { handleMaterialLibraryApi } from './controllers/materialLibraryController.js';
import { handleProjectStorageApi } from './controllers/projectController.js';
import { ensureProjectsRoot } from './repositories/projectRepository.js';
import { ensureMaterialLibraryRoot } from './repositories/materialLibraryRepository.js';
import { safeRequestPathname, sendJson } from './utils/http.js';

export async function handleProjectApi(req, res) {
  const pathname = safeRequestPathname(req.url);

  // CORS（本地 Vite 同源开发一般不需要；保留以防直连端口）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  try {
    await ensureProjectsRoot();
    await ensureMaterialLibraryRoot();

    if (pathname.startsWith('/api/material-library')) {
      return await handleMaterialLibraryApi(req, res, pathname);
    }

    if (pathname.startsWith('/api/project')) {
      return await handleProjectStorageApi(req, res, pathname);
    }
  } catch (err) {
    if (err?.message === '__material_library_not_found__') {
      sendJson(res, 404, { error: '素材不存在' });
      return true;
    }
    console.error('[projects-api]', err);
    sendJson(res, 500, { error: err?.message || '服务器错误' });
    return true;
  }

  return false;
}
