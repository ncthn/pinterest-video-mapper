#!/usr/bin/env python3
import argparse
import ast
import base64
import json
import os
import shlex
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

import cv2


DEFAULT_PROJECT = "gen-lang-client-0041394631"
DEFAULT_LOCATION = "global"
DEFAULT_MODEL = "gemini-2.5-flash"


def read_json(path, fallback):
    path = Path(path)
    if not path.exists():
        return fallback
    return json.loads(path.read_text())


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, indent=2) + "\n")
    temp.replace(path)


def access_token(command):
    return subprocess.check_output(
        shlex.split(command),
        text=True,
        stderr=subprocess.DEVNULL,
    ).strip()


def endpoint(project, location, model):
    host = "aiplatform.googleapis.com" if location == "global" else f"{location}-aiplatform.googleapis.com"
    return (
        f"https://{host}/v1/projects/{project}"
        f"/locations/{location}/publishers/google/models/{model}:generateContent"
    )


def jpeg_b64(path):
    return base64.b64encode(Path(path).read_bytes()).decode("ascii")


def frame_paths(pin, frame_dir):
    frame_dir.mkdir(parents=True, exist_ok=True)
    return frame_dir / f"{pin['id']}_0s.jpg", frame_dir / f"{pin['id']}_1s.jpg"


def video_source(pin):
    local = pin.get("localVideo", "").lstrip("/")
    if local and Path(local).exists():
        return local
    return pin.get("videoUrl") or ""


def extract_frames(pin, frame_dir):
    first, one_second = frame_paths(pin, frame_dir)
    if first.exists() and one_second.exists():
        return [first, one_second]

    source = video_source(pin)
    capture = cv2.VideoCapture(source)
    if not capture.isOpened():
        raise RuntimeError(f"Could not open video source for pin {pin['id']}")

    for seconds, out_path in [(0, first), (1, one_second)]:
        if out_path.exists():
            continue
        capture.set(cv2.CAP_PROP_POS_MSEC, seconds * 1000)
        ok, frame = capture.read()
        if not ok and seconds:
            capture.set(cv2.CAP_PROP_POS_FRAMES, 0)
            ok, frame = capture.read()
        if not ok:
            raise RuntimeError(f"Could not read {seconds}s frame for pin {pin['id']}")
        cv2.imwrite(str(out_path), frame, [int(cv2.IMWRITE_JPEG_QUALITY), 86])

    capture.release()
    return [first, one_second]


def prompt_for(pin):
    return f"""
You are labeling Pinterest competitor videos for Bynyla.

Use the two frames only:
- frame_0s is the first frame.
- frame_1s is the frame at 1 second.

The product is already pre-mapped by deterministic rules. Do not second-guess the product.
Return only compact JSON with this shape:
{{
  "has_logo": boolean,
  "logo_brand": string or null,
  "has_text": boolean,
  "text_language": "english" | "not_english" | "none",
  "visible_text": string,
  "confidence": number,
  "reason": string, max 20 words
}}

Logo means a visible brand logo or watermark in the creative, including product/logo marks,
TikTok/CapCut-style watermarks, or competitor brand marks. Ignore normal app UI controls.
For text_language, use "none" when has_text is false.

Pinterest title: {pin.get('title') or ''}
Pinterest description: {pin.get('description') or ''}
Pre-mapped Bynyla product handle: {pin.get('suggestedProductHandle') or ''}
Pre-mapping reason: {pin.get('suggestedProductReason') or ''}
""".strip()


def call_vertex(url, token, pin, frames):
    payload = {
        "contents": [{
            "role": "user",
            "parts": [
                {"text": prompt_for(pin)},
                {"inlineData": {"mimeType": "image/jpeg", "data": jpeg_b64(frames[0])}},
                {"inlineData": {"mimeType": "image/jpeg", "data": jpeg_b64(frames[1])}},
            ],
        }],
        "generationConfig": {
            "temperature": 0,
            "maxOutputTokens": 2048,
            "responseMimeType": "application/json",
            "responseSchema": {
                "type": "OBJECT",
                "properties": {
                    "has_logo": {"type": "BOOLEAN"},
                    "logo_brand": {"type": "STRING", "nullable": True},
                    "has_text": {"type": "BOOLEAN"},
                    "text_language": {"type": "STRING", "enum": ["english", "not_english", "none"]},
                    "visible_text": {"type": "STRING"},
                    "confidence": {"type": "NUMBER"},
                    "reason": {"type": "STRING"},
                },
                "required": ["has_logo", "has_text", "text_language", "visible_text", "confidence", "reason"],
            },
        },
    }
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=90) as response:
        body = json.loads(response.read().decode("utf8"))
    text = body["candidates"][0]["content"]["parts"][0]["text"]
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        stripped = text.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        start = stripped.find("{")
        end = stripped.rfind("}")
        if start >= 0 and end >= start:
            stripped = stripped[start:end + 1]
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError:
            try:
                parsed = ast.literal_eval(stripped)
            except Exception as error:
                raise ValueError(f"Could not parse Vertex JSON: {text[:500]!r}") from error
    return parsed, body.get("usageMetadata", {})


def annotation_patch(result):
    vertex = result["vertex"]
    patch = {
        "logoStatus": "logo" if vertex.get("has_logo") else "no_logo",
        "textStatus": "has_text" if vertex.get("has_text") else "no_text",
        "textLanguage": vertex.get("text_language") if vertex.get("has_text") else "not_applicable",
        "vertex": {
            "model": result["model"],
            "frames": result["frames"],
            "hasLogo": vertex.get("has_logo"),
            "logoBrand": vertex.get("logo_brand"),
            "hasText": vertex.get("has_text"),
            "textLanguage": vertex.get("text_language"),
            "visibleText": vertex.get("visible_text") or "",
            "confidence": vertex.get("confidence"),
            "reason": vertex.get("reason") or "",
            "processedAt": result["processedAt"],
        },
    }
    return patch


def merge_seed_annotations(seed_path, results, products):
    annotations = read_json(seed_path, {})
    products_by_handle = {product["handle"]: product for product in products}
    for result in results.values():
        pin = result["pin"]
        pin_id = pin["id"]
        existing = annotations.get(pin_id, {"pinId": pin_id})
        product = products_by_handle.get(pin.get("suggestedProductHandle"))
        if product and not existing.get("products"):
            existing["products"] = [product]
        existing.update(annotation_patch(result))
        existing["pinId"] = pin_id
        existing["source"] = "seed+vertex"
        annotations[pin_id] = existing
    write_json(seed_path, annotations)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pins", default="data/pins.json")
    parser.add_argument("--products", default="data/products.json")
    parser.add_argument("--out", default="data/vertex-premapped.json")
    parser.add_argument("--seed-annotations", default="data/annotations.seed.json")
    parser.add_argument("--frame-dir", default=".cache/vertex-premapped-frames")
    parser.add_argument("--project", default=DEFAULT_PROJECT)
    parser.add_argument("--location", default=DEFAULT_LOCATION)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--token-command", default=os.environ.get("VERTEX_TOKEN_COMMAND", "gcloud auth print-access-token"))
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--sleep", type=float, default=0.2)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    pins = read_json(args.pins, [])
    products = read_json(args.products, [])
    selected = [pin for pin in pins if pin.get("suggestedProductHandle")]
    if args.limit:
        selected = selected[:args.limit]

    output = read_json(args.out, {"meta": {}, "results": {}})
    results = output.setdefault("results", {})
    errors = []
    token = access_token(args.token_command)
    url = endpoint(args.project, args.location, args.model)

    for index, pin in enumerate(selected, 1):
        pin_id = pin["id"]
        if pin_id in results and not args.force:
            print(f"{index}/{len(selected)} exists {pin_id}", flush=True)
            continue
        try:
            frames = extract_frames(pin, Path(args.frame_dir))
            try:
                vertex, usage = call_vertex(url, token, pin, frames)
            except urllib.error.HTTPError as error:
                if error.code not in (401, 403):
                    raise
                token = access_token(args.token_command)
                vertex, usage = call_vertex(url, token, pin, frames)
            result = {
                "pin": pin,
                "frames": [str(frames[0]), str(frames[1])],
                "model": args.model,
                "processedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "usage": usage,
                "vertex": vertex,
            }
            results[pin_id] = result
            output["meta"] = {
                "project": args.project,
                "location": args.location,
                "model": args.model,
                "sourceCount": len(selected),
                "completedCount": len(results),
                "updatedAt": result["processedAt"],
            }
            write_json(args.out, output)
            merge_seed_annotations(args.seed_annotations, results, products)
            print(f"{index}/{len(selected)} ok {pin_id}", flush=True)
            time.sleep(args.sleep)
        except Exception as error:
            errors.append({"pinId": pin_id, "error": str(error)})
            write_json("data/vertex-errors.json", errors)
            print(f"{index}/{len(selected)} error {pin_id}: {error}", flush=True)

    if errors:
        raise SystemExit(f"{len(errors)} Vertex rows failed")


if __name__ == "__main__":
    main()
