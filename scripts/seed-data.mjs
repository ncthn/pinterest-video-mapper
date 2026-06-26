import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const sourcePins = "/tmp/aresforhim-user-videos-full.json";
const sourceProducts = "/tmp/bynyla-products-for-pin-mapper.json";
const publicProducts = "/tmp/bynyla-public-products.json";

const knownMappings = [
  {
    handle: "margot-bag",
    reason: "Angel -> Margot Bag",
    test: (text) => /\bangel\b/.test(text) && !/\bangelina\b/.test(text),
  },
  {
    handle: "eden-bag",
    reason: "Bogota -> Eden Bag",
    test: (text) => /\bbogota\b/.test(text),
  },
  {
    handle: "ada-bag",
    reason: "Maya -> Ada Bag",
    test: (text) => /\bmaya\b/.test(text),
  },
  {
    handle: "sasha-bag",
    reason: "Napoli -> Sasha Bag",
    test: (text) => /\bnapoli\b/.test(text),
  },
];

const hiddenVideoTest = (text) => /\bmini dress(?:es)?\b/.test(text) || /\bdress(?:es)?\b/.test(text);

const productResponse = JSON.parse(await fs.readFile(sourceProducts, "utf8"));
const publicProductResponse = JSON.parse(await fs.readFile(publicProducts, "utf8"));
const publicByHandle = new Map(
  publicProductResponse.products.map((product) => [
    product.handle,
    {
      image: product.images?.[0]?.src || "",
      price: product.variants?.[0]?.price || "",
    },
  ]),
);
const products = productResponse.products.nodes
  .filter((product) => {
    const title = product.title.toLowerCase();
    return product.status === "ACTIVE"
      && product.onlineStoreUrl
      && title.includes("bag")
      && !title.includes("charm");
  })
  .map((product) => ({
    title: product.title,
    handle: product.handle,
    productType: product.productType || "",
    onlineStoreUrl: product.onlineStoreUrl,
    image: publicByHandle.get(product.handle)?.image || "",
    price: publicByHandle.get(product.handle)?.price || "",
  }))
  .sort((a, b) => a.title.localeCompare(b.title));

const pinResponse = JSON.parse(await fs.readFile(sourcePins, "utf8"));
const sourcePinList = Array.isArray(pinResponse) ? pinResponse : pinResponse.videoPins;
const pins = sourcePinList
  .map((pin) => {
    const text = `${pin.title} ${pin.description}`.toLowerCase();
    const mapping = knownMappings.find((item) => item.test(text));
    return {
      ...pin,
      localVideo: pin.localVideo || `/videos/${pin.id}.mp4`,
      hiddenReason: hiddenVideoTest(text) ? "dress" : "",
      suggestedProductHandle: mapping?.handle || "",
      suggestedProductReason: mapping?.reason || "",
    };
  })
  .filter((pin) => !pin.hiddenReason)
  .sort((a, b) => {
    if (a.suggestedProductHandle && !b.suggestedProductHandle) return -1;
    if (!a.suggestedProductHandle && b.suggestedProductHandle) return 1;
    return a.title.localeCompare(b.title);
  });

const annotations = Object.fromEntries(
  pins.map((pin) => {
    const lower = `${pin.title} ${pin.description}`.toLowerCase();
    const mappedProduct = products.find((product) => product.handle === pin.suggestedProductHandle);
    const guessedProducts = mappedProduct ? [mappedProduct] : products
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
        mappingSource: mappedProduct ? pin.suggestedProductReason : "",
        source: "seed",
      },
    ];
  }),
);

await fs.writeFile(path.join(root, "data", "products.json"), `${JSON.stringify(products, null, 2)}\n`);
await fs.writeFile(path.join(root, "data", "pins.json"), `${JSON.stringify(pins, null, 2)}\n`);
await fs.writeFile(path.join(root, "data", "annotations.seed.json"), `${JSON.stringify(annotations, null, 2)}\n`);

console.log(`Seeded ${pins.length} video pins and ${products.length} active products.`);
