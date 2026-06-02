import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// `apps/web` reaches into the workspace packages via relative `.ts` source
// paths (not the bare package specifier — `packages/ir`'s `main` points at an
// unbuilt `dist/` per ADR-0013). Vite handles `.ts` natively, so no aliases
// are required: the import chain
//   apps/web → packages/codegen/src/index.ts → packages/ir/src/validate.ts
// has no runtime `.js` specifiers (validate.ts's only `.js` import is
// `import type`, which erases). See ADR-0022.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  // Allow Vite's dev server to serve files from the monorepo root so the
  // relative imports into `packages/ir` and `packages/codegen` resolve.
  server: { fs: { allow: ["../.."] } },
  build: {
    // Output the single-file build to the root /docs folder so GitHub Pages
    // can serve it directly from the "Deploy from branch → /docs" setting.
    outDir: "../../docs",
    // Preserve existing documentation files (ARCHITECTURE.md, DECISIONS.md, etc.)
    emptyOutDir: false,
  },
});
