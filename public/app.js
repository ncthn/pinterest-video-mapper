const rowsEl = document.querySelector("#rows");
const template = document.querySelector("#row-template");
const searchEl = document.querySelector("#search");
const unmappedEl = document.querySelector("#unmappedOnly");
const logoFilterEl = document.querySelector("#logoFilter");
const countEl = document.querySelector("#count");
const loadMoreEl = document.querySelector("#loadMore");
const PAGE_SIZE = 8;
const VIDEO_AHEAD = 2;

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

let renderedCount = PAGE_SIZE;
let rowObserver = null;
let syncQueued = false;

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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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
    : [{
      title: product.title,
      handle: product.handle,
      url: product.onlineStoreUrl || product.url || "",
      image: product.image || "",
      price: product.price || "",
    }];
  return saveAnnotation(pinId, { products }, statusEl);
}

function renderProductCards(container, pin, products, statusEl, variant = "") {
  container.innerHTML = "";
  products.forEach((product) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `product-card ${isSelected(pin.id, product) ? "selected" : ""} ${variant}`;
    button.innerHTML = `
      <img src="${escapeHtml(product.image || "")}" alt="" loading="lazy">
      <span>
        <strong>${escapeHtml(product.title)}</strong>
        <small>${escapeHtml(product.price ? `$${product.price}` : product.productType || "")}</small>
      </span>
    `;
    button.addEventListener("click", async () => {
      await toggleProduct(pin.id, product, statusEl);
      renderRows();
    });
    container.append(button);
  });
}

function attachLazyVideo(video, pin) {
  const primarySrc = pin.localVideo || pin.videoUrl || "";
  video.dataset.primarySrc = primarySrc;
  video.dataset.fallbackSrc = pin.videoUrl || "";
  video.poster = pin.thumbnail || "";
  video.muted = true;
  video.playsInline = true;
  video.defaultPlaybackRate = 2;
  video.playbackRate = 2;
  video.addEventListener("loadedmetadata", () => {
    video.playbackRate = 2;
  });
  video.addEventListener("error", () => {
    if (video.dataset.fallbackSrc && video.src !== video.dataset.fallbackSrc) {
      video.src = video.dataset.fallbackSrc;
    }
  }, { once: true });
}

function loadVideo(video, shouldPlay = false) {
  if (!video.src && video.dataset.primarySrc) {
    video.src = video.dataset.primarySrc;
    video.load();
  }
  if (shouldPlay) {
    video.playbackRate = 2;
    video.play().catch(() => {});
  } else {
    video.pause();
  }
}

function toggleVideoPlayback(video) {
  loadVideo(video, false);
  video.playbackRate = 2;
  if (video.paused) {
    video.play().catch(() => {});
  } else {
    video.pause();
  }
}

function unloadVideo(video) {
  if (!video.src) return;
  video.pause();
  video.removeAttribute("src");
  video.load();
}

function syncVideoWindow() {
  const rows = [...rowsEl.querySelectorAll(".pin-row")];
  if (!rows.length) return;

  const viewportTop = document.querySelector(".topbar")?.getBoundingClientRect().bottom || 0;
  const activeRow = rows.find((row) => {
    const rect = row.getBoundingClientRect();
    return rect.bottom > viewportTop + 8 && rect.top < window.innerHeight;
  }) || rows[0];
  const activeIndex = Number(activeRow.dataset.index || 0);
  const keep = new Set(
    Array.from({ length: VIDEO_AHEAD + 1 }, (_, offset) => activeIndex + offset),
  );

  rows.forEach((row) => {
    const rowIndex = Number(row.dataset.index);
    const video = row.querySelector("video");
    if (!video) return;
    if (keep.has(rowIndex)) loadVideo(video, rowIndex === activeIndex);
    else unloadVideo(video);
  });
}

function queueVideoSync() {
  if (syncQueued) return;
  syncQueued = true;
  requestAnimationFrame(() => {
    syncQueued = false;
    syncVideoWindow();
  });
}

function renderRow(pin, rowIndex) {
  const node = template.content.firstElementChild.cloneNode(true);
  node.dataset.index = String(rowIndex);
  const video = node.querySelector("video");
  const videoHitbox = node.querySelector(".video-hitbox");
  const title = node.querySelector(".pin-title");
  const description = node.querySelector(".pin-description");
  const pinId = node.querySelector(".pin-id");
  const logoButtons = [...node.querySelectorAll("[data-logo]")];
  const textStatusButtons = [...node.querySelectorAll("[data-text-status]")];
  const textLanguageButtons = [...node.querySelectorAll("[data-text-language]")];
  const productSearch = node.querySelector(".product-search");
  const selectedEl = node.querySelector(".selected-products");
  const popularEl = node.querySelector(".popular-products");
  const resultsEl = node.querySelector(".product-results");
  const notes = node.querySelector(".notes");
  const statusEl = node.querySelector(".save-status");
  const annotation = state.annotations[pin.id] || {};

  attachLazyVideo(video, pin);
  videoHitbox.addEventListener("click", () => toggleVideoPlayback(video));
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

  const textStatus = annotation.textStatus || "unknown";
  textStatusButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.textStatus === textStatus);
    button.addEventListener("click", () => {
      const patch = { textStatus: button.dataset.textStatus };
      if (patch.textStatus === "no_text") patch.textLanguage = "not_applicable";
      saveAnnotation(pin.id, patch, statusEl).then(renderRows);
    });
  });

  const textLanguage = annotation.textLanguage || "unknown";
  textLanguageButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.textLanguage === textLanguage);
    button.disabled = textStatus === "no_text";
    button.addEventListener("click", () => {
      saveAnnotation(pin.id, { textLanguage: button.dataset.textLanguage, textStatus: "has_text" }, statusEl).then(renderRows);
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
      .filter((product) => query || !popularProducts.some((popular) => popular.handle === product.handle))
      .slice(0, query ? 12 : 0);
    const quickPicks = (guessed.length ? guessed : popularProducts)
      .filter((product) => !selected.some((item) => item.handle === product.handle))
      .slice(0, 4);

    renderProductCards(selectedEl, pin, selected, statusEl);
    selectedEl.classList.toggle("empty", selected.length === 0);
    if (!selected.length) selectedEl.innerHTML = "<p>No Bynyla bag selected yet.</p>";
    renderProductCards(popularEl, pin, quickPicks, statusEl, guessed.length ? "guess" : "");
    renderProductCards(resultsEl, pin, results, statusEl);
    resultsEl.classList.toggle("open", Boolean(query));
  };

  productSearch.addEventListener("input", renderProducts);
  productSearch.addEventListener("focus", renderProducts);
  productSearch.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      productSearch.value = "";
      resultsEl.classList.remove("open");
      productSearch.blur();
    }
  });
  node.addEventListener("focusout", (event) => {
    if (!node.contains(event.relatedTarget)) {
      resultsEl.classList.remove("open");
    }
  });
  notes.addEventListener("change", () => saveAnnotation(pin.id, { notes: notes.value }, statusEl));
  renderProducts();
  return node;
}

function pinVisible(pin) {
  const query = normalize(searchEl.value);
  const ann = state.annotations[pin.id] || {};
  const productText = selectedProducts(pin.id).map((product) => product.title).join(" ");
  const haystack = normalize(`${pin.title} ${pin.description} ${productText}`);
  const textDone = ann.textStatus === "no_text" || (ann.textStatus === "has_text" && ann.textLanguage && ann.textLanguage !== "unknown");
  const hasMapping = Boolean(
    (ann.products || []).length
      && ann.logoStatus
      && ann.logoStatus !== "unknown"
      && textDone,
  );
  if (query && !haystack.includes(query)) return false;
  if (unmappedEl.checked && hasMapping) return false;
  if (logoFilterEl.value && (ann.logoStatus || "unknown") !== logoFilterEl.value) return false;
  return true;
}

function renderRows() {
  if (!rowObserver) {
    rowObserver = new IntersectionObserver(queueVideoSync, { rootMargin: "0px", threshold: 0.01 });
  } else {
    rowObserver.disconnect();
  }
  rowsEl.innerHTML = "";
  const visible = state.pins.filter(pinVisible);
  const page = visible.slice(0, renderedCount);
  page.forEach((pin, index) => {
    const row = renderRow(pin, index);
    rowsEl.append(row);
    rowObserver.observe(row);
  });
  countEl.textContent = `${page.length}/${visible.length} shown · ${state.pins.length} total videos`;
  loadMoreEl.hidden = page.length >= visible.length;
  queueVideoSync();
}

async function init() {
  const res = await fetch("/api/bootstrap");
  if (!res.ok) throw new Error("Could not load mapper data");
  state = await res.json();
  [searchEl, unmappedEl, logoFilterEl].forEach((el) => el.addEventListener("input", () => {
    renderedCount = PAGE_SIZE;
    renderRows();
  }));
  loadMoreEl.addEventListener("click", () => {
    renderedCount += PAGE_SIZE;
    renderRows();
  });
  window.addEventListener("scroll", queueVideoSync, { passive: true });
  window.addEventListener("resize", queueVideoSync, { passive: true });
  renderRows();
}

init().catch((error) => {
  rowsEl.innerHTML = `<p class="error">${error.message}</p>`;
});
