# Architecture

The repository has three independently owned projects.

## Frontend

`frontend` owns the user interface only:

- routes and pages
- React components
- hooks and state
- frontend API wrappers
- styles and assets

It does not read project files directly and does not call external model
providers directly.

Current internal layout:

- `src/api` for frontend API helpers and asset URL normalization
- `src/components` for shared UI components
- `src/store` for client-side state and contexts
- `src/features` for feature-owned UI/configuration
- `src/utils` for reusable frontend utilities
- `src/styles` for global styles

Only `App.jsx` and `main.jsx` remain at the frontend source root as application entry/orchestration files.

## Node API

`backend/node` owns local project and library APIs:

- project list/create/load/save/delete/copy/rename
- project assets and thumbnails
- material library data and media
- translation and text/image analysis
- model-provider client calls for Node-owned workflows

The service runs on port `3200` and is exposed to the browser under
`/api/node`.

Node internal boundaries:

- `routes` registers Express routes
- `controllers` handle HTTP request/response behavior
- `services` handle business flow and derived data
- `repositories` handle local file/index access
- `clients` handle external model providers
- `config` owns environment and storage configuration

## Python Media API

`backend/python` owns media workflows:

- image generation
- video generation
- task polling
- generated media file serving
- media-provider integrations

The service runs on port `3300` and is exposed to the browser under
`/api/media`.

The current production media runtime remains `app/image_generate_service.py`.
Shared configuration and media path infrastructure live in `app/core`.

## Data Boundary

During phase 1, shared local data stays at the repository root and is configured
through service env files. This keeps existing data readable while the services
gain clear project boundaries.

The next refactor phase should reduce cross-service file sharing by routing
cross-service writes through explicit APIs.
