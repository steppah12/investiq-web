// src/trade.js — order-form flow confirmed live 2026-09-23. Market is
// already the default-selected order type on page load; clicking it
// again hits a HeadlessUI quirk where the label has no rendered size, so
// clickRadioOption skips the click entirely when the option is already
// checked (aria-checked="true").

const ACTIONS = { BUY: "Buy", SELL: "Sell" };

export async function openStockPickerModal(page) {
  const sharesCard = page.locator("text=Want to trade shares?").locator("..");
  const startTradingBtn = sharesCard.getByRole("button", { name: /start trading/i });
  await startTradingBtn.click();

  const modal = page.locator('[role="dialog"]');
  await modal.waitFor({ state: "attached", timeout: 10000 });
  return modal;
}

export async function findStockRow(modal, tickerOrName) {
  const searchBox = modal.getByPlaceholder(/search/i);
  await searchBox.fill(tickerOrName);

  const loadingOverlay = modal.locator(".p-datatable-loading-overlay");
  await loadingOverlay.waitFor({ state: "hidden", timeout: 8000 }).catch(() => {});

  const row = modal.locator("tr, [role='row']").filter({ hasText: tickerOrName }).first();
  await row.waitFor({ state: "visible", timeout: 10000 });
  return row;
}

async function clickRadioOption(page, labelText) {
  const label = page.getByText(new RegExp("^" + labelText + "$", "i")).first();
  const roleAncestor = label.locator("xpath=ancestor::*[@role='radio'][1]");

  if ((await roleAncestor.count()) > 0) {
    const alreadyChecked = await roleAncestor.first().getAttribute("aria-checked");
    if (alreadyChecked === "true") {
      console.log('[trade] "' + labelText + '" already selected, skipping click.');
      return;
    }
    await roleAncestor.first().click({ force: true });
    return;
  }

  await label.locator("xpath=ancestor::*[position()<=4]").last().click({ force: true });
}

async function submitOrderForm(page, opts) {
  const quantity = opts.quantity;
  const orderType = opts.orderType || "market";
  const limitPrice = opts.limitPrice;

  await page.getByText(/please fill in the form below/i).first().waitFor({ state: "attached", timeout: 10000 });

  const fs = await import("fs");
  fs.writeFileSync("./debug-last-order-form.html", await page.content());

  if (orderType === "limit") {
    if (limitPrice == null) {
      throw new Error("submitOrderForm: orderType 'limit' requires a limitPrice.");
    }
    await clickRadioOption(page, "limit");
    await page.getByLabel(/price/i).fill(String(limitPrice));
  } else {
    await clickRadioOption(page, "market");
  }

  // The whole order form is rendered TWICE in the DOM — once for mobile
  // ("block lg:hidden") and once for a desktop sidebar ("hidden
  // lg:block") — a standard responsive pattern, but it means any
  // .first()/.last() pick can silently grab the display:none copy
  // depending on the headless viewport width. Filter to :visible instead
  // of guessing which duplicate is the real one (confirmed root cause,
  // 2026-09-23 — this also explains the earlier "Market" click issue).
  const quantityInput = page.locator('input[type="number"]:visible').first();
  await quantityInput.fill(String(quantity));

  await page.waitForTimeout(1500);

  const submitButton = page.locator('button:visible').filter({ hasText: /^Submit$/i }).first();
  await submitButton.click();

  console.log("[trade] Submit clicked. Check debug-after-submit output to see what happens next.");
}

export async function placeTrade(page, ticker, action, orderParams) {
  if (!ACTIONS[action]) {
    throw new Error('Unknown action "' + action + '" — expected BUY or SELL.');
  }

  await page.goto("https://academy.nse.co.ke/trader/dashboard", { waitUntil: "domcontentloaded" });

  const modal = await openStockPickerModal(page);
  const row = await findStockRow(modal, ticker);

  const actionButton = row.getByRole("button", { name: new RegExp("^" + ACTIONS[action] + "$", "i") });
  await actionButton.click();

  console.log('[trade] Clicked ' + ACTIONS[action] + ' for "' + ticker + '". Handing off to order form...');
  await submitOrderForm(page, orderParams);

  console.log('[trade] Order for ' + ticker + ' (' + action + ') submitted.');
}
