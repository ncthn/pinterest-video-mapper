import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import express from "express";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const annotationFile = path.join(dataDir, "annotations.json");
const seedAnnotationFile = path.join(__dirname, "data", "annotations.seed.json");
const sessionSecret = process.env.SESSION_SECRET || "local-dev-session-secret";
const appPassword = process.env.APP_PASSWORD || "";

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

function sign(value) {
  return crypto.createHmac("sha256", sessionSecret).update(value).digest("hex");
}

function isAuthenticated(req) {
  if (!appPassword) return true;
  const token = req.cookies.pvm_session;
  return token === sign("authenticated");
}

function requireAuth(req, res, next) {
  if (req.path === "/login" || req.path === "/api/login" || req.path === "/healthz") {
    return next();
  }
  if (isAuthenticated(req)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "auth_required" });
  return res.redirect("/login");
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temp, filePath);
}

async function readAnnotations() {
  const seed = await readJson(seedAnnotationFile, {});
  const current = await readJson(annotationFile, {});
  return { ...seed, ...current };
}

function asCsvCell(value) {
  const text = Array.isArray(value) ? value.join("|") : String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

app.use(requireAuth);
app.use(express.static(path.join(__dirname, "public")));

app.get("/login", (_req, res) => {
  res.type("html").send(`<!doctype html>
    <html><head><title>Login</title><link rel="stylesheet" href="/styles.css"></head>
    <body class="login-page">
      <form class="login-card" method="post" action="/api/login">
        <p class="eyebrow">Private mapper</p>
        <h1>Pinterest Video Mapper</h1>
        <input type="password" name="password" placeholder="Password" autofocus />
        <button type="submit">Enter</button>
      </form>
      <script>
        document.querySelector('form').addEventListener('submit', async (event) => {
          event.preventDefault();
          const password = new FormData(event.target).get('password');
          const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
          if (res.ok) location.href = '/';
          else event.target.classList.add('shake');
        });
      </script>
    </body></html>`);
});

app.post("/api/login", (req, res) => {
  if (!appPassword || req.body?.password === appPassword) {
    res.cookie("pvm_session", sign("authenticated"), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 14,
    });
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: "invalid_password" });
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.get("/api/bootstrap", async (_req, res, next) => {
  try {
    const [pins, products, annotations] = await Promise.all([
      readJson(path.join(__dirname, "data", "pins.json"), []),
      readJson(path.join(__dirname, "data", "products.json"), []),
      readAnnotations(),
    ]);
    res.json({ pins, products, annotations });
  } catch (error) {
    next(error);
  }
});

app.put("/api/annotations/:pinId", async (req, res, next) => {
  try {
    const pinId = req.params.pinId;
    const annotations = await readAnnotations();
    const previous = annotations[pinId] || {};
    annotations[pinId] = {
      ...previous,
      ...req.body,
      pinId,
      updatedAt: new Date().toISOString(),
    };
    await writeJson(annotationFile, annotations);
    res.json({ ok: true, annotation: annotations[pinId] });
  } catch (error) {
    next(error);
  }
});

app.get("/api/export.json", async (_req, res, next) => {
  try {
    const [pins, annotations] = await Promise.all([
      readJson(path.join(__dirname, "data", "pins.json"), []),
      readAnnotations(),
    ]);
    res.json(pins.map((pin) => ({ ...pin, annotation: annotations[pin.id] || {} })));
  } catch (error) {
    next(error);
  }
});

app.get("/api/export.csv", async (_req, res, next) => {
  try {
    const [pins, annotations] = await Promise.all([
      readJson(path.join(__dirname, "data", "pins.json"), []),
      readAnnotations(),
    ]);
    const headers = [
      "pin_id",
      "source_url",
      "title",
      "logo_status",
      "text_status",
      "text_language",
      "product_titles",
      "product_handles",
      "notes",
    ];
    const rows = pins.map((pin) => {
      const ann = annotations[pin.id] || {};
      const products = ann.products || [];
      return [
        pin.id,
        pin.sourceUrl,
        pin.title,
        ann.logoStatus || "unknown",
        ann.textStatus || "unknown",
        ann.textLanguage || "unknown",
        products.map((product) => product.title),
        products.map((product) => product.handle),
        ann.notes || "",
      ].map(asCsvCell).join(",");
    });
    res.header("Content-Type", "text/csv");
    res.attachment("pinterest-video-mapping.csv");
    res.send(`${headers.join(",")}\n${rows.join("\n")}\n`);
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "server_error" });
});

app.listen(port, () => {
  console.log(`Pinterest Video Mapper listening on ${port}`);
});
