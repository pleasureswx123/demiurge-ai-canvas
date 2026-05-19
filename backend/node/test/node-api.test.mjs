import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'demiurge-node-api-'));
process.env.PROJECTS_ROOT = path.join(tempRoot, 'projects');
process.env.MATERIAL_LIBRARY_ROOT = path.join(tempRoot, 'material-library');

const { createApp } = await import('../src/app.js');

let server;
let baseUrl;

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();
  return { response, body };
}

before(async () => {
  const app = createApp();
  server = await new Promise((resolve) => {
    const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe('Node API', () => {
  test('reports health without requiring model API keys', async () => {
    const { response, body } = await request('/api/node/health');

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.service, 'node-api');
    assert.equal(typeof body.hasDeepSeekApiKey, 'boolean');
    assert.equal(typeof body.hasArkApiKey, 'boolean');
  });

  test('creates, lists, saves, loads, and deletes a project', async () => {
    const createResult = await request('/api/node/project/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Smoke Project' }),
    });

    assert.equal(createResult.response.status, 200);
    assert.equal(createResult.body.ok, true);
    assert.match(createResult.body.slug, /^proj_/);

    const slug = createResult.body.slug;
    const listResult = await request('/api/node/project/list');

    assert.equal(listResult.response.status, 200);
    assert.ok(listResult.body.projects.some((project) => project.slug === slug));

    const saveResult = await request('/api/node/project/save', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug,
        data: {
          name: 'Smoke Project Updated',
          flow: {
            nodes: [{ id: 'node-1', type: 'aiText', position: { x: 1, y: 2 }, data: { text: 'hello' } }],
            edges: [],
            viewport: { x: 0, y: 0, zoom: 1 },
          },
        },
      }),
    });

    assert.equal(saveResult.response.status, 200);
    assert.equal(saveResult.body.ok, true);

    const loadResult = await request(`/api/node/project/load?slug=${encodeURIComponent(slug)}`);

    assert.equal(loadResult.response.status, 200);
    assert.equal(loadResult.body.ok, true);
    assert.equal(loadResult.body.data.name, 'Smoke Project Updated');
    assert.equal(loadResult.body.data.flow.nodes[0].id, 'node-1');

    const deleteResult = await request(`/api/node/project/delete?slug=${encodeURIComponent(slug)}`, {
      method: 'DELETE',
    });

    assert.equal(deleteResult.response.status, 200);
    assert.equal(deleteResult.body.ok, true);

    const loadDeletedResult = await request(`/api/node/project/load?slug=${encodeURIComponent(slug)}`);
    assert.equal(loadDeletedResult.response.status, 404);
  });

  test('keeps legacy project routes compatible', async () => {
    const createResult = await request('/api/project/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Legacy Route Project' }),
    });

    assert.equal(createResult.response.status, 200);
    assert.equal(createResult.body.ok, true);

    const listResult = await request('/api/project/list');
    assert.equal(listResult.response.status, 200);
    assert.ok(listResult.body.projects.some((project) => project.slug === createResult.body.slug));
  });

  test('rejects project media path traversal', async () => {
    const createResult = await request('/api/node/project/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Traversal Project' }),
    });

    const slug = createResult.body.slug;
    const traversalResult = await request(`/api/node/project/media/${encodeURIComponent(slug)}/..%2Fproject_data.json`);

    assert.ok([400, 404].includes(traversalResult.response.status));
    assert.notEqual(traversalResult.response.status, 200);
  });

  test('saves and lists material library metadata', async () => {
    const saveResult = await request('/api/node/material-library/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Library Item',
        category: '人物',
        kind: 'image',
        assetPath: 'library-item.png',
      }),
    });

    assert.equal(saveResult.response.status, 200);
    assert.equal(saveResult.body.ok, true);
    assert.equal(saveResult.body.item.assetUrl, '/api/node/material-library/media/library-item.png');

    const listResult = await request('/api/node/material-library/list');
    assert.equal(listResult.response.status, 200);
    assert.ok(listResult.body.items.some((item) => item.id === saveResult.body.item.id));
  });

  test('validates AI route inputs before calling model providers', async () => {
    const translateResult = await request('/api/node/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    });

    assert.equal(translateResult.response.status, 400);
    assert.equal(translateResult.body.error, 'Text is required');

    const analyzeResult = await request('/api/node/text-analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '' }),
    });

    assert.equal(analyzeResult.response.status, 400);
    assert.equal(analyzeResult.body.error, 'Prompt is required');
  });
});
