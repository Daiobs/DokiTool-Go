import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

const __dirname = dirname(fileURLToPath(import.meta.url))

function rewriteMonitorRoute(req, _res, next) {
  if (typeof req.url === 'string') {
    const qIndex = req.url.indexOf('?')
    const pathname = qIndex >= 0 ? req.url.slice(0, qIndex) : req.url
    if (pathname === '/monitor' || pathname === '/monitor/') {
      const search = qIndex >= 0 ? req.url.slice(qIndex) : ''
      req.url = `/monitor.html${search}`
    }
  }
  next()
}

function monitorRouteRewritePlugin() {
  return {
    name: 'dokitool-monitor-route-rewrite',
    configureServer(server) {
      server.middlewares.use(rewriteMonitorRoute)
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewriteMonitorRoute)
    },
  }
}

export default defineConfig(({ mode, isSsrBuild }) => ({
  plugins: [vue(), monitorRouteRewritePlugin()],
  build: {
    manifest: true,
    // File hashes give every visual asset a safe long-lived cache key.
    assetsInlineLimit: 0,
    ...(isSsrBuild
      ? {}
      : {
          rollupOptions: {
            input: {
              main: resolve(__dirname, 'index.html'),
              monitor: resolve(__dirname, 'monitor.html'),
            },
          },
        }),
  },
  resolve: {
    alias: {
      '@': '/src'
    }
  },
  server: {
    proxy: {
      '/api': {
        target: loadEnv(mode, process.cwd(), '').DEV_API_TARGET || 'http://127.0.0.1:8081',
        changeOrigin: false,
      },
    },
  },
}))
