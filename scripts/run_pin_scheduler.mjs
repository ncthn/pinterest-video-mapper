#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_TIMEZONE,
  normalizeBoardName,
  selectNextDueJob,
  shouldStopForPinterestResponse,
} from "./pinterest_scheduler_lib.mjs";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const firestoreProject = "gen-lang-client-0878196270";
const firestoreDb = "(default)";
const storeId = "bynyla";
const pinterestApi = "https://api.pinterest.com/v5";

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== null) return fallback;
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temp, filePath);
}

async function appendJsonl(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`);
}

function rootPath(value) {
  return path.isAbsolute(value) ? value : path.join(root, value);
}

function gcloudToken() {
  return execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8" }).trim();
}

function firestoreValue(value) {
  if (!value) return undefined;
  if ("stringValue" in value) return value.stringValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
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

async function pinterestRequest(token, method, endpoint, body = undefined) {
  const res = await fetch(`${pinterestApi}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (shouldStopForPinterestResponse({ status: res.status, body: text })) {
    const error = new Error(`Pinterest risk stop: ${res.status} ${text.slice(0, 300)}`);
    error.riskStop = true;
    throw error;
  }
  if (!res.ok) throw new Error(`Pinterest ${method} ${endpoint} failed: ${res.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

async function shopifyGraphql(shopifyUrl, shopifyToken, query, variables = {}) {
  const res = await fetch(`https://${shopifyUrl}/admin/api/2025-01/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": shopifyToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) throw new Error(`Shopify GraphQL failed: ${JSON.stringify(body.errors || body).slice(0, 500)}`);
  return body.data;
}

async function downloadVideo(job, cacheDir) {
  await fs.mkdir(cacheDir, { recursive: true });
  const videoPath = path.join(cacheDir, `${job.pinId}.mp4`);
  try {
    const stat = await fs.stat(videoPath);
    if (stat.size > 0) return videoPath;
  } catch {}
  const res = await fetch(job.videoUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Video download failed: ${res.status}`);
  await finished(Readable.fromWeb(res.body).pipe(createWriteStream(videoPath)));
  return videoPath;
}

async function extractFirstFrame(videoPath, job, cacheDir) {
  const framePath = path.join(cacheDir, `${job.pinId}-cover.jpg`);
  try {
    const stat = await fs.stat(framePath);
    if (stat.size > 0) return framePath;
  } catch {}
  await execFileAsync("ffmpeg", [
    "-y",
    "-i", videoPath,
    "-frames:v", "1",
    "-q:v", "2",
    framePath,
  ]);
  return framePath;
}

async function postMultipart(url, fields, fileField, filePath, contentType) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields || {})) form.append(key, value);
  const blob = new Blob([await fs.readFile(filePath)], { type: contentType });
  form.append(fileField, blob, path.basename(filePath));
  const res = await fetch(url, { method: "POST", body: form });
  const text = await res.text();
  if (!res.ok) throw new Error(`Multipart upload failed: ${res.status} ${text.slice(0, 500)}`);
}

async function uploadCoverToShopify(config, framePath, job) {
  const filename = `pinterest-${job.productHandle}-${job.pinId}-${crypto.randomUUID()}.jpg`;
  const staged = await shopifyGraphql(config.shopify_url, config.shopify_token, `
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }
  `, {
    input: [{
      filename,
      mimeType: "image/jpeg",
      resource: "FILE",
      httpMethod: "POST",
    }],
  });
  const target = staged.stagedUploadsCreate.stagedTargets[0];
  if (!target) throw new Error(`Shopify staged upload failed: ${JSON.stringify(staged.stagedUploadsCreate.userErrors)}`);
  const fields = Object.fromEntries(target.parameters.map((param) => [param.name, param.value]));
  await postMultipart(target.url, fields, "file", framePath, "image/jpeg");

  const created = await shopifyGraphql(config.shopify_url, config.shopify_token, `
    mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files { id fileStatus ... on MediaImage { image { url } } }
        userErrors { field message }
      }
    }
  `, {
    files: [{
      contentType: "IMAGE",
      originalSource: target.resourceUrl,
      alt: `${job.productTitle} Pinterest video cover`,
    }],
  });
  const file = created.fileCreate.files[0];
  if (!file) throw new Error(`Shopify fileCreate failed: ${JSON.stringify(created.fileCreate.userErrors)}`);
  if (file.image?.url) return file.image.url;

  for (let attempt = 0; attempt < 18; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const polled = await shopifyGraphql(config.shopify_url, config.shopify_token, `
      query fileNode($id: ID!) {
        node(id: $id) {
          ... on MediaImage { fileStatus image { url } }
        }
      }
    `, { id: file.id });
    if (polled.node?.image?.url) return polled.node.image.url;
  }
  throw new Error(`Shopify cover image did not become ready for ${job.pinId}`);
}

async function uploadPinterestVideo(pinterestToken, videoPath) {
  const registered = await pinterestRequest(pinterestToken, "POST", "/media", { media_type: "video" });
  const mediaId = registered.media_id;
  const fields = Object.fromEntries((registered.upload_parameters || []).map((param) => [param.name, param.value]));
  await postMultipart(registered.upload_url, fields, "file", videoPath, "video/mp4");
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const media = await pinterestRequest(pinterestToken, "GET", `/media/${mediaId}`);
    if (media.status === "succeeded") return mediaId;
    if (media.status === "failed") throw new Error(`Pinterest media failed: ${JSON.stringify(media).slice(0, 500)}`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`Pinterest media did not finish processing for ${mediaId}`);
}

async function listBoards(pinterestToken) {
  const boards = [];
  let bookmark = "";
  do {
    const suffix = bookmark ? `?bookmark=${encodeURIComponent(bookmark)}` : "";
    const page = await pinterestRequest(pinterestToken, "GET", `/boards${suffix}`);
    boards.push(...(page.items || []));
    bookmark = page.bookmark || "";
  } while (bookmark);
  return boards;
}

async function resolveBoard(pinterestToken, boardName, createMissing) {
  const boards = await listBoards(pinterestToken);
  const normalized = normalizeBoardName(boardName);
  const found = boards.find((board) => normalizeBoardName(board.name) === normalized);
  if (found) return found;
  if (!createMissing) throw new Error(`Missing Pinterest board: ${boardName}`);
  return pinterestRequest(pinterestToken, "POST", "/boards", {
    name: boardName,
    description: `${boardName.toLowerCase()} saves and video pins`,
    privacy: "PUBLIC",
  });
}

async function publishJob(job, context) {
  const board = await resolveBoard(context.pinterestToken, job.boardName, context.createMissingBoards);
  const videoPath = await downloadVideo(job, context.cacheDir);
  const framePath = await extractFirstFrame(videoPath, job, context.cacheDir);
  const coverUrl = await uploadCoverToShopify(context.config, framePath, job);
  const mediaId = await uploadPinterestVideo(context.pinterestToken, videoPath);
  const pin = await pinterestRequest(context.pinterestToken, "POST", "/pins", {
    board_id: board.id,
    title: job.title,
    description: job.description,
    link: job.productUrl,
    alt_text: `${job.productTitle} styled in a short video`,
    media_source: {
      source_type: "video_id",
      media_id: mediaId,
      cover_image_url: coverUrl,
    },
  });
  const verified = await pinterestRequest(context.pinterestToken, "GET", `/pins/${pin.id}`);
  return {
    boardId: board.id,
    boardName: board.name,
    coverUrl,
    mediaId,
    pinId: pin.id,
    pinUrl: `https://www.pinterest.com/pin/${pin.id}/`,
    verifiedMediaType: verified.media?.media_type || "",
  };
}

async function acquireLock(lockPath) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  try {
    const handle = await fs.open(lockPath, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    return async () => {
      await handle.close();
      await fs.rm(lockPath, { force: true });
    };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(`Scheduler already running: ${lockPath}`);
  }
}

async function main() {
  const queuePath = rootPath(argValue("queue", "data/publish-queue.json"));
  const manifestPath = rootPath(argValue("manifest", "data/publish-manifest.jsonl"));
  const cacheDir = rootPath(argValue("cache-dir", ".cache/publish"));
  const dryRun = hasFlag("dry-run");
  const preflight = hasFlag("preflight");
  const createMissingBoards = hasFlag("create-missing-boards");
  const timezone = argValue("timezone", DEFAULT_TIMEZONE);
  const lockPath = path.join(root, ".cache/publish.lock");
  const releaseLock = await acquireLock(lockPath);
  try {
    const queue = await readJson(queuePath);
    if (preflight) {
      const config = await fetchStoreConfig();
      const pinterestToken = await decryptKms(config.pinterest_write_token_encrypted);
      const boards = await listBoards(pinterestToken);
      const uniqueBoardNames = [...new Set((queue.jobs || []).map((job) => job.boardName))];
      const missingBoards = uniqueBoardNames.filter((boardName) => (
        !boards.some((board) => normalizeBoardName(board.name) === normalizeBoardName(boardName))
      ));
      const createdBoards = [];
      if (missingBoards.length && createMissingBoards) {
        for (const boardName of missingBoards) {
          const board = await pinterestRequest(pinterestToken, "POST", "/boards", {
            name: boardName,
            description: `${boardName.toLowerCase()} saves and video pins`,
            privacy: "PUBLIC",
          });
          createdBoards.push({ id: board.id, name: board.name });
        }
      }
      console.log(JSON.stringify({
        ok: missingBoards.length === 0 || createMissingBoards,
        jobs: queue.jobs?.length || 0,
        boardNames: uniqueBoardNames,
        missingBoards,
        createdBoards,
      }, null, 2));
      if (missingBoards.length && !createMissingBoards) process.exitCode = 2;
      return;
    }
    const job = selectNextDueJob(queue.jobs || [], new Date(), timezone);
    if (!job) {
      console.log("No due publish jobs.");
      return;
    }
    console.log(`Due job ${job.id}: ${job.title} -> ${job.productHandle} at ${job.scheduledAt}`);
    if (dryRun) {
      console.log(JSON.stringify({ dryRun: true, job }, null, 2));
      return;
    }

    const config = await fetchStoreConfig();
    const pinterestToken = await decryptKms(config.pinterest_write_token_encrypted);
    job.status = "publishing";
    job.attempts = Number(job.attempts || 0) + 1;
    job.startedAt = new Date().toISOString();
    await writeJson(queuePath, queue);
    await appendJsonl(manifestPath, { event: "started", at: job.startedAt, jobId: job.id, pinId: job.pinId });

    try {
      const published = await publishJob(job, {
        cacheDir,
        config,
        pinterestToken,
        createMissingBoards,
      });
      job.status = "published";
      job.createdPinId = published.pinId;
      job.createdPinUrl = published.pinUrl;
      job.boardId = published.boardId;
      job.coverUrl = published.coverUrl;
      job.mediaId = published.mediaId;
      job.publishedAt = new Date().toISOString();
      job.lastError = "";
      await writeJson(queuePath, queue);
      await appendJsonl(manifestPath, { event: "published", at: job.publishedAt, jobId: job.id, ...published });
      console.log(JSON.stringify({ published: job.id, pinUrl: published.pinUrl, boardName: published.boardName }, null, 2));
    } catch (error) {
      job.status = error.riskStop ? "blocked" : "queued";
      job.lastError = error.message;
      job.failedAt = new Date().toISOString();
      await writeJson(queuePath, queue);
      await appendJsonl(manifestPath, { event: error.riskStop ? "risk_stop" : "failed", at: job.failedAt, jobId: job.id, error: error.message });
      throw error;
    }
  } finally {
    await releaseLock();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(error.riskStop ? 3 : 1);
});
