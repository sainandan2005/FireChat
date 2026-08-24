import { test, expect } from "@playwright/test";
import { makeUser, registerViaApi, loginViaUi } from "./helpers";

test.describe("authentication", () => {
  test("unauthenticated users are redirected to login", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login\?next=%2F/);
  });

  test("register → logout → login round-trip through the UI", async ({ page }) => {
    const user = makeUser("auth");
    const email = user.email;

    await page.goto("/register");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Username").fill(user.username);
    await page.getByLabel("Password").fill(user.password);
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page).toHaveURL(/\/$|\/$/);
    await expect(page.locator("footer").getByText(user.username)).toBeVisible();

    // logout via footer
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/);

    // login again with the same credentials
    await loginViaUi(page, { ...user, email });
    await expect(page.locator("footer").getByText(user.username)).toBeVisible();
  });

  test("wrong password shows an error", async ({ page }) => {
    const user = makeUser("wrongpw");
    await registerViaApi(user, "http://localhost:3000");

    await page.goto("/login");
    await page.getByLabel("Email or username").fill(user.username);
    await page.getByLabel("Password").fill("definitely-wrong");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByText("Invalid credentials")).toBeVisible();
  });
});
