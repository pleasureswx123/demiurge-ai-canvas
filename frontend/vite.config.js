import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 3100,
    strictPort: true,
    proxy: {
      '/api/node': {
        target: 'http://127.0.0.1:3200',
        changeOrigin: true,
      },
      '/api/media': {
        target: 'http://127.0.0.1:3300',
        changeOrigin: true,
      },
      '/api/project': {
        target: 'http://127.0.0.1:3200',
        changeOrigin: true,
      },
      '/api/material-library': {
        target: 'http://127.0.0.1:3200',
        changeOrigin: true,
      },
      '/api/video-file': {
        target: 'http://127.0.0.1:3300',
        changeOrigin: true,
      },
      '/api/video-task': {
        target: 'http://127.0.0.1:3300',
        changeOrigin: true,
      },
      '/api/generate-image': {
        target: 'http://127.0.0.1:3300',
        changeOrigin: true,
      },
      '/api/generate-video': {
        target: 'http://127.0.0.1:3300',
        changeOrigin: true,
      },
      '/api/seedance-face-review': {
        target: 'http://127.0.0.1:3300',
        changeOrigin: true,
      },
    },
  },
})
