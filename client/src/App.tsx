import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fileToBase64 } from "./fileToBase64";
import { api, type ApiResponse } from "./api";

type Listing = ApiResponse<typeof api, "listAuctions">["listings"][number];
type Detail = ApiResponse<typeof api, "getAuction">;
type Message = ApiResponse<typeof api, "listMyMessages">["messages"][number];

const CONDITIONS = ["Runs & drives", "Runs, needs work", "Not running", "Parts / salvage"] as const;
const TITLES = ["Clean title", "Rebuilt / salvage title", "No title — bill of sale", "Lien / other"] as const;

function money(n: number) { return "$" + n.toLocaleString(); }

// Marketplace fees: selling is FREE for the seller; the buyer pays 10% of
// the winning bid under $1,000 and 5% at $1,000 or more, plus a card
// processing fee of 2.9% of the subtotal (bid + buyer fee) plus $0.30.
function buyerFeeFor(amount: number) { return Math.max(1, Math.round(amount < 1000 ? amount * 0.1 : amount * 0.05)); }
function buyerFeeRate(amount: number) { return amount < 1000 ? "10%" : "5%"; }
function processingFeeCentsFor(subtotalDollars: number) { return Math.round(subtotalDollars * 100 * 0.029) + 30; }
function moneyCents(cents: number) { return "$" + (cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  return now;
}

function countdown(endsAt: string, now: number) {
  const ms = new Date(endsAt).getTime() - now;
  if (ms <= 0) return { label: "Ended", urgent: false, ended: true };
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const label = d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m ${String(sec).padStart(2, "0")}s` : `${m}m ${String(sec).padStart(2, "0")}s`;
  return { label, urgent: ms < 3600 * 1000, ended: false };
}

function CarVisual({ listing, large }: { listing: Listing; large?: boolean }) {
  if (listing.imageUrl) {
    return <img src={listing.imageUrl} alt={`${listing.year} ${listing.make} ${listing.model}`} className={`w-full object-cover ${large ? "h-64 sm:h-80" : "h-44"}`} loading="lazy" />;
  }
  return (
    <div className={`w-full ${large ? "h-64 sm:h-80" : "h-44"} flex flex-col items-center justify-center bg-[#1c1d20] text-[#f4f1ea] relative overflow-hidden`} aria-hidden="true">
      <div className="absolute inset-x-0 bottom-0 h-1.5 bg-[var(--accent-strong)]" />
      <span className="font-display font-700 text-6xl font-bold tracking-wide opacity-90">{listing.year}</span>
      <span className="font-display text-2xl uppercase tracking-[0.2em] mt-1">{listing.make} {listing.model}</span>
      <span className="text-xs uppercase tracking-widest text-[#a39d90] mt-2">{listing.location}</span>
    </div>
  );
}

function ListingCard({ listing, now, onOpen, onWatch }: { listing: Listing; now: number; onOpen: () => void; onWatch: () => void }) {
  const cd = countdown(listing.endsAt, now);
  const price = listing.currentBid ?? listing.startingPrice;
  return (
    <article className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl overflow-hidden flex flex-col">
      <button type="button" onClick={onOpen} aria-label={`View ${listing.year} ${listing.make} ${listing.model}`} className="text-left block w-full">
        <CarVisual listing={listing} />
      </button>
      <div className="p-4 flex flex-col gap-2 flex-1">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-display text-2xl font-semibold uppercase leading-none">{listing.year} {listing.make} {listing.model}{listing.trim ? ` ${listing.trim}` : ""}</h3>
          <button type="button" onClick={onWatch} aria-label={listing.isWatched ? `Remove ${listing.make} ${listing.model} from watchlist` : `Watch ${listing.make} ${listing.model}`} className={`shrink-0 px-2.5 py-1 rounded-full text-xs font-semibold border ${listing.isWatched ? "bg-[var(--accent-strong)] text-black border-transparent" : "border-[var(--border)] text-[var(--dim)]"}`}>
            {listing.isWatched ? "★ Watching" : "☆ Watch"}
          </button>
        </div>
        <p className="text-sm text-[var(--dim)]">{listing.mileage.toLocaleString()} mi · {listing.condition} · {listing.location}</p>
        <div className="mt-auto pt-2 flex items-end justify-between border-t border-[var(--border)]">
          <div>
            <p className="text-[11px] uppercase tracking-widest text-[var(--dim)]">{listing.currentBid != null ? "Current bid" : "Starting bid"}</p>
            <p className="font-display text-3xl font-bold tabular leading-none">{money(price)}</p>
            <p className="text-xs text-[var(--dim)] mt-1">{listing.bidCount} bid{listing.bidCount === 1 ? "" : "s"}{listing.reservePrice != null ? (listing.reserveMet ? " · Reserve met" : " · Reserve not met") : " · No reserve"}</p>
          </div>
          <div className={`text-right ${cd.ended ? "text-[var(--dim)]" : cd.urgent ? "text-[var(--danger)]" : ""}`}>
            <p className="text-[11px] uppercase tracking-widest">{cd.ended ? "Auction" : "Time left"}</p>
            <p className="font-display text-xl font-semibold tabular leading-none">{cd.label}</p>
          </div>
        </div>
        <button type="button" onClick={onOpen} className="mt-2 w-full py-2.5 rounded-xl bg-[var(--text)] text-[var(--bg)] font-semibold text-sm" aria-label={`Bid on ${listing.year} ${listing.make} ${listing.model}`}>
          {listing.isEnded ? "View result" : "View & bid"}
        </button>
      </div>
    </article>
  );
}

function DetailView({ id, now, onClose }: { id: number; now: number; onClose: () => void }) {
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ["auction", id], queryFn: () => api.getAuction({ id }), refetchInterval: 5000 });
  const [bidderName, setBidderName] = useState(() => localStorage.getItem("bidderName") ?? "");
  const [bidderPhone, setBidderPhone] = useState(() => localStorage.getItem("bidderPhone") ?? "");
  const [bidderEmail, setBidderEmail] = useState(() => localStorage.getItem("bidderEmail") ?? "");
  const [amount, setAmount] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const bidMut = useMutation({
    mutationFn: () => api.placeBid({ listingId: id, bidderName: bidderName.trim(), bidderPhone: bidderPhone.trim(), bidderEmail: bidderEmail.trim(), amount: Number(amount) }),
    onSuccess: (r) => {
      localStorage.setItem("bidderName", bidderName.trim());
      localStorage.setItem("bidderPhone", bidderPhone.trim());
      localStorage.setItem("bidderEmail", bidderEmail.trim());
      setMsg({ kind: "ok", text: r.extended ? "You're the high bidder! Bid in the final minutes — clock extended to 2:00." : "You're the high bidder!" });
      setAmount("");
      queryClient.invalidateQueries({ queryKey: ["auction", id] });
      queryClient.invalidateQueries({ queryKey: ["auctions"] });
    },
    onError: (e) => setMsg({ kind: "err", text: e instanceof Error ? e.message : "Bid failed — try a higher amount." }),
  });
  const watchMut = useMutation({
    mutationFn: () => api.toggleWatch({ listingId: id }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["auction", id] }); queryClient.invalidateQueries({ queryKey: ["auctions"] }); },
  });
  const deleteMut = useMutation({
    mutationFn: () => api.deleteListing({ id }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["auctions"] }); onClose(); },
  });
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (detail.isPending) return <div className="p-6 text-center text-[var(--dim)]">Loading auction…</div>;
  if (detail.error || !detail.data) return <div className="p-6 text-center"><p className="text-[var(--danger)]">Couldn't load this auction.</p><button type="button" onClick={onClose} className="mt-3 underline">Back to auctions</button></div>;

  const { listing, bids } = detail.data as Detail;
  const cd = countdown(listing.endsAt, now);
  const price = listing.currentBid ?? listing.startingPrice;
  const minBid = listing.currentBid != null ? listing.currentBid + 1 : listing.startingPrice;
  const suggested = listing.currentBid != null ? listing.currentBid + 100 : listing.startingPrice;

  return (
    <div className="pb-10">
      <button type="button" onClick={onClose} className="text-sm font-semibold underline underline-offset-4 mb-3" aria-label="Back to all auctions">← All auctions</button>
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl overflow-hidden">
        <CarVisual listing={listing} large />
        <div className="p-4 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-display text-4xl font-bold uppercase leading-none">{listing.year} {listing.make} {listing.model}{listing.trim ? ` ${listing.trim}` : ""}</h2>
              <p className="text-sm text-[var(--dim)] mt-2">{listing.location} · Seller: {listing.sellerName}</p>
            </div>
            <button type="button" onClick={() => watchMut.mutate()} aria-label={listing.isWatched ? "Remove from watchlist" : "Add to watchlist"} className={`px-3 py-1.5 rounded-full text-sm font-semibold border ${listing.isWatched ? "bg-[var(--accent-strong)] text-black border-transparent" : "border-[var(--border)]"}`}>
              {listing.isWatched ? "★ Watching" : "☆ Watch"}
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-5 text-sm">
            {[["Mileage", `${listing.mileage.toLocaleString()} mi`], ["Condition", listing.condition], ["Title", listing.titleStatus], ["Ends", new Date(listing.endsAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })]].map(([k, v]) => (
              <div key={k} className="bg-[var(--surface2)] rounded-xl p-3"><p className="text-[11px] uppercase tracking-widest text-[var(--dim)]">{k}</p><p className="font-semibold mt-0.5">{v}</p></div>
            ))}
          </div>

          <p className="mt-5 text-[15px] leading-relaxed whitespace-pre-wrap">{listing.description}</p>

          <div className="mt-6 border-t border-[var(--border)] pt-5 flex flex-wrap gap-6 items-end justify-between">
            <div>
              <p className="text-[11px] uppercase tracking-widest text-[var(--dim)]">{listing.currentBid != null ? "Current bid" : "Starting bid"}</p>
              <p className="font-display text-5xl font-bold tabular leading-none">{money(price)}</p>
              <p className="text-sm text-[var(--dim)] mt-1">{listing.bidCount} bid{listing.bidCount === 1 ? "" : "s"}{listing.highBidder ? ` · High bidder: ${listing.highBidder}` : ""}{listing.reservePrice != null ? (listing.reserveMet ? " · Reserve met" : " · Reserve not yet met") : " · No reserve"}</p>
            </div>
            <div className={cd.ended ? "text-[var(--dim)]" : cd.urgent ? "text-[var(--danger)]" : ""}>
              <p className="text-[11px] uppercase tracking-widest">{cd.ended ? "Auction ended" : "Time left"}</p>
              <p className="font-display text-4xl font-bold tabular leading-none">{cd.label}</p>
            </div>
          </div>

          {listing.isEnded ? (
            <div className="mt-5 bg-[var(--surface2)] rounded-xl p-4">
              <p className="font-display text-2xl font-semibold uppercase">Sale closed</p>
              {listing.sale?.status === "sold" && listing.sale.amount != null ? (
                <>
                  <p className="text-sm mt-1">Winner: <strong>{listing.sale.winnerName}</strong> at {money(listing.sale.amount)}. The buyer has been invoiced the total below, payable by card through Stripe, and both sides got each other's contact info by text and email. The seller gets paid once Stripe verifies the invoice payment and both buyer and seller confirm the pickup — all tracked in the checkout under Messages.</p>
                  <p role="status" className="text-sm mt-2 font-semibold">Stripe payment status: {listing.sale.invoicePaidAt ? `Paid — verified by Stripe ${new Date(listing.sale.invoicePaidAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : listing.sale.stripePaymentStatus === "open" ? "Awaiting card payment on Stripe" : listing.sale.stripePaymentStatus === "creating" ? "Creating the Stripe checkout link…" : listing.sale.stripePaymentStatus === "expired" ? "Stripe checkout link expired" : "Not paid yet"} <span className="font-normal text-[var(--dim)]">(Stripe account: Cash 4 Cars C&B — live mode; real card payments.)</span></p>
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mt-3 text-sm">
                    <div className="bg-[var(--surface)] rounded-lg p-3"><p className="text-[11px] uppercase tracking-widest text-[var(--dim)]">Winning bid</p><p className="font-display text-2xl font-bold tabular">{money(listing.sale.amount)}</p></div>
                    <div className="bg-[var(--surface)] rounded-lg p-3"><p className="text-[11px] uppercase tracking-widest text-[var(--dim)]">Buyer fee ({buyerFeeRate(listing.sale.amount)})</p><p className="font-display text-2xl font-bold tabular">{money(listing.sale.buyerFee ?? buyerFeeFor(listing.sale.amount))}</p></div>
                    <div className="bg-[var(--surface)] rounded-lg p-3"><p className="text-[11px] uppercase tracking-widest text-[var(--dim)]">Processing fee (2.9% + $0.30)</p><p className="font-display text-2xl font-bold tabular">{moneyCents(listing.sale.processingFee ?? processingFeeCentsFor(listing.sale.amount + (listing.sale.buyerFee ?? buyerFeeFor(listing.sale.amount))))}</p></div>
                    <div className="bg-[var(--surface)] rounded-lg p-3"><p className="text-[11px] uppercase tracking-widest text-[var(--dim)]">Invoice total due</p><p className="font-display text-2xl font-bold tabular">{moneyCents((listing.sale.amount + (listing.sale.buyerFee ?? buyerFeeFor(listing.sale.amount))) * 100 + (listing.sale.processingFee ?? processingFeeCentsFor(listing.sale.amount + (listing.sale.buyerFee ?? buyerFeeFor(listing.sale.amount)))))}</p></div>
                    <div className="bg-[var(--surface)] rounded-lg p-3"><p className="text-[11px] uppercase tracking-widest text-[var(--dim)]">Seller fee</p><p className="font-display text-2xl font-bold tabular">Free</p></div>
                  </div>
                </>
              ) : (
                <p className="text-sm text-[var(--dim)] mt-1">{listing.bidCount === 0 ? "No bids — this one didn't sell. The seller can relist it." : listing.reservePrice != null && !listing.reserveMet ? `High bid was ${money(price)} but the reserve wasn't met — no sale, and no fees are owed.` : `Winner: ${listing.highBidder} at ${money(price)}. Seller and winner arrange payment and pickup directly.`}</p>
              )}
            </div>
          ) : (
            <form className="mt-5" onSubmit={(e: FormEvent) => { e.preventDefault(); setMsg(null); bidMut.mutate(); }}>
              <div className="grid sm:grid-cols-3 gap-3">
                <div>
                  <label htmlFor="bidder-name" className="text-xs font-semibold uppercase tracking-widest text-[var(--dim)]">Your name</label>
                  <input id="bidder-name" value={bidderName} onChange={(e) => setBidderName(e.target.value)} required placeholder="e.g. Charles M." className="mt-1 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-3 text-base" />
                </div>
                <div>
                  <label htmlFor="bidder-phone" className="text-xs font-semibold uppercase tracking-widest text-[var(--dim)]">Your mobile phone (required — for texts)</label>
                  <input id="bidder-phone" type="tel" value={bidderPhone} onChange={(e) => setBidderPhone(e.target.value)} required placeholder="So the seller can reach you" className="mt-1 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-3 text-base" />
                </div>
                <div>
                  <label htmlFor="bidder-email" className="text-xs font-semibold uppercase tracking-widest text-[var(--dim)]">Your email (required)</label>
                  <input id="bidder-email" type="email" value={bidderEmail} onChange={(e) => setBidderEmail(e.target.value)} required placeholder="you@example.com" className="mt-1 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-3 text-base" />
                </div>
              </div>
              <div className="grid sm:grid-cols-[1fr_auto] gap-3 mt-3">
                <div>
                  <label htmlFor="bid-amount" className="text-xs font-semibold uppercase tracking-widest text-[var(--dim)]">Your bid (min {money(minBid)})</label>
                  <input id="bid-amount" type="number" inputMode="numeric" min={minBid} step={1} value={amount} onChange={(e) => setAmount(e.target.value)} required placeholder={String(suggested)} className="mt-1 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-3 text-base tabular" />
                </div>
                <button type="submit" disabled={bidMut.isPending} className="self-end py-3 px-6 rounded-xl bg-[var(--accent-strong)] text-black font-display text-xl font-bold uppercase tracking-wide disabled:opacity-50" aria-label="Place bid">
                  {bidMut.isPending ? "Bidding…" : "Place bid"}
                </button>
              </div>
              <p className="text-xs text-[var(--dim)] mt-2">If you win, an invoice for the winning bid plus the buyer fee plus a card processing fee (2.9% of the subtotal + $0.30) is sent to you by text and email to pay by card through Stripe (live mode — a real card payment), and you and the seller get each other's contact info. Buyer fee if you win: {buyerFeeRate(Number(amount) || price)} of the winning bid ({money(buyerFeeFor(Number(amount) || price))} at {money(Number(amount) || price)}), plus a processing fee of {moneyCents(processingFeeCentsFor((Number(amount) || price) + buyerFeeFor(Number(amount) || price)))}. The seller is paid after Stripe verifies your invoice payment and both sides confirm the pickup.</p>
              <div className="flex flex-wrap gap-2 mt-3">
                {[100, 250, 500, 1000].map((inc) => (
                  <button key={inc} type="button" onClick={() => setAmount(String((listing.currentBid ?? listing.startingPrice) + inc))} className="px-3 py-1.5 rounded-full border border-[var(--border)] text-sm font-semibold" aria-label={`Set bid to current plus ${inc} dollars`}>+{money(inc)}</button>
                ))}
                <span className="text-xs text-[var(--dim)] self-center">Bids in the last 2 minutes extend the clock by 2 minutes.</span>
              </div>
              {msg && <p role="status" className={`mt-3 text-sm font-semibold ${msg.kind === "ok" ? "text-green-600" : "text-[var(--danger)]"}`}>{msg.text}</p>}
            </form>
          )}

          <div className="mt-7">
            <h3 className="font-display text-2xl font-semibold uppercase">Bid history</h3>
            {bids.length === 0 ? <p className="text-sm text-[var(--dim)] mt-2">No bids yet — the first one takes it at the starting price.</p> : (
              <ul className="mt-2 divide-y divide-[var(--border)]">
                {bids.map((b, i) => (
                  <li key={b.id} className="py-2.5 flex items-center justify-between text-sm">
                    <span className="font-semibold">{b.bidderName}{i === 0 ? <span className="ml-2 text-[11px] uppercase tracking-widest bg-[var(--accent-strong)] text-black px-2 py-0.5 rounded-full">High bid</span> : null}</span>
                    <span className="tabular font-semibold">{money(b.amount)} <span className="text-[var(--dim)] font-normal">· {new Date(b.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span></span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="mt-7 pt-4 border-t border-[var(--border)]">
            {!confirmDelete ? (
              <button type="button" onClick={() => setConfirmDelete(true)} className="text-sm text-[var(--danger)] underline underline-offset-4" aria-label="Remove this listing">Seller: remove this listing</button>
            ) : (
              <span className="flex flex-wrap gap-3 items-center text-sm">
                <span className="font-semibold">Remove this listing and all its bids?</span>
                <button type="button" onClick={() => deleteMut.mutate()} className="px-3 py-1.5 rounded-lg bg-[var(--danger)] text-white font-semibold" aria-label="Confirm remove listing">Yes, remove</button>
                <button type="button" onClick={() => setConfirmDelete(false)} className="underline" aria-label="Cancel removal">Cancel</button>
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SellForm({ onDone }: { onDone: (id: number) => void }) {
  const queryClient = useQueryClient();
  const [f, setF] = useState({ year: new Date().getFullYear().toString(), make: "", model: "", trim: "", mileage: "", condition: CONDITIONS[0] as string, titleStatus: TITLES[0] as string, location: "", description: "", sellerName: "", sellerPhone: "", sellerEmail: "", startingPrice: "", reservePrice: "", duration: "72" });
  const [photo, setPhoto] = useState<{ dataBase64: string; mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif"; preview: string; name: string } | null>(null);
  const [photoErr, setPhotoErr] = useState("");
  const [err, setErr] = useState("");
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  async function onPhoto(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    setPhotoErr("");
    if (!file) { setPhoto(null); return; }
    if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)) { setPhotoErr("Please pick a JPG, PNG, WebP, or GIF picture."); e.target.value = ""; return; }
    if (file.size > 8 * 1024 * 1024) { setPhotoErr("That picture is over 8 MB — pick a smaller one."); e.target.value = ""; return; }
    try {
      const { dataBase64, mimeType } = await fileToBase64(file);
      setPhoto({ dataBase64, mimeType: mimeType as "image/jpeg" | "image/png" | "image/webp" | "image/gif", preview: URL.createObjectURL(file), name: file.name });
    } catch {
      setPhotoErr("Couldn't read that picture — try another file.");
    }
  }

  const mut = useMutation({
    mutationFn: () => api.createListing({
      year: Number(f.year), make: f.make, model: f.model, trim: f.trim, mileage: Number(f.mileage),
      condition: f.condition as typeof CONDITIONS[number], titleStatus: f.titleStatus as typeof TITLES[number],
      location: f.location, description: f.description,
      photo: photo ? { dataBase64: photo.dataBase64, mimeType: photo.mimeType } : null,
      sellerName: f.sellerName, sellerPhone: f.sellerPhone, sellerEmail: f.sellerEmail,
      startingPrice: Number(f.startingPrice), reservePrice: f.reservePrice ? Number(f.reservePrice) : 0, durationHours: Number(f.duration),
    }),
    onSuccess: (r) => { queryClient.invalidateQueries({ queryKey: ["auctions"] }); onDone(r.id); },
    onError: (e) => setErr(e instanceof Error ? e.message : "Couldn't create the listing — check the fields and try again."),
  });

  const inputCls = "mt-1 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-base";
  const labelCls = "text-xs font-semibold uppercase tracking-widest text-[var(--dim)]";

  return (
    <form onSubmit={(e: FormEvent) => { e.preventDefault(); setErr(""); mut.mutate(); }} className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4 sm:p-6 pb-6">
      <h2 className="font-display text-3xl font-bold uppercase">List a car for auction</h2>
      <p className="text-sm text-[var(--dim)] mt-1">Anyone can list. It goes live the moment you submit, and bidding stays open until the clock runs out. Your mobile phone and email are required — when your car sells, you and the buyer instantly get a text and an email with each other's contact info. Selling is free — there is no seller fee. The buyer is invoiced the winning bid plus their buyer fee and a card processing fee (2.9% of the subtotal + $0.30), payable by card through Stripe (live account — real card payments), and you get paid once Stripe verifies the invoice payment and both sides confirm the pickup.</p>
      <div className="grid sm:grid-cols-3 gap-4 mt-5">
        <div><label htmlFor="sf-year" className={labelCls}>Year</label><input id="sf-year" type="number" required min={1900} max={2030} value={f.year} onChange={set("year")} className={inputCls} /></div>
        <div><label htmlFor="sf-make" className={labelCls}>Make</label><input id="sf-make" required value={f.make} onChange={set("make")} placeholder="Ford" className={inputCls} /></div>
        <div><label htmlFor="sf-model" className={labelCls}>Model</label><input id="sf-model" required value={f.model} onChange={set("model")} placeholder="F-150" className={inputCls} /></div>
        <div><label htmlFor="sf-trim" className={labelCls}>Trim (optional)</label><input id="sf-trim" value={f.trim} onChange={set("trim")} placeholder="XLT, Sport…" className={inputCls} /></div>
        <div><label htmlFor="sf-mileage" className={labelCls}>Mileage</label><input id="sf-mileage" type="number" required min={0} value={f.mileage} onChange={set("mileage")} placeholder="145000" className={inputCls} /></div>
        <div><label htmlFor="sf-location" className={labelCls}>Location (city, state)</label><input id="sf-location" required value={f.location} onChange={set("location")} placeholder="Chattanooga, TN" className={inputCls} /></div>
        <div><label htmlFor="sf-condition" className={labelCls}>Condition</label><select id="sf-condition" value={f.condition} onChange={set("condition")} className={inputCls}>{CONDITIONS.map((c) => <option key={c}>{c}</option>)}</select></div>
        <div><label htmlFor="sf-title" className={labelCls}>Title status</label><select id="sf-title" value={f.titleStatus} onChange={set("titleStatus")} className={inputCls}>{TITLES.map((t) => <option key={t}>{t}</option>)}</select></div>
        <div><label htmlFor="sf-duration" className={labelCls}>Auction length</label><select id="sf-duration" value={f.duration} onChange={set("duration")} className={inputCls}><option value="24">1 day</option><option value="48">2 days</option><option value="72">3 days</option><option value="120">5 days</option><option value="168">7 days</option><option value="336">14 days</option></select></div>
        <div><label htmlFor="sf-start" className={labelCls}>Starting bid ($)</label><input id="sf-start" type="number" required min={1} value={f.startingPrice} onChange={set("startingPrice")} placeholder="500" className={inputCls} /></div>
        <div><label htmlFor="sf-reserve" className={labelCls}>Reserve price ($) — optional</label><input id="sf-reserve" type="number" min={0} value={f.reservePrice} onChange={set("reservePrice")} placeholder="Leave blank for no reserve" className={inputCls} /></div>
        <div><label htmlFor="sf-seller" className={labelCls}>Your name (seller)</label><input id="sf-seller" required value={f.sellerName} onChange={set("sellerName")} placeholder="Shown on the listing" className={inputCls} /></div>
        <div><label htmlFor="sf-phone" className={labelCls}>Your mobile phone (required — for texts)</label><input id="sf-phone" type="tel" required value={f.sellerPhone} onChange={set("sellerPhone")} placeholder="So the winner can reach you" className={inputCls} /></div>
        <div><label htmlFor="sf-email" className={labelCls}>Your email (required)</label><input id="sf-email" type="email" required value={f.sellerEmail} onChange={set("sellerEmail")} placeholder="you@example.com" className={inputCls} /></div>
      </div>
      <div className="mt-4">
        <label htmlFor="sf-photo" className={labelCls}>Photo of the vehicle — upload from your phone or computer</label>
        <input id="sf-photo" type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={onPhoto} className="mt-1 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-base file:mr-3 file:rounded-lg file:border-0 file:bg-[var(--text)] file:px-3 file:py-1.5 file:text-[var(--bg)] file:font-semibold" aria-describedby="sf-photo-note" />
        <p id="sf-photo-note" className="text-xs text-[var(--dim)] mt-1">JPG, PNG, WebP, or GIF, up to 8 MB. Optional, but cars with a photo sell faster.</p>
        {photoErr && <p role="alert" className="mt-1 text-sm font-semibold text-[var(--danger)]">{photoErr}</p>}
        {photo && (
          <div className="mt-3 flex items-center gap-3">
            <img src={photo.preview} alt="Preview of the vehicle photo you picked" className="h-24 w-36 object-cover rounded-xl border border-[var(--border)]" />
            <div className="text-sm">
              <p className="font-semibold break-all">{photo.name}</p>
              <button type="button" onClick={() => setPhoto(null)} className="underline underline-offset-4 text-[var(--danger)]" aria-label="Remove the selected photo">Remove photo</button>
            </div>
          </div>
        )}
      </div>
      <div className="mt-4"><label htmlFor="sf-desc" className={labelCls}>Description — be honest about what it needs</label><textarea id="sf-desc" required rows={4} value={f.description} onChange={set("description")} placeholder="What runs, what doesn't, what's been replaced, any rust, leaks, or warning lights…" className={inputCls} /></div>
      {err && <p role="alert" className="mt-3 text-sm font-semibold text-[var(--danger)]">{err}</p>}
      <button type="submit" disabled={mut.isPending} className="mt-5 w-full sm:w-auto px-8 py-3.5 rounded-xl bg-[var(--accent-strong)] text-black font-display text-2xl font-bold uppercase tracking-wide disabled:opacity-50" aria-label="Start the auction">
        {mut.isPending ? "Listing…" : "Start the auction"}
      </button>
    </form>
  );
}

function channelBadge(m: Message) {
  if (m.channel === "in_app") return "In-app copy";
  if (m.channel === "sms") return m.sentAt ? "Text · sent" : "Text · queued";
  return m.sentAt ? "Email · sent" : "Email · queued";
}

function MessageCard({ m, onOpen }: { m: Message; onOpen: () => void }) {
  return (
    <article className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" onClick={onOpen} className="font-display text-2xl font-semibold uppercase leading-none text-left underline-offset-4 hover:underline" aria-label={`View the auction for ${m.car}`}>{m.car}</button>
        <span className={`text-[11px] font-semibold uppercase tracking-widest px-2 py-0.5 rounded-full ${m.sentAt ? "bg-[var(--accent-strong)] text-black" : "bg-[var(--surface2)] text-[var(--dim)]"}`}>{channelBadge(m)}</span>
      </div>
      <p className="text-xs text-[var(--dim)] mt-1">{m.role === "owner" ? "Fee / win notice for the site owner" : m.role === "buyer" ? "Sent to the winning buyer" : "Sent to the seller"} · {new Date(m.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</p>
      <p className="text-[15px] leading-relaxed mt-2">{m.body}</p>
    </article>
  );
}

function OwnerSettingsForm() {
  const queryClient = useQueryClient();
  const contact = useQuery({ queryKey: ["ownerContact"], queryFn: () => api.getOwnerContact({}) });
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (contact.data) { setName(contact.data.ownerName); setPhone(contact.data.ownerPhone); setEmail(contact.data.ownerEmail); }
  }, [contact.data]);
  const mut = useMutation({
    mutationFn: () => api.saveOwnerContact({ ownerName: name.trim(), ownerPhone: phone.trim(), ownerEmail: email.trim() }),
    onSuccess: () => { setSaved(true); queryClient.invalidateQueries({ queryKey: ["ownerContact"] }); queryClient.invalidateQueries({ queryKey: ["ownerMessages"] }); },
  });
  const inputCls = "mt-1 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-base";
  const labelCls = "text-xs font-semibold uppercase tracking-widest text-[var(--dim)]";
  return (
    <form onSubmit={(e: FormEvent) => { e.preventDefault(); setSaved(false); mut.mutate(); }} className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4 sm:p-5">
      <h3 className="font-display text-2xl font-bold uppercase">Owner contact — where win &amp; fee messages go</h3>
      <p className="text-sm text-[var(--dim)] mt-1">Site owner only: every time a car sells, a win message and the fee breakdown (selling is free for the seller · buyer pays 10% under $1,000 / 5% at $1,000+, plus a 2.9% + $0.30 card processing fee) are texted and emailed to this mobile number and email address — along with invoice-paid, pickup, payout, and delivery-request updates.</p>
      {!contact.isPending && contact.data && !contact.data.isSet && <p role="status" className="mt-2 text-sm font-semibold text-[var(--danger)]">Not set yet — until you save your number and email, win and fee messages can't be texted or emailed to you (in-app copies still appear below).</p>}
      <div className="grid sm:grid-cols-3 gap-3 mt-3">
        <div><label htmlFor="oc-name" className={labelCls}>Your name</label><input id="oc-name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Charles Morton" className={inputCls} /></div>
        <div><label htmlFor="oc-phone" className={labelCls}>Your mobile phone</label><input id="oc-phone" type="tel" required value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="For text messages" className={inputCls} /></div>
        <div><label htmlFor="oc-email" className={labelCls}>Your email</label><input id="oc-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className={inputCls} /></div>
      </div>
      {mut.error && <p role="alert" className="mt-2 text-sm font-semibold text-[var(--danger)]">{mut.error instanceof Error ? mut.error.message : "Couldn't save — check the fields and try again."}</p>}
      {saved && !mut.isPending && <p role="status" className="mt-2 text-sm font-semibold text-green-600">Saved — win and fee messages will be texted and emailed here on every sale.</p>}
      <button type="submit" disabled={mut.isPending || contact.isPending} className="mt-3 px-6 py-2.5 rounded-xl bg-[var(--accent-strong)] text-black font-display text-xl font-bold uppercase disabled:opacity-50" aria-label="Save owner contact info">
        {mut.isPending ? "Saving…" : "Save my contact info"}
      </button>
    </form>
  );
}

type DeliveryRequest = ApiResponse<typeof api, "listDeliveryRequests">["requests"][number];

function DeliveryRequestCard({ r }: { r: DeliveryRequest }) {
  const queryClient = useQueryClient();
  const [quote, setQuote] = useState("");
  const [err, setErr] = useState("");
  const [sent, setSent] = useState(false);
  const fmt = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const bothAgreed = r.deliveryBuyerAgreedAt != null && r.deliverySellerAgreedAt != null;
  const quoteMut = useMutation({
    mutationFn: () => api.quoteDelivery({ saleId: r.saleId, quoteCents: Math.round(Number(quote) * 100) }),
    onSuccess: () => {
      setSent(true);
      setQuote("");
      queryClient.invalidateQueries({ queryKey: ["deliveryRequests"] });
      queryClient.invalidateQueries({ queryKey: ["ownerMessages"] });
    },
    onError: (e) => setErr(e instanceof Error ? e.message : "Couldn't send the quote — try again."),
  });
  const inputCls = "mt-1 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-base";
  const labelCls = "text-xs font-semibold uppercase tracking-widest text-[var(--dim)]";
  return (
    <article className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h4 className="font-display text-2xl font-bold uppercase leading-none">{r.car}</h4>
        {bothAgreed ? (
          <span className="text-[11px] font-bold uppercase tracking-widest px-2.5 py-1 rounded-full bg-[var(--accent-strong)] text-black">Booked at {r.deliveryQuoteCents != null ? moneyCents(r.deliveryQuoteCents) : ""}</span>
        ) : r.deliveryQuoteCents != null ? (
          <span className="text-[11px] font-bold uppercase tracking-widest px-2.5 py-1 rounded-full bg-[var(--surface2)] border border-[var(--border)]">Quoted {moneyCents(r.deliveryQuoteCents)} — awaiting agreement</span>
        ) : (
          <span className="text-[11px] font-bold uppercase tracking-widest px-2.5 py-1 rounded-full bg-[var(--surface2)] border border-[var(--border)]">Needs your quote</span>
        )}
      </div>
      <p className="text-sm mt-2">Pickup: <strong>{r.pickupLocation}</strong> (seller {r.sellerName} — {r.sellerContact})<br />Deliver to: <strong>{r.deliveryAddress}</strong> (buyer {r.buyerName} — {r.buyerContact}){r.deliveryNotes ? <><br />Notes: {r.deliveryNotes}</> : null}{r.deliveryRequestedAt ? <><br /><span className="text-[var(--dim)]">Requested {fmt(r.deliveryRequestedAt)}</span></> : null}</p>
      {r.deliveryQuoteCents != null && (
        <p className="text-sm mt-2">Quote: <strong>{moneyCents(r.deliveryQuoteCents)} for the whole trip</strong>{r.deliveryQuotedAt ? ` · sent ${fmt(r.deliveryQuotedAt)}` : ""}<br />
          Buyer: {r.deliveryBuyerAgreedAt ? <span className="font-semibold text-green-600">✓ agreed {fmt(r.deliveryBuyerAgreedAt)}</span> : "not agreed yet"} · Seller: {r.deliverySellerAgreedAt ? <span className="font-semibold text-green-600">✓ agreed {fmt(r.deliverySellerAgreedAt)}</span> : "not agreed yet"}
        </p>
      )}
      {!bothAgreed && (
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); setErr(""); setSent(false); quoteMut.mutate(); }} className="mt-3">
          <div className="grid sm:grid-cols-[1fr_auto] gap-3 items-end">
            <div>
              <label htmlFor={`dq-${r.saleId}`} className={labelCls}>{r.deliveryQuoteCents != null ? "New quote for this trip ($)" : "Your quote for this trip ($)"}</label>
              <input id={`dq-${r.saleId}`} type="number" inputMode="decimal" min={0.01} step="0.01" required value={quote} onChange={(e) => setQuote(e.target.value)} placeholder="e.g. 150" className={`${inputCls} tabular`} />
            </div>
            <button type="submit" disabled={quoteMut.isPending} className="py-2.5 px-5 rounded-xl bg-[var(--accent-strong)] text-black font-display text-lg font-bold uppercase disabled:opacity-50" aria-label={`Send the delivery quote for the ${r.car}`}>
              {quoteMut.isPending ? "Sending…" : r.deliveryQuoteCents != null ? "Send new quote" : "Send quote"}
            </button>
          </div>
          <p className="text-xs text-[var(--dim)] mt-2">One price for the whole trip — no flat rate, no per-mile rate. The quote goes to both buyer and seller by text, email, and in-app, and shows in their checkout; each side agrees to it there before the haul is booked.{r.deliveryQuoteCents != null ? " Sending a new quote replaces the old one and clears any agreement already given." : ""}</p>
          {err && <p role="alert" className="mt-2 text-sm font-semibold text-[var(--danger)]">{err}</p>}
          {sent && !quoteMut.isPending && <p role="status" className="mt-2 text-sm font-semibold text-green-600">Quote sent — buyer and seller can see it in the checkout and agree to it.</p>}
        </form>
      )}
      {bothAgreed && <p className="text-sm text-[var(--dim)] mt-2">Both sides agreed to this price — arrange the haul and contact buyer and seller to schedule it.</p>}
    </article>
  );
}

function DeliveryRequestsPanel() {
  const requests = useQuery({ queryKey: ["deliveryRequests"], queryFn: () => api.listDeliveryRequests({}), refetchInterval: 15000 });
  return (
    <section aria-label="Delivery requests" className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4 sm:p-5">
      <h3 className="font-display text-2xl font-bold uppercase">Delivery requests — quote per trip</h3>
      <p className="text-sm text-[var(--dim)] mt-1">Site owner only: when a buyer or seller asks for delivery, it lands here with the pickup and delivery addresses and notes. Quote one price for the whole trip — there is no flat rate and no per-mile rate. Both sides see the quoted price in their checkout and agree to it before you haul.</p>
      {requests.isPending ? <p className="py-6 text-center text-[var(--dim)]">Loading delivery requests…</p>
        : requests.error ? <p className="py-6 text-center text-[var(--danger)]">Couldn't load delivery requests. <button type="button" className="underline" onClick={() => requests.refetch()} aria-label="Retry loading delivery requests">Retry</button></p>
        : !requests.data || requests.data.requests.length === 0 ? <p className="text-sm text-[var(--dim)] mt-3">No delivery requests yet — when a buyer or seller taps "Arrange delivery" in a sale's checkout, it shows up here for your per-trip quote.</p>
        : (
          <div className="flex flex-col gap-3 mt-4">
            {requests.data.requests.map((r) => <DeliveryRequestCard key={r.saleId} r={r} />)}
          </div>
        )}
    </section>
  );
}

type Checkout = ApiResponse<typeof api, "getSaleCheckout">;

function stripeStatusLabel(c: Checkout): { label: string; paid: boolean } {
  if (c.invoicePaidAt || c.stripePaymentStatus === "paid") return { label: "Paid — verified by Stripe", paid: true };
  switch (c.stripePaymentStatus) {
    case "creating": return { label: "Creating your Stripe checkout link…", paid: false };
    case "open": return { label: "Awaiting card payment on Stripe", paid: false };
    case "expired": return { label: "Stripe checkout link expired — create a new one", paid: false };
    case "failed": return { label: "Stripe payment failed — try again", paid: false };
    default: return { label: "Not paid yet", paid: false };
  }
}

function CheckoutPanel({ code }: { code: string }) {
  const queryClient = useQueryClient();
  const checkout = useQuery({ queryKey: ["saleCheckout", { code }], queryFn: () => api.getSaleCheckout({ accessCode: code }), enabled: code.trim().length >= 6, refetchInterval: 5000 });
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [actionErr, setActionErr] = useState("");
  const [checkMsg, setCheckMsg] = useState("");
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["saleCheckout"] });
    queryClient.invalidateQueries({ queryKey: ["myMessages"] });
  };
  const onErr = (e: unknown) => setActionErr(e instanceof Error ? e.message : "Something went wrong — try again.");
  const createStripeMut = useMutation({ mutationFn: () => api.createStripeCheckout({ accessCode: code }), onSuccess: refresh, onError: onErr });
  const checkStripeMut = useMutation({
    mutationFn: () => api.checkStripePayment({ accessCode: code }),
    onSuccess: () => { setCheckMsg("Checking with Stripe now — this page refreshes on its own. If you just paid, the paid status usually shows within a minute."); refresh(); },
    onError: onErr,
  });
  const pickupMut = useMutation({ mutationFn: (role: "buyer" | "seller") => api.confirmPickup({ accessCode: code, role }), onSuccess: refresh, onError: onErr });
  const deliveryMut = useMutation({ mutationFn: () => api.requestDelivery({ accessCode: code, deliveryAddress: address.trim(), deliveryNotes: notes.trim() }), onSuccess: refresh, onError: onErr });
  const agreeDeliveryMut = useMutation({ mutationFn: (role: "buyer" | "seller") => api.agreeToDelivery({ accessCode: code, role }), onSuccess: refresh, onError: onErr });

  if (checkout.isPending) return <p className="mt-4 text-[var(--dim)]">Loading this sale's checkout…</p>;
  if (checkout.error || !checkout.data || !checkout.data.found) return null;
  const c = checkout.data as Checkout;
  const fmt = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const inputCls = "mt-1 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-base";
  const labelCls = "text-xs font-semibold uppercase tracking-widest text-[var(--dim)]";
  const busy = createStripeMut.isPending || checkStripeMut.isPending || pickupMut.isPending || deliveryMut.isPending || agreeDeliveryMut.isPending;
  const stripe = stripeStatusLabel(c);

  return (
    <section aria-label={`Checkout for ${c.car}`} className="mt-4 bg-[var(--surface)] border-2 border-[var(--accent-strong)] rounded-2xl p-4 sm:p-5">
      <h3 className="font-display text-3xl font-bold uppercase leading-none">Checkout — {c.car}</h3>
      <p className="text-sm text-[var(--dim)] mt-1">Buyer: {c.buyerName} · Seller: {c.sellerName}. The seller gets paid only when Stripe has verified the invoice payment <em>and</em> both sides confirm the pickup.</p>

      <div className="grid sm:grid-cols-2 gap-4 mt-4">
        <div className="bg-[var(--surface2)] rounded-xl p-4">
          <p className="text-[11px] uppercase tracking-widest text-[var(--dim)]">Step 1 · Buyer invoice — pay by card through Stripe</p>
          <p className="font-display text-3xl font-bold tabular mt-1">{c.totalDue != null ? moneyCents(Math.round(c.totalDue * 100)) : "—"}</p>
          <p className="text-sm text-[var(--dim)]">Winning bid {c.amount != null ? money(c.amount) : "—"} + buyer fee {c.buyerFee != null ? money(c.buyerFee) : "—"} + processing fee {c.processingFee != null ? moneyCents(c.processingFee) : "—"} (2.9% of the subtotal + $0.30). Seller fee: free.</p>
          <p role="status" className={`mt-3 inline-block text-[11px] font-bold uppercase tracking-widest px-2.5 py-1 rounded-full ${stripe.paid ? "bg-[var(--accent-strong)] text-black" : "bg-[var(--surface)] border border-[var(--border)]"}`}>
            Stripe payment: {stripe.label}
          </p>
          <p className="text-xs text-[var(--dim)] mt-2">Stripe account: {c.stripeAccountName ?? "Cash 4 Cars C&B"} · <strong>Live mode</strong> — real card payments; real money moves.</p>
          {stripe.paid ? (
            <div className="mt-2 text-sm">
              <p role="status" className="font-semibold text-green-600">✓ Invoice paid by card through Stripe{c.invoicePaidAt ? ` — verified ${fmt(c.invoicePaidAt)}` : ""}</p>
              {c.stripePaymentIntentId && <p className="text-[var(--dim)] mt-1">Stripe payment: {c.stripePaymentIntentId}</p>}
              {c.stripeCheckoutSessionId && <p className="text-[var(--dim)]">Checkout session: {c.stripeCheckoutSessionId}</p>}
            </div>
          ) : (
            <>
              <p className="text-sm mt-2">{c.invoiceSentAt ? `Invoice sent ${fmt(c.invoiceSentAt)} by text and email with your Stripe pay link.` : "Your Stripe pay link is sent by text and email."} Pay on Stripe's secure checkout page — the invoice only counts as paid once Stripe verifies the payment. There is no "I've paid" button anymore.</p>
              {c.stripeCheckoutUrl ? (
                <>
                  <a href={c.stripeCheckoutUrl} target="_blank" rel="noreferrer" className="mt-3 block w-full text-center py-3 rounded-xl bg-[var(--accent-strong)] text-black font-display text-xl font-bold uppercase" aria-label="Pay the invoice by card on Stripe">
                    Pay {c.totalDue != null ? moneyCents(Math.round(c.totalDue * 100)) : ""} by card on Stripe
                  </a>
                  <button type="button" disabled={busy} onClick={() => { setActionErr(""); setCheckMsg(""); checkStripeMut.mutate(); }} className="mt-2 w-full py-2.5 rounded-xl border-2 border-[var(--text)] font-display text-lg font-bold uppercase disabled:opacity-50" aria-label="Check my Stripe payment status">
                    {checkStripeMut.isPending ? "Asking Stripe…" : "I paid on Stripe — check payment status"}
                  </button>
                  {checkMsg && <p role="status" className="mt-2 text-xs text-[var(--dim)]">{checkMsg}</p>}
                  <p className="text-xs text-[var(--dim)] mt-2">After paying on Stripe, come back here and tap check payment status — AuctionFloor asks Stripe directly{c.stripeLastCheckedAt ? ` (last checked ${fmt(c.stripeLastCheckedAt)})` : ""}.</p>
                </>
              ) : c.stripePaymentStatus === "creating" ? (
                <p role="status" className="mt-3 text-sm font-semibold">Creating your Stripe checkout link… this page refreshes on its own — your pay button and a texted/emailed link appear in a moment.</p>
              ) : (
                <button type="button" disabled={busy} onClick={() => { setActionErr(""); createStripeMut.mutate(); }} className="mt-3 w-full py-2.5 rounded-xl bg-[var(--accent-strong)] text-black font-display text-xl font-bold uppercase disabled:opacity-50" aria-label="Create my Stripe checkout link to pay by card">
                  {createStripeMut.isPending ? "Creating…" : c.stripePaymentStatus === "expired" ? "Create a new Stripe checkout link" : "Pay by card — create my Stripe checkout"}
                </button>
              )}
            </>
          )}
        </div>

        <div className="bg-[var(--surface2)] rounded-xl p-4">
          <p className="text-[11px] uppercase tracking-widest text-[var(--dim)]">Step 2 · Pickup — both sides confirm</p>
          {c.payoutReleasedAt ? (
            <p role="status" className="mt-2 text-base font-semibold text-green-600">✓ Seller paid {c.amount != null ? money(c.amount) : ""} — payout released {fmt(c.payoutReleasedAt)}. This sale is complete.</p>
          ) : (
            <>
              <p className="text-sm mt-2">When the car changes hands, each side taps their own button:</p>
              <div className="flex flex-col gap-2 mt-3">
                {c.buyerPickupConfirmedAt ? (
                  <p role="status" className="text-sm font-semibold text-green-600">✓ Buyer confirmed pickup — {fmt(c.buyerPickupConfirmedAt)}</p>
                ) : (
                  <button type="button" disabled={busy} onClick={() => { setActionErr(""); pickupMut.mutate("buyer"); }} className="py-2.5 rounded-xl bg-[var(--text)] text-[var(--bg)] font-display text-lg font-bold uppercase disabled:opacity-50" aria-label="Buyer confirms the car was picked up">
                    Buyer: confirm pickup
                  </button>
                )}
                {c.sellerPickupConfirmedAt ? (
                  <p role="status" className="text-sm font-semibold text-green-600">✓ Seller confirmed pickup — {fmt(c.sellerPickupConfirmedAt)}</p>
                ) : (
                  <button type="button" disabled={busy} onClick={() => { setActionErr(""); pickupMut.mutate("seller"); }} className="py-2.5 rounded-xl bg-[var(--text)] text-[var(--bg)] font-display text-lg font-bold uppercase disabled:opacity-50" aria-label="Seller confirms the car was picked up">
                    Seller: confirm pickup
                  </button>
                )}
              </div>
              <p className="text-xs text-[var(--dim)] mt-2">
                {!c.invoicePaidAt && !c.buyerPickupConfirmedAt && !c.sellerPickupConfirmedAt ? "Payout releases as soon as Stripe verifies the invoice payment and both confirmations are in." :
                  !c.invoicePaidAt ? "Both confirmations are in — the payout releases the moment Stripe verifies the invoice payment." :
                  "Invoice payment is verified by Stripe — the payout releases the moment both confirmations are in."}
              </p>
            </>
          )}
        </div>
      </div>

      <div className="bg-[var(--surface2)] rounded-xl p-4 mt-4">
        <p className="text-[11px] uppercase tracking-widest text-[var(--dim)]">Or · Delivery arranged by the site owner — priced per trip</p>
        {c.deliveryRequestedAt ? (
          <div className="mt-2 text-sm">
            <p role="status" className="font-semibold text-green-600">✓ Delivery requested — {fmt(c.deliveryRequestedAt)}</p>
            <p className="mt-1">Deliver to: <strong>{c.deliveryAddress}</strong>{c.deliveryNotes ? <><br />Notes: {c.deliveryNotes}</> : null}</p>
            {c.deliveryQuoteCents == null ? (
              <p className="text-[var(--dim)] mt-2">Delivery is priced per trip — no flat rate, no per-mile rate. The site owner is quoting the cost for this trip from the pickup and delivery addresses and notes entered. The quoted price will show here, and both buyer and seller agree to it before the haul is booked.</p>
            ) : c.deliveryBuyerAgreedAt && c.deliverySellerAgreedAt ? (
              <div className="mt-3">
                <p role="status" className="font-semibold text-green-600">✓ Delivery booked at the quoted price — both sides agreed {fmt(c.deliverySellerAgreedAt > c.deliveryBuyerAgreedAt ? c.deliverySellerAgreedAt : c.deliveryBuyerAgreedAt)}.</p>
                <p className="font-display text-3xl font-bold tabular mt-1">{moneyCents(c.deliveryQuoteCents)} <span className="text-base font-semibold text-[var(--dim)]">for the whole trip</span></p>
                <p className="text-[var(--dim)] mt-1">The site owner will personally arrange the haul and contact both sides to schedule it.</p>
              </div>
            ) : (
              <div className="mt-3">
                <p className="text-[11px] uppercase tracking-widest text-[var(--dim)]">Quoted delivery price — per trip{c.deliveryQuotedAt ? ` · quoted ${fmt(c.deliveryQuotedAt)}` : ""}</p>
                <p className="font-display text-4xl font-bold tabular leading-none mt-1">{moneyCents(c.deliveryQuoteCents)}</p>
                <p className="text-[var(--dim)] mt-1">One price for the whole trip, quoted by the site owner from the pickup and delivery addresses — no flat rate, no per-mile rate. Delivery is booked only when <em>both</em> sides agree to this price:</p>
                <div className="flex flex-col gap-2 mt-3">
                  {c.deliveryBuyerAgreedAt ? (
                    <p role="status" className="text-sm font-semibold text-green-600">✓ Buyer agreed to {moneyCents(c.deliveryQuoteCents)} — {fmt(c.deliveryBuyerAgreedAt)}</p>
                  ) : (
                    <button type="button" disabled={busy} onClick={() => { setActionErr(""); agreeDeliveryMut.mutate("buyer"); }} className="py-2.5 rounded-xl bg-[var(--text)] text-[var(--bg)] font-display text-lg font-bold uppercase disabled:opacity-50" aria-label={`Buyer agrees to delivery at ${moneyCents(c.deliveryQuoteCents)}`}>
                      Buyer: agree to delivery at {moneyCents(c.deliveryQuoteCents)}
                    </button>
                  )}
                  {c.deliverySellerAgreedAt ? (
                    <p role="status" className="text-sm font-semibold text-green-600">✓ Seller agreed to {moneyCents(c.deliveryQuoteCents)} — {fmt(c.deliverySellerAgreedAt)}</p>
                  ) : (
                    <button type="button" disabled={busy} onClick={() => { setActionErr(""); agreeDeliveryMut.mutate("seller"); }} className="py-2.5 rounded-xl bg-[var(--text)] text-[var(--bg)] font-display text-lg font-bold uppercase disabled:opacity-50" aria-label={`Seller agrees to delivery at ${moneyCents(c.deliveryQuoteCents)}`}>
                      Seller: agree to delivery at {moneyCents(c.deliveryQuoteCents)}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : (
          <form onSubmit={(e: FormEvent) => { e.preventDefault(); setActionErr(""); deliveryMut.mutate(); }} className="mt-2">
            <p className="text-sm">Skip the pickup run — the site owner will personally arrange delivery from the seller to the buyer. Delivery is priced per trip: no flat rate and no per-mile rate. The owner quotes the cost for the trip from the pickup and delivery addresses and the notes you enter, and that quoted price is shown to both buyer and seller here before either side agrees to delivery.</p>
            <div className="grid sm:grid-cols-2 gap-3 mt-3">
              <div><label htmlFor="dlv-address" className={labelCls}>Delivery address (where the car goes)</label><input id="dlv-address" required minLength={5} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Street, city, state" className={inputCls} /></div>
              <div><label htmlFor="dlv-notes" className={labelCls}>Notes (optional)</label><input id="dlv-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Timing, gate, does it roll…" className={inputCls} /></div>
            </div>
            <button type="submit" disabled={busy} className="mt-3 px-6 py-2.5 rounded-xl border-2 border-[var(--text)] font-display text-lg font-bold uppercase disabled:opacity-50" aria-label="Request delivery arranged by the site owner">
              {deliveryMut.isPending ? "Sending…" : "Arrange delivery"}
            </button>
          </form>
        )}
      </div>

      {actionErr && <p role="alert" className="mt-3 text-sm font-semibold text-[var(--danger)]">{actionErr}</p>}
    </section>
  );
}

function OwnerLoginForm() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ["ownerStatus"], queryFn: () => api.ownerStatus() });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [done, setDone] = useState("");
  const isSetup = status.data && !status.data.ownerExists;
  const mut = useMutation({
    mutationFn: () =>
      isSetup ? api.ownerSetup({ email: email.trim(), password }) : api.ownerLogin({ email: email.trim(), password }),
    onSuccess: () => {
      setDone(isSetup ? "Owner account created — you are now logged in." : "Logged in as the site owner.");
      queryClient.invalidateQueries({ queryKey: ["ownerStatus"] });
      queryClient.invalidateQueries({ queryKey: ["ownerContact"] });
      queryClient.invalidateQueries({ queryKey: ["ownerMessages"] });
      queryClient.invalidateQueries({ queryKey: ["deliveryRequests"] });
    },
    onError: (e) => setErr(e instanceof Error ? e.message : "Login failed."),
  });
  const inputCls = "mt-1 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-base";
  const labelCls = "text-xs font-semibold uppercase tracking-widest text-[var(--dim)]";
  return (
    <form onSubmit={(e: FormEvent) => { e.preventDefault(); setErr(""); setDone(""); mut.mutate(); }} className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-4 sm:p-5">
      <h3 className="font-display text-2xl font-bold uppercase">{isSetup ? "Set up the owner account" : "Owner login"}</h3>
      <p className="text-sm text-[var(--dim)] mt-1">
        {isSetup
          ? "No owner account exists yet. Create it here — this email and password are how the site owner signs in to see fee notices, delivery quotes, and owner settings. (On the original site this was automatic; on the public site the owner signs in.)"
          : "Fee notices carry both parties' contact info, so this tab is visible only to the site owner. Log in with the owner email and password."}
      </p>
      <div className="grid sm:grid-cols-2 gap-3 mt-3">
        <div><label htmlFor="ol-email" className={labelCls}>Owner email</label><input id="ol-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className={inputCls} /></div>
        <div><label htmlFor="ol-password" className={labelCls}>Password (8+ characters)</label><input id="ol-password" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} className={inputCls} /></div>
      </div>
      {err && <p role="alert" className="mt-2 text-sm font-semibold text-[var(--danger)]">{err}</p>}
      {done && <p role="status" className="mt-2 text-sm font-semibold text-green-600">{done}</p>}
      <button type="submit" disabled={mut.isPending || status.isPending} className="mt-3 px-6 py-2.5 rounded-xl bg-[var(--accent-strong)] text-black font-display text-xl font-bold uppercase disabled:opacity-50">
        {mut.isPending ? "Working…" : isSetup ? "Create owner account" : "Log in"}
      </button>
    </form>
  );
}

function MessagesView({ onOpenListing }: { onOpenListing: (id: number) => void }) {
  const [tab, setTab] = useState<"mine" | "owner">("mine");
  const [code, setCode] = useState("");
  const contact = useQuery({ queryKey: ["ownerContact"], queryFn: () => api.getOwnerContact({}) });
  const isOwner = contact.data?.isOwner === true;
  const mine = useQuery({
    queryKey: ["myMessages", { code }],
    queryFn: () => api.listMyMessages({ accessCode: code }),
    enabled: tab === "mine" && code.trim().length >= 6,
  });
  const owner = useQuery({
    queryKey: ["ownerMessages"],
    queryFn: () => api.listOwnerMessages({}),
    enabled: tab === "owner" && isOwner,
    refetchInterval: 15000,
  });
  const inputCls = "mt-1 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-base";
  const labelCls = "text-xs font-semibold uppercase tracking-widest text-[var(--dim)]";

  return (
    <div className="pb-10">
      <h2 className="font-display text-4xl font-bold uppercase leading-none">Messages</h2>
      <p className="text-sm text-[var(--dim)] mt-2">When an auction is won, the buyer is invoiced by text and email with a Stripe pay link (winning bid + buyer fee + a 2.9% + $0.30 card processing fee — Stripe account in live mode, real card payments), buyer and seller get each other's contact info, and the site owner gets the win + fee message the same way. Enter a sale's access code below to see its messages and its checkout — pay the invoice by card on Stripe, confirm the pickup (both sides), or arrange delivery through the owner (priced per trip: the owner quotes the cost, and both sides see and agree to the quoted price before the haul is booked).</p>
      <div className="flex flex-wrap gap-2 mt-4" role="tablist" aria-label="Message inboxes">
        <button type="button" role="tab" aria-selected={tab === "mine"} onClick={() => setTab("mine")} className={`px-4 py-2 rounded-full font-display text-lg font-semibold uppercase tracking-wide ${tab === "mine" ? "bg-[var(--text)] text-[var(--bg)]" : "bg-[var(--surface)] border border-[var(--border)]"}`}>My messages</button>
        <button type="button" role="tab" aria-selected={tab === "owner"} onClick={() => setTab("owner")} className={`px-4 py-2 rounded-full font-display text-lg font-semibold uppercase tracking-wide ${tab === "owner" ? "bg-[var(--text)] text-[var(--bg)]" : "bg-[var(--surface)] border border-[var(--border)]"}`}>Owner — fees &amp; settings</button>
      </div>

      {tab === "mine" ? (
        <div className="mt-4">
          <div className="max-w-md">
            <label htmlFor="msg-code" className={labelCls}>Sale access code — from your win text or email</label>
            <input id="msg-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. K7QX2M9P" autoCapitalize="characters" className={`${inputCls} uppercase tracking-widest`} aria-describedby="msg-code-note" />
            <p id="msg-code-note" className="text-xs text-[var(--dim)] mt-1">Each sale's win text and email carries an 8-letter access code for that sale. It keeps the other side's contact info private — a phone number or email alone can't pull up anyone's messages.</p>
          </div>
          {code.trim().length < 6 ? (
            <p className="py-10 text-center text-[var(--dim)]">Enter the access code from your win text or email, and that sale's messages will show up here.</p>
          ) : mine.isPending ? <p className="py-10 text-center text-[var(--dim)]">Loading the sale's messages…</p>
            : mine.error ? <p className="py-10 text-center text-[var(--danger)]">Couldn't load messages. <button type="button" className="underline" onClick={() => mine.refetch()} aria-label="Retry loading messages">Retry</button></p>
            : !mine.data || mine.data.messages.length === 0 ? (
              <div className="py-12 text-center bg-[var(--surface)] border border-dashed border-[var(--border)] rounded-2xl mt-4 px-6">
                <p className="font-display text-3xl font-bold uppercase">No sale found for that code</p>
                <p className="text-[var(--dim)] mt-2">Check the code in your win text or email and try again — codes are 8 characters, letters and numbers.</p>
              </div>
            ) : (
              <>
                <CheckoutPanel code={code.trim()} />
                <div className="flex flex-col gap-3 mt-4">
                  {mine.data.messages.map((m) => <MessageCard key={m.id} m={m} onOpen={() => onOpenListing(m.listingId)} />)}
                </div>
              </>
            )}
        </div>
      ) : contact.isPending ? <p className="py-10 text-center text-[var(--dim)]">Checking owner access…</p>
      : !isOwner ? (
        <div className="mt-4 flex flex-col gap-4">
          <OwnerLoginForm />
          <div className="py-8 text-center bg-[var(--surface)] border border-dashed border-[var(--border)] rounded-2xl px-6">
            <p className="font-display text-3xl font-bold uppercase">Owner only</p>
            <p className="text-[var(--dim)] mt-2 max-w-md mx-auto">Fee notices carry both parties' contact info, so this tab — and the owner's contact settings — are visible only to the site owner after logging in above.</p>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-4">
          <OwnerSettingsForm />
          <DeliveryRequestsPanel />
          {owner.isPending ? <p className="py-8 text-center text-[var(--dim)]">Loading fee notices…</p>
            : owner.error ? <p className="py-8 text-center text-[var(--danger)]">Couldn't load fee notices. <button type="button" className="underline" onClick={() => owner.refetch()} aria-label="Retry loading fee notices">Retry</button></p>
            : !owner.data || owner.data.messages.length === 0 ? (
              <div className="py-12 text-center bg-[var(--surface)] border border-dashed border-[var(--border)] rounded-2xl px-6">
                <p className="font-display text-3xl font-bold uppercase">No sales yet</p>
                <p className="text-[var(--dim)] mt-2">The first time a car sells, the win message and the fee notice (selling is free · buyer fee 10% under $1,000 / 5% at $1,000+, plus a 2.9% + $0.30 card processing fee) are texted and emailed to the owner contact above, and copies land here — along with invoice, pickup, payout, and delivery updates.</p>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {owner.data.messages.map((m) => <MessageCard key={m.id} m={m} onOpen={() => onOpenListing(m.listingId)} />)}
              </div>
            )}
        </div>
      )}
    </div>
  );
}

export function App() {
  const now = useNow();
  const [filter, setFilter] = useState<"live" | "ending" | "ended" | "watched" | "all">("live");
  const [search, setSearch] = useState("");
  const [condition, setCondition] = useState("");
  const [sort, setSort] = useState<"ending" | "price_low" | "price_high" | "newest">("ending");
  const [view, setView] = useState<{ kind: "floor" } | { kind: "detail"; id: number } | { kind: "sell" } | { kind: "messages" }>({ kind: "floor" });

  const auctions = useQuery({
    queryKey: ["auctions", { search, filter, condition, sort }],
    queryFn: () => api.listAuctions({ search, filter, condition, sort }),
    refetchInterval: 15000,
  });
  const queryClient = useQueryClient();
  const watchMut = useMutation({
    mutationFn: (id: number) => api.toggleWatch({ listingId: id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["auctions"] }),
  });

  const listings = auctions.data?.listings ?? [];
  const stats = auctions.data?.stats;
  const featured = useMemo(() => (filter === "live" && !search ? listings[0] : undefined), [listings, filter, search]);
  const gridListings = featured ? listings.slice(1) : listings;

  const tabs: { key: typeof filter; label: string }[] = [
    { key: "live", label: "Live now" }, { key: "ending", label: "Ending < 24h" }, { key: "watched", label: "Watchlist" }, { key: "ended", label: "Ended" }, { key: "all", label: "All" },
  ];

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <header className="sticky top-0 z-20 bg-[#111214] text-[#f4f1ea] pt-safe shadow-md">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <button type="button" onClick={() => setView({ kind: "floor" })} className="text-left min-w-0" aria-label="Go to the auction floor">
            <span className="font-display text-2xl sm:text-3xl font-bold uppercase tracking-wide leading-none">Auction<span className="text-[var(--accent-strong)]">Floor</span></span>
            <span className="block text-[10px] sm:text-[11px] uppercase tracking-[0.2em] text-[#a39d90]">Cars · Open to everyone</span>
          </button>
          <div className="shrink-0 flex items-center gap-2">
            <button type="button" onClick={() => setView({ kind: "messages" })} className="px-3 sm:px-4 py-2.5 rounded-xl border border-[#f4f1ea]/40 text-[#f4f1ea] font-display text-lg sm:text-xl font-bold uppercase whitespace-nowrap" aria-label="Open messages">
              Messages
            </button>
            <button type="button" onClick={() => setView({ kind: "sell" })} className="px-3 sm:px-4 py-2.5 rounded-xl bg-[var(--accent-strong)] text-black font-display text-lg sm:text-xl font-bold uppercase whitespace-nowrap" aria-label="Sell a car — list it for auction">
              + Sell a car
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-4">
        {view.kind === "detail" ? (
          <DetailView id={view.id} now={now} onClose={() => setView({ kind: "floor" })} />
        ) : view.kind === "messages" ? (
          <div>
            <button type="button" onClick={() => setView({ kind: "floor" })} className="text-sm font-semibold underline underline-offset-4 mb-3" aria-label="Back to auctions">← Back to auctions</button>
            <MessagesView onOpenListing={(id) => setView({ kind: "detail", id })} />
          </div>
        ) : view.kind === "sell" ? (
          <div>
            <button type="button" onClick={() => setView({ kind: "floor" })} className="text-sm font-semibold underline underline-offset-4 mb-3" aria-label="Back to auctions">← Back to auctions</button>
            <SellForm onDone={(id) => setView({ kind: "detail", id })} />
          </div>
        ) : (
          <>
            {stats && (
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-[var(--dim)] mb-4" aria-label="Marketplace totals">
                <span><strong className="text-[var(--text)] font-display text-xl">{stats.live}</strong> live</span>
                <span><strong className="text-[var(--text)] font-display text-xl">{stats.totalBids}</strong> bids placed</span>
                <span><strong className="text-[var(--text)] font-display text-xl">{stats.ended}</strong> sold / ended</span>
                <span><strong className="text-[var(--text)] font-display text-xl">{stats.watched}</strong> watched</span>
              </div>
            )}

            <div className="flex gap-2 overflow-x-auto pb-1 -mx-4 px-4" role="tablist" aria-label="Auction filters">
              {tabs.map((t) => (
                <button key={t.key} type="button" role="tab" aria-selected={filter === t.key} onClick={() => setFilter(t.key)} className={`shrink-0 px-4 py-2 rounded-full font-display text-lg font-semibold uppercase tracking-wide ${filter === t.key ? "bg-[var(--text)] text-[var(--bg)]" : "bg-[var(--surface)] border border-[var(--border)]"}`}>
                  {t.label}
                </button>
              ))}
            </div>

            <div className="grid sm:grid-cols-[1fr_180px_180px] gap-3 mt-3">
              <div>
                <label htmlFor="search" className="sr-only">Search cars</label>
                <input id="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search make, model, or town — e.g. Ford, Silverado, Chattanooga" className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-base" />
              </div>
              <div>
                <label htmlFor="cond-filter" className="sr-only">Filter by condition</label>
                <select id="cond-filter" value={condition} onChange={(e) => setCondition(e.target.value)} className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-base">
                  <option value="">Any condition</option>
                  {CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="sort" className="sr-only">Sort auctions</label>
                <select id="sort" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-base">
                  <option value="ending">Ending soonest</option>
                  <option value="price_low">Price: low to high</option>
                  <option value="price_high">Price: high to low</option>
                  <option value="newest">Newest listed</option>
                </select>
              </div>
            </div>

            {auctions.isPending ? <p className="py-16 text-center text-[var(--dim)]">Loading the floor…</p>
              : auctions.error ? <p className="py-16 text-center text-[var(--danger)]">Couldn't load auctions. <button type="button" className="underline" onClick={() => auctions.refetch()} aria-label="Retry loading auctions">Retry</button></p>
              : listings.length === 0 ? (
                <div className="py-14 text-center bg-[var(--surface)] border border-dashed border-[var(--border)] rounded-2xl mt-6 px-6">
                  <p className="font-display text-3xl font-bold uppercase">{filter === "watched" ? "Nothing on your watchlist yet" : filter === "ended" ? "No ended auctions yet" : "The floor is empty"}</p>
                  <p className="text-[var(--dim)] mt-2 max-w-md mx-auto">{filter === "watched" ? "Tap ☆ Watch on any car and it'll wait for you here." : "No cars match right now. Be the first to put one on the block — listing is free and takes about two minutes."}</p>
                  {filter !== "watched" && <button type="button" onClick={() => setView({ kind: "sell" })} className="mt-5 px-6 py-3 rounded-xl bg-[var(--accent-strong)] text-black font-display text-xl font-bold uppercase" aria-label="List the first car">List a car</button>}
                </div>
              ) : (
                <>
                  {featured && (
                    <section aria-label="Ending soonest" className="mt-5 bg-[#111214] text-[#f4f1ea] rounded-2xl overflow-hidden">
                      <div className="grid md:grid-cols-2">
                        <button type="button" onClick={() => setView({ kind: "detail", id: featured.id })} className="block text-left" aria-label={`View featured ${featured.year} ${featured.make} ${featured.model}`}>
                          <CarVisual listing={featured} large />
                        </button>
                        <div className="p-5 sm:p-7 flex flex-col">
                          <p className="text-[11px] uppercase tracking-[0.25em] text-[var(--accent-strong)] font-semibold">Ending soonest</p>
                          <h2 className="font-display text-4xl sm:text-5xl font-bold uppercase leading-none mt-2">{featured.year} {featured.make} {featured.model}{featured.trim ? ` ${featured.trim}` : ""}</h2>
                          <p className="text-sm text-[#a39d90] mt-2">{featured.mileage.toLocaleString()} mi · {featured.condition} · {featured.location}</p>
                          <div className="flex gap-8 mt-5">
                            <div><p className="text-[11px] uppercase tracking-widest text-[#a39d90]">{featured.currentBid != null ? "Current bid" : "Starting bid"}</p><p className="font-display text-5xl font-bold tabular leading-none">{money(featured.currentBid ?? featured.startingPrice)}</p></div>
                            <div><p className="text-[11px] uppercase tracking-widest text-[#a39d90]">Time left</p><p className={`font-display text-5xl font-bold tabular leading-none ${countdown(featured.endsAt, now).urgent ? "text-red-400" : ""}`}>{countdown(featured.endsAt, now).label}</p></div>
                          </div>
                          <button type="button" onClick={() => setView({ kind: "detail", id: featured.id })} className="mt-auto pt-6" aria-label={`Bid on the featured ${featured.make} ${featured.model}`}>
                            <span className="block w-full text-center py-3.5 rounded-xl bg-[var(--accent-strong)] text-black font-display text-2xl font-bold uppercase">Bid now — {featured.bidCount} bid{featured.bidCount === 1 ? "" : "s"} in</span>
                          </button>
                        </div>
                      </div>
                    </section>
                  )}
                  <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-5">
                    {gridListings.map((l) => (
                      <ListingCard key={l.id} listing={l} now={now} onOpen={() => setView({ kind: "detail", id: l.id })} onWatch={() => watchMut.mutate(l.id)} />
                    ))}
                  </div>
                </>
              )}

            <footer className="mt-10 text-sm text-[var(--dim)] leading-relaxed border-t border-[var(--border)] pt-4 pb-6">
              <p><strong className="text-[var(--text)]">How it works:</strong> anyone lists a car with a starting bid and a clock. Highest bid when the clock runs out wins (reserve must be met if the seller set one). Bids in the final 2 minutes extend the auction by 2 minutes so nobody gets sniped. Contact info — mobile phone and email — is required to list and to bid: the moment an auction is won, the buyer is invoiced by text and email, buyer and seller get each other's contact info, and the site owner gets the win and fee message the same way. The buyer pays the invoice by card on Stripe's secure checkout page (the connected Stripe account, Cash 4 Cars C&B, is in live mode — real card payments), and the invoice counts as paid only once Stripe verifies it; when the car is picked up, both buyer and seller confirm the pickup in the checkout under Messages — and that's when the seller gets paid. Prefer delivery? Either side can ask the site owner to arrange delivery from seller to buyer from the same checkout. Delivery is priced per trip — no flat rate and no per-mile rate: the owner personally quotes the cost for the trip from the pickup and delivery addresses and notes entered, and that quoted price is shown to both buyer and seller in the checkout before either side agrees to it.</p>
              <p className="mt-2"><strong className="text-[var(--text)]">Fees when a car sells:</strong> selling is free — the seller pays no fee. The buyer pays 10% of the winning bid on anything under $1,000, and 5% on $1,000 or more, on top of the winning bid, plus a card processing fee of 2.9% of the subtotal (winning bid + buyer fee) plus $0.30. No sale, no fees.</p>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}
