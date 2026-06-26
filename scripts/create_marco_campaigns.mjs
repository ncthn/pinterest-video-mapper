#!/usr/bin/env node
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";

const firestoreProject = process.env.FIRESTORE_PROJECT || "gen-lang-client-0878196270";
const firestoreDb = process.env.FIRESTORE_DB || "(default)";
const pinterestApi = "https://api.pinterest.com/v5";
const startTime = Math.floor(new Date("2026-06-27T00:00:00.000Z").getTime() / 1000);
const dailySpendCap = 7_000_000;
const promotionId = "7834020584286";

const targetSpec = {
  LOCATION: [
    "US", "AU", "BE", "BG", "CA", "HR", "CY", "DK", "EE", "FI", "DE", "GR",
    "HK", "IE", "IL", "IT", "LV", "LT", "LU", "MT", "NL", "NO", "PL", "PT",
    "RO", "SK", "SI", "ES", "SE", "CH", "TW", "AE", "GB", "SG",
  ],
};

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const dryRun = process.argv.includes("--dry-run");
const storeId = argValue("store", "marcomarsano");
const queuePath = argValue("queue", "data/marco-publish-queue.json");

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
      const error = new Error(`Pinterest ${method} ${endpoint} failed: ${res.status} ${text.slice(0, 1000)}`);
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
  if (Array.isArray(body)) {
    return body.map((item) => item?.data || item).filter(Boolean);
  }
  if (Array.isArray(body?.items)) {
    return body.items.map((item) => item?.data || item).filter(Boolean);
  }
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

function byProduct(jobs) {
  const groups = new Map();
  for (const job of jobs) {
    if (job.status !== "published" || !job.createdPinId) continue;
    if (!groups.has(job.productTitle)) groups.set(job.productTitle, []);
    groups.get(job.productTitle).push(job);
  }
  return groups;
}

function take(grouped, productTitle, count, offset = 0) {
  const rows = grouped.get(productTitle) || [];
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(rows[(offset + i) % rows.length]);
  if (out.some((row) => !row)) throw new Error(`Not enough pins for ${productTitle}`);
  return out;
}

function uniquePins(rows) {
  return [...new Map(rows.map((row) => [row.createdPinId, row])).values()];
}

function campaignPlan(queue) {
  const grouped = byProduct(queue.jobs || []);
  const campaigns = [
    {
      name: "MM P+ Conversion - Mixed Set 1 - 10 Pins - 7/day",
      products: ["Bari Cargo Shorts", "Elio Stretch Chino", "Fiorenzo Cotton Shirt", "Lecce Cotton Shirt", "Renato Stretch Pants"],
      pins: uniquePins([
        ...take(grouped, "Bari Cargo Shorts", 2),
        ...take(grouped, "Elio Stretch Chino", 2),
        ...take(grouped, "Fiorenzo Cotton Shirt", 2),
        ...take(grouped, "Lecce Cotton Shirt", 2),
        ...take(grouped, "Renato Stretch Pants", 2),
      ]),
    },
    {
      name: "MM P+ Conversion - Mixed Set 2 - 10 Pins - 7/day",
      products: ["Bari Cargo Shorts", "Pavia Stretch Pants", "Riviera Polo", "Sabbio Cotton Shirt", "Santorini Leather Loafers"],
      pins: uniquePins([
        ...take(grouped, "Bari Cargo Shorts", 2),
        ...take(grouped, "Pavia Stretch Pants", 2),
        ...take(grouped, "Riviera Polo", 2),
        ...take(grouped, "Sabbio Cotton Shirt", 2),
        ...take(grouped, "Santorini Leather Loafers", 2),
      ]),
    },
    {
      name: "MM P+ Conversion - Mixed Set 3 - 10 Pins - 7/day",
      products: ["Elio Stretch Chino", "Fiorenzo Cotton Shirt", "Lecce Cotton Shirt", "Renato Stretch Pants", "Sabbio Cotton Shirt"],
      pins: uniquePins([
        ...take(grouped, "Elio Stretch Chino", 2),
        ...take(grouped, "Fiorenzo Cotton Shirt", 2),
        ...take(grouped, "Lecce Cotton Shirt", 2),
        ...take(grouped, "Renato Stretch Pants", 2),
        ...take(grouped, "Sabbio Cotton Shirt", 2, 2),
      ]),
    },
    {
      name: "MM P+ Conversion - Mixed Set 4 - 10 Pins - 7/day",
      products: ["Bari Cargo Shorts", "Pavia Stretch Pants", "Riviera Polo", "Sabbio Cotton Shirt", "Santorini Leather Loafers"],
      pins: uniquePins([
        ...take(grouped, "Bari Cargo Shorts", 2),
        ...take(grouped, "Pavia Stretch Pants", 2, 1),
        ...take(grouped, "Riviera Polo", 2),
        ...take(grouped, "Sabbio Cotton Shirt", 2, 2),
        ...take(grouped, "Santorini Leather Loafers", 2),
      ]),
    },
    {
      name: "MM P+ Conversion - Lido Linen Pants - 9 Pins - 7/day",
      products: ["Lido Linen Pants"],
      pins: uniquePins(take(grouped, "Lido Linen Pants", 9)),
    },
  ];

  for (const campaign of campaigns) {
    if (campaign.name.includes("10 Pins") && campaign.pins.length !== 10) {
      throw new Error(`${campaign.name} expected 10 unique pins, got ${campaign.pins.length}`);
    }
  }
  return campaigns;
}

function campaignPayload(name) {
  return {
    ad_account_id: undefined,
    name,
    status: "ACTIVE",
    daily_spend_cap: dailySpendCap,
    is_flexible_daily_budgets: true,
    objective_type: "WEB_CONVERSION",
    is_campaign_budget_optimization: true,
    is_performance_plus: true,
    start_time: startTime,
  };
}

function adGroupPayload(name, campaignId) {
  return {
    name,
    status: "ACTIVE",
    campaign_id: campaignId,
    billable_event: "IMPRESSION",
    targeting_spec: targetSpec,
    optimization_goal_metadata: {
      conversion_tag_v3_goal_metadata: {
        conversion_event: "CHECKOUT",
        learning_mode_type: "NOT_ACTIVE",
        is_roas_optimized: false,
        reporting_event: "CHECKOUT",
      },
    },
    bid_strategy_type: "AUTOMATIC_BID",
    promotion_ids: [promotionId],
    promotion_application_level: "AD_GROUP",
    default_utm_source_enabled: true,
  };
}

function adPayload(job, adGroupId, campaignId) {
  return {
    ad_group_id: adGroupId,
    campaign_id: campaignId,
    name: `Conversions Ad | ${job.title}`,
    status: "ACTIVE",
    creative_type: "VIDEO",
    pin_id: job.createdPinId,
    destination_url: job.productUrl,
    customizable_cta_type: "SHOP_NOW",
  };
}

async function ensureCampaign(token, advertiserId, existingCampaigns, name) {
  const existing = existingCampaigns.find((campaign) => campaign.name === name && campaign.is_performance_plus === true);
  if (existing) return existing;
  if (dryRun) return { id: `dry-campaign-${name}`, name };
  const payload = campaignPayload(name);
  payload.ad_account_id = advertiserId;
  const created = await pinterestRequest(
    token,
    "POST",
    `/ad_accounts/${advertiserId}/campaigns`,
    [payload],
    true,
  );
  const [campaign] = normalizeBatchResponse(created);
  if (!campaign?.id) throw new Error(`Campaign create returned no id: ${JSON.stringify(created).slice(0, 1000)}`);
  return campaign;
}

async function ensureAdGroup(token, advertiserId, campaignId, name) {
  if (dryRun) return { id: `dry-adgroup-${name}`, name };
  const existing = await listAll(token, `/ad_accounts/${advertiserId}/ad_groups`, { campaign_ids: campaignId });
  const found = existing.find((adGroup) => adGroup.name === name);
  if (found) return found;
  const created = await pinterestRequest(
    token,
    "POST",
    `/ad_accounts/${advertiserId}/ad_groups`,
    [adGroupPayload(name, campaignId)],
    true,
  );
  const [adGroup] = normalizeBatchResponse(created);
  if (!adGroup?.id) throw new Error(`Ad group create returned no id: ${JSON.stringify(created).slice(0, 1000)}`);
  return adGroup;
}

async function ensureAds(token, advertiserId, campaignId, adGroupId, pins) {
  if (dryRun) return { existing: 0, created: pins.length, missing: pins };
  const existing = await listAll(token, `/ad_accounts/${advertiserId}/ads`, { ad_group_ids: adGroupId });
  const existingPinIds = new Set(existing.map((ad) => ad.pin_id));
  const missing = pins.filter((job) => !existingPinIds.has(job.createdPinId));
  if (!missing.length) return { existing: existing.length, created: 0, missing };

  const created = await pinterestRequest(
    token,
    "POST",
    `/ad_accounts/${advertiserId}/ads`,
    missing.map((job) => adPayload(job, adGroupId, campaignId)),
    true,
  );
  const ads = normalizeBatchResponse(created);
  return { existing: existing.length, created: ads.length, missing };
}

async function main() {
  const queue = JSON.parse(await fs.readFile(queuePath, "utf8"));
  const config = await fetchStoreConfig();
  const token = await decryptKms(config.pinterest_write_token_encrypted);
  const advertiserId = config.pinterest_advertiser_id;
  const plan = campaignPlan(queue);
  console.log(JSON.stringify({
    dryRun,
    storeId,
    advertiserId,
    startTime,
    startTimeIso: new Date(startTime * 1000).toISOString(),
    dailySpendCap,
    promotionId,
    campaigns: plan.map((campaign) => ({
      name: campaign.name,
      productCount: campaign.products.length,
      pinCount: campaign.pins.length,
      products: campaign.products,
    })),
  }, null, 2));

  const campaigns = await listAll(token, `/ad_accounts/${advertiserId}/campaigns`);
  const results = [];
  for (const entry of plan) {
    const campaign = await ensureCampaign(token, advertiserId, campaigns, entry.name);
    campaigns.push(campaign);
    const adGroupName = `${entry.name} - ad group`;
    const adGroup = await ensureAdGroup(token, advertiserId, campaign.id, adGroupName);
    const ads = await ensureAds(token, advertiserId, campaign.id, adGroup.id, entry.pins);
    results.push({
      campaignName: entry.name,
      campaignId: campaign.id,
      adGroupId: adGroup.id,
      pinCount: entry.pins.length,
      existingAds: ads.existing,
      createdAds: ads.created,
      pins: entry.pins.map((pin) => ({ product: pin.productTitle, pinId: pin.createdPinId, url: pin.createdPinUrl })),
    });
    console.log(JSON.stringify(results.at(-1), null, 2));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
