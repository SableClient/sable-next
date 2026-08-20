import { sentrySvelteKit } from '@sentry/sveltekit';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { isAbsolute, relative } from 'node:path';

export default defineConfig({
  server: {
    // Keep the frontend endpoint aligned with src-tauri/tauri.conf.json.
    port: 3000,
    strictPort: true,
    watch: {
      ignored: (path) => {
        const file = isAbsolute(path) ? relative(process.cwd(), path) : path;
        if (!file) return false;
        // A build rewrites these, and the reload it triggers cannot help anyway:
        // the SharedWorker holding the old wasm outlives it.
        if (file === 'src/generated/wasm' || file.startsWith('src/generated/wasm/')) return true;
        return file !== 'src' && !file.startsWith('src/') && file !== 'vite.config.ts';
      },
    },
  },
  plugins: [
    sentrySvelteKit({
      // The plugin detects the adapter from `svelte.config.js`, which this
      // project does not have, and does not know `adapter-static` either.
      adapter: 'other',
      autoUploadSourceMaps: Boolean(process.env.SENTRY_AUTH_TOKEN),
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      release: { name: process.env.VITE_APP_VERSION },
      sourcemaps: {
        // `adapter: 'other'` would look in `.svelte-kit/output`, not the copy
        // `adapter-static` writes and the browser loads.
        assets: ['./dist/**/*.js', './dist/**/*.js.map'],
        // Otherwise the maps ship to Cloudflare with the bundle.
        filesToDeleteAfterUpload: ['./dist/**/*.js.map'],
      },
    }),
    sveltekit({
      compilerOptions: {
        // Force runes mode for the project, except for libraries. Can be removed in svelte 6.
        runes: ({ filename }) =>
          filename.split(/[/\\]/).includes('node_modules') ? undefined : true,
      },

      // The web build is a client-side app served as Cloudflare Worker assets.
      // Dynamic app routes are resolved by the client after Cloudflare's SPA
      // fallback serves the root document
      paths: {
        // Cloudflare's SPA fallback may serve this document from a nested route.
        // Absolute asset URLs prevent the browser requesting `/<route>/_app/...`.
        relative: false,
      },
      prerender: {
        handleUnseenRoutes: 'ignore',
      },
      adapter: adapter({
        assets: 'dist',
        pages: 'dist',
      }),
    }),
  ],
});
