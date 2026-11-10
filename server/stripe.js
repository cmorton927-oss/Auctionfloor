// Direct Stripe integration — no Muse agent delegation.
// STRIPE_SECRET_KEY must be a restricted key on the live Cash 4 Cars C&B
// account acct_1UYs2oRrelUqumEN with Checkout Sessions: Write.
// The key is read ONLY from the environment; it is never in code/files.
import Stripe from "stripe";
import { STRIPE_ACCOUNT_NAME, saleTotalDueCents } from "./fees.js";

let stripeClient = null;
export function getStripe() {
  if (stripeClient) return stripeClient;
  const key = process.env.STRIPE_SECRET_KEY || "";
  if (!key) return null;
  stripeClient = new Stripe(key);
  return stripeClient;
}
export const stripeConfigured = () => Boolean(process.env.STRIPE_SECRET_KEY);

export function appUrl() {
  return (process.env.APP_URL || "https://auction423.com").replace(/\/$/, "");
}

// Create a hosted Checkout Session for a sale's exact invoice total.
// Returns { id, url, paymentStatus, livemode }.
export async function createCheckoutSession(listing, sale, car) {
  const stripe = getStripe();
  if (!stripe) throw new Error("Stripe is not configured yet — the owner needs to set STRIPE_SECRET_KEY.");
  const totalCents = saleTotalDueCents(sale);
  const base = appUrl();
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    success_url: `${base}/messages?code=${sale.accessToken}&payment=success`,
    cancel_url: `${base}/messages?code=${sale.accessToken}&payment=cancelled`,
    customer_email: sale.winnerEmail || undefined,
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: {
            name: `AuctionFloor invoice — ${car}`,
            description: `Winning bid + buyer fee + card processing fee (2.9% + $0.30)`,
          },
          unit_amount: totalCents,
        },
        quantity: 1,
      },
    ],
    metadata: {
      auctionfloor_sale_id: String(sale.id),
      auctionfloor_listing_id: String(listing.id),
      source: "auctionfloor",
      stripe_account: STRIPE_ACCOUNT_NAME,
    },
  });
  return {
    id: session.id,
    url: session.url,
    paymentStatus: session.payment_status,
    livemode: session.livemode,
    paymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : null,
  };
}

// Re-read a Checkout Session directly from Stripe.
export async function retrieveCheckoutSession(sessionId) {
  const stripe = getStripe();
  if (!stripe) throw new Error("Stripe is not configured yet — the owner needs to set STRIPE_SECRET_KEY.");
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  return {
    id: session.id,
    paymentStatus: session.payment_status,
    status: session.status,
    paymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : "",
    amountTotalCents: session.amount_total ?? 0,
    livemode: session.livemode,
  };
}
