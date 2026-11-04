import { afterEach, expect, it, vi } from "vitest";
import { getClient, getMode } from "@/lib/meta/client";
afterEach(() => vi.unstubAllEnvs());
it("requires explicit mock mode instead of silently serving fixtures when live credentials are absent", () => {
  vi.stubEnv("OFFLOAD_MOCK", "0"); vi.stubEnv("MODEL_API_KEY", "");
  expect(() => getMode()).toThrow("Live Meta service is not configured");
  vi.stubEnv("OFFLOAD_MOCK", "1"); expect(getMode()).toBe("mock");
});
it("live clients do not automatically retry ambiguous paid attempts", () => {
  vi.stubEnv("MODEL_API_KEY", "test-not-a-real-credential");
  const client = getClient();
  expect(client.maxRetries).toBe(0); expect(client.timeout).toBe(90_000);
});
