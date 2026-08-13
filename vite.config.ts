import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
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
        return (
          Boolean(file) &&
          !['src', 'crates/sable-core', 'crates/sable-wasm'].some(
            (directory) => file === directory || file.startsWith(`${directory}/`)
          ) &&
          !['vite.config.ts', 'svelte.config.js'].includes(file)
        );
      },
    },
  },
  plugins: [
    sveltekit({
      preprocess: vitePreprocess({ script: true }),
      alias: {
        '@': './src',
      },
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
