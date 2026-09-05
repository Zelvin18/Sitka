import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, '../src/shared'),
      '@renderer': resolve(__dirname, '../src/renderer/src'),
      // The renderer lives outside this folder, so its bare imports must be
      // pinned to this project's node_modules for the Vercel build.
      react: resolve(__dirname, 'node_modules/react'),
      'react-dom': resolve(__dirname, 'node_modules/react-dom'),
      qrcode: resolve(__dirname, 'node_modules/qrcode')
    }
  },
  server: {
    fs: { allow: [resolve(__dirname, '..')] }
  },
  build: {
    rollupOptions: {
      input: {
        landing: resolve(__dirname, 'index.html'),
        app: resolve(__dirname, 'app.html'),
        event: resolve(__dirname, 'event.html'),
        host: resolve(__dirname, 'host.html'),
        legal: resolve(__dirname, 'legal.html'),
        replay: resolve(__dirname, 'replay.html'),
        stage: resolve(__dirname, 'stage.html')
      }
    }
  }
})
