#!/usr/bin/env node
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { rankPinsByAtc } from "./bynyla_campaign_lib.mjs";

const firestoreProject = process.env.FIRESTORE_PROJECT || "gen-lang-client-0878196270";
const firestoreDb = process.env.FIRESTORE_DB || "(default)";
const pinterestApi = "https://api.pinterest.com/v5";
const storeId = "bynyla";
const dailySpendCap = 5_000_000;
const promotionId = "7834020571808";
const sourceWwCampaignName = "Margot Bag - Video - WW - Batch 1 - 20/day";

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const dryRun = process.argv.includes("--dry-run");
const limit = Number(argValue("limit", "10"));
const lookbackDays = Number(argValue("lookback-days", "30"));

function gcloudToken() {
  return execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8" }).trim();
}

function firestoreValue(value) {
  if (!value) return undefined;
  if ("stringValue" in value) return value.stringValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(firestoreValue);
  if ("mapValue" in value) {
    return Object.fromEntries(
      Object.entries(value.mapValue.fields || {}).map(([key, child]) => [key, firestoreValue(child)]),
    );
  }
  return undefined;
}

async function fetchStoreConfig() {
  const token = gcloudToken();
  const url = `https://firestore.googleapis.com/v1/projects/${firestoreProject}/databases/${encodeURIComponent(firestoreDb)}/documents/stores/${storeId}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Firestore store read failed: ${res.status} ${await res.text()}`);
  const doc = await res.json();
  return Object.fromEntries(
    Object.entries(doc.fields || {}).map(([key, value]) => [key, firestoreValue(value)]),
  );
}

async function decryptKms(encrypted) {
  if (typeof encrypted === "string") encrypted = JSON.parse(encrypted);
  if (!encrypted?.ciphertext || !encrypted?.keyName) throw new Error("Missing encrypted token payload");
  const token = gcloudToken();
  const res = await fetch(`https://cloudkms.googleapis.com/v1/${encrypted.keyName}:decrypt`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ciphertext: encrypted.ciphertext }),
  });
  if (!res.ok) throw new Error(`KMS decrypt failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return Buffer.from(body.plaintext, "base64").toString("utf8");
}

async function pinterestRequest(token, method, endpoint, body = undefined, rawArrayFallback = false) {
  const send = async (payload) => {
    const res = await fetch(`${pinterestApi}${endpoint}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const text = await res.text();
    if (!res.ok) {
      const error = new Error(`Pinterest ${method} ${endpoint} failed: ${res.status} ${text.slice(0, 1500)}`);
      error.status = res.status;
      error.body = text;
      throw error;
    }
    return text ? JSON.parse(text) : {};
  };
  try {
    return await send(body);
  } catch (error) {
    if (
      rawArrayFallback
      && body
      && !Array.isArray(body)
      && Array.isArray(body.items)
      && String(error.body || "").includes("is not of type 'array'")
    ) {
      return send(body.items);
    }
    throw error;
  }
}

function normalizeBatchResponse(body) {
  const unwrap = (items) => {
    const exceptions = items
      .map((item) => item?.exceptions || item?.exception)
      .filter((exception) => exception && (!Array.isArray(exception) || exception.length));
    if (exceptions.length) {
      throw new Error(`Pinterest batch returned exceptions: ${JSON.stringify(exceptions).slice(0, 1500)}`);
    }
    return items.map((item) => item?.data || item).filter(Boolean);
  };
  if (Array.isArray(body)) return unwrap(body);
  if (Array.isArray(body?.items)) return unwrap(body.items);
  if (body?.data) return [body.data];
  return body ? [body] : [];
}

async function listAll(token, endpoint, params = {}) {
  const items = [];
  let bookmark = "";
  do {
    const query = new URLSearchParams({ page_size: "100", ...params });
    if (bookmark) query.set("bookmark", bookmark);
    const page = await pinterestRequest(token, "GET", `${endpoint}?${query}`);
    items.push(...(page.items || []));
    bookmark = page.bookmark || "";
  } while (bookmark);
  return items;
}

function dateDaysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function startTimeEpoch() {
  return Math.floor((Date.now() + 15 * 60 * 1000) / 1000);
}

async function fetchAdAnalytics(token, advertiserId, ads) {
  const columns = [
    "AD_ID",
    "PIN_ID",
    "TOTAL_CLICK_ADD_TO_CART",
    "TOTAL_VIEW_ADD_TO_CART",
    "SPEND_IN_MICRO_DOLLAR",
    "TOTAL_CLICK_CHECKOUT",
    "TOTAL_VIEW_CHECKOUT",
  ];
  const rows = [];
  const adIds = ads.map((ad) => ad.id).filter(Boolean);
  for (let index = 0; index < adIds.length; index += 50) {
    const batch = adIds.slice(index, index + 50);
    const query = new URLSearchParams({
      start_date: dateDaysAgo(lookbackDays),
      end_date: today(),
      granularity: "TOTAL",
      columns: columns.join(","),
      ad_ids: batch.join(","),
      conversion_report_time: "TIME_OF_AD_ACTION",
    });
    const body = await pinterestRequest(token, "GET", `/ad_accounts/${advertiserId}/ads/analytics?${query}`);
    rows.push(...(Array.isArray(body) ? body : body.items || body.data || []));
  }
  return rows;
}

async function fetchAdDetails(token, advertiserId, adIds) {
  const details = [];
  for (const adId of adIds) {
    const ad = await pinterestRequest(token, "GET", `/ad_accounts/${advertiserId}/ads/${adId}`);
    details.push(ad);
  }
  return details;
}

function adLookup(ads) {
  const map = new Map();
  for (const ad of ads) {
    if (!ad.pin_id) continue;
    const existing = map.get(ad.pin_id);
    if (!existing || String(ad.updated_time || "") > String(existing.updated_time || "")) {
      map.set(ad.pin_id, ad);
    }
  }
  return map;
}

function campaignPayload(name, targetSpec) {
  return {
    ad_account_id: undefined,
    name,
    status: "ACTIVE",
    daily_spend_cap: dailySpendCap,
    is_flexible_daily_budgets: true,
    objective_type: "WEB_CONVERSION",
    is_campaign_budget_optimization: true,
    is_performance_plus: true,
    start_time: startTimeEpoch(),
  };
}

function adGroupPayload(name, campaignId, targetSpec, template = {}) {
  return {
    name,
    status: "ACTIVE",
    campaign_id: campaignId,
    billable_event: template.billable_event || "IMPRESSION",
    targeting_spec: targetSpec,
    optimization_goal_metadata: template.optimization_goal_metadata || {
      conversion_tag_v3_goal_metadata: {
        conversion_event: "CHECKOUT",
        learning_mode_type: "NOT_ACTIVE",
        is_roas_optimized: false,
        reporting_event: "CHECKOUT",
      },
    },
    bid_strategy_type: template.bid_strategy_type || "AUTOMATIC_BID",
    promotion_ids: [promotionId],
    promotion_application_level: "AD_GROUP",
    default_utm_source_enabled: true,
  };
}

function adPayload(pin, adGroupId, campaignId, sourceAd) {
  const destinationUrl = sourceAd?.destination_url || sourceAd?.click_tracking_url || "";
  if (!destinationUrl) throw new Error(`Missing destination URL for pin ${pin.pinId}`);
  return {
    ad_group_id: adGroupId,
    campaign_id: campaignId,
    name: `Top ATC Ad | ${pin.pinId}`,
    status: "ACTIVE",
    creative_type: sourceAd?.creative_type || "VIDEO",
    pin_id: pin.pinId,
    destination_url: destinationUrl,
    customizable_cta_type: sourceAd?.customizable_cta_type || "SHOP_NOW",
  };
}

async function ensureCampaign(token, advertiserId, existingCampaigns, name, targetSpec) {
  const existing = existingCampaigns.find((campaign) => campaign.name === name);
  if (existing) return existing;
  if (dryRun) return { id: `dry-campaign-${name}`, name };
  const payload = campaignPayload(name, targetSpec);
  payload.ad_account_id = advertiserId;
  const created = await pinterestRequest(token, "POST", `/ad_accounts/${advertiserId}/campaigns`, [payload], true);
  const [campaign] = normalizeBatchResponse(created);
  if (!campaign?.id) throw new Error(`Campaign create returned no id: ${JSON.stringify(created).slice(0, 1000)}`);
  return campaign;
}

async function ensureAdGroup(token, advertiserId, campaignId, name, targetSpec, template) {
  if (dryRun) return { id: `dry-adgroup-${name}`, name };
  const existing = await listAll(token, `/ad_accounts/${advertiserId}/ad_groups`, {
    campaign_ids: campaignId,
    entity_statuses: "ACTIVE,PAUSED,DRAFT",
  });
  const found = existing.find((adGroup) => adGroup.name === name);
  if (found) return found;
  const created = await pinterestRequest(
    token,
    "POST",
    `/ad_accounts/${advertiserId}/ad_groups`,
    [adGroupPayload(name, campaignId, targetSpec, template)],
    true,
  );
  const [adGroup] = normalizeBatchResponse(created);
  if (!adGroup?.id) throw new Error(`Ad group create returned no id: ${JSON.stringify(created).slice(0, 1000)}`);
  return adGroup;
}

async function ensureAds(token, advertiserId, campaignId, adGroupId, pins, adsByPin) {
  if (dryRun) return { existing: 0, created: pins.length };
  const existing = await listAll(token, `/ad_accounts/${advertiserId}/ads`, {
    ad_group_ids: adGroupId,
    entity_statuses: "ACTIVE,PAUSED,DRAFT",
  });
  const existingPinIds = new Set(existing.map((ad) => ad.pin_id));
  const missing = pins.filter((pin) => !existingPinIds.has(pin.pinId));
  if (!missing.length) return { existing: existing.length, created: 0 };
  const payload = missing.map((pin) => adPayload(pin, adGroupId, campaignId, adsByPin.get(pin.pinId)));
  const created = await pinterestRequest(token, "POST", `/ad_accounts/${advertiserId}/ads`, payload, true);
  const ads = normalizeBatchResponse(created);
  return { existing: existing.length, created: ads.length };
}

function findSourceCampaign(campaigns) {
  const exact = campaigns.find((campaign) => campaign.name === sourceWwCampaignName);
  if (exact) return exact;
  const pplusWw = campaigns.find((campaign) => campaign.is_performance_plus && /WW/i.test(campaign.name));
  if (pplusWw) return pplusWw;
  throw new Error("Could not find a WW Performance+ source campaign");
}

async function main() {
  const config = await fetchStoreConfig();
  const token = await decryptKms(config.pinterest_write_token_encrypted);
  const advertiserId = config.pinterest_advertiser_id;

  const [campaigns, ads] = await Promise.all([
    listAll(token, `/ad_accounts/${advertiserId}/campaigns`, { entity_statuses: "ACTIVE,PAUSED,DRAFT" }),
    listAll(token, `/ad_accounts/${advertiserId}/ads`, { entity_statuses: "ACTIVE,PAUSED,DRAFT" }),
  ]);
  const analytics = await fetchAdAnalytics(token, advertiserId, ads);
  const ranked = rankPinsByAtc(ads, analytics).slice(0, limit);
  if (ranked.length < limit) throw new Error(`Expected ${limit} ranked pins, got ${ranked.length}`);
  const sourceAdDetails = await fetchAdDetails(
    token,
    advertiserId,
    ranked.map((pin) => pin.adIds[0]).filter(Boolean),
  );

  const sourceCampaign = findSourceCampaign(campaigns);
  const sourceAdGroups = await listAll(token, `/ad_accounts/${advertiserId}/ad_groups`, {
    campaign_ids: sourceCampaign.id,
    entity_statuses: "ACTIVE,PAUSED,DRAFT",
  });
  const templateAdGroup = sourceAdGroups[0] || {};
  const wwTargetSpec = templateAdGroup.targeting_spec || { LOCATION: [] };
  const frTargetSpec = { ...wwTargetSpec, LOCATION: ["FR"] };
  const adsByPin = adLookup(sourceAdDetails);
  const selectedPins = ranked.map((pin) => ({
    ...pin,
    destinationUrl: adsByPin.get(pin.pinId)?.destination_url || "",
  }));

  const plans = [
    {
      name: `Bynyla Top ATC Pins - WW P+ - ${limit} Pins - 5/day`,
      adGroupName: "Bynyla Top ATC Pins - WW P+ - ad group",
      targetSpec: wwTargetSpec,
    },
    {
      name: `Bynyla Top ATC Pins - FR P+ - ${limit} Pins - 5/day`,
      adGroupName: "Bynyla Top ATC Pins - FR P+ - ad group",
      targetSpec: frTargetSpec,
    },
  ];

  console.log(JSON.stringify({
    dryRun,
    advertiserId,
    dailySpendCap,
    promotionId,
    sourceCampaign: { id: sourceCampaign.id, name: sourceCampaign.name },
    dateRange: { start: dateDaysAgo(lookbackDays), end: today() },
    selectedPins,
    plans: plans.map((plan) => ({ name: plan.name, targetSpec: plan.targetSpec })),
  }, null, 2));

  const results = [];
  for (const plan of plans) {
    const campaign = await ensureCampaign(token, advertiserId, campaigns, plan.name, plan.targetSpec);
    campaigns.push(campaign);
    const adGroup = await ensureAdGroup(token, advertiserId, campaign.id, plan.adGroupName, plan.targetSpec, templateAdGroup);
    const adResult = await ensureAds(token, advertiserId, campaign.id, adGroup.id, selectedPins, adsByPin);
    results.push({
      campaignName: plan.name,
      campaignId: campaign.id,
      adGroupId: adGroup.id,
      selectedPins: selectedPins.map((pin) => ({ pinId: pin.pinId, atc: pin.atc, destinationUrl: pin.destinationUrl })),
      ads: adResult,
    });
  }
  console.log(JSON.stringify({ results }, null, 2));
  await fs.writeFile("data/bynyla-top-atc-campaigns.json", `${JSON.stringify({ selectedPins, results }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
