import { test, expect } from "@playwright/test";
import {
  makeUser,
  registerViaApi,
  loginViaUi,
  sendMessage,
} from "./helpers";

test.describe("two-user realtime chat", () => {
  let alice: ReturnType<typeof makeUser> & { token?: string; userId?: string };
  let bob: ReturnType<typeof makeUser> & { token?: string; userId?: string };

  test.beforeAll(async ({ baseURL }) => {
    alice = makeUser("alice");
    bob = makeUser("bob");
    const a = await registerViaApi(alice, baseURL!);
    const b = await registerViaApi(bob, baseURL!);
    alice.token = a.token;
    alice.userId = a.userId;
    bob.token = b.token;
    bob.userId = b.userId;
  });

  test("live message, reply, and reaction sync across two browsers", async ({ browser }) => {
    const aliceCtx = await browser.newContext();
    const bobCtx = await browser.newContext();
    const alicePage = await aliceCtx.newPage();
    const bobPage = await bobCtx.newPage();

    await loginViaUi(alicePage, alice);
    await loginViaUi(bobPage, bob);

    // alice starts a DM with bob via the new-chat dialog
    await alicePage.getByRole("button", { name: "New conversation" }).click();
    await alicePage.getByPlaceholder("Search people by username or email").fill(bob.username);
    await expect(
      alicePage.locator("li", { hasText: bob.username }).locator("button")
    ).toBeVisible();
    await alicePage.locator("li", { hasText: bob.username }).locator("button").first().click();

    // both sides now have the conversation open
    await expect(alicePage.getByLabel("Message", { exact: true })).toBeVisible();
    await bobPage.goto("/");
    await bobPage.locator("a", { hasText: alice.username }).first().click();
    await expect(bobPage.getByLabel("Message", { exact: true })).toBeVisible();

    // alice sends → bob receives live
    await sendMessage(alicePage, "hello from playwright");
    await expect(bobPage.getByText("hello from playwright").first()).toBeVisible({ timeout: 10_000 });

    // bob replies → alice receives live
    await sendMessage(bobPage, "hey alice, got it");
    await expect(alicePage.getByText("hey alice, got it").first()).toBeVisible({ timeout: 10_000 });

    // bob hovers alice's message and reacts 🔥
    const incoming = alicePage.getByText("hello from playwright");
    await incoming.click({ button: "right" }).catch(() => {});
    await bobPage.locator("li.group\\/msg").first().hover();
    await bobPage.getByRole("button", { name: "Add reaction" }).first().click();
    await bobPage.getByRole("button", { name: "🔥" }).click();

    // alice sees the reaction chip
    await expect(
      alicePage.locator("button", { hasText: "🔥" }).first()
    ).toBeVisible({ timeout: 10_000 });

    await aliceCtx.close();
    await bobCtx.close();
  });
});
