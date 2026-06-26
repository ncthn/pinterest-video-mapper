#!/usr/bin/env python3
import argparse
import json
from pathlib import Path

import requests


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pins", default="data/pins.json")
    parser.add_argument("--out-dir", default="public/videos")
    args = parser.parse_args()

    pins = json.loads(Path(args.pins).read_text())
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    session.headers.update({"User-Agent": "Mozilla/5.0"})
    errors = []

    for index, pin in enumerate(pins, 1):
        url = pin.get("videoUrl")
        if not url:
            continue
        out_path = out_dir / f"{pin['id']}.mp4"
        if out_path.exists() and out_path.stat().st_size > 0:
            print(f"{index}/{len(pins)} exists {out_path.name}")
            continue
        try:
            print(f"{index}/{len(pins)} download {pin['id']}")
            with session.get(url, stream=True, timeout=90) as response:
                response.raise_for_status()
                temp = out_path.with_suffix(".mp4.part")
                with temp.open("wb") as handle:
                    for chunk in response.iter_content(chunk_size=1024 * 1024):
                        if chunk:
                            handle.write(chunk)
                temp.rename(out_path)
        except Exception as error:
            errors.append({"id": pin["id"], "error": str(error)})

    if errors:
        Path("data/download-errors.json").write_text(json.dumps(errors, indent=2) + "\n")
        raise SystemExit(f"{len(errors)} downloads failed")


if __name__ == "__main__":
    main()
