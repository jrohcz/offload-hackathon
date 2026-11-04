import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  // Use Chromium's full new-headless renderer. The separate headless-shell
  // build on the verification host never schedules requestAnimationFrame,
  // including on a plain HTML button, so Playwright cannot check stability.
  // Keep normal actionability checks; do not force clicks or shim page clocks.
  use: { baseURL: "http://localhost:3000", channel: "chromium" },
});
