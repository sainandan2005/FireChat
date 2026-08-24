import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";

export interface TestUser {
  email: string;
  username: string;
  password: string;
  token?: string;
  userId?: string;
}

export function makeUser(prefix: string): TestUser {
  const id = randomUUID().slice(0, 8);
  return {
    email: `${prefix}-${id}@e2e.dev`,
    username: `e2e_${prefix}_${id.replace(/-/g, "")}`.slice(0, 20),
    password: "password123",
  };
}

/** Registers via API and returns the session token + user id. */
export async function registerViaApi(user: TestUser, baseURL: string): Promise<{ token: string; userId: string }> {
  // unique spoofed IP per registration so dev rate limits don't cascade across tests
  const headers = { "content-type": "application/json", "x-forwarded-for": `10.77.${randomNumber()}.${randomNumber()}` };
  const res = await fetch(`${baseURL}/api/auth/register`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: user.email, username: user.username, password: user.password }),
  });
  if (res.status === 409) {
    return loginViaApi(user, baseURL);
  }
  expect(res.status).toBe(201);
  const json = (await res.json()) as { token: string; user: { id: string } };
  return { token: json.token, userId: json.user.id };
}

function randomNumber(): number {
  return Math.floor(Math.random() * 250) + 1;
}

export async function loginViaApi(user: TestUser, baseURL: string): Promise<{ token: string; userId: string }> {
  const res = await fetch(`${baseURL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: user.username, password: user.password }),
  });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { token: string; user: { id: string } };
  return { token: json.token, userId: json.user.id };
}

/** Logs a page in through the real UI form. */
export async function loginViaUi(page: Page, user: TestUser): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email or username").fill(user.username);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

/** Sends a chat message through the composer. */
export async function sendMessage(page: Page, text: string): Promise<void> {
  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill(text);
  await composer.press("Enter");
}
