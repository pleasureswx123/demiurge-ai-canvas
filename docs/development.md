# Development

## Install

```powershell
cd frontend
npm install
```

```powershell
cd backend\node
npm install
```

```powershell
cd backend\python
pip install -r requirements.txt
```

## Run

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

Open `http://localhost:3100`.

## Health Checks

- Frontend: `http://localhost:3100`
- Node API: `http://127.0.0.1:3200/api/node/health`
- Python media API: `http://127.0.0.1:3300/api/media/health`

## API Routing

Local development routing is configured in `frontend/vite.config.js`:

- `/api/node` -> `http://127.0.0.1:3200`
- `/api/media` -> `http://127.0.0.1:3300`

See `docs/phase1-baseline.md` for the runnable baseline and compatibility
checks that must stay green during the next refactor phase.

## Validation

Run these before treating a refactor step as stable:

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
python -m py_compile app\image_generate_service.py app\main.py app\core\config.py app\core\media_paths.py test_image_generate.py
```

Smoke checks should cover Node health, Python media health, project list,
project create/save/load/delete, material-library list, project history,
legacy media URLs, and the browser dashboard.
