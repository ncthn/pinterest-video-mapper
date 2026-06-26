const rowsEl = document.querySelector("#rows");
const template = document.querySelector("#row-template");
const searchEl = document.querySelector("#search");
const unmappedEl = document.querySelector("#unmappedOnly");
const logoFilterEl = document.querySelector("#logoFilter");
const countEl = document.querySelector("#count");

const popularHandles = [
  "nina-bag",
  "eden-bag",
  "mabel-bag",
  "margot-bag",
  "angelina-bag",
  "angel-bag",
  "bogota-bag",
  "luna-bag",
  "amira-bag",
  "maya-bag",
];

let state = {
  pins: [],
  products: [],
  annotations: {},
};

function normalize(text) {
  return String(text || "").toLowerCase().trim();
}

function selectedProducts(pinId) {
  return state.annotations[pinId]?.products || [];
}

function isSelected(pinId, product) {
  return selectedProducts(pinId).some((item) => item.handle === product.handle);
}

function productMatches(product, query) {
  const haystack = `${product.title} ${product.handle} ${product.productType}`.toLowerCase();
  return haystack.includes(query);
}

function guessProducts(pin) {
  const text = normalize(`${pin.title} ${pin.description}`);
  return state.products.filter((product) => {
    const base = normalize(product.title.replace(/\s+bag$/i, ""));
    return base.length >= 4 && text.includes(base);
  });
}

async function saveAnnotation(pinId, patch, statusEl) {
  const current = state.annotations[pinId] || {};
  const next = { ...current, ...patch };
  state.annotations[pinId] = next;
  statusEl.textContent = "Saving...";
  const res = await fetch(`/api/annotations/${pinId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(next),
  });
  if (!res.ok) {
    statusEl.textContent = "Save failed";
    return;
  }
  const body = await res.json();
  state.annotations[pinId] = body.annotation;
  statusEl.textContent = "Saved";
}

function toggleProduct(pinId, product, statusEl) {
  const current = selectedProducts(pinId);
  const exists = current.some((item) => item.handle === product.handle);
  const products = exists
    ? current.filter((item) => item.handle !== product.handle)
    : [...current, { title: product.title, handle: product.handle, url: product.onlineStoreUrl || "" }];
  return saveAnnotation(pinId, { products }, statusEl);
}

function renderProductChips(container, pin, products, statusEl, variant = "") {
  container.innerHTML = "";
  products.forEach((product) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `chip ${isSelected(pin.id, product) ? "selected" : ""} ${variant}`;
    button.textContent = product.title;
    button.addEventListener("click", async () => {
      await toggleProduct(pin.id, product, statusEl);
      renderRows();
    });
    container.append(button);
  });
}

function renderRow(pin) {
  const node = template.content.firstElementChild.cloneNode(true);
  const video = node.querySelector("video");
  const title = node.querySelector(".pin-title");
  const description = node.querySelector(".pin-description");
  const pinId = node.querySelector(".pin-id");
  const logoButtons = [...node.querySelectorAll("[data-logo]")];
  const productSearch = node.querySelector(".product-search");
  const selectedEl = node.querySelector(".selected-products");
  const popularEl = node.querySelector(".popular-products");
  const resultsEl = node.querySelector(".product-results");
  const notes = node.querySelector(".notes");
  const statusEl = node.querySelector(".save-status");
  const annotation = state.annotations[pin.id] || {};

  video.src = pin.localVideo || pin.videoUrl || "";
  video.dataset.fallbackSrc = pin.videoUrl || "";
  video.poster = pin.thumbnail || "";
  video.addEventListener("error", () => {
    if (video.dataset.fallbackSrc && video.src !== video.dataset.fallbackSrc) {
      video.src = video.dataset.fallbackSrc;
    }
  }, { once: true });
  title.href = pin.sourceUrl;
  title.textContent = pin.title || pin.id;
  description.textContent = pin.description || "No description scraped.";
  pinId.textContent = `${pin.id} · ${pin.duration ? `${pin.duration}s` : "duration unknown"}`;
  notes.value = annotation.notes || "";

  const logoStatus = annotation.logoStatus || "unknown";
  logoButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.logo === logoStatus);
    button.addEventListener("click", () => {
      saveAnnotation(pin.id, { logoStatus: button.dataset.logo }, statusEl).then(renderRows);
    });
  });

  const popularProducts = popularHandles
    .map((handle) => state.products.find((product) => product.handle === handle))
    .filter(Boolean);

  const renderProducts = () => {
    const query = normalize(productSearch.value);
    const selected = selectedProducts(pin.id)
      .map((selectedProduct) => state.products.find((product) => product.handle === selectedProduct.handle) || selectedProduct)
      .filter(Boolean);
    const guessed = guessProducts(pin).filter((product) => !selected.some((item) => item.handle === product.handle));
    const results = state.products
      .filter((product) => productMatches(product, query))
      .filter((product) => !popularProducts.some((popular) => popular.handle === product.handle))
      .slice(0, query ? 18 : 10);

    renderProductChips(selectedEl, pin, selected, statusEl);
    renderProductChips(popularEl, pin, popularProducts, statusEl);
    renderProductChips(resultsEl, pin, [...guessed, ...results], statusEl, guessed.length ? "guess" : "");
  };

  productSearch.addEventListener("input", renderProducts);
  notes.addEventListener("change", () => saveAnnotation(pin.id, { notes: notes.value }, statusEl));
  renderProducts();
  return node;
}

function pinVisible(pin) {
  const query = normalize(searchEl.value);
  const ann = state.annotations[pin.id] || {};
  const productText = selectedProducts(pin.id).map((product) => product.title).join(" ");
  const haystack = normalize(`${pin.title} ${pin.description} ${productText}`);
  const hasMapping = Boolean((ann.products || []).length || (ann.logoStatus && ann.logoStatus !== "unknown") || ann.notes);
  if (query && !haystack.includes(query)) return false;
  if (unmappedEl.checked && hasMapping) return false;
  if (logoFilterEl.value && (ann.logoStatus || "unknown") !== logoFilterEl.value) return false;
  return true;
}

function renderRows() {
  rowsEl.innerHTML = "";
  const visible = state.pins.filter(pinVisible);
  visible.forEach((pin) => rowsEl.append(renderRow(pin)));
  countEl.textContent = `${visible.length}/${state.pins.length} videos`;
}

async function init() {
  const res = await fetch("/api/bootstrap");
  if (!res.ok) throw new Error("Could not load mapper data");
  state = await res.json();
  [searchEl, unmappedEl, logoFilterEl].forEach((el) => el.addEventListener("input", renderRows));
  renderRows();
}

init().catch((error) => {
  rowsEl.innerHTML = `<p class="error">${error.message}</p>`;
});
