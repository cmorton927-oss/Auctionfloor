// Typed REST client for the Render port. Same action names as the
// original Muse artifact, now POST /api/<action> with a JSON body.
// (The original used the Hatch SDK action client; this port uses fetch.)
export type ApiResponse<T, K extends keyof T> = T[K] extends (args: any) => Promise<infer R> ? R : never;

async function call(action: string, args: Record<string, unknown> = {}) {
  const res = await fetch(`/api/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

// Each method mirrors one original action. The client (App.tsx) calls
// these exactly as it called the SDK actions.
export const api = {
  listAuctions: (args: { search?: string; filter?: string; condition?: string; sort?: string }) =>
    call("listAuctions", args) as Promise<{
      listings: any[];
      stats: { live: number; ended: number; totalBids: number; watched: number };
    }>,
  getAuction: (args: { id: number }) => call("getAuction", args) as Promise<{ listing: any; bids: any[] }>,
  createListing: (args: Record<string, unknown>) => call("createListing", args) as Promise<{ id: number }>,
  placeBid: (args: Record<string, unknown>) =>
    call("placeBid", args) as Promise<{ ok?: boolean; extended?: boolean; newEndsAt?: string; needsDeposit?: boolean; checkoutUrl?: string; sessionId?: string }>,
  buyNow: (args: Record<string, unknown>) =>
    call("buyNow", args) as Promise<{ ok?: boolean; saleId?: number; accessToken?: string | null; amount?: number; needsDeposit?: boolean; checkoutUrl?: string; sessionId?: string }>,
  bidderStatus: (args: { email: string }) => call("bidderStatus", args) as Promise<{ verified: boolean }>,
  confirmDeposit: (args: { sessionId: string }) =>
    call("confirmDeposit", args) as Promise<{ ok: boolean; alreadyConfirmed?: boolean; placed?: boolean; kind?: string; reason?: string; saleId?: number; accessToken?: string | null; amount?: number; extended?: boolean; newEndsAt?: string; listingId?: number | null }>,
  toggleWatch: (args: { listingId: number }) => call("toggleWatch", args) as Promise<{ watched: boolean }>,
  removeBid: (args: { listingId: number; bidId: number }) => call("removeBid", args) as Promise<{ ok: true }>,
  deleteListing: (args: { id: number }) => call("deleteListing", args) as Promise<{ ok: true }>,
  listMyMessages: (args: { accessCode: string }) => call("listMyMessages", args) as Promise<{ messages: any[] }>,
  getSaleCheckout: (args: { accessCode: string }) => call("getSaleCheckout", args) as Promise<any>,
  createStripeCheckout: (args: { accessCode: string }) => call("createStripeCheckout", args) as Promise<any>,
  checkStripePayment: (args: { accessCode: string }) => call("checkStripePayment", args) as Promise<any>,
  confirmPickup: (args: { accessCode: string; role: "buyer" | "seller" }) => call("confirmPickup", args) as Promise<any>,
  requestDelivery: (args: { accessCode: string; deliveryAddress: string; deliveryNotes?: string }) =>
    call("requestDelivery", args) as Promise<any>,
  quoteDelivery: (args: { saleId: number; quoteCents: number }) => call("quoteDelivery", args) as Promise<{ ok: true }>,
  agreeToDelivery: (args: { accessCode: string; role: "buyer" | "seller" }) => call("agreeToDelivery", args) as Promise<any>,
  listDeliveryRequests: (args: Record<string, unknown>) =>
    call("listDeliveryRequests", args) as Promise<{ requests: any[] }>,
  listOwnerMessages: (args: Record<string, unknown>) => call("listOwnerMessages", args) as Promise<{ messages: any[] }>,
  getOwnerContact: (args: Record<string, unknown>) =>
    call("getOwnerContact", args) as Promise<{
      ownerName: string; ownerPhone: string; ownerEmail: string; isSet: boolean; isOwner: boolean;
    }>,
  saveOwnerContact: (args: { ownerName: string; ownerPhone: string; ownerEmail: string }) =>
    call("saveOwnerContact", args) as Promise<{ ok: true }>,
  ownerStatus: () =>
    fetch("/api/owner/status").then((r) => r.json()) as Promise<{ ownerExists: boolean; isOwner: boolean; email: string }>,
  ownerSetup: (args: { email: string; password: string }) =>
    call("owner/setup", args) as Promise<{ ok: true; email: string }>,
  ownerLogin: (args: { email: string; password: string }) =>
    call("owner/login", args) as Promise<{ ok: true; email: string }>,
  ownerLogout: () => call("owner/logout", {}) as Promise<{ ok: true }>,
  subscribeAlerts: (args: { email: string }) => call("subscribeAlerts", args) as Promise<{ ok: true; alreadySubscribed: boolean }>,
  alertSubscriberCount: () => call("alertSubscriberCount", {}) as Promise<{ activeCount: number; totalCount: number }>,
  requestBidLookup: (args: { email: string }) => call("requestBidLookup", args) as Promise<{ ok: true; retryAfterSec?: number }>,
  getMyBids: (args: { email: string; code: string }) => call("getMyBids", args) as Promise<{ bids: any[] }>,
};
