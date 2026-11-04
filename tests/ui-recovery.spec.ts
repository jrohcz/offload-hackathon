import { test, expect, type Page } from "@playwright/test";

const pixel = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const draft = () => ({
  mode: "mock", approved: false,
  segmentation: { status: "ok", maskCount: 1 },
  originalDataUrl: pixel, cutoutDataUrl: pixel, heroDataUrl: pixel,
  condition: { defects: [], overlayDataUrl: pixel },
  listing: {
    title: "Test turntable", category: "Electronics", condition: "Used",
    description: "A turntable. Working condition untested.", brand: null, model: null,
    facts_confirmed: ["A black turntable"], facts_unknown: ["Working condition", "Cartridge type"],
    questions_for_owner: ["Does it work?", "What is the cartridge type?"], sam_concept: "turntable",
    priceSuggestion: { range: null, quick_sale: null, currency: "EUR", sources: [] },
  },
  ownerPolicy: { minPrice: null, currency: "EUR", pickupOnly: true, pickupWindows: [], availability: null, facts: [] },
});

async function bootstrap(page: Page) {
  await page.route("**/api/session", route => route.fulfill({ json: { csrfToken: "browser-test-token", mode: "mock" } }));
  await page.route("**/api/inbox", route => route.fulfill({ json: { cards: [], simulation: null } }));
  await page.route("**/api/find", route => route.fulfill({ json: { requests: [], offers: [] } }));
}

test("Network failure unlocks Sell and preserves a useful retry path", async ({ page }) => {
  await bootstrap(page);
  let writes = 0;
  await page.route("**/api/sell", async route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { sell: null } });
    expect(route.request().headers()["x-offload-csrf"]).toBe("browser-test-token");
    writes += 1;
    if (writes === 1) return route.abort("failed");
    return route.fulfill({ json: draft() });
  });
  const unhandled: string[] = [];
  page.on("pageerror", error => unhandled.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "Try the demo item" }).click();
  await expect(page.getByText(/Connection lost/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Try the demo item" })).toBeEnabled();
  await page.getByRole("button", { name: "Try the demo item" }).click();
  await expect(page.getByText("Draft ready for your review.")).toBeVisible();
  await expect(page.getByText("Price estimate unavailable")).toBeVisible();
  await expect(page.getByText("Mock mode · sample responses")).toBeVisible();
  expect(unhandled).toEqual([]);
});

test("HTML server errors are readable and do not leave Sell busy", async ({ page }) => {
  await bootstrap(page);
  await page.route("**/api/sell", route => route.request().method() === "GET"
    ? route.fulfill({ json: { sell: null } })
    : route.fulfill({ status: 502, contentType: "text/html", body: "<h1>Bad gateway</h1>" }));
  await page.goto("/");
  await page.getByRole("button", { name: "Try the demo item" }).click();
  await expect(page.getByText(/could not finish this request \(502\)/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Try the demo item" })).toBeEnabled();
});

test("Find prevents double submit and preserves input after failure", async ({ page }) => {
  await bootstrap(page);
  await page.route("**/api/sell", route => route.fulfill({ json: { sell: null } }));
  let writes = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/find", async route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { requests: [], offers: [] } });
    writes += 1;
    expect(route.request().headers()["x-offload-csrf"]).toBe("browser-test-token");
    await held;
    return route.fulfill({ status: 503, json: { error: "Store temporarily unavailable. Try again." } });
  });
  await page.goto("/");
  await page.getByLabel("What are you looking for", { exact: true }).fill("Working bicycle");
  const save = page.getByRole("button", { name: "Save need", exact: true });
  await save.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(page.locator(".find-form button")).toBeDisabled();
  await expect.poll(() => writes).toBe(1);
  release();
  await expect(page.locator(".find-card").getByText(/Store temporarily unavailable/)).toBeVisible();
  await expect(save).toBeEnabled();
  await expect(page.getByLabel("What are you looking for", { exact: true })).toHaveValue("Working bicycle");
});

test("Owner answers retain provenance, reset approval, and are saved with CSRF", async ({ page }) => {
  await bootstrap(page);
  let stored = { ...draft(), approved: true };
  await page.route("**/api/sell", async route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { sell: stored } });
    expect(route.request().method()).toBe("PATCH");
    expect(route.request().headers()["x-offload-csrf"]).toBe("browser-test-token");
    stored = { ...stored, ...route.request().postDataJSON() };
    return route.fulfill({ json: { sell: stored } });
  });
  await page.goto("/");
  await page.getByLabel("Does it work?", { exact: true }).fill("No");
  await page.getByRole("button", { name: "Add answers to the listing" }).click();
  await expect(page.getByText("Owner answer — Does it work?: No", { exact: true })).toBeVisible();
  await expect(page.getByText("Owner confirms: item does not work.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve listing in one tap" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Simulation locked" })).toBeDisabled();
  expect(stored.listing.facts_unknown).toEqual(["Cartridge type"]);
  expect(stored.listing.description).toContain("Initial photo draft:");
  expect(stored.listing.description).toContain("Owner update: Does it work? No");
  expect(stored.ownerPolicy.availability).toBeNull();
  await page.reload();
  await expect(page.getByText("Owner confirms: item does not work.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Simulation locked" })).toBeDisabled();
});

test("Native photo and voice inputs remain visible and keyboard focusable", async ({ page }) => {
  await bootstrap(page);
  await page.route("**/api/sell", route => route.fulfill({ json: { sell: null } }));
  await page.goto("/");
  for (const id of ["photo", "voice"]) {
    const control = page.locator(`#${id}`);
    await expect(control).toBeVisible();
    await control.focus();
    await expect(control).toBeFocused();
  }
  await expect(page.getByText("Drop a photo of the item")).toHaveCount(0);
  await expect(page.getByText("0 messages to read")).toHaveCount(0);
});


test("A restored mock draft is labeled separately from current live service mode", async ({ page }) => {
  await bootstrap(page);
  await page.route("**/api/session", route => route.fulfill({ json: { csrfToken: "browser-test-token", mode: "real" } }));
  await page.route("**/api/sell", route => route.fulfill({ json: { sell: draft() } }));
  await page.goto("/");
  await expect(page.getByText("Live Meta API", { exact: true })).toBeVisible();
  await expect(page.getByText("This draft uses mock sample responses.", { exact: true })).toBeVisible();
});

test("Find cards preserve seller terms for review after the input clears and on reload", async ({ page }) => {
  await bootstrap(page);
  await page.route("**/api/sell", route => route.fulfill({ json: { sell: null } }));
  const sellerMessage = "Working toddler bicycle for EUR 80. Pickup Saturday at 10:00 in Brno. Minor paint scratches.";
  const state = {
    requests: [{ id: "review-need", need: "Working toddler bicycle", budget: 100, currency: "EUR", mustWork: true }],
    offers: [{
      id: "review-offer", requestId: "review-need", status: "qualified", sellerMessage,
      questions: [], reasons: [], price: 80, currency: "EUR", pickupSlot: "Saturday at 10:00 in Brno",
      card: { id: "review-card", status: "pending", summary: "Matching offer — EUR 80.", pickupSlot: "Saturday at 10:00 in Brno" },
    }],
  };
  await page.route("**/api/find", route => route.fulfill({ json: state }));
  await page.goto("/");
  const card = page.locator(".find-card .deal-card");
  await expect(page.getByLabel("Seller message", { exact: true })).toHaveValue("");
  await expect(card.getByText("Pickup: Saturday at 10:00 in Brno", { exact: true })).toBeVisible();
  await expect(card.getByText(`Seller message: ${sellerMessage}`, { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Yes", exact: true })).toBeEnabled();
  await page.reload();
  await expect(card.getByText(`Seller message: ${sellerMessage}`, { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(card.getByText("Pickup: Saturday at 10:00 in Brno", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});
