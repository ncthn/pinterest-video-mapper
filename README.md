# Pinterest Video Mapper

Private internal tool for mapping scraped Pinterest videos to Bynyla products.

## Local

```bash
npm install
APP_PASSWORD=change-me npm run dev
```

Open `http://localhost:3000`.

## Data

- `data/pins.json` is the scraped video-only manifest.
- `data/products.json` is the Bynyla product picker seed.
- `data/annotations.json` is runtime state and is intentionally gitignored.

## Render

This app is intended to run behind `APP_PASSWORD`. The `render.yaml` mounts a persistent disk at `/var/data`, and the server stores annotations there when `DATA_DIR=/var/data`.
