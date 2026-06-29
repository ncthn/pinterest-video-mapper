function num(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function rankPinsByAtc(ads, analyticsRows) {
  const adById = new Map(ads.map((ad) => [String(ad.id), ad]));
  const byPin = new Map();

  for (const row of analyticsRows) {
    const adId = String(row.AD_ID || row.ad_id || "");
    const ad = adById.get(adId);
    const pinId = String(ad?.pin_id || ad?.pinId || row.PIN_ID || row.pin_id || "");
    if (!pinId) continue;
    const atc = num(row.TOTAL_CLICK_ADD_TO_CART) + num(row.TOTAL_VIEW_ADD_TO_CART);
    const current = byPin.get(pinId) || { pinId, atc: 0, adIds: new Set() };
    current.atc += atc;
    if (adId) current.adIds.add(adId);
    byPin.set(pinId, current);
  }

  return [...byPin.values()]
    .map((row) => ({ ...row, adIds: [...row.adIds] }))
    .sort((a, b) => b.atc - a.atc || a.pinId.localeCompare(b.pinId));
}
