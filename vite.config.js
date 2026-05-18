import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api/generate-image': {
        target: 'http://127.0.0.1:8790',
        changeOrigin: true,
      },
      '/api/generate-video': {
        target: 'http://127.0.0.1:8790',
        changeOrigin: true,
      },
      '/api/video-task': {
        target: 'http://127.0.0.1:8790',
        changeOrigin: true,
      },
      '/api/video-file': {
        target: 'http://127.0.0.1:8790',
        changeOrigin: true,
      },
      '/api/seedance-face-review': {
        target: 'http://127.0.0.1:8790',
        changeOrigin: true,
      },
      // 工程管理 API 固定走 Node（deepseek-proxy 8787），避免与其它 /api 混淆
      '/api/project': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
})
