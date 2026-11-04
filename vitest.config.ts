import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": new URL(".", import.meta.url).pathname } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Unit tests must never write into the developer/demo database.
    env: { OFFLOAD_DB_PATH: "/tmp/offload-test.db", OFFLOAD_MOCK: "1" },
  },
});
