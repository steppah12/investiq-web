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
  const label = await findVisibleLabel(page, /^current\s*balance$/i);
  const card = label.locator("xpath=ancestor::*[position()<=3]").last();

  const deadline = Date.now() + 30000;
  let lastValue = null;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    const text = await card.innerText().catch(() => "");
    const match = text.match(/KES\s*([\d,]+(?:\.\d+)?)/i) || text.match(/[\d,]+(?:\.\d+)?/);
    const value = match ? parseFloat((match[1] || match[0]).replace(/,/g, "")) : null;
    console.log("[portfolio]   balance poll #" + attempt + ": " + value);
    if (value != null && value > 0 && value === lastValue) {
      return value;
    }
    lastValue = value;
    await page.waitForTimeout(700);
  }

  const fs = await import("fs");
  fs.writeFileSync("./debug-balance-stuck.txt", await card.innerText().catch(() => "<could not read>"));
  throw new Error("Current Balance never stabilized on a non-zero value within 15s (last read: " + lastValue + ") — see debug-balance-stuck.txt.");
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
