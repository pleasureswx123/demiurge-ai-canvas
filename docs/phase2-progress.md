# Phase 2 Progress

This document records incremental single-responsibility refactors after the runnable Phase 1 baseline.

## Completed

### Node API entrypoint split

`backend/node/src/main.js` is now only responsible for:

- creating the Express app
- installing shared middleware
- registering route modules
- starting the HTTP listener

The Node service now has active boundaries:

- `src/config/` for environment and path configuration
- `src/routes/` for route registration
- `src/controllers/` for HTTP request/response handling
- `src/services/` for business flow
- `src/clients/` for external model-provider clients

Project and material-library APIs are now served through focused controllers while the compatibility bridge keeps old saved URLs working.

### Syntax verification

`backend/node/package.json` now runs syntax checks through `scripts/check-syntax.mjs`, which recursively checks service source files instead of checking only the old entry files.

### Project API support modules

The Phase 1 compatibility module has started moving responsibilities into focused support modules:

- `src/config/storage.js` owns shared data roots, media extension sets, and ffmpeg resolution.
- `src/utils/http.js` owns JSON/body helpers, request pathname normalization, and media responses.
- `src/repositories/materialLibraryRepository.js` owns material-library index reads/writes, asset filename validation, and Seedance subject normalization.
- `src/repositories/projectRepository.js` owns project slug validation, project root setup, default flow creation, and directory copy behavior.
- `src/repositories/projectAssetRepository.js` owns safe project asset path resolution and latest image lookup.
- `src/services/assetUrlService.js` owns legacy asset URL rewriting and canonical `/api/node` / `/api/media` asset URL construction.
- `src/services/projectPreviewService.js` owns dashboard cover tiles, generated history records, and video poster generation.

- `src/controllers/projectController.js` owns project HTTP behavior.
- `src/controllers/materialLibraryController.js` owns material-library HTTP behavior.

`backend/node/src/projects-api.mjs` is now a thin compatibility dispatcher of roughly 50 lines. It owns CORS, shared root initialization, legacy route bridging, and error normalization.

### Python media core modules

The Python media runtime still uses the production-compatible `image_generate_service.py` HTTP server for full image/video functionality, but common infrastructure has moved into `app/core/`:

- `app/core/config.py` owns env loading, service port, service revision, and shared data roots.
- `app/core/media_paths.py` owns per-request output directory binding and project-scoped media URL generation.

The FastAPI shell entrypoint `app/main.py` now reads the same core config, so future FastAPI migration will not create a second configuration path.

### Frontend directories

The frontend now has real code in the intended directories:

- `src/api/` owns API route helpers, material-library API, asset URL normalization, and project asset materialization.
- `src/components/` owns reusable panels, toolbars, and small shared UI components.
- `src/store/` owns canvas UI, node UI, connection hover, generation cancel, and project workspace state.
- `src/features/projects/` owns the project dashboard.
- `src/features/generation/` owns image/video generation model configuration.
- `src/features/nodes/` owns React Flow node implementations.
- `src/utils/` owns mention token utilities.
- `src/styles/` owns global styles.

## Preserved Compatibility

The following routes are still intentionally supported:

- `/api/node/project/*`
- `/api/node/material-library/*`
- `/api/project/*`
- `/api/material-library/*`

The legacy routes are compatibility routes for old saved project data, existing local media URLs, and current browser sessions. They should not be removed until all persisted data has been migrated or rewritten safely.

## Remaining Deepening Work

The remaining work is now deeper internal simplification rather than baseline architecture:

- Split `backend/python/app/image_generate_service.py` further into provider clients, schemas, routers, and image/video services.
- Split the three large frontend node components into smaller hooks/components inside `src/features/nodes`.
- Replace cross-service file sharing with explicit service APIs where it provides a real boundary benefit.

## Latest Checks

- Frontend production build passed.
- Node API syntax check passed.
- Python media service syntax check passed.
- Frontend proxy health checks passed for Node and Python services.
- Project list and material-library list passed through the new API namespace.
- Project create/save/load/delete smoke test passed and cleaned up its temporary project.
- Legacy project asset URLs are still normalized on load.
- Project media and thumbnail `HEAD` checks passed.
- Legacy `/api/video-file/*` compatibility passed.
- Project history returned expected image/video counts.
- Browser dashboard check passed with no broken images and no console errors.
