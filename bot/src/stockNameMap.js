// Confirmed via direct search on academy.nse.co.ke/trader/marketwatch —
// these are NOT the same as our canonical stock names (used everywhere
// else: iq_stock_*, predictions.stock_name, etc.). This map exists ONLY
// to translate canonical name -> what to type into Soko Play's search box.
// If Soko Play doesn't have an entry here for a name, the canonical name
// itself is used as the search term (works fine for Kenya Re, Crown
// Paints — their canonical name already substring-matches).
export const SOKO_PLAY_SEARCH_TERM = {
  "Stanbic Bank": "Stanbic Holdings",
  "Co-op Bank": "Co-operative Bank",
  "ABSA NewGold ETF": "NEW GOLD ETF",
};

export function searchTermFor(canonicalName) {
  return SOKO_PLAY_SEARCH_TERM[canonicalName] || canonicalName;
}
