/**
 * The Chrome extension build.
 *
 * The extension is the Sitca web app itself, packaged: app.html and its
 * assets are built exactly as for the website and dropped into
 * extension/dist, next to the manifest, the background worker and the Meet
 * page script from extension/static. Chrome then shows app.html in its side
 * panel. Absolute paths (/assets/…, /signin.webp) resolve against the
 * extension's own root, so nothing in the app changes for this.
 *
 *   cd web && npm run build:ext      →  extension/dist  (load unpacked in Chrome)
 */
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { cpSync, existsSync, mkdirSync, readdirSync, copyFileSync } from 'fs'

// the tests build into a folder of their own, never over the extension a browser has loaded
const OUT = process.env.SITCA_EXT_OUT || resolve(__dirname, '../extension/dist')
const STATIC = resolve(__dirname, '../extension/static')
const PUBLIC = resolve(__dirname, 'public')
/** the pictures the app page needs; the site's films, posters and PNG originals stay on the site */
const KEEP = (f: string): boolean => f.endsWith('.webp') || ['favicon.svg', 'apple-touch-icon.png', 'welcome-hero.png', 'sitca-hero.jpg'].includes(f)

/** manifest, worker, page script and styles, and the few pictures: copied once the app is built */
function extensionFiles(): Plugin {
  return {
    name: 'sitca-extension-files',
    closeBundle() {
      if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })
      cpSync(STATIC, OUT, { recursive: true })
      for (const f of readdirSync(PUBLIC)) if (KEEP(f)) copyFileSync(resolve(PUBLIC, f), resolve(OUT, f))
    }
  }
}

export default defineConfig({
  plugins: [react(), extensionFiles()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, '../src/shared'),
      '@renderer': resolve(__dirname, '../src/renderer/src'),
      react: resolve(__dirname, 'node_modules/react'),
      'react-dom': resolve(__dirname, 'node_modules/react-dom'),
      qrcode: resolve(__dirname, 'node_modules/qrcode'),
      jsqr: resolve(__dirname, 'node_modules/jsqr')
    }
  },
  define: {
    // the app knows it runs inside the extension, and where its server is
    'import.meta.env.VITE_SITCA_EXTENSION': JSON.stringify('1'),
    'import.meta.env.VITE_API_ORIGIN': JSON.stringify('https://sitcaai.vercel.app')
  },
  publicDir: false,
  build: {
    outDir: OUT,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        app: resolve(__dirname, 'app.html')
      }
    }
  }
})
