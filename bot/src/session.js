// src/session.js
//
// Handles everything related to being (and staying) logged into
// NSE Soko Play (academy.nse.co.ke). Session state (cookies + storage)
// is persisted to disk so we don't log in from scratch on every run.
//
// Credentials come from environment variables — never hardcode them.
//   NSE_EMAIL=you@example.com
//   NSE_PASSWORD=your-password
//
// Usage:
//   import { launchSession } from "./session.js";
//   const { browser, context, page } = await launchSession();
//   ... do stuff with page ...
//   await browser.close();

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import "dotenv/config";

const BASE_URL = "https://academy.nse.co.ke";
const LOGIN_URL = `${BASE_URL}/onboard`;
const DASHBOARD_URL_FRAGMENT = "/trader/dashboard";
const STATE_FILE = path.resolve("./.session/storage-state.json");

function assertCredentials() {
  const { NSE_EMAIL, NSE_PASSWORD } = process.env;
  if (!NSE_EMAIL || !NSE_PASSWORD) {
    throw new Error(
      "Missing NSE_EMAIL / NSE_PASSWORD environment variables. " +
        "Copy .env.example to .env and fill them in."
    );
  }
  return { NSE_EMAIL, NSE_PASSWORD };
}

function ensureStateDir() {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Performs a fresh login via the UI form and saves the resulting
 * session (cookies + localStorage) to disk for reuse.
 */
async function performLogin(page) {
  const { NSE_EMAIL, NSE_PASSWORD } = assertCredentials();

  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

  // The "Log In" tab is selected by default per the screenshot, but
  // click it defensively in case "Sign Up" was last active.
  const loginTab = page.getByRole("tab", { name: /log in/i }).first();
  if (await loginTab.isVisible().catch(() => false)) {
    await loginTab.click();
  }

  const emailInput = page.locator('input[type="email"], input[placeholder*="mail" i]').first();
  const passwordInput = page.locator('input[type="password"]').first();

  await emailInput.waitFor({ state: "visible", timeout: 15000 });
  await emailInput.fill(NSE_EMAIL);
  await passwordInput.fill(NSE_PASSWORD);

  const loginButton = page.getByRole("button", { name: /login/i }).first();
  await loginButton.click();

  // Wait for either the dashboard to load or an error message to appear.
  await Promise.race([
    page.waitForURL(`**${DASHBOARD_URL_FRAGMENT}**`, { timeout: 20000 }),
    page.waitForSelector("text=/invalid|incorrect|failed/i", { timeout: 20000 }),
  ]).catch(() => {});

  if (!page.url().includes(DASHBOARD_URL_FRAGMENT)) {
    throw new Error(
      "Login did not reach the dashboard. Check credentials, or the site " +
        "may have changed its login flow (screenshot the current login " +
        "page again if this keeps failing)."
    );
  }

  ensureStateDir();
  await page.context().storageState({ path: STATE_FILE });
  console.log("[session] Logged in and saved session state.");
}

/**
 * Checks whether the current page/context is actually authenticated.
 * NSE Soko Play redirects to /onboard with a "session has expired"
 * banner when a stored session is stale — this checks for both signals.
 */
export async function isLoggedIn(page) {
  try {
    await page.goto(`${BASE_URL}${DASHBOARD_URL_FRAGMENT}`, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
  } catch {
    return false;
  }

  if (page.url().includes("/onboard")) return false;

  const expiredBanner = page.locator("text=/session has expired/i");
  if (await expiredBanner.isVisible().catch(() => false)) return false;

  // Confirm something only the logged-in dashboard shows.
  const marketStatus = page.locator("text=/market status/i");
  const dashboardOk = await marketStatus.isVisible({ timeout: 5000 }).catch(() => false);
  if (!dashboardOk) return false;

  try {
    const walletResponse = await page.waitForResponse(
      (res) => res.url().indexOf("/api/Wallets/balances") !== -1,
      { timeout: 8000 }
    );
    if (walletResponse.status() === 401) {
      console.log("[session] Wallets/balances returned 401 - treating session as expired.");
      return false;
    }
  } catch {}

  return true;
}

/**
 * Launches a browser + context, restoring a saved session if present,
 * and transparently (re)logs in if the session is missing or expired.
 * This is the "auto re-login on session expiry" behaviour you asked for —
 * every caller just gets a guaranteed-authenticated `page` back.
 */
export async function launchSession({ headless = true } = {}) {
  // If PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 was set (Playwright's own
  // Chromium download unreachable), fall back to a system-installed
  // Chromium via CHROMIUM_PATH — same browser engine, works identically
  // for our purposes.
  const launchOptions = { headless };
  if (process.env.CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.CHROMIUM_PATH;
  }
  const browser = await chromium.launch(launchOptions);

  const hasStoredState = fs.existsSync(STATE_FILE);
  const context = await browser.newContext(
    hasStoredState ? { storageState: STATE_FILE } : {}
  );
  const page = await context.newPage();
const cdpSession = await context.newCDPSession(page);
await cdpSession.send("Network.setCacheDisabled", { cacheDisabled: true });

  const loggedIn = hasStoredState && (await isLoggedIn(page));
  if (!loggedIn) {
    console.log(
      hasStoredState
        ? "[session] Stored session expired — logging in again."
        : "[session] No stored session — logging in fresh."
    );
    await performLogin(page);
  } else {
    console.log("[session] Restored valid session, no login needed.");
  }

  return { browser, context, page };
}

/**
 * Wraps an action so that if it ever runs into an expired session
 * mid-flight (e.g. a long-running bot hits a token timeout between
 * actions), it re-logs in and retries once automatically.
 */
export async function withSession(page, action) {
  try {
    return await action(page);
  } catch (err) {
    const stillLoggedIn = await isLoggedIn(page);
    if (stillLoggedIn) throw err; // Not a session problem — rethrow.

    console.warn("[session] Session dropped mid-action — re-authenticating and retrying once.");
    await performLogin(page);
    return action(page); // Retry once. If it fails again, let it throw.
  }
}

// Allow `npm run login` to just verify/refresh the session on its own.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { browser, page } = await launchSession({ headless: false });
  console.log("[session] Current URL:", page.url());
  await browser.close();
}
