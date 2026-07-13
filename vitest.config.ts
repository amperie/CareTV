import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@caretv/adapters": new URL("./packages/adapters/src/index.ts", import.meta.url).pathname,
      "@caretv/config": new URL("./packages/config/src/index.ts", import.meta.url).pathname,
      "@caretv/core": new URL("./packages/core/src/index.ts", import.meta.url).pathname,
      "@caretv/database": new URL("./packages/database/src/index.ts", import.meta.url).pathname,
      "@caretv/state-machine": new URL("./packages/state-machine/src/index.ts", import.meta.url)
        .pathname
    }
  },
  test: {
    coverage: {
      reporter: ["text", "html"]
    },
    globals: true,
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"]
  }
});
