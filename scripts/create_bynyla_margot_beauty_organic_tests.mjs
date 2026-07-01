#!/usr/bin/env node
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";

const firestoreProject = process.env.FIRESTORE_PROJECT || "gen-lang-client-0878196270";
const firestoreDb = process.env.FIRESTORE_DB || "(default)";
const pinterestApi = "https://api.pinterest.com/v5";
const storeId = "bynyla";
const promotionId = "7834020571808";
const dailySpendCap = 15_000_000;
const pinsPerCampaign = 15;
const campaignCount = 3;
const productHandle = "margot-bag";
const productUrl = "https://bynyla.com/products/margot-bag";
const beautySourceCampaignName = "Margot Bag - Video - WW - Manual - 3 ads groups";
const beautySourceAdGroupName = "Women + unspecified ; Interest: women's beauty";
const campaignsToPause = [
  "Copy 2026-06-27 of Margot Bag - Video - WW - Batch 1 - 20/day",
  "Copy 2026-06-27 of Copy 1 of Margot Bag - Video - WW - Manual - 3 ads groups",
  "Copy 2026-06-27 of Margot Bag - Video - WW - Batch 1",
];

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const dryRun = process.argv.includes("--dry-run");
const skipPauses = process.argv.includes("--skip-pauses");
const namePrefix = argValue("name-prefix", "Margot Organic Beauty Test 2026-07-01");

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

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readManifest(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function startTimeEpoch() {
  return Math.floor((Date.now() + 15 * 60 * 1000) / 1000);
}

function handleFromUrl(url) {
  try {
    const match = new URL(url).pathname.match(/\/products\/([^/?#]+)/);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

function campaignPayload(name, advertiserId) {
  return {
    ad_account_id: advertiserId,
    name,
    status: "ACTIVE",
    daily_spend_cap: dailySpendCap,
    is_flexible_daily_budgets: true,
    objective_type: "WEB_CONVERSION",
    is_campaign_budget_optimization: true,
    start_time: startTimeEpoch(),
  };
}

function adGroupPayload(name, campaignId, template) {
  return {
    name,
    status: "ACTIVE",
    campaign_id: campaignId,
    billable_event: template.billable_event || "IMPRESSION",
    targeting_spec: template.targeting_spec,
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

function adPayload(pin, campaignId, adGroupId) {
  return {
    ad_group_id: adGroupId,
    campaign_id: campaignId,
    name: `Organic Margot Beauty | ${pin.createdPinId}`,
    status: "ACTIVE",
    creative_type: "VIDEO",
    pin_id: pin.createdPinId,
    destination_url: productUrl,
    customizable_cta_type: "VISIT_SITE",
  };
}

async function ensureCampaign(token, advertiserId, campaigns, name) {
  const existing = campaigns.find((campaign) => campaign.name === name);
  if (existing) return existing;
  if (dryRun) return { id: `dry-campaign-${name}`, name, daily_spend_cap: dailySpendCap, status: "ACTIVE" };
  const created = await pinterestRequest(
    token,
    "POST",
    `/ad_accounts/${advertiserId}/campaigns`,
    [campaignPayload(name, advertiserId)],
    true,
  );
  const [campaign] = normalizeBatchResponse(created);
  if (!campaign?.id) throw new Error(`Campaign create returned no id: ${JSON.stringify(created).slice(0, 1000)}`);
  return campaign;
}

async function ensureAdGroup(token, advertiserId, campaignId, name, template) {
  if (dryRun) return { id: `dry-adgroup-${name}`, name, status: "ACTIVE" };
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
    [adGroupPayload(name, campaignId, template)],
    true,
  );
  const [adGroup] = normalizeBatchResponse(created);
  if (!adGroup?.id) throw new Error(`Ad group create returned no id: ${JSON.stringify(created).slice(0, 1000)}`);
  return adGroup;
}

async function ensureAds(token, advertiserId, campaignId, adGroupId, pins) {
  if (dryRun) return { existing: 0, created: pins.length };
  const existing = await listAll(token, `/ad_accounts/${advertiserId}/ads`, {
    ad_group_ids: adGroupId,
    entity_statuses: "ACTIVE,PAUSED,DRAFT",
  });
  const existingPinIds = new Set(existing.map((ad) => String(ad.pin_id)).filter(Boolean));
  const missing = pins.filter((pin) => !existingPinIds.has(String(pin.createdPinId)));
  if (!missing.length) return { existing: existing.length, created: 0 };
  const created = await pinterestRequest(
    token,
    "POST",
    `/ad_accounts/${advertiserId}/ads`,
    missing.map((pin) => adPayload(pin, campaignId, adGroupId)),
    true,
  );
  const ads = normalizeBatchResponse(created);
  return { existing: existing.length, created: ads.length };
}

async function pauseCampaigns(token, advertiserId, pauseTargets) {
  const toPause = pauseTargets.filter((campaign) => campaign.status !== "PAUSED");
  if (dryRun || skipPauses || !toPause.length) {
    return { requested: toPause.length, paused: 0, skipped: pauseTargets.length - toPause.length };
  }
  const payload = toPause.map((campaign) => ({
    id: campaign.id,
    ad_account_id: advertiserId,
    status: "PAUSED",
  }));
  const patched = await pinterestRequest(token, "PATCH", `/ad_accounts/${advertiserId}/campaigns`, payload, true);
  const campaigns = normalizeBatchResponse(patched);
  return { requested: toPause.length, paused: campaigns.length, skipped: pauseTargets.length - toPause.length };
}

function pickUntestedPins(queue, manifest, allAds) {
  const jobs = Array.isArray(queue) ? queue : (queue.jobs || []);
  const publishByJob = new Map(
    manifest
      .filter((event) => event.event === "published" && event.pinId)
      .map((event) => [event.jobId, event]),
  );
  const advertisedPinIds = new Set(allAds.map((ad) => String(ad.pin_id)).filter(Boolean));
  return jobs
    .filter((job) => job.productHandle === productHandle)
    .filter((job) => job.status === "published")
    .map((job) => ({ job, event: publishByJob.get(job.id) }))
    .filter((item) => item.event?.pinId)
    .map(({ job, event }) => ({
      sourcePinId: String(job.pinId),
      createdPinId: String(event.pinId),
      pinUrl: event.pinUrl || "",
      title: job.title || "",
      scheduledAt: job.scheduledAt || "",
    }))
    .filter((pin) => !advertisedPinIds.has(pin.createdPinId));
}

function chunkPins(pins) {
  const needed = pinsPerCampaign * campaignCount;
  if (pins.length < needed) {
    throw new Error(`Expected at least ${needed} untested ${productHandle} pins, found ${pins.length}`);
  }
  const selected = pins.slice(0, needed);
  return Array.from({ length: campaignCount }, (_, index) => selected.slice(index * pinsPerCampaign, (index + 1) * pinsPerCampaign));
}

function findBeautyTemplate(campaigns, adGroups) {
  const sourceCampaign = campaigns.find((campaign) => campaign.name === beautySourceCampaignName);
  const source = adGroups.find((adGroup) => (
    adGroup.name === beautySourceAdGroupName
    && (!sourceCampaign || adGroup.campaign_id === sourceCampaign.id)
  ));
  if (source?.targeting_spec) return source;
  const fallback = adGroups.find((adGroup) => (
    /Interest: women's beauty/i.test(adGroup.name || "")
    && adGroup.status === "ACTIVE"
    && adGroup.targeting_spec
  ));
  if (fallback) return fallback;
  throw new Error("Could not find an active women's beauty ad group template");
}

async function main() {
  const config = await fetchStoreConfig();
  const token = await decryptKms(config.pinterest_write_token_encrypted);
  const advertiserId = config.pinterest_advertiser_id;
  const [queue, manifest, campaigns, adGroups, ads] = await Promise.all([
    readJson("data/publish-queue.json"),
    readManifest("data/publish-manifest.jsonl"),
    listAll(token, `/ad_accounts/${advertiserId}/campaigns`, { entity_statuses: "ACTIVE,PAUSED,DRAFT" }),
    listAll(token, `/ad_accounts/${advertiserId}/ad_groups`, { entity_statuses: "ACTIVE,PAUSED,DRAFT" }),
    listAll(token, `/ad_accounts/${advertiserId}/ads`, { entity_statuses: "ACTIVE,PAUSED,DRAFT" }),
  ]);

  const untestedPins = pickUntestedPins(queue, manifest, ads);
  const groups = chunkPins(untestedPins);
  const templateAdGroup = findBeautyTemplate(campaigns, adGroups);
  const pauseTargets = campaigns.filter((campaign) => campaignsToPause.includes(campaign.name));
  const missingPauseTargets = campaignsToPause.filter((name) => !pauseTargets.some((campaign) => campaign.name === name));
  const plans = groups.map((pins, index) => ({
    campaignName: `${namePrefix} ${index + 1} - Beauty - 15 Pins - 15/day`,
    adGroupName: `${namePrefix} ${index + 1} - Women Beauty`,
    pins,
  }));

  console.log(JSON.stringify({
    dryRun,
    skipPauses,
    advertiserId,
    dailySpendCap,
    promotionId,
    untestedAvailable: untestedPins.length,
    selectedUniquePins: new Set(groups.flat().map((pin) => pin.createdPinId)).size,
    templateAdGroup: {
      id: templateAdGroup.id,
      name: templateAdGroup.name,
      campaignId: templateAdGroup.campaign_id,
      targetInterest: templateAdGroup.targeting_spec?.INTEREST || [],
    },
    plans: plans.map((plan) => ({
      campaignName: plan.campaignName,
      adGroupName: plan.adGroupName,
      pinCount: plan.pins.length,
      pins: plan.pins.map((pin) => pin.createdPinId),
    })),
    pauseTargets: pauseTargets.map((campaign) => ({
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      dailySpendCap: Number(campaign.daily_spend_cap || 0) / 1e6,
    })),
    missingPauseTargets,
  }, null, 2));

  const results = [];
  for (const plan of plans) {
    const campaign = await ensureCampaign(token, advertiserId, campaigns, plan.campaignName);
    campaigns.push(campaign);
    const adGroup = await ensureAdGroup(token, advertiserId, campaign.id, plan.adGroupName, templateAdGroup);
    const adsResult = await ensureAds(token, advertiserId, campaign.id, adGroup.id, plan.pins);
    results.push({
      campaignName: plan.campaignName,
      campaignId: campaign.id,
      adGroupId: adGroup.id,
      pinCount: plan.pins.length,
      pins: plan.pins,
      ads: adsResult,
    });
  }
  const pauseResult = await pauseCampaigns(token, advertiserId, pauseTargets);
  console.log(JSON.stringify({ results, pauseResult }, null, 2));
  await fs.writeFile(
    "data/bynyla-margot-beauty-organic-tests.json",
    `${JSON.stringify({ dryRun, plans, results, pauseTargets, pauseResult }, null, 2)}\n`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
