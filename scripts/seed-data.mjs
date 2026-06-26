import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const sourcePins = "/tmp/aresforhim-user-videos-full.json";
const sourceProducts = "/tmp/bynyla-products-for-pin-mapper.json";

const productResponse = JSON.parse(await fs.readFile(sourceProducts, "utf8"));
const products = productResponse.products.nodes
  .filter((product) => product.status === "ACTIVE" && product.onlineStoreUrl)
  .map((product) => ({
    title: product.title,
    handle: product.handle,
    productType: product.productType || "",
    onlineStoreUrl: product.onlineStoreUrl,
  }))
  .sort((a, b) => a.title.localeCompare(b.title));

const pinResponse = JSON.parse(await fs.readFile(sourcePins, "utf8"));
const sourcePinList = Array.isArray(pinResponse) ? pinResponse : pinResponse.videoPins;
const pins = sourcePinList.map((pin) => ({
  ...pin,
  localVideo: pin.localVideo || `/videos/${pin.id}.mp4`,
}));

const annotations = Object.fromEntries(
  pins.map((pin) => {
    const lower = `${pin.title} ${pin.description}`.toLowerCase();
    const guessedProducts = products
      .filter((product) => {
        const base = product.title.toLowerCase().replace(/\s+bag$/, "");
        return base.length >= 4 && lower.includes(base);
      })
      .map((product) => ({
        title: product.title,
        handle: product.handle,
        url: product.onlineStoreUrl,
      }));
    return [
      pin.id,
      {
        pinId: pin.id,
        logoStatus: "unknown",
        products: guessedProducts,
        notes: "",
        source: "seed",
      },
    ];
  }),
);

await fs.writeFile(path.join(root, "data", "products.json"), `${JSON.stringify(products, null, 2)}\n`);
await fs.writeFile(path.join(root, "data", "pins.json"), `${JSON.stringify(pins, null, 2)}\n`);
await fs.writeFile(path.join(root, "data", "annotations.seed.json"), `${JSON.stringify(annotations, null, 2)}\n`);

console.log(`Seeded ${pins.length} video pins and ${products.length} active products.`);
