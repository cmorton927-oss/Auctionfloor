// Fee schedule — exactly as specified by the owner (unchanged from the
// original AuctionFloor):
// - Selling is FREE: the seller pays no fee.
// - Buyer pays 5% of the winning bid under $5,000, 2.5% at $5,000 or more.
// - Administrative fee: 2.9% of the invoice subtotal (winning bid +
//   buyer fee) plus $0.30, stored in CENTS.
export const SELLER_FEE = 0;
export const STRIPE_ACCOUNT_NAME = "Cash 4 Cars C&B";
export const STRIPE_ACCOUNT_ID = "acct_1UYs2oRrelUqumEN";

export function buyerFeeFor(amount) {
  return Math.max(1, Math.round(amount < 5000 ? amount * 0.05 : amount * 0.025));
}
export function buyerFeeRate(amount) {
  return amount < 5000 ? "5%" : "2.5%";
}
export function adminFeeCentsFor(subtotalDollars) {
  return Math.round(subtotalDollars * 100 * 0.029) + 30;
}
export function saleTotalDueCents(sale) {
  const subtotal = (sale.amount ?? 0) + (sale.buyerFee ?? 0);
  const proc = sale.processingFee ?? adminFeeCentsFor(subtotal);
  return subtotal * 100 + proc;
}
export function money(n) {
  return "$" + n.toLocaleString();
}
export function moneyCents(cents) {
  return "$" + (cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function carName(row) {
  return `${row.year} ${row.make} ${row.model}${row.trim ? ` ${row.trim}` : ""}`;
}
