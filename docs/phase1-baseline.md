# Phase 1 Baseline

This document records the runnable baseline after the repository was split into
three service-owned projects.

## Service Layout

- `frontend`: React/Vite UI, port `3100`
- `backend/node`: Express API, port `3200`
- `backend/python`: Python media service, port `3300`

The repository root does not own a runtime command. Start each service from its
own project directory.

## Required Startup

Terminal 1:

```powershell
cd backend\node
npm run dev
```

Terminal 2:

```powershell
cd backend\python
node run-image-service-dev.mjs
```

Terminal 3:

```powershell
cd frontend
npm run dev
```

Open `http://127.0.0.1:3100`.

## Canonical API Namespaces

New frontend code should call only:

- `/api/node/*`
- `/api/media/*`

Compatibility routes remain intentionally available for old project data and
older browser sessions:

- `/api/project/*`
- `/api/material-library/*`
- `/api/video-file/*`
- `/api/video-task/*`
- `/api/generate-image`
- `/api/generate-video`
- `/api/seedance-face-review`

Do not remove these compatibility paths until all stored project data has been
migrated and verified.

## Data Compatibility

Old `project_data.json` files may contain asset URLs such as:

- `/api/project/media/...`
- `/api/material-library/media/...`
- `/api/video-file/...`

The baseline preserves these projects through three layers:

- frontend URL normalization in `frontend/src/api/assetUrls.js`
- Node API load-time normalization in `backend/node/src/projects-api.mjs`
- Vite proxy compatibility in `frontend/vite.config.js`

## Baseline Checks

Run these before starting deeper refactors:

```powershell
cd frontend
npm run build
```

```powershell
cd backend\node
npm run lint
```

```powershell
cd backend\python
python -m py_compile app\image_generate_service.py app\main.py test_image_generate.py
```

With all services running, verify:

- `GET http://127.0.0.1:3100`
- `GET http://127.0.0.1:3100/api/node/health`
- `GET http://127.0.0.1:3100/api/media/health`
- `GET http://127.0.0.1:3100/api/node/project/list`
- `GET http://127.0.0.1:3100/api/node/material-library/list`
- at least one old `/api/project/media/...` URL returns `200`
- at least one old `/api/video-file/...` URL returns `200`

Browser acceptance:

- project dashboard renders thumbnails without broken images
- an old project opens with assets visible
- console has no errors during dashboard load or project open
