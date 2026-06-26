export const DEFAULT_DAILY_CAP = 35;
export const DEFAULT_TIMEZONE = "Europe/Paris";

const TITLES = [
  "your uni bag 🩵",
  "your 1am cart 🩵",
  "worth the click 🩵",
  "the bag upgrade 🩵",
  "cute and useful 🩵",
  "your outfit fix 🩵",
  "saved for later 🩵",
  "the daily bag 🩵",
  "your new default 🩵",
  "actually fits it all 🩵",
  "for class + coffee 🩵",
  "the one to save 🩵",
  "soft but useful 🩵",
  "the bag you needed 🩵",
  "not just cute 🩵",
  "your campus bag 🩵",
  "easy outfit win 🩵",
  "the commute bag 🩵",
  "made for errands 🩵",
  "your everyday carry 🩵",
];

const DESCRIPTIONS_BY_HANDLE = {
  "eden-bag": [
    "your everyday woven bag for coffee runs, errands, uni days, and last-minute plans. soft, slouchy, easy to style, and cute enough to make a basic outfit feel intentional.",
    "the bag you grab when the outfit needs texture, shape, and somewhere to actually put your things. eden is easy, roomy, and made for the days that do not stay on schedule.",
    "soft woven texture, an easy shoulder shape, and enough space for the real-life stuff. eden is the kind of bag that makes jeans, a cardigan, and coffee look like a plan.",
  ],
  "margot-bag": [
    "your put-together bag for laptop days, class, work, and the plans after. structured enough to clean up the outfit, roomy enough to actually be useful.",
    "margot is for the days when you need the bag to do more than look cute. laptop, notebook, lip oil, keys, wallet, all in one place without killing the outfit.",
    "the everyday bag for campus, commutes, coffee shops, and trying to look like you have your life slightly more together than you do.",
  ],
  "ada-bag": [
    "your small-but-useful bag for coffee, errands, nights out, and the plans that were supposed to be quick. easy to wear, easy to grab, cute without trying too hard.",
    "ada is the bag for the essentials-only days. phone, wallet, lip oil, keys, and just enough room to not regret bringing the tiny bag.",
    "the quick-plan bag. compact, cute, and made for the outfits where a tote feels like too much but pockets are absolutely not enough.",
  ],
  "sasha-bag": [
    "your soft hobo bag for everyday outfits that need a little more shape. roomy, slouchy, and easy to wear with denim, knits, coats, and coffee walks.",
    "sasha is the bag for days when a basic tote feels boring. soft shape, easy shoulder fit, and enough room for the things that somehow always come with you.",
    "the everyday carry with a softer mood. cute with casual outfits, useful for real days, and just polished enough to make the whole look feel finished.",
  ],
};

export function buildCopyBank() {
  return {
    titles: TITLES,
    descriptionsByHandle: DESCRIPTIONS_BY_HANDLE,
  };
}

export function normalizeBoardName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function visibleLength(value) {
  return [...String(value || "")].length;
}

export function productBoardName(product) {
  return product?.title || "";
}

function seededJitter(seed, min, max) {
  const x = Math.sin(seed * 9999) * 10000;
  const fraction = x - Math.floor(x);
  return min + Math.floor(fraction * (max - min + 1));
}

function scheduledAt(date, slot, dailyCap) {
  const startMinutes = 8 * 60;
  const endMinutes = 23 * 60 + 30;
  const available = endMinutes - startMinutes;
  const baseGap = Math.floor(available / Math.max(dailyCap - 1, 1));
  const jitter = seededJitter(slot + date.replaceAll("-", "").length, -5, 5);
  const minutes = Math.min(endMinutes, Math.max(startMinutes, startMinutes + slot * baseGap + jitter));
  const hour = String(Math.floor(minutes / 60)).padStart(2, "0");
  const minute = String(minutes % 60).padStart(2, "0");
  return `${date}T${hour}:${minute}:00`;
}

function nextDate(startDate, offset) {
  const date = new Date(`${startDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

export function selectEligiblePins(results, products, options = {}) {
  const productsByHandle = new Map(products.map((product) => [product.handle, product]));
  const includeLogo = options.includeLogo !== false;
  return results
    .filter((row) => row?.pin?.suggestedProductHandle)
    .filter((row) => row?.vertex?.text_language === "english")
    .filter((row) => includeLogo || row?.vertex?.has_logo === false)
    .map((row) => {
      const product = productsByHandle.get(row.pin.suggestedProductHandle);
      if (!product) return null;
      return {
        pinId: row.pin.id,
        sourceUrl: row.pin.sourceUrl || "",
        sourceTitle: row.pin.title || "",
        sourceDescription: row.pin.description || "",
        videoUrl: row.pin.videoUrl || "",
        localVideo: row.pin.localVideo || "",
        thumbnail: row.pin.thumbnail || "",
        productHandle: product.handle,
        productTitle: product.title,
        productUrl: product.onlineStoreUrl || product.url || `https://bynyla.com/products/${product.handle}`,
        boardName: productBoardName(product),
        vertex: row.vertex,
      };
    })
    .filter(Boolean);
}

function rotateByProduct(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.productHandle)) groups.set(row.productHandle, []);
    groups.get(row.productHandle).push(row);
  }
  const orderedGroups = [...groups.values()].sort((a, b) => b.length - a.length);
  const output = [];
  while (orderedGroups.some((group) => group.length)) {
    for (const group of orderedGroups) {
      const item = group.shift();
      if (item) output.push(item);
    }
  }
  return output;
}

export function buildPublishQueue(eligibleRows, options = {}) {
  const dailyCap = Number(options.dailyCap || DEFAULT_DAILY_CAP);
  const startDate = options.startDate || new Date().toISOString().slice(0, 10);
  const timezone = options.timezone || DEFAULT_TIMEZONE;
  const copy = buildCopyBank();
  return rotateByProduct(eligibleRows).map((row, index) => {
    const dayOffset = Math.floor(index / dailyCap);
    const slot = index % dailyCap;
    const publishDate = nextDate(startDate, dayOffset);
    const descriptions = copy.descriptionsByHandle[row.productHandle] || copy.descriptionsByHandle["margot-bag"];
    return {
      id: `${row.pinId}-${row.productHandle}`,
      status: "queued",
      pinId: row.pinId,
      competitorPinUrl: row.sourceUrl,
      productHandle: row.productHandle,
      productTitle: row.productTitle,
      productUrl: row.productUrl,
      boardName: row.boardName,
      videoUrl: row.videoUrl,
      localVideo: row.localVideo,
      thumbnail: row.thumbnail,
      title: copy.titles[index % copy.titles.length],
      description: descriptions[index % descriptions.length],
      publishDate,
      scheduledAt: scheduledAt(publishDate, slot, dailyCap),
      timezone,
      attempts: 0,
      createdPinId: "",
      createdPinUrl: "",
      lastError: "",
    };
  });
}

function localDateParts(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

export function localSortableTimestamp(date, timezone = DEFAULT_TIMEZONE) {
  const parts = localDateParts(date, timezone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

export function selectNextDueJob(jobs, now = new Date(), timezone = DEFAULT_TIMEZONE) {
  const nowLocal = localSortableTimestamp(now, timezone);
  return jobs
    .filter((job) => job.status === "queued")
    .filter((job) => job.scheduledAt <= nowLocal)
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))[0] || null;
}

export function shouldStopForPinterestResponse(response) {
  const body = String(response?.body || "").toLowerCase();
  return response?.status === 429
    || body.includes("rate limit")
    || body.includes("too many")
    || body.includes("spam")
    || body.includes("blocked");
}
