// src/portfolio.js — corrected 2026-09-23.
//
// Cash balance: no "Loading..." marker exists — it silently shows
// "KES 0.00" before the real value loads. Also, the dashboard likely
// renders duplicate mobile/desktop copies of the balance card (same
// pattern confirmed in trade.js's order form), so we filter to the
// VISIBLE match instead of taking .first() blind, then poll until two
// consecutive reads agree on a non-zero value.
//
// Holdings: a direct URL load of /trader/portfolio returns "No results
// found" even for a real account — reaching it via the dashboard's own
// "View All Your Holdings" link (same path a human takes) is required
// for the SPA's account context to initialize.

export async function getAccountSnapshot(page) {
  await page.goto("https://academy.nse.co.ke/trader/dashboard", {
    waitUntil: "domcontentloaded",
  });

  const cashBalance = await readCashBalance(page);
  const holdings = await readHoldings(page).catch((err) => {
    console.warn("[portfolio] Could not read holdings (non-fatal):", err.message);
    return [];
  });

  console.log("[portfolio] cashBalance=" + cashBalance + ", holdings=" + holdings.length + " position(s)");
  return { cashBalance, holdings };
}

async function findVisibleLabel(page, regex) {
  const candidates = page.getByText(regex);
  const count = await candidates.count();
  for (let i = 0; i < count; i++) {
    if (await candidates.nth(i).isVisible().catch(() => false)) {
      return candidates.nth(i);
    }
  }
  const fs = await import("fs");
  const dump = [];
  for (let i = 0; i < count; i++) {
    dump.push({
      index: i,
      visible: await candidates.nth(i).isVisible().catch(() => "error"),
      text: await candidates.nth(i).innerText().catch(() => "error"),
    });
  }
  fs.writeFileSync("./debug-balance-candidates.json", JSON.stringify(dump, null, 2));
  throw new Error("No VISIBLE label found among " + count + " match(es) for " + regex + " — see debug-balance-candidates.json.");
}

async function readCashBalance(page) {
  let label = await findVisibleLabel(page, /^current\s*balance$/i);
  let card = label.locator("xpath=ancestor::*[position()<=3]").last();

  const deadline = Date.now() + 30000;
  let lastValue = null;
  let attempt = 0;
  let reloaded = false;

  while (Date.now() < deadline) {
    attempt++;
    const text = await card.innerText().catch(() => "");
    const match = text.match(/KES\s*([\d,]+(?:\.\d+)?)/i) || text.match(/[\d,]+(?:\.\d+)?/);
    const value = match ? parseFloat((match[1] || match[0]).replace(/,/g, "")) : null;
    console.log("[portfolio]   balance poll #" + attempt + ": " + value);
    if (value != null && value > 0 && value === lastValue) {
      return value;
    }

    // Stuck at 0/null for 10s straight with no reload attempted yet —
    // force a fresh dashboard navigation once, in case the balance API
    // call that should have fired never actually did.
    if (!reloaded && attempt >= 14 && (value === 0 || value == null)) {
      console.log("[portfolio]   still 0 after ~10s — reloading dashboard once to retry.");
      reloaded = true;
      await page.goto("https://academy.nse.co.ke/trader/dashboard", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1000);
      label = await findVisibleLabel(page, /^current\s*balance$/i);
      card = label.locator("xpath=ancestor::*[position()<=3]").last();
    }

    lastValue = value;
    await page.waitForTimeout(700);
  }

  const fs = await import("fs");
  fs.writeFileSync("./debug-balance-stuck.txt", await card.innerText().catch(() => "<could not read>"));
  await page.screenshot({ path: "./debug-balance-stuck.png", fullPage: true }).catch(() => {});
  throw new Error("Current Balance never stabilized on a non-zero value within 30s, even after one reload (last read: " + lastValue + ") — see debug-balance-stuck.txt/.png.");
}

async function readHoldings(page) {
  await page.goto("https://academy.nse.co.ke/trader/dashboard", { waitUntil: "domcontentloaded" });

  const viewAllLink = await findVisibleLabel(page, /view\s+all\s+your\s+holdings/i);
  await viewAllLink.click();

  await page.getByText(/^holding$/i).first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(2000);

  const fs = await import("fs");
  fs.writeFileSync("./debug-portfolio.html", await page.content());

  const rows = page.locator("table.p-datatable-table tbody tr");
  const rowCount = await rows.count();
  const holdings = [];

  for (let i = 0; i < rowCount; i++) {
    const row = rows.nth(i);
    if ((await row.locator(".p-datatable-emptymessage").count()) > 0) continue;

    const cells = row.locator("td");
    const cellCount = await cells.count();
    if (cellCount < 4) continue;

    const nameCell = await cells.nth(0).innerText().catch(() => "");
    const holdingCell = await cells.nth(3).innerText().catch(() => "");
    const name = nameCell.trim();
    const shares = parseFloat(holdingCell.replace(/,/g, "").trim());

    if (name && Number.isFinite(shares) && shares > 0) {
      holdings.push({ name: name, shares: shares });
    }
  }

  console.log("[portfolio] Parsed " + holdings.length + " holding row(s) from " + rowCount + " total row(s) — see debug-portfolio.html if this looks wrong.");
  return holdings;
}

// Ground-truth trade verification, added 2026-09-25 after confirming
// Orders/create returning {"Message":"Order Placed Successfully"} does
// NOT mean the trade actually happened — a real BUY logged "success" via
// that response alone showed zero balance/holdings change the next day.
// This checks the exchange's own matched-orders record instead of
// trusting the create-call's response text. Uses page.request (Playwright's
// own request context, shares session cookies) rather than page.evaluate's
// fetch, since the latter hit a CORS-style "Failed to fetch" when tried
// from inside page JS.
export async function verifyTradeFilled(page, { symbolId, side, quantity, submittedAfter }) {
  const deadline = Date.now() + 60000;
  let attempt = 0;

  // The app attaches its JWT manually per-request from localStorage —
  // Playwright's page.request only auto-carries cookies, not this token,
  // which is why a bare page.request.post got 401 even inside an
  // authenticated session (confirmed 2026-09-25 via a live diagnostic).
  const token = await page.evaluate(() => localStorage.getItem("token"));

  while (Date.now() < deadline) {
    attempt++;
    try {
      const res = await page.request.post(
        "https://trading.agilebiz.co.ke/api/Orders/matchedorders",
        {
          data: { CompetitionId: "e961e975-215f-4971-92d5-57523e7a36f2" },
          headers: {
            "Content-Type": "application/json",
            "Authorization": token ? "Bearer " + token : "",
          },
        }
      );
      if (res.status() === 401) {
        console.warn("[portfolio]   verify poll #" + attempt + ": got 401 even with token — session may have rotated mid-poll.");
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      const orders = await res.json();

      const match = (orders || []).find((o) => {
        if (String(o.SymbolId) !== String(symbolId)) return false;
        if (Math.abs(Number(o.Quantity) - quantity) > 0.001) return false;
        const wantSide = side === "BUY" ? "Buy" : "Sell";
        if (o.OrderSide !== wantSide) return false;
        const orderTime = new Date(o.OrderDate).getTime();
        return orderTime >= submittedAfter - 5000; // small clock-skew allowance
      });

      console.log("[portfolio]   verify poll #" + attempt + ": " + (match ? "FOUND matched order " + match.ShortOrderId : "not found yet"));
      if (match) return { filled: true, order: match };
    } catch (err) {
      console.warn("[portfolio]   verify poll #" + attempt + " request failed:", err.message);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }

  return { filled: false, order: null };
}

// Real, honest market-open check — added 2026-09-25 as the fix for
// orders being silently discarded when submitted during "Closing Price
// Publication." Unlike Orders/create's response text, this endpoint was
// confirmed accurate in a live test (returned IsMarketOpen:false exactly
// when a just-placed order turned out to have vanished).
export async function isMarketOpen(page) {
  const token = await page.evaluate(() => localStorage.getItem("token"));
  const res = await page.request.get(
    "https://trading.agilebiz.co.ke/api/Symbols/market-status",
    { headers: { "Authorization": "Bearer " + token } }
  );
  const data = await res.json();
  console.log("[portfolio] Market status check:", JSON.stringify(data));
  return data.IsMarketOpen === true;
}
