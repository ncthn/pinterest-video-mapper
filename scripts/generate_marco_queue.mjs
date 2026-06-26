#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const titleRotation = [
  "look sharper instantly",
  "smart casual, solved",
  "sharp without a suit",
  "upgrade your basics",
  "the better summer pant",
  "the sharper shirt",
  "the better polo",
  "the refined loafer",
  "quiet confidence",
  "the weekend uniform",
];

const products = {
  Bari_Cargo_Shorts: {
    productHandle: "cargo-shorts",
    productTitle: "Bari Cargo Shorts",
    productUrl: "https://marcomarsano.com/products/cargo-shorts",
    boardName: "Bottoms",
    description: "A sharper take on warm-weather cargo shorts. Clean structure, easy movement, and the kind of fit that works from city walks to weekend plans.",
  },
  Elio_Stretch_Chino: {
    productHandle: "elio-stretch-chino",
    productTitle: "Elio Stretch Chino",
    productUrl: "https://marcomarsano.com/products/elio-stretch-chino",
    boardName: "Bottoms",
    description: "A clean chino with enough stretch to actually move in. Built for smart casual days when jeans feel too relaxed and trousers feel too formal.",
  },
  Fiorenzo_Cotton_Shirt: {
    productHandle: "fiorenzo-cotton-shirt",
    productTitle: "Fiorenzo Cotton Shirt",
    productUrl: "https://marcomarsano.com/products/fiorenzo-cotton-shirt",
    boardName: "Tops",
    description: "A refined cotton shirt for warm days, dinners, and easy smart casual outfits. Simple, sharp, and built to make the whole fit look cleaner.",
  },
  Lecce_Cotton_Shirt: {
    productHandle: "casual-mens-shirt",
    productTitle: "Lecce Cotton Shirt",
    productUrl: "https://marcomarsano.com/products/casual-mens-shirt",
    boardName: "Tops",
    description: "An easy cotton shirt with a polished finish. Wear it open, buttoned, or layered when the outfit needs to look considered without feeling stiff.",
  },
  Lido_Linen_Pants: {
    productHandle: "linen-beach-pants",
    productTitle: "Lido Linen Pants",
    productUrl: "https://marcomarsano.com/products/linen-beach-pants",
    boardName: "Bottoms",
    description: "Lightweight linen pants made for warm days, travel, and resort-ready outfits. Relaxed enough for summer, clean enough to look put together.",
  },
  Pavia_Stretch_Pants: {
    productHandle: "elegant-mens-pants",
    productTitle: "Pavia Stretch Pants",
    productUrl: "https://marcomarsano.com/products/elegant-mens-pants",
    boardName: "Bottoms",
    description: "A sharper everyday pant with a flexible fit. Clean lines, easy comfort, and a smart casual look that works beyond the office.",
  },
  Renato_Stretch_Pants: {
    productHandle: "renato-premium-stretch-pants",
    productTitle: "Renato Stretch Pants",
    productUrl: "https://marcomarsano.com/products/renato-premium-stretch-pants",
    boardName: "Bottoms",
    description: "A refined stretch pant for days that need comfort without losing shape. Easy to style, clean through the leg, and built for daily wear.",
  },
  Riviera_Polo: {
    productHandle: "riviero-polo-shirt",
    productTitle: "Riviera Polo",
    productUrl: "https://marcomarsano.com/products/riviero-polo-shirt",
    boardName: "Tops",
    description: "A clean polo that upgrades the casual uniform. Sharp enough for dinner, relaxed enough for the weekend, and easy to wear all summer.",
  },
  Sabbio_Cotton_Shirt: {
    productHandle: "sabbio-classic-cotton-shirt",
    productTitle: "Sabbio Cotton Shirt",
    productUrl: "https://marcomarsano.com/products/sabbio-classic-cotton-shirt",
    boardName: "Tops",
    description: "A classic cotton shirt with a sharper everyday feel. Built for clean summer outfits, smart casual plans, and easy layering.",
  },
  Santorini_Leather_Loafers: {
    productHandle: "santorini-leather-loafers",
    productTitle: "Santorini Leather Loafers",
    productUrl: "https://marcomarsano.com/products/santorini-leather-loafers",
    boardName: "Footwear",
    description: "A polished leather loafer for resort days, dinners, and smart casual outfits. The kind of shoe that finishes the look without trying too hard.",
  },
};

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
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

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.size > 0;
  } catch {
    return false;
  }
}

async function main() {
  const sourceDir = rootPath(argValue("source", "/home/nathan/Apps/mm-video-ads"));
  const outPath = rootPath(argValue("out", "data/marco-publish-queue.json"));
  const now = new Date().toISOString();
  const jobs = [];
  let titleIndex = 0;

  for (const [folder, product] of Object.entries(products)) {
    const dir = path.join(sourceDir, folder);
    const entries = (await fs.readdir(dir)).filter((name) => name.endsWith(".mp4")).sort();
    for (const filename of entries) {
      const localVideo = path.join(dir, filename);
      if (!(await fileExists(localVideo))) throw new Error(`Missing video: ${localVideo}`);
      jobs.push({
        id: `${folder}-${filename.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
        status: "queued",
        pinId: `${folder}-${jobs.length + 1}`,
        competitorPinUrl: "",
        productHandle: product.productHandle,
        productTitle: product.productTitle,
        productUrl: product.productUrl,
        boardName: product.boardName,
        videoUrl: "",
        localVideo,
        thumbnail: "",
        title: titleRotation[titleIndex % titleRotation.length],
        description: product.description,
        publishDate: now.slice(0, 10),
        scheduledAt: "2026-01-01T08:00:00",
        timezone: "Europe/Paris",
        attempts: 0,
        createdPinId: "",
        createdPinUrl: "",
        lastError: "",
      });
      titleIndex += 1;
    }
  }

  await writeJson(outPath, {
    meta: {
      generatedAt: now,
      source: sourceDir,
      store: "marcomarsano",
      totalJobs: jobs.length,
    },
    jobs,
  });
  const byBoard = jobs.reduce((acc, job) => {
    acc[job.boardName] = (acc[job.boardName] || 0) + 1;
    return acc;
  }, {});
  console.log(JSON.stringify({ outPath, totalJobs: jobs.length, byBoard }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
