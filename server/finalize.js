// Core sale logic, ported 1:1 from the original actions.ts:
// finalizeEndedAuctions, payout gate, Stripe-verified paid gateway,
// delivery quote/agree flow notifications. No agent delegation anywhere —
// Stripe is called directly (server/stripe.js) and notifications go
// through server/notify.js.
import { desc, eq } from "drizzle-orm";
import { db } from "./db.js";
import * as schema from "./schema.js";
import {
  STRIPE_ACCOUNT_NAME,
  buyerFeeFor,
  buyerFeeRate,
  carName,
  money,
  moneyCents,
  processingFeeCentsFor,
  saleTotalDueCents,
} from "./fees.js";
import { buyerSellerOwnerEntries, getOwnerSettingsRow, notifySaleParties } from "./notify.js";
import { createCheckoutSession } from "./stripe.js";

function randomAccessToken() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 8 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

export async function releasePayoutIfReady(listing, sale) {
  if (!sale.invoicePaidAt || !sale.buyerPickupConfirmedAt || !sale.sellerPickupConfirmedAt || sale.payoutReleasedAt) return false;
  await db.update(schema.sales).set({ payoutReleasedAt: new Date() }).where(eq(schema.sales.id, sale.id));
  sale.payoutReleasedAt = new Date();
  const car = carName(listing);
  const amount = sale.amount ?? 0;
  const entries = await buyerSellerOwnerEntries(listing, sale, {
    buyer: `Pickup complete — both you and the seller confirmed the pickup of the ${car}, and your invoice was paid, so the seller's payout of ${money(amount)} has been released. Thanks for buying on AuctionFloor.`,
    seller: `You got paid — both you and the buyer confirmed the pickup of the ${car} and the buyer's invoice was paid, so your payout of ${money(amount)} has been released. Selling on AuctionFloor is free — no seller fee was taken.`,
    owner: `Payout released — the ${car} sale is complete: buyer invoice paid and pickup confirmed by both buyer (${sale.winnerName ?? "buyer"}) and seller (${listing.sellerName}). Seller payout of ${money(amount)} released.`,
  });
  await notifySaleParties(listing, sale, `Seller paid: ${car} — AuctionFloor`, entries);
  return true;
}

// The single gateway to "invoice paid": only after Stripe itself reports
// payment_status "paid" for the full invoice total (checked in api.js via
// the Stripe API and in the webhook handler).
export async function applyVerifiedStripePayment(listing, sale) {
  if (sale.invoicePaidAt) return;
  await db.update(schema.sales).set({ invoicePaidAt: new Date(), stripePaymentStatus: "paid" }).where(eq(schema.sales.id, sale.id));
  sale.invoicePaidAt = new Date();
  sale.stripePaymentStatus = "paid";
  const car = carName(listing);
  const totalCents = saleTotalDueCents(sale);
  const entries = await buyerSellerOwnerEntries(listing, sale, {
    buyer: `Payment verified by Stripe — your invoice of ${moneyCents(totalCents)} for the ${car} is PAID (card payment through the ${STRIPE_ACCOUNT_NAME} Stripe account, live mode). Next step: arrange pickup with the seller, and when the car is picked up, confirm the pickup in the AuctionFloor checkout under Messages — that's when the seller gets paid.`,
    seller: `Good news — Stripe has verified the buyer's card payment of ${moneyCents(totalCents)} for your ${car}. Arrange the pickup with the buyer, and when the car is picked up, confirm the pickup in the AuctionFloor checkout under Messages. Once both you and the buyer confirm, your payout of ${money(sale.amount ?? 0)} is released.`,
    owner: `Stripe payment verified — buyer ${sale.winnerName ?? ""} paid ${moneyCents(totalCents)} by card for the ${car} (seller: ${listing.sellerName}; Stripe session ${sale.stripeCheckoutSessionId ?? ""}). Seller payout of ${money(sale.amount ?? 0)} releases once both sides confirm pickup.`,
  });
  await notifySaleParties(listing, sale, `Invoice paid via Stripe: ${car} — AuctionFloor`, entries);
  await releasePayoutIfReady(listing, sale);
}

async function createCheckoutForSale(listing, sale) {
  try {
    const session = await createCheckoutSession(listing, sale, carName(listing));
    await db
      .update(schema.sales)
      .set({
        stripeCheckoutSessionId: session.id,
        stripeCheckoutUrl: session.url,
        stripePaymentStatus: session.paymentStatus === "paid" ? "paid" : "open",
        stripeLivemode: session.livemode ? true : false,
        stripeCheckoutCreatedAt: new Date(),
      })
      .where(eq(schema.sales.id, sale.id));
    sale.stripeCheckoutSessionId = session.id;
    sale.stripeCheckoutUrl = session.url;
    sale.stripePaymentStatus = session.paymentStatus === "paid" ? "paid" : "open";
    if (session.paymentStatus === "paid") {
      await applyVerifiedStripePayment(listing, sale);
    } else {
      const car = carName(listing);
      const totalCents = saleTotalDueCents(sale);
      const owner = await getOwnerSettingsRow();
      const entries = [
        { role: "buyer", name: sale.winnerName ?? "Buyer", phone: sale.winnerPhone ?? null, email: sale.winnerEmail ?? null, body: `Pay your AuctionFloor invoice for the ${car} — ${moneyCents(totalCents)} by card on Stripe's secure checkout page: ${session.url} . Stripe verifies the payment with AuctionFloor automatically; the seller is paid once the payment is verified and both sides confirm pickup. The Stripe account (${STRIPE_ACCOUNT_NAME}) is live, so this is a real card payment. Your Messages access code for this sale is ${sale.accessToken ?? ""}.` },
        { role: "owner", name: owner?.ownerName ?? "Marketplace owner", phone: owner?.ownerPhone ?? null, email: owner?.ownerEmail ?? null, body: `Stripe checkout created for the ${car} sale — buyer ${sale.winnerName ?? ""} was sent the Stripe pay link for ${moneyCents(totalCents)} (live mode). Session: ${session.id}.` },
      ];
      await notifySaleParties(listing, sale, `Pay your invoice by card: ${car} — AuctionFloor`, entries);
    }
  } catch (err) {
    // Stripe not configured (or a Stripe error): leave the sale in
    // "creating" and let the buyer re-request checkout from the panel.
    console.error("Stripe checkout creation failed for sale", sale.id, err.message);
  }
}

export async function finalizeEndedAuctions() {
  const now = Date.now();
  const rows = await db.select().from(schema.listings);
  const saleRows = await db.select().from(schema.sales);
  const finalized = new Set(saleRows.map((s) => s.listingId));
  const existingTokens = new Set(saleRows.map((s) => s.accessToken).filter(Boolean));

  for (const row of rows) {
    if (new Date(row.endsAt).getTime() > now || finalized.has(row.id)) continue;
    const bidRows = await db.select().from(schema.bids).where(eq(schema.bids.listingId, row.id)).orderBy(desc(schema.bids.amount));
    const top = bidRows[0];

    if (!top) {
      await db.insert(schema.sales).values({ listingId: row.id, status: "no_sale" });
      continue;
    }
    if (row.reservePrice != null && top.amount < row.reservePrice) {
      await db.insert(schema.sales).values({
        listingId: row.id, status: "reserve_not_met",
        winnerName: top.bidderName, winnerPhone: top.bidderPhone ?? null, winnerEmail: top.bidderEmail ?? null,
        amount: top.amount,
      });
      continue;
    }

    const buyerFee = buyerFeeFor(top.amount);
    const processingFee = processingFeeCentsFor(top.amount + buyerFee);
    let accessToken = "";
    for (let i = 0; i < 5 && !accessToken; i++) {
      const candidate = randomAccessToken();
      if (!existingTokens.has(candidate)) accessToken = candidate;
    }
    if (!accessToken) accessToken = randomAccessToken();
    existingTokens.add(accessToken);
    const inserted = await db.insert(schema.sales).values({
      listingId: row.id, status: "sold",
      winnerName: top.bidderName, winnerPhone: top.bidderPhone ?? null, winnerEmail: top.bidderEmail ?? null,
      amount: top.amount, buyerFee, sellerFee: 0, processingFee,
      accessToken, invoiceSentAt: new Date(), stripePaymentStatus: "creating", stripeLivemode: true,
    }).returning();
    const sale = inserted[0];
    if (!sale) continue;
    const car = carName(row);
    const totalDueCents = (top.amount + buyerFee) * 100 + processingFee;
    const buyerContact = [top.bidderPhone, top.bidderEmail].filter(Boolean).join(" · ") || "not provided";
    const sellerContact = [row.sellerPhone, row.sellerEmail].filter(Boolean).join(" · ") || "not provided";
    const codeLine = ` Your Messages access code for this sale is ${accessToken} — enter it under Messages on AuctionFloor any time to pull this sale up again.`;
    const deliveryLine = ` Rather pick it up than haul it yourself? AuctionFloor can arrange delivery from the seller to the buyer through the site owner — open the checkout under Messages with your access code and tap "Arrange delivery". Delivery is priced per trip: there is no flat rate and no per-mile rate. The owner personally quotes the cost for the trip from the pickup and delivery addresses and notes you enter, and that quoted price is shown to both you and the other party in the checkout before either of you agrees to delivery.`;
    const buyerBody =
      `INVOICE — you won the ${car} for ${money(top.amount)}. ` +
      `Buyer fee: ${money(buyerFee)} (${buyerFeeRate(top.amount)} of the winning bid). ` +
      `Card processing fee: ${moneyCents(processingFee)} (2.9% of the ${money(top.amount + buyerFee)} subtotal plus $0.30). ` +
      `Total due on this invoice: ${moneyCents(totalDueCents)}, payable by card through Stripe. ` +
      `To pay: open the checkout under Messages on AuctionFloor with your access code and tap "Pay by card on Stripe" — you'll enter your card on Stripe's secure checkout page, and AuctionFloor marks the invoice paid only after Stripe verifies the payment. The Stripe account (${STRIPE_ACCOUNT_NAME}) is live, so this is a real card payment. ` +
      `The seller, ${row.sellerName}, can be reached at ${sellerContact} to arrange pickup. ` +
      `When the car is picked up, both you and the seller confirm the pickup in the checkout — that's when the seller gets paid. Selling is free for the seller (no seller fee).` +
      deliveryLine + codeLine;
    const sellerBody =
      `Your ${car} sold for ${money(top.amount)}. Selling is free — there is no seller fee on this sale. ` +
      `The winning buyer, ${top.bidderName}, has been invoiced ${moneyCents(totalDueCents)} (winning bid ${money(top.amount)} plus their ${money(buyerFee)} buyer fee and a ${moneyCents(processingFee)} card processing fee — 2.9% of the subtotal plus $0.30), payable by card through Stripe (live account). ` +
      `Contact the buyer at ${buyerContact} to arrange pickup. ` +
      `You get paid ${money(top.amount)} once Stripe has verified the buyer's invoice as paid and both you and the buyer confirm the pickup in the checkout under Messages on AuctionFloor.` +
      deliveryLine + codeLine;
    const ownerFeeBody =
      `Fee notice — ${car} sold for ${money(top.amount)}. ` +
      `Seller fee: free ($0). ` +
      `Buyer fee due: ${money(buyerFee)} (${buyerFeeRate(top.amount)} of the winning bid, from buyer ${top.bidderName}). ` +
      `Card processing fee due from the buyer: ${moneyCents(processingFee)} (2.9% of the ${money(top.amount + buyerFee)} subtotal plus $0.30). ` +
      `The buyer has been invoiced ${moneyCents(totalDueCents)} total, payable by card through the connected Stripe account (${STRIPE_ACCOUNT_NAME}, live mode); the seller is paid ${money(top.amount)} only after Stripe verifies the payment and both sides confirm pickup. ` +
      `Buyer contact: ${buyerContact}. Seller contact: ${sellerContact}.`;
    const owner = await getOwnerSettingsRow();
    const ownerWinBody =
      `The ${car} just sold for ${money(top.amount)} on AuctionFloor. ` +
      `Winner: ${top.bidderName} — ${buyerContact}. Seller: ${row.sellerName} — ${sellerContact}. ` +
      `Buyer and seller have been sent each other's contact info by text and email.`;
    const entries = [
      { role: "buyer", name: top.bidderName, phone: top.bidderPhone ?? null, email: top.bidderEmail ?? null, body: buyerBody },
      { role: "seller", name: row.sellerName, phone: row.sellerPhone ?? null, email: row.sellerEmail ?? null, body: sellerBody },
      { role: "owner", name: owner?.ownerName ?? "Marketplace owner", phone: owner?.ownerPhone ?? null, email: owner?.ownerEmail ?? null, body: ownerFeeBody },
    ];
    // Owner win message is a separate in-app/sms/email notice (same pattern
    // as the original): send it as an extra owner entry.
    await notifySaleParties(row, sale, `Your ${car} sold — AuctionFloor`, entries);
    if (owner) {
      await notifySaleParties(row, sale, `Auction won: ${car} — AuctionFloor`, [
        { role: "owner", name: owner.ownerName, phone: owner.ownerPhone, email: owner.ownerEmail, body: ownerWinBody },
      ]);
    }
    // Kick off the Stripe Checkout Session right away (async, best-effort).
    createCheckoutForSale(row, sale).catch(() => {});
  }
}

export { createCheckoutForSale };
