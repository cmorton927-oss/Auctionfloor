# AuctionFloor — Render Port

Open car-auction marketplace for **Cash 4 Cars C&B** (Charles & Brandi Morton),
ported from the Muse fullstack artifact (`online-car-auctions`, v7) to a
standard stack that runs on Render:

- **Node 20 + Express** serving the React client (Vite + Tailwind)
- **Postgres** via Drizzle (`pg-core`) — the original 9 SQLite migrations
  converted to Postgres in `drizzle/0001`–`0009`
- **Direct Stripe API** integration (no Muse agent delegation)
- **Owner login** (email + password) instead of Muse viewer identity
- Photos on a 1 GB Render persistent disk under `UPLOADS_DIR`
  (survives redeploys; see below)

## What it does (all replicated from the original)

- Anyone can list a car: year/make/model/trim, mileage, condition, title
  status, location, description, photos — drag-and-drop or tap to pick,
  up to 8 per listing (JPG/PNG/WebP/GIF ≤ 8 MB each; first photo is the
  main one on the listing card, detail page shows a gallery) — starting
  bid, optional reserve, 1–14 days. Listing is live immediately.
- Anyone can bid (name + mobile + email required). Bids in the final
  2 minutes extend the clock by 2 minutes (anti-sniping). A bidder can
  check "Bid privately" — public views then show only their initials
  (high bidder, bid history, and the winner line if they win); the
  seller and owner still see the real name on a win.
- **Bidder verification — one-time $10 refundable deposit:** before their
  first bid (or Buy Now), a bidder verifies their card through a $10
  Stripe Checkout Session created with `payment_intent_data.capture_method:
  "manual"` — the $10 is authorized (proving the card is good) but never
  captured, so the hold releases automatically (~7 days) and no fee is
  charged. The pending bid/Buy Now rides in the session metadata; on
  return, `/api/confirmDeposit` re-reads the session from Stripe, marks
  the email verified in `verified_bidders` (migration 0018), and places
  the pending bid — re-checking that the auction is still live and the
  bid still meets the minimum. Verification is per-email and permanent;
  `/api/bidderStatus` lets the bid form show the right note. Confirm is
  idempotent per deposit session.
- Tabs: Live now / Ending < 24h / Watchlist / Ended / All, plus search,
  condition filter, and sort (ending soonest, price, newest). Detail pages
  with specs, seller name only, and full bid history.
- **Fees, exactly:** selling is FREE. Buyer fee 5% under $5,000, 2.5% at
  $5,000+. Administrative fee 2.9% of (winning bid + buyer fee) + $0.30,
  in cents: `round(subtotal_cents × 0.029) + 30`. Example: $800 win →
  $40 buyer fee + $24.66 administrative fee = **$864.66 due**. No sale, no fees.
- On a win the buyer is auto-invoiced and pays by card on Stripe's hosted
  checkout. The invoice counts as paid **only** when Stripe itself reports
  `payment_status: "paid"`, session `complete`, and the exact invoice total
  — verified by re-reading the Checkout Session from Stripe, and by the
  `checkout.session.completed` webhook when configured. There is no
  "I've paid" self-attestation button.
- **Seller payout releases only after the invoice is paid AND both buyer
  and seller confirm pickup** in the checkout.
- **Delivery, quoted per trip:** either side requests delivery with an
  address + notes; the owner quotes one price for the whole trip (no flat
  rate, no per-mile rate); both sides agree to book it. The owner can
  re-quote before both agree (clears earlier agreements); once both agree
  the price is locked.
- **Win messages:** buyer and seller each get the other's phone/email, plus
  a copy in Messages gated by a per-sale 8-character access code (delivered
  only inside the win text/email). The owner gets a win message + fee
  notice. In-app copies are always written; email (SendGrid) and SMS
  (Twilio) are sent when configured — if a provider key is absent, those
  copies stay queued in-app (`sent_at` empty) and the sale is never blocked.
- **Local only — 250-mile radius of Chattanooga 37406:** a seller must enter a
  5-digit ZIP code when listing, and it must be within 250 miles of 37406
  (checked server-side from ZIP centroids; a listing right on the boundary can
  be off by a few miles). Outside the radius the listing is rejected.
- **New-listing email alerts:** a signup box on the home page ("Never miss a new listing") takes just an email address — no account. Every new listing emails all active subscribers (car, starting bid, Buy Now, location, link) with a per-recipient unsubscribe link. Sending uses the existing SendGrid wiring (`SENDGRID_API_KEY` + `EMAIL_FROM` env vars); until those are set, alerts are skipped and the listing is never blocked. Migration 0014 added alert_subscribers. Signups send the owner no notification; the Owner tab shows the live subscriber count instead (owner-only `/api/alertSubscriberCount`).
- **Buy Now:** a seller can set an optional Buy Now price when listing. While
  the auction is live, a buyer can end it early by paying that price (two-tap
  confirm in the listing view) — the sale then finalizes exactly like a won
  bid: invoice + buyer fee + administrative fee, Stripe checkout, pickup
  confirmations before the seller is paid. If bidding has already passed the
  Buy Now price, the button disappears. Buy Now also clears the reserve: the
  asking price is the seller's explicit sell-now price.
- **Seller privacy toggle:** on the list-a-car form, "Stay private during the
  auction" shows the listing as "Private seller" instead of the seller's name.
  The seller's real name and contact info are still collected and still go to
  the winning buyer only — in the win message and the code-gated Messages
  checkout. The owner tab always sees the real name.
- **Owner tab** (Messages → Owner — fees & settings): fee notices, delivery
  requests + per-trip quotes, and owner contact settings. Gated by owner
  login — see below.

## Owner login (first run)

The original site knew the owner automatically (Muse viewer identity). On
the public site the owner signs in:

1. Open the site → Messages → Owner — fees & settings.
2. The first time, it offers **"Set up the owner account"** — enter an
   email + password (8+ characters). This only works while no owner account
   exists yet.
3. After that, log in with that email + password. The session lasts 30 days.

Owner contact (name / mobile / email for win + fee texts/emails) is saved
separately in the same tab, exactly as before.

## Environment variables

Copy `.env.example` to `.env` for local dev. On Render, set them in the
dashboard (Environment tab). **Never put a real key in code, in git, or
in chat.**

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Render injects it from the Render Postgres service |
| `PORT` | no | Render sets it; default 3000 |
| `APP_URL` | no | Default `https://auction423.com`. Used for Stripe success/cancel return URLs — no `example.com` placeholders anywhere |
| `STRIPE_SECRET_KEY` | for payments | Restricted key on the **live** Cash 4 Cars C&B account `acct_1UYs2oRrelUqumEN`, **Checkout Sessions: Write**. Create in Stripe dashboard → Developers → API keys → Create restricted key. Without it, checkout creation returns 503 and sales stay unpaid — nothing is charged by accident |
| `STRIPE_WEBHOOK_SECRET` | no | Stripe dashboard → Developers → Webhooks, endpoint `https://auction423.com/api/stripe/webhook`, event `checkout.session.completed`. If unset, the webhook rejects requests; payment verification still works through the "check payment status" button |
| `SESSION_SECRET` | yes | Any long random string (owner login sessions) |
| `UPLOADS_DIR` | no | Default `./uploads`. **Note:** Render disk is ephemeral — see S3 note below |
| `SENDGRID_API_KEY`, `EMAIL_FROM` | no | Email notifications. If absent, email copies queue in-app |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | no | SMS notifications. If absent, SMS copies queue in-app |

## Local development

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL (local Postgres) + SESSION_SECRET
npm run build          # builds the React client into dist/
npm start              # runs migrations, then serves on $PORT (default 3000)
```

Migrations run automatically on startup (and manually with
`npm run migrate`). The smoke test needs a local Postgres:

```bash
# create the test database first:
#   createdb auctionfloor_test   (user auctionfloor / password auctionfloor)
DATABASE_URL=postgres://auctionfloor:auctionfloor@localhost:5432/auctionfloor_test npm run test:smoke
```

It exercises list → bid → force-end → finalize → fees → checkout →
delivery quote/agree → pickup confirmations → payout gate, and asserts
the payout does **not** release while the invoice is unpaid.

## Deploy to Render ($13/month)

1. **GitHub repo** — push this folder to a repo in Charles's GitHub
   account (Render deploys from Git; auto-deploy on push).
2. **Render account** — Charles creates it on his own device and adds his
   payment method. Month-to-month, cancel anytime; compute is billed
   prorated to the second.
3. **New → Blueprint**, point it at the repo. `render.yaml` defines:
   - Web Service `auctionfloor`, Starter **$7/mo** — build
     `npm install && npm run build`, start `node server.js`
   - Postgres `auctionfloor-db`, Basic **$6/mo**
   - Total **$13/mo** on the Hobby workspace ($0).
4. **Environment (Render dashboard → Environment)** — set the secrets
   from the table above: `STRIPE_SECRET_KEY` (restricted key, Checkout
   Sessions: Write, on `acct_1UYs2oRrelUqumEN`), `SESSION_SECRET`
   (generate one), `STRIPE_WEBHOOK_SECRET` (optional), SendGrid/Twilio
   keys (optional). `DATABASE_URL` and `APP_URL` come from the blueprint.
5. **Custom domain** — Render → Settings → Custom Domains → add
   `auction423.com`. Render shows a CNAME target
   (`<service>.onrender.com`); add that CNAME record in **Namecheap**
   (where `auction423.com` is registered — bought Nov 10, 2026 for
   $12.28, expires Nov 10, 2027). Render provisions free SSL
   automatically. `cash4carscb.com` is not involved at all.
6. **Verify live before announcing** — create a test listing on the Render
   URL, bid, end it, confirm the invoice + Stripe checkout flow, then
   delete the test data.

## What was NOT carried over from the Muse artifact

- Muse viewer identity (`ctx.viewer.isOwner`) → owner email/password login.
- Muse blob storage (`ctx.blobs`) → disk uploads under `UPLOADS_DIR`.
- Agent-delegated Stripe/notification tasks (`ctx.agent.spawnTask`) →
  direct Stripe API calls, SendGrid/Twilio, in-app message queue.
- The `entries` placeholder table from migration 0001 (dropped in 0002
  upstream; the Postgres 0001 is a no-op kept for history).
- Watchlist is global (shared), exactly as in the original — there are no
  bidder accounts in either version.

## Known follow-ups (not blockers)

- **Photo storage:** uploads live on a 1 GB Render persistent disk
  (`render.yaml` `disk:` block, mount `/var/data`, `UPLOADS_DIR` =
  `/var/data/uploads`), so photos survive redeploys. The disk is tied to
  this one service instance — if the service itself is ever deleted, the
  photos go with it. A future step could move uploads to S3-compatible
  object storage instead. Listing data itself lives safely in Postgres.
- **Stripe webhook:** optional but recommended — set
  `STRIPE_WEBHOOK_SECRET` so paid invoices are marked the moment Stripe
  completes checkout, without waiting for the buyer to tap "check payment
  status".
- **Email/SMS providers:** SendGrid + Twilio are wired in but optional.
  Until keys are set, win/fee texts and emails queue in-app and the owner
  can see them in Messages; the sale flow itself is unaffected.
