import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, '../src/shared'),
      '@renderer': resolve(__dirname, '../src/renderer/src')
    }
  },
  server: {
    fs: { allow: [resolve(__dirname, '..')] }
  },
  build: {
    rollupOptions: {
      input: {
        app: resolve(__dirname, 'app.html'),
        main: resolve(__dirname, 'index.html'),
        host: resolve(__dirname, 'host.html')
      }
    }
  }
})
