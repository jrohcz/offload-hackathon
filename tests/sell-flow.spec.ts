import { test, expect } from "@playwright/test";

test("Sell flow builds a mock listing", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Try the demo item" }).click();
  await expect(page.getByText("Draft ready for your review.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Approve listing in one tap" })).toBeVisible();
});

test("Sell flow runs simulation and accepts a deal card", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Try the demo item" }).click();
  await expect(page.getByText("Draft ready for your review.")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Approve listing in one tap" }).click();
  await page.getByRole("button", { name: "Run simulation" }).click();
  await expect(page.getByText("yes / no inbox")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Buyer, EUR 120/)).toBeVisible();
  await page.locator(".card.inbox").getByRole("button", { name: "Yes" }).click();
  await expect(page.getByText("accepted")).toBeVisible();
});

test("Approved listing and terminal decision survive a browser reload", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Try the demo item" }).click();
  await expect(page.getByText("Draft ready for your review.")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Approve listing in one tap" }).click();
  await page.getByRole("button", { name: "Run simulation" }).click();
  await expect(page.locator(".card.inbox")).toBeVisible({ timeout: 30_000 });
  await page.locator(".card.inbox").getByRole("button", { name: "Yes", exact: true }).first().click();
  await expect(page.locator(".card.inbox .status-accepted")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Approved — ready for buyers" })).toBeVisible();
  await expect(page.locator(".card.inbox .status-accepted")).toBeVisible();
  await expect(page.locator(".card.inbox").getByRole("button", { name: "Yes", exact: true }).first()).toBeDisabled();
});
