#!/usr/bin/env python3
import argparse
import json
import sys
import time
from pathlib import Path

import requests


def best_image(pin):
    images = pin.get("images") or {}
    for key in ("736x", "564x", "474x", "236x", "170x"):
        image = images.get(key)
        if isinstance(image, dict) and image.get("url"):
            return image["url"]
    for image in images.values():
        if isinstance(image, dict) and image.get("url"):
            return image["url"]
    return ""


def best_video(pin):
    video_list = ((pin.get("videos") or {}).get("video_list") or {})
    if not video_list:
        return None
    for key in ("V_720P", "V_540P", "V_480P", "V_HLSV4"):
        if key in video_list and video_list[key].get("url"):
            return key, video_list[key]
    for key, value in video_list.items():
        if isinstance(value, dict) and value.get("url"):
            return key, value
    return None


def scrape(username, delay=0.4, max_pages=0):
    session = requests.Session()
    session.headers.update(
        {
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0",
            "X-Pinterest-PWS-Handler": "www/[username].js",
        }
    )
    endpoint = "https://www.pinterest.com/resource/UserPinsResource/get/"
    options = {
        "username": username,
        "field_set_key": "mobile_grid_item",
        "is_own_profile_pins": False,
        "add_vase": True,
    }

    bookmark = None
    seen_bookmarks = set()
    seen_pins = set()
    video_pins = []
    all_pin_count = 0
    page = 0

    while True:
        page += 1
        request_options = dict(options)
        if bookmark:
            request_options["bookmarks"] = [bookmark]
        response = session.get(
            endpoint,
            params={"data": json.dumps({"options": request_options}, separators=(",", ":"))},
            timeout=45,
        )
        response.raise_for_status()
        payload = response.json()["resource_response"]
        pins = payload.get("data") or []
        all_pin_count += len(pins)
        page_video_count = 0

        for pin in pins:
            pin_id = str(pin.get("id") or "")
            if not pin_id or pin_id in seen_pins:
                continue
            seen_pins.add(pin_id)
            video = best_video(pin)
            if not video:
                continue
            format_id, video_data = video
            duration_ms = video_data.get("duration")
            video_pins.append(
                {
                    "id": pin_id,
                    "sourceUrl": f"https://www.pinterest.com/pin/{pin_id}/",
                    "title": pin.get("grid_title") or pin.get("title") or "",
                    "description": pin.get("description") or "",
                    "duration": round(duration_ms / 1000, 3) if isinstance(duration_ms, (int, float)) else None,
                    "thumbnail": video_data.get("thumbnail") or best_image(pin),
                    "uploader": ((pin.get("pinner") or {}).get("full_name") or ""),
                    "trackedLink": pin.get("tracked_link") or pin.get("link") or "",
                    "videoUrl": video_data["url"],
                    "videoFormat": format_id,
                    "localVideo": f"/videos/{pin_id}.mp4",
                }
            )
            page_video_count += 1

        print(
            f"page={page} pins={len(pins)} page_videos={page_video_count} total_videos={len(video_pins)}",
            file=sys.stderr,
        )
        next_bookmark = payload.get("bookmark")
        if not next_bookmark or next_bookmark == bookmark or next_bookmark in seen_bookmarks:
            break
        seen_bookmarks.add(next_bookmark)
        bookmark = next_bookmark
        if max_pages and page >= max_pages:
            break
        time.sleep(delay)

    return {"username": username, "allPinCount": all_pin_count, "videoPins": video_pins}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("username")
    parser.add_argument("--out", required=True)
    parser.add_argument("--delay", type=float, default=0.4)
    parser.add_argument("--max-pages", type=int, default=0)
    args = parser.parse_args()
    result = scrape(args.username, delay=args.delay, max_pages=args.max_pages)
    Path(args.out).write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    print(
        f"scraped {result['allPinCount']} pins, {len(result['videoPins'])} videos",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
