from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
ENV_FILES = [ROOT / ".env", ROOT / ".env.local"]


def load_env():
    for env_path in ENV_FILES:
        if not env_path.exists():
            continue
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


def main():
    load_env()

    parser = argparse.ArgumentParser(description="Test local image generation API")
    parser.add_argument("--url", default="http://127.0.0.1:8790/api/generate-image")
    parser.add_argument("--model", default="gemini-3-pro-image-preview")
    parser.add_argument("--ratio", default="16:9")
    parser.add_argument("--size", default="1024x576")
    parser.add_argument("--prompt", default="A cinematic sci-fi city street at dusk, neon lights, detailed")
    parser.add_argument("--slug", default="")
    args = parser.parse_args()

    body = {
        "model": args.model,
        "ratio": args.ratio,
        "ui_size": args.size,
        "size": args.size,
        "prompt": args.prompt,
        "input_images": [],
    }
    headers = {"Content-Type": "application/json"}
    if args.slug:
        headers["X-Project-Slug"] = args.slug

    print("POST", args.url)
    print(json.dumps(body, ensure_ascii=False, indent=2))

    try:
        response = requests.post(args.url, headers=headers, json=body, timeout=300)
        print("STATUS:", response.status_code)
        try:
            print(json.dumps(response.json(), ensure_ascii=False, indent=2))
        except Exception:
            print(response.text)
    except Exception as err:
        print("ERROR:", str(err))


if __name__ == "__main__":
    main()
