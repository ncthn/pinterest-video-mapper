#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DAILY_CAP,
  DEFAULT_TIMEZONE,
  buildPublishQueue,
  selectEligiblePins,
} from "./pinterest_scheduler_lib.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function tomorrowDate() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return date.toISOString().slice(0, 10);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function rootPath(value) {
  return path.isAbsolute(value) ? value : path.join(root, value);
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temp, filePath);
}

async function main() {
  const vertexPath = rootPath(argValue("vertex", "data/vertex-premapped.json"));
  const productsPath = rootPath(argValue("products", "data/products.json"));
  const outPath = rootPath(argValue("out", "data/publish-queue.json"));
  const startDate = argValue("start-date", tomorrowDate());
  const dailyCap = Number(argValue("daily-cap", String(DEFAULT_DAILY_CAP)));
  const timezone = argValue("timezone", DEFAULT_TIMEZONE);
  const includeLogo = !hasFlag("no-logo-only");

  const [vertex, products] = await Promise.all([readJson(vertexPath), readJson(productsPath)]);
  const eligible = selectEligiblePins(Object.values(vertex.results || {}), products, { includeLogo });
  const jobs = buildPublishQueue(eligible, { startDate, dailyCap, timezone });
  const queue = {
    meta: {
      generatedAt: new Date().toISOString(),
      source: "vertex-premapped",
      startDate,
      dailyCap,
      timezone,
      includeLogo,
      totalJobs: jobs.length,
    },
    jobs,
  };

  await writeJson(outPath, queue);
  const byProduct = jobs.reduce((acc, job) => {
    acc[job.productHandle] = (acc[job.productHandle] || 0) + 1;
    return acc;
  }, {});
  console.log(JSON.stringify({ outPath, totalJobs: jobs.length, byProduct, startDate, dailyCap, includeLogo }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
