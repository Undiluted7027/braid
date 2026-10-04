import { defineConfig } from "vite";

// The command-line launcher as one file, served by the instance at /braid.mjs so that
// `curl -O <instance>/braid.mjs && node braid.mjs join ...` works with nothing installed but Node.
export default defineConfig({
	build: {
		ssr: "cli/braid.mjs", outDir: "dist/client", emptyOutDir: false, copyPublicDir: false, minify: false,
		rollupOptions: { output: { entryFileNames: "braid.mjs", format: "es" } },
	},
});
