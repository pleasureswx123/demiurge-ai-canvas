# Demiurge AI Canvas

This repository is organized as a multi-project, multi-service application.
Each project owns one responsibility and has its own dependencies, environment
file, and development workflow.

## Projects

- `frontend`: React/Vite canvas application. Runs on `http://localhost:3100`.
- `backend/node`: Express API for projects, material library, translation, and analysis. Runs on `http://127.0.0.1:3200`.
- `backend/python`: Python media API for image/video generation and media files. Runs on `http://127.0.0.1:3300`.

Shared local data remains at the repository root for phase 1:

- `projects/`
- `outputs/`
- `material-library/`

Both backend services read these locations through their own `.env.local`
configuration.

## Development

Start the three services in separate terminals:

```powershell
cd backend\node
npm run dev
```

```powershell
cd backend\python
node run-image-service-dev.mjs
```

```powershell
cd frontend
npm run dev
```

Open `http://localhost:3100`.

## API Namespaces

The browser only uses namespaced API routes:

- `/api/node/*` goes to the Node API service.
- `/api/media/*` goes to the Python media service.

The frontend Vite proxy owns this split during local development.

## Environment

Each service owns its own env files:

- `frontend/.env.example`
- `backend/node/.env.example`
- `backend/python/.env.example`

Copy the relevant example to `.env.local` in that service directory and fill in
local secrets. Do not put service secrets in the repository root.

## Verification

Minimum migration checks:

```powershell
cd frontend
npm run build
```

```powershell
cd backend\node
npm run lint
npm run start
```

```powershell
cd backend\python
python -m py_compile app\image_generate_service.py app\main.py
python app\image_generate_service.py
```

Then verify the app can list/create/load/save projects, use the material
library, translate/analyze text, generate images, submit video tasks, poll video
status, and read generated media.

The current runnable migration baseline is recorded in
`docs/phase1-baseline.md`.
