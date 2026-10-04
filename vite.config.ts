import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	root: "src/ui",
	plugins: [react()],
	build: { outDir: "../../dist/client", emptyOutDir: true },
	// `vite` (dev server) proxies to a running `wrangler dev`.
	server: { proxy: { "/api": { target: "http://localhost:8787", ws: true }, "/preview": "http://localhost:8787", "/mcp": "http://localhost:8787" } },
});
