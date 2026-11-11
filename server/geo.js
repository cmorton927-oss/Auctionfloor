// Local-only radius check for AuctionFloor.
// Listings must be within RADIUS_MILES of CENTER_ZIP (Chattanooga 37406),
// keeping the auction local to the 423 area. Distances are haversine miles
// between ZIP-code centroids from the `zipcodes` package data, so a listing
// right on the boundary can be off by a few miles either way.
import zipcodes from "zipcodes";

export const CENTER_ZIP = "37406";
export const RADIUS_MILES = 250;

function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 3958.8; // Earth radius in miles
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function zipLookup(zip) {
  const row = zipcodes.lookup(String(zip ?? "").trim());
  if (!row || row.latitude == null || row.longitude == null) return null;
  return { zip: row.zip, city: row.city, state: row.state, latitude: row.latitude, longitude: row.longitude };
}

export function distanceFromCenterMiles(zip) {
  const a = zipLookup(zip);
  const b = zipLookup(CENTER_ZIP);
  if (!a || !b) return null;
  return haversineMiles(a.latitude, a.longitude, b.latitude, b.longitude);
}

// Returns { ok: true, miles } or { ok: false, reason }.
export function checkLocalRadius(zip) {
  const miles = distanceFromCenterMiles(zip);
  if (miles == null) return { ok: false, reason: "That ZIP code couldn't be found — check it and try again." };
  if (miles > RADIUS_MILES) {
    return {
      ok: false,
      miles,
      reason: `That ZIP code is about ${Math.round(miles)} miles from Chattanooga (37406) — AuctionFloor is local to the 423 area, within ${RADIUS_MILES} miles.`,
    };
  }
  return { ok: true, miles };
}
