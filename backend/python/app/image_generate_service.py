from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import mimetypes
import os
import time
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlparse
import re

import requests
from core.config import (
    MEDIA_SERVICE_REVISION,
    MATERIAL_LIBRARY_ROOT,
    OUTPUTS_DIR,
    PROJECTS_ROOT,
    PY_SERVICE_HOST,
    PY_SERVICE_PORT,
    load_env,
)
from core.media_paths import (
    active_outputs_dir,
    bind_outputs_from_request,
    reset_outputs_context,
    video_preview_url,
)

DEFAULT_ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"
ARK_IMAGE_ENDPOINT = f"{DEFAULT_ARK_BASE_URL}/images/generations"
ARK_VIDEO_TASKS_ENDPOINT = f"{DEFAULT_ARK_BASE_URL}/contents/generations/tasks"
DASHSCOPE_VIDEO_ENDPOINT = (
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis"
)
DASHSCOPE_TASK_ENDPOINT = "https://dashscope.aliyuncs.com/api/v1/tasks"
GEMINI_GENERATE_CONTENT_TMPL = (
    "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
)
VECTORENGINE_BASE_URL = "https://api.vectorengine.ai/v1"
XUNKE_BASE_URL = "https://api.xunkecloud.cn"

REQUESTS_SESSION = requests.Session()
REQUESTS_SESSION.trust_env = False

IMAGE_MODEL_MAP = {
    "Seedream-5.0": {
        "backend": "volcengine_ark",
        "api_model": "doubao-seedream-5-0-260128",
        "endpoint": "/api/v3/images/generations",
    },
    "Nano Banana 2": {
        "backend": "vectorengine_openai",
        "api_model": "gemini-3.1-flash-image-preview",
        "endpoint": "/v1/chat/completions",
    },
    "gemini-3-pro-image-preview": {
        "backend": "vectorengine_openai",
        "api_model": "gemini-3-pro-image-preview",
        "endpoint": "/v1/chat/completions",
    },
    "gpt-image-2": {
        "backend": "openai_images",
        "api_model": "gpt-image-2",
        "endpoint": "/v1/images/generations",
        "edit_endpoint": "/v1/images/edits",
    },
}

# Frontend UI model name -> Ark API model ID mapping.
VIDEO_MODEL_TO_ARK: dict[str, str] = {
    "wan2.7-i2v": "doubao-seedance-2-0-260128",
    "seedance-2.0": "doubao-seedance-2-0-260128",
    "seedance-1.5-pro": "doubao-seedance-1-5-pro-251215",
}
DEFAULT_ARK_VIDEO_MODEL = "doubao-seedance-2-0-260128"

_ARK_STATUS_MAP: dict[str, str] = {
    "queued": "PENDING",
    "running": "RUNNING",
    "succeeded": "SUCCEEDED",
    "failed": "FAILED",
    "expired": "FAILED",
    "cancelled": "FAILED",
}
_KKAI_STATUS_MAP: dict[str, str] = {
    "created": "PENDING",
    "queued": "PENDING",
    "pending": "PENDING",
    "processing": "RUNNING",
    "running": "RUNNING",
    "in_progress": "RUNNING",
    "succeeded": "SUCCEEDED",
    "success": "SUCCEEDED",
    "completed": "SUCCEEDED",
    "complete": "SUCCEEDED",
    "failed": "FAILED",
    "failure": "FAILED",
    "error": "FAILED",
    "cancelled": "FAILED",
    "canceled": "FAILED",
}
GEMINI_ASPECT_RATIO_BY_UI = {
    "鑷€傚簲": "1:1",
    "1:1": "1:1",
    "9:16": "9:16",
    "16:9": "16:9",
    "3:4": "3:4",
    "4:3": "4:3",
    "3:2": "3:2",
    "2:3": "2:3",
    "4:5": "4:5",
    "5:4": "5:4",
    "21:9": "21:9",
}


def resolve_ark_api_key() -> str:
    load_env()
    return (
        os.environ.get("ARK_API_KEY")
        or os.environ.get("VOLCENGINE_ARK_API_KEY")
        or os.environ.get("DOUBAO_API_KEY")
        or ""
    ).strip()


def resolve_gemini_api_key() -> str:
    load_env()
    return (os.environ.get("GEMINI_API_KEY") or "").strip()


def resolve_dashscope_api_key() -> str:
    load_env()
    return (os.environ.get("DASHSCOPE_API_KEY") or "").strip()


def resolve_kkai_api_key() -> str:
    load_env()
    return (
        os.environ.get("XUNKE_API_KEY")
        or os.environ.get("XUNKECLOUD_API_KEY")
        or os.environ.get("SEEDANCE_API_KEY")
        or ""
    ).strip()


def resolve_kkai_asset_token() -> str:
    load_env()
    return (
        os.environ.get("XUNKE_ASSET_TOKEN")
        or os.environ.get("XUNKECLOUD_ASSET_TOKEN")
        or resolve_kkai_api_key()
        or ""
    ).strip()


def resolve_kkai_base_url() -> str:
    load_env()
    return (
        os.environ.get("XUNKE_BASE_URL")
        or os.environ.get("XUNKECLOUD_BASE_URL")
        or XUNKE_BASE_URL
    ).strip().rstrip("/")


def resolve_kkai_asset_base_url() -> str:
    load_env()
    return (
        os.environ.get("XUNKE_ASSET_BASE_URL")
        or os.environ.get("XUNKECLOUD_ASSET_BASE_URL")
        or os.environ.get("XUNKE_BASE_URL")
        or XUNKE_BASE_URL
    ).strip().rstrip("/")


def resolve_kkai_video_endpoint() -> str:
    return f"{resolve_kkai_base_url()}/v1/videos"


def resolve_kkai_video_model(
    ui_model: str,
    resolution: str,
    duration: int | str | None = None,
    has_visual_refs: bool = False,
    force_vision: bool = False,
) -> str:
    load_env()
    resolution_l = str(resolution or "").strip().lower()
    normalized_resolution = resolution_l if resolution_l in {"480p", "720p", "1080p"} else "480p"
    resolution_key = normalized_resolution.upper()
    is_fast = str(ui_model or "").strip().lower() in {"seedance-2.0-fast", "seed-2-fast"}
    if is_fast:
        env_key = f"XUNKE_VIDEO_MODEL_SEEDANCE_2_0_FAST_{resolution_key}"
        return (
            os.environ.get(env_key)
            or (os.environ.get("XUNKE_VIDEO_MODEL_SEEDANCE_2_0_FAST") if normalized_resolution == "480p" else "")
            or f"seed-2-fast-{normalized_resolution}"
        ).strip()
    env_key = f"XUNKE_VIDEO_MODEL_SEEDANCE_2_0_{resolution_key}"
    return (
        os.environ.get(env_key)
        or (os.environ.get("XUNKE_VIDEO_MODEL_SEEDANCE_2_0") if normalized_resolution == "480p" else "")
        or f"seed-2-{normalized_resolution}"
    ).strip()


def resolve_kkai_requested_video_model(requested_model: str, force_vision: bool) -> str:
    raw = str(requested_model or "").strip()
    if not raw:
        return ""
    if raw in {"seed-2", "seed-2-fast", "seed-2-vision", "seed-2-fast-vision"}:
        return ""
    if raw.startswith("doubao-seedance-2-0"):
        return ""
    if raw.startswith("seed-2-") and raw.endswith(("480p", "720p", "1080p")):
        return raw
    mapping = {
        "seed-2-480": ("", ""),
        "seed-2-720": ("", ""),
        "seed-2-1080": ("", ""),
        "seed-2-fast-480": ("", ""),
        "seed-2-fast-720": ("", ""),
        "seed-2-fast-1080": ("", ""),
    }
    pair = mapping.get(raw)
    if not pair:
        return raw
    return pair[1] if force_vision else pair[0]


def resolve_ark_base_url() -> str:
    load_env()
    return (os.environ.get("ARK_BASE_URL") or DEFAULT_ARK_BASE_URL).strip().rstrip("/")


def resolve_ark_video_tasks_endpoint() -> str:
    base_url = resolve_ark_base_url()
    lower_base = base_url.lower()
    if lower_base.endswith("/contents/generations/tasks"):
        return base_url
    if lower_base.endswith("/api/v3"):
        return f"{base_url}/contents/generations/tasks"
    return f"{base_url}/contents/generations/tasks"


def resolve_video_provider(preferred: str = "") -> str:
    load_env()
    raw = (preferred or os.environ.get("VIDEO_PROVIDER") or "xunke_seedance").strip().lower()
    if raw in {"xunke", "xunkecloud", "xunke_seedance", "kkai", "kk", "kkai_seedance", "kkidc", "kuaikuai", "seedance"}:
        return "xunke_seedance"
    if raw in {"dashscope", "wan", "wan2.7", "wan2.7-i2v"}:
        return "dashscope"
    return "ark_seedance"


def resolve_ark_video_model(ui_model: str = "seedance-2.0", provider_model_hint: str = "") -> str:
    load_env()
    ui_model = str(ui_model or "seedance-2.0").strip()
    per_model_env = {
        "seedance-2.0": "ARK_VIDEO_MODEL_SEEDANCE_2_0",
        "seedance-1.5-pro": "ARK_VIDEO_MODEL_SEEDANCE_1_5_PRO",
    }
    env_key = per_model_env.get(ui_model, "")
    if env_key:
        env_value = (os.environ.get(env_key) or "").strip()
        if env_value:
            return env_value
    hint = str(provider_model_hint or "").strip()
    if hint:
        return hint
    return VIDEO_MODEL_TO_ARK.get(ui_model, DEFAULT_ARK_VIDEO_MODEL)


def resolve_vectorengine_api_key() -> str:
    load_env()
    return (
        os.environ.get("VECTORENGINE_API_KEY")
        or os.environ.get("GEMINI_RELAY_API_KEY")
        or os.environ.get("IMAGE_API_KEY")
        or ""
    ).strip()


def resolve_vectorengine_base_url() -> str:
    load_env()
    return (
        os.environ.get("VECTORENGINE_BASE_URL")
        or os.environ.get("GEMINI_RELAY_BASE_URL")
        or os.environ.get("IMAGE_API_BASE_URL")
        or VECTORENGINE_BASE_URL
        or ""
    ).strip().rstrip("/")


def resolve_vectorengine_model(default_model: str = "gemini-3-pro-image-preview") -> str:
    load_env()
    model_alias_env = {
        "gemini-3-pro-image-preview": "VECTORENGINE_MODEL_NANO_BANANA_PRO",
        "gemini-3.1-flash-image-preview": "VECTORENGINE_MODEL_NANO_BANANA_2",
    }
    alias_key = model_alias_env.get(str(default_model).strip(), "")
    alias_value = (os.environ.get(alias_key) or "").strip() if alias_key else ""
    if alias_value:
        return alias_value
    specific = (
        os.environ.get(f"VECTORENGINE_MODEL_{str(default_model).upper().replace('.', '_').replace('-', '_')}")
        or os.environ.get(f"GEMINI_RELAY_MODEL_{str(default_model).upper().replace('.', '_').replace('-', '_')}")
        or ""
    ).strip()
    if specific:
        return specific
    if default_model:
        return str(default_model).strip()
    return (
        os.environ.get("VECTORENGINE_MODEL")
        or os.environ.get("GEMINI_RELAY_MODEL")
        or os.environ.get("IMAGE_API_MODEL")
        or "gemini-3-pro-image-preview"
    ).strip()


def resolve_vectorengine_endpoint(default_model: str, default_endpoint: str = "") -> str:
    load_env()
    custom = (
        os.environ.get("VECTORENGINE_ENDPOINT")
        or os.environ.get("GEMINI_RELAY_ENDPOINT")
        or os.environ.get("IMAGE_API_ENDPOINT")
        or ""
    ).strip()
    if custom:
        return custom if custom.startswith("/") else f"/{custom}"
    if default_endpoint:
        return default_endpoint if str(default_endpoint).startswith("/") else f"/{default_endpoint}"
    return "/v1/chat/completions"


def resolve_gpt_image_2_api_key() -> str:
    load_env()
    return (
        os.environ.get("GPT_IMAGE_2_API_KEY")
        or os.environ.get("VECTORENGINE_API_KEY")
        or os.environ.get("GEMINI_RELAY_API_KEY")
        or os.environ.get("OPENAI_IMAGE_API_KEY")
        or os.environ.get("OPENAI_API_KEY")
        or ""
    ).strip()


def resolve_gpt_image_2_base_url() -> str:
    load_env()
    return (
        os.environ.get("GPT_IMAGE_2_BASE_URL")
        or os.environ.get("OPENAI_IMAGE_BASE_URL")
        or os.environ.get("OPENAI_BASE_URL")
        or os.environ.get("VECTORENGINE_BASE_URL")
        or os.environ.get("GEMINI_RELAY_BASE_URL")
        or "https://api.openai.com"
    ).strip().rstrip("/")


def resolve_gpt_image_2_model(default_model: str = "gpt-image-2") -> str:
    load_env()
    return (
        os.environ.get("GPT_IMAGE_2_MODEL")
        or os.environ.get("OPENAI_IMAGE_MODEL")
        or str(default_model or "gpt-image-2")
    ).strip()


def resolve_gpt_image_2_endpoint(default_endpoint: str = "/v1/images/generations") -> str:
    load_env()
    endpoint = (
        os.environ.get("GPT_IMAGE_2_GENERATIONS_ENDPOINT")
        or os.environ.get("OPENAI_IMAGE_GENERATIONS_ENDPOINT")
        or default_endpoint
        or "/v1/images/generations"
    )
    endpoint = str(endpoint).strip()
    return endpoint if endpoint.startswith("/") else f"/{endpoint}"


def resolve_gpt_image_2_edit_endpoint(default_endpoint: str = "/v1/images/edits") -> str:
    load_env()
    endpoint = (
        os.environ.get("GPT_IMAGE_2_EDITS_ENDPOINT")
        or os.environ.get("OPENAI_IMAGE_EDITS_ENDPOINT")
        or default_endpoint
        or "/v1/images/edits"
    )
    endpoint = str(endpoint).strip()
    return endpoint if endpoint.startswith("/") else f"/{endpoint}"


def resolve_gpt_image_2_url(endpoint: str) -> str:
    """
    Keep VectorEngine-compatible base URLs stable: when the base URL already
    ends with /v1, avoid appending another /v1 from the endpoint.
    """
    base_url = resolve_gpt_image_2_base_url()
    normalized_endpoint = endpoint if str(endpoint).startswith("/") else f"/{endpoint}"
    base_lower = base_url.lower().rstrip("/")
    if base_lower.endswith("/v1") and normalized_endpoint.startswith("/v1/"):
        normalized_endpoint = normalized_endpoint[len("/v1") :] or "/"
    return f"{base_url}{normalized_endpoint}"


def resolve_vectorengine_chat_url(endpoint: str) -> str:
    base_url = resolve_vectorengine_base_url()
    lower_base = base_url.lower()
    normalized_endpoint = endpoint if endpoint.startswith("/") else f"/{endpoint}"
    if lower_base.endswith("/v1/chat/completions"):
        return base_url
    if lower_base.endswith("/v1"):
        return f"{base_url}/chat/completions"
    return f"{base_url}{normalized_endpoint}"


def send_json(handler: BaseHTTPRequestHandler, status_code: int, payload: dict):
    handler.send_response(status_code)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Access-Control-Allow-Origin", "*")
    # Allow X-Project-Slug so browser preflight succeeds for generation requests.
    handler.send_header("Access-Control-Allow-Headers", "Content-Type, X-Project-Slug")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    handler.end_headers()
    handler.wfile.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))


def read_json_body(handler: BaseHTTPRequestHandler) -> dict:
    content_length = int(handler.headers.get("Content-Length", "0"))
    raw_body = handler.rfile.read(content_length) if content_length else b"{}"
    return json.loads(raw_body.decode("utf-8") or "{}")


def normalize_http_path(handler_path: str) -> str:
    raw = (handler_path or "/").strip().split("?", 1)[0].strip()
    if raw == "/api/media":
        raw = "/api"
    elif raw.startswith("/api/media/"):
        raw = "/api/" + raw[len("/api/media/"):]
    if len(raw) > 1 and raw.endswith("/"):
        raw = raw.rstrip("/")
    return raw or "/"


def normalize_ui_image_model(raw: object) -> str:
    text = str(raw or "").strip()
    if not text:
        return ""
    return " ".join(text.split())


def resolve_image_model(ui_model_normalized: str) -> dict | None:
    if ui_model_normalized in IMAGE_MODEL_MAP:
        return IMAGE_MODEL_MAP[ui_model_normalized]
    lower = ui_model_normalized.lower()
    tokens = lower.replace("-", " ").split()
    compact = "".join(lower.split())
    if compact in {"gptimage2", "gptimage-2", "gptimage"}:
        return IMAGE_MODEL_MAP["gpt-image-2"]
    if ("nano" in tokens and "banana" in tokens) or compact.startswith("nanobanana"):
        return IMAGE_MODEL_MAP["Nano Banana 2"]
    if compact == "gemini3proimagepreview":
        return IMAGE_MODEL_MAP["gemini-3-pro-image-preview"]
    return None


def guess_extension_from_response(response: requests.Response, fallback: str = ".png") -> str:
    content_type = response.headers.get("Content-Type", "").split(";")[0].strip()
    guessed = mimetypes.guess_extension(content_type) if content_type else None
    if guessed:
        return guessed
    parsed_path = Path(urlparse(response.url).path)
    if parsed_path.suffix:
        return parsed_path.suffix
    return fallback


def normalize_image_input(image_value: str) -> str:
    if not image_value:
        raise ValueError("收到空的图像输入")
    candidate = str(image_value).strip()
    if candidate.startswith("data:image/") and "," in candidate:
        return candidate
    if candidate.startswith("http://") or candidate.startswith("https://"):
        return candidate
    try:
        possible_path = Path(candidate)
        if possible_path.exists() and possible_path.is_file():
            return base64.b64encode(possible_path.read_bytes()).decode("utf-8")
    except (OSError, ValueError):
        pass
    return candidate


def build_doubao_payload(request_body: dict) -> dict:
    selected_model = normalize_ui_image_model(request_body.get("model"))
    model_cfg = resolve_image_model(selected_model) or {}
    prompt = str(request_body.get("prompt") or "").strip()
    size = str(request_body.get("size") or "").strip() or "2048x2048"
    input_images = request_body.get("input_images") or []

    if not prompt:
        raise ValueError("prompt 不能为空")
    if model_cfg.get("backend") != "volcengine_ark":
        raise ValueError(f"当前还没有实现模型分支：{selected_model}")

    payload = {
        "model": model_cfg.get("api_model") or "doubao-seedream-5-0-260128",
        "prompt": prompt,
        "size": size,
        "response_format": "url",
        "stream": False,
        "watermark": False,
        "sequential_image_generation": "disabled",
    }
    normalized_images = [normalize_image_input(item) for item in input_images if item]
    if normalized_images:
        payload["image"] = normalized_images[0] if len(normalized_images) == 1 else normalized_images
    return payload


def build_generate_content_request(request_body: dict) -> dict:
    prompt = str(request_body.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("prompt 不能为空")

    parts: list[dict] = []
    for raw_img in request_body.get("input_images") or []:
        item = gemini_inline_part_from_frontend_image(str(raw_img)) if raw_img else None
        if item:
            parts.append(item)
    parts.append({"text": prompt})

    image_cfg = {"aspectRatio": ratio_for_gemini_aspect(request_body)}
    size = str(request_body.get("size") or "").strip()
    if size:
        image_cfg["size"] = size

    return {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "responseModalities": ["TEXT", "IMAGE"],
            "imageConfig": image_cfg,
        },
    }


def call_doubao_api(payload: dict) -> dict:
    api_key = resolve_ark_api_key()
    if not api_key:
        raise ValueError("Missing ARK_API_KEY")
    response = REQUESTS_SESSION.post(
        ARK_IMAGE_ENDPOINT,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        json=payload,
        timeout=180,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"Ark image request failed: HTTP {response.status_code}: {response.text}")
    return response.json()


def download_result_image(image_url: str, prefix: str = "img") -> dict:
    response = REQUESTS_SESSION.get(image_url, timeout=180)
    response.raise_for_status()
    extension = guess_extension_from_response(response, ".png")
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    file_name = f"{prefix}_{timestamp}{extension}"
    save_path = active_outputs_dir() / file_name
    save_path.write_bytes(response.content)
    mime_type = response.headers.get("Content-Type", "").split(";")[0].strip() or "image/png"
    preview_data_url = f"data:{mime_type};base64,{base64.b64encode(response.content).decode('utf-8')}"
    return {
        "saved_filename": file_name,
        "saved_path": str(save_path),
        "preview_data_url": preview_data_url,
    }


def ratio_for_gemini_aspect(request_body: dict) -> str:
    ratio_id = str(request_body.get("ratio") or "").strip()
    return GEMINI_ASPECT_RATIO_BY_UI.get(ratio_id, "1:1")


def gemini_inline_part_from_frontend_image(image_value: str) -> dict | None:
    if not image_value:
        return None
    normalized = normalize_image_input(image_value)
    if normalized.startswith("data:image/") and "," in normalized:
        header, b64_text = normalized.split(",", 1)
        mime_type = header.split(";")[0].replace("data:", "").strip() or "image/png"
        return {"inlineData": {"mimeType": mime_type, "data": b64_text.strip()}}
    if normalized.startswith("http://") or normalized.startswith("https://"):
        img_resp = REQUESTS_SESSION.get(normalized, timeout=120)
        img_resp.raise_for_status()
        mime_type = img_resp.headers.get("Content-Type", "").split(";")[0].strip() or "image/png"
        return {
            "inlineData": {
                "mimeType": mime_type,
                "data": base64.b64encode(img_resp.content).decode("utf-8"),
            }
        }
    return {"inlineData": {"mimeType": "image/png", "data": str(normalized).strip()}}


def call_gemini_generate_content(api_model: str, body: dict) -> dict:
    api_key = resolve_gemini_api_key()
    if not api_key:
        raise ValueError("Missing GEMINI_API_KEY")
    response = REQUESTS_SESSION.post(
        GEMINI_GENERATE_CONTENT_TMPL.format(model=api_model),
        params={"key": api_key},
        headers={"Content-Type": "application/json"},
        json=body,
        timeout=240,
    )
    if response.status_code >= 400:
        snippet = (response.text or "")[:800]
        if response.status_code == 429:
            raise RuntimeError(
                "Gemini quota is insufficient or the current key cannot access this image model."
            )
        if response.status_code in (401, 403):
            raise RuntimeError("Gemini API authorization failed. Check GEMINI_API_KEY.")
        raise RuntimeError(f"Gemini request failed: HTTP {response.status_code}: {snippet}")
    return response.json()


def call_vectorengine_chat_completions(endpoint: str, body: dict) -> dict:
    key = resolve_vectorengine_api_key()
    if not key:
        raise ValueError("Missing VECTORENGINE_API_KEY")
    url = resolve_vectorengine_chat_url(endpoint)
    response = REQUESTS_SESSION.post(
        url,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": f"Bearer {key}",
        },
        json=body,
        timeout=240,
    )
    if response.status_code >= 400:
        snippet = (response.text or "")[:800]
        snippet_lower = snippet.lower()
        if (
            response.status_code == 402
            or "insufficient_quota" in snippet_lower
            or "insufficient balance" in snippet_lower
            or "quota" in snippet_lower
        ):
            raise RuntimeError("VectorEngine quota is insufficient")
        if response.status_code in (401, 403):
            raise RuntimeError("VectorEngine API authorization failed. Check VECTORENGINE_API_KEY.")
        raise RuntimeError(f"VectorEngine request failed: HTTP {response.status_code}: {snippet}")
    return response.json()


def extract_inline_image_from_gemini_response(response_json: dict) -> tuple[bytes, str]:
    feedback = response_json.get("promptFeedback") or {}
    block_reason = feedback.get("blockReason")
    if block_reason:
        raise RuntimeError(f"Gemini blocked the request: blockReason={block_reason}")
    candidates = response_json.get("candidates") or []
    for cand in candidates:
        content = cand.get("content") or {}
        for part in content.get("parts") or []:
            inline = part.get("inlineData") or part.get("inline_data")
            if not inline:
                continue
            mime = inline.get("mimeType") or inline.get("mime_type") or "image/png"
            data_b64 = inline.get("data") or ""
            if not data_b64:
                continue
            try:
                return base64.b64decode(data_b64), mime
            except binascii.Error as exc:
                raise RuntimeError(f"Gemini returned invalid image base64: {exc}") from exc
    raise RuntimeError(
        f"Gemini response did not contain image data. Response: {json.dumps(response_json, ensure_ascii=False)[:600]}"
    )


def save_inline_image(raw_bytes: bytes, mime_type: str, prefix: str) -> tuple[str, Path, str]:
    ext = mimetypes.guess_extension(mime_type.split(";")[0].strip()) or ".png"
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    file_name = f"{prefix}_{stamp}{ext}"
    save_path = active_outputs_dir() / file_name
    save_path.write_bytes(raw_bytes)
    preview_data_url = f"data:{mime_type};base64,{base64.b64encode(raw_bytes).decode('utf-8')}"
    return file_name, save_path, preview_data_url


def build_vectorengine_chat_request(request_body: dict, api_model: str) -> dict:
    prompt = str(request_body.get("prompt") or "").strip()
    ratio = ratio_for_gemini_aspect(request_body)
    size = str(request_body.get("size") or "").strip()

    user_parts: list[object] = []
    instruction = (
        f"{prompt}\n\n"
        f"Please generate an image, not a text-only reply. "
        f"Preferred aspect ratio: {ratio}. "
        f"Preferred output size: {size or 'auto'}."
    ).strip()
    user_parts.append({"type": "text", "text": instruction})

    for raw_img in request_body.get("input_images") or []:
        val = str(raw_img or "").strip()
        if not val:
            continue
        user_parts.append({"type": "image_url", "image_url": {"url": val}})

    content: object
    if len(user_parts) == 1:
        content = instruction
    else:
        content = user_parts

    return {
        "model": api_model,
        "messages": [{"role": "user", "content": content}],
        "stream": False,
        "max_tokens": 2048,
    }


def _collect_text_fragments(value: object) -> list[str]:
    texts: list[str] = []
    if isinstance(value, str):
        texts.append(value)
    elif isinstance(value, list):
        for item in value:
            texts.extend(_collect_text_fragments(item))
    elif isinstance(value, dict):
        if isinstance(value.get("text"), str):
            texts.append(str(value.get("text")))
        if isinstance(value.get("content"), str):
            texts.append(str(value.get("content")))
        for nested in value.values():
            if isinstance(nested, (dict, list)):
                texts.extend(_collect_text_fragments(nested))
    return texts


def extract_image_result_from_openai_chat(response_json: dict) -> tuple[str, str | None]:
    texts = _collect_text_fragments(response_json.get("choices") or [])
    joined = "\n".join(texts).strip()

    md_match = re.search(r"!\[[^\]]*\]\((data:image/[^)]+|https?://[^)\s]+)\)", joined)
    if md_match:
        return md_match.group(1), joined

    data_match = re.search(r"(data:image/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+)", joined)
    if data_match:
        return data_match.group(1).replace("\n", ""), joined

    url_match = re.search(r"(https?://[^\s)>\"]+)", joined)
    if url_match:
        return url_match.group(1), joined

    raise RuntimeError(
        f"VectorEngine chat returned success but no image result. Response: {joined[:600] or json.dumps(response_json, ensure_ascii=False)[:600]}"
    )


def frontend_image_to_bytes(image_value: str) -> tuple[bytes, str, str]:
    normalized = normalize_image_input(image_value)
    if normalized.startswith("data:image/") and "," in normalized:
        header, b64_text = normalized.split(",", 1)
        mime_type = header.split(";")[0].replace("data:", "").strip() or "image/png"
        ext = mimetypes.guess_extension(mime_type) or ".png"
        return base64.b64decode(b64_text), mime_type, ext
    if normalized.startswith("http://") or normalized.startswith("https://"):
        response = REQUESTS_SESSION.get(normalized, timeout=180)
        response.raise_for_status()
        mime_type = response.headers.get("Content-Type", "").split(";")[0].strip() or "image/png"
        ext = guess_extension_from_response(response, ".png")
        return response.content, mime_type, ext
    try:
        raw_bytes = base64.b64decode(normalized)
        return raw_bytes, "image/png", ".png"
    except (binascii.Error, ValueError):
        raise RuntimeError("GPT Image 2 输入图片格式无法识别")


def extract_openai_images_result(response_json: dict) -> tuple[bytes | None, str | None, str | None]:
    data = response_json.get("data") or []
    if not data:
        raise RuntimeError(
            f"OpenAI Images returned success but no data. Response: {json.dumps(response_json, ensure_ascii=False)[:600]}"
        )
    first = data[0] or {}
    image_url = str(first.get("url") or "").strip()
    if image_url:
        return None, None, image_url
    b64_text = str(first.get("b64_json") or "").strip()
    if b64_text:
        return base64.b64decode(b64_text), "image/png", None
    raise RuntimeError(
        f"OpenAI Images returned success but no url or b64_json. Response: {json.dumps(response_json, ensure_ascii=False)[:600]}"
    )


def generate_image_via_gemini(request_body: dict, model_cfg: dict) -> dict:
    prompt = str(request_body.get("prompt") or "").strip()
    ui_model_label = normalize_ui_image_model(request_body.get("model"))
    if not prompt:
        raise ValueError("prompt 不能为空")

    request_json = build_generate_content_request(request_body)
    response_json = call_gemini_generate_content(
        str(model_cfg.get("api_model") or "gemini-2.5-flash-image"),
        request_json,
    )
    raw_bytes, mime_type = extract_inline_image_from_gemini_response(response_json)
    file_name, save_path, preview_data_url = save_inline_image(raw_bytes, mime_type, "gemini")

    return {
        "ok": True,
        "provider": "google-gemini",
        "model": ui_model_label,
        "api_model": model_cfg.get("api_model"),
        "prompt": prompt,
        "aspect_ratio": ratio_for_gemini_aspect(request_body),
        "size": request_body.get("size"),
        "saved_filename": file_name,
        "saved_path": str(save_path),
        "preview_data_url": preview_data_url,
    }


def generate_image_via_vectorengine(request_body: dict, model_cfg: dict) -> dict:
    prompt = str(request_body.get("prompt") or "").strip()
    ui_model_label = normalize_ui_image_model(request_body.get("model"))
    if not prompt:
        raise ValueError("prompt 不能为空")

    api_model = resolve_vectorengine_model(str(model_cfg.get("api_model") or "gemini-3-pro-image-preview"))
    endpoint = resolve_vectorengine_endpoint(
        str(model_cfg.get("api_model") or "gemini-3-pro-image-preview"),
        str(model_cfg.get("endpoint") or ""),
    )
    request_json = build_vectorengine_chat_request(request_body, api_model)
    response_json = call_vectorengine_chat_completions(endpoint, request_json)
    image_ref, response_text = extract_image_result_from_openai_chat(response_json)

    if image_ref.startswith("data:image/"):
        header, b64_text = image_ref.split(",", 1)
        mime_type = header.split(";")[0].replace("data:", "").strip() or "image/png"
        raw_bytes = base64.b64decode(b64_text)
        file_name, save_path, preview_data_url = save_inline_image(raw_bytes, mime_type, "vectorengine")
        result_url = None
    else:
        result_url = image_ref
        download_result = download_result_image(image_ref, prefix="vectorengine")
        file_name = download_result["saved_filename"]
        save_path = Path(download_result["saved_path"])
        preview_data_url = download_result["preview_data_url"]

    return {
        "ok": True,
        "provider": "vectorengine",
        "model": ui_model_label,
        "api_model": api_model,
        "endpoint": endpoint,
        "prompt": prompt,
        "aspect_ratio": ratio_for_gemini_aspect(request_body),
        "size": request_body.get("size"),
        "saved_filename": file_name,
        "saved_path": str(save_path),
        "preview_data_url": preview_data_url,
        "result_url": result_url,
        "response_text": response_text,
    }


def generate_image_via_openai_images(request_body: dict, model_cfg: dict) -> dict:
    prompt = str(request_body.get("prompt") or "").strip()
    ui_model_label = normalize_ui_image_model(request_body.get("model"))
    if not prompt:
        raise ValueError("prompt 不能为空")

    key = resolve_gpt_image_2_api_key()
    if not key:
        raise ValueError("Missing GPT_IMAGE_2_API_KEY")

    api_model = resolve_gpt_image_2_model(str(model_cfg.get("api_model") or "gpt-image-2"))
    size = str(request_body.get("size") or "").strip() or "1024x1024"
    input_images = [str(item or "").strip() for item in (request_body.get("input_images") or []) if item]
    headers = {
        "Authorization": f"Bearer {key}",
    }

    try:
        if input_images:
            endpoint = resolve_gpt_image_2_edit_endpoint(str(model_cfg.get("edit_endpoint") or "/v1/images/edits"))
            url = resolve_gpt_image_2_url(endpoint)
            files: list[tuple[str, tuple[str, bytes, str]]] = []
            for index, image_value in enumerate(input_images):
                raw_bytes, mime_type, extension = frontend_image_to_bytes(image_value)
                field_name = "image" if len(input_images) == 1 else "image[]"
                files.append(
                    (
                        field_name,
                        (f"input_{index + 1}{extension}", raw_bytes, mime_type),
                    )
                )
            response = REQUESTS_SESSION.post(
                url,
                headers=headers,
                data={
                    "model": api_model,
                    "prompt": prompt,
                    "size": size,
                },
                files=files,
                timeout=300,
            )
            resolved_endpoint = endpoint
        else:
            endpoint = resolve_gpt_image_2_endpoint(str(model_cfg.get("endpoint") or "/v1/images/generations"))
            url = resolve_gpt_image_2_url(endpoint)
            response = REQUESTS_SESSION.post(
                url,
                headers={
                    **headers,
                    "Content-Type": "application/json",
                },
                json={
                    "model": api_model,
                    "prompt": prompt,
                    "size": size,
                },
                timeout=300,
            )
            resolved_endpoint = endpoint
    except requests.RequestException as req_err:
        raise RuntimeError(
            f"GPT Image 2 request connection failed: {str(req_err)[:280]}"
        )

    if response.status_code >= 400:
        snippet = (response.text or "")[:800]
        snippet_lower = snippet.lower()
        if response.status_code == 401:
            raise RuntimeError(
                f"GPT Image 2 returned 401. Check GPT_IMAGE_2_API_KEY and base URL. Upstream: {snippet[:400]}"
            )
        if response.status_code == 403:
            if (
                "insufficient_quota" in snippet_lower
                or "quota" in snippet_lower
                or "billing" in snippet_lower
                or "balance" in snippet_lower
            ):
                raise RuntimeError(
                    f"GPT Image 2 returned 403/quota or permission issue. Upstream: {snippet[:400]}"
                )
            raise RuntimeError(
                f"GPT Image 2 returned 403. Check account/model permission. Upstream: {snippet[:400]}"
            )
        if response.status_code == 429:
            raise RuntimeError(
                f"GPT Image 2 returned 429/rate limit. Upstream: {snippet[:400]}"
            )
        raise RuntimeError(f"GPT Image 2 request failed: HTTP {response.status_code}: {snippet}")

    response_json = response.json()
    raw_bytes, mime_type, image_url = extract_openai_images_result(response_json)
    if image_url:
        download_result = download_result_image(image_url, prefix="gptimage2")
        file_name = download_result["saved_filename"]
        save_path = Path(download_result["saved_path"])
        preview_data_url = download_result["preview_data_url"]
        result_url = image_url
    else:
        file_name, save_path, preview_data_url = save_inline_image(
            raw_bytes or b"",
            mime_type or "image/png",
            "gptimage2",
        )
        result_url = None

    return {
        "ok": True,
        "provider": "openai-images",
        "model": ui_model_label,
        "api_model": api_model,
        "endpoint": resolved_endpoint,
        "prompt": prompt,
        "size": size,
        "saved_filename": file_name,
        "saved_path": str(save_path),
        "preview_data_url": preview_data_url,
        "result_url": result_url,
    }


def route_image_generation(request_body: dict) -> dict:
    ui_model = normalize_ui_image_model(request_body.get("model"))
    request_body["model"] = ui_model
    model_cfg = resolve_image_model(ui_model) or {}
    backend = str(model_cfg.get("backend") or "")

    if backend == "volcengine_ark":
        payload = build_doubao_payload(request_body)
        api_result = call_doubao_api(payload)
        image_url = (((api_result or {}).get("data") or [{}])[0]).get("url")
        if not image_url:
            raise RuntimeError(f"API response did not contain an image URL: {json.dumps(api_result, ensure_ascii=False)}")
        return {
            "ok": True,
            "provider": "volcengine-ark",
            "model": ui_model,
            "api_model": payload.get("model"),
            "endpoint": model_cfg.get("endpoint"),
            "prompt": request_body.get("prompt"),
            "size": payload.get("size"),
            "result_url": image_url,
            **download_result_image(image_url),
        }

    if backend == "google_gemini":
        return generate_image_via_gemini(request_body, model_cfg)

    if backend == "vectorengine_openai":
        return generate_image_via_vectorengine(request_body, model_cfg)

    if backend == "openai_images":
        return generate_image_via_openai_images(request_body, model_cfg)

    if ui_model:
        raise ValueError(f"Unsupported image model: {ui_model}")
    raise ValueError("Missing image model name")


# Video generation

def download_video_file(video_url: str, prefix: str = "video") -> dict:
    """Download a video and save it to the outputs directory."""
    resp = REQUESTS_SESSION.get(video_url, timeout=300, stream=True)
    resp.raise_for_status()

    content_type = resp.headers.get("Content-Type", "video/mp4").split(";")[0].strip()
    ext = mimetypes.guess_extension(content_type) or ".mp4"
    if ext in (".mp4v", ".mpg4"):
        ext = ".mp4"

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    file_name = f"{prefix}_{timestamp}{ext}"
    save_path = active_outputs_dir() / file_name

    with open(save_path, "wb") as f:
        for chunk in resp.iter_content(chunk_size=65536):
            f.write(chunk)

    return {"saved_filename": file_name, "saved_path": str(save_path)}


def _make_video_preview_result(video_url: str) -> dict:
    """Return a local preview URL when download succeeds, otherwise the source URL."""
    try:
        saved = download_video_file(video_url)
        return {
            "preview_url": video_preview_url(saved["saved_filename"]),
            "result_url": video_url,
            "saved_filename": saved["saved_filename"],
        }
    except Exception as dl_err:
        return {
            "preview_url": video_url,
            "result_url": video_url,
            "download_error": str(dl_err),
        }


# DashScope wan2.7-i2v

# KK-AI Seedance 2.0

def _dig_first(obj, paths: list[list[object]], default=None):
    for path_items in paths:
        cur = obj
        ok = True
        for key in path_items:
            if isinstance(key, int):
                if isinstance(cur, list) and 0 <= key < len(cur):
                    cur = cur[key]
                else:
                    ok = False
                    break
            elif isinstance(cur, dict) and key in cur:
                cur = cur.get(key)
            else:
                ok = False
                break
        if ok and cur not in (None, ""):
            return cur
    return default


def _xunke_auth_header(token: str) -> str:
    token = str(token or "").strip()
    if token.lower().startswith("bearer "):
        return token
    return f"Bearer {token}"


def _kkai_error_message(data: object, fallback: str) -> str:
    if isinstance(data, dict):
        err = data.get("error")
        if isinstance(err, dict):
            return str(err.get("message") or err.get("msg") or fallback)
        if err:
            return str(err)
        return str(data.get("message") or data.get("msg") or fallback)
    return fallback


def _kkai_status(raw_status: object) -> str:
    text = str(raw_status or "").strip()
    if not text:
        return "PENDING"
    return _KKAI_STATUS_MAP.get(text.lower(), text.upper())


def _normalize_asset_id(value: object) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    if raw.startswith("asset://"):
        return raw
    return f"asset://{raw}"


def _normalize_kkai_media_ref(value: object) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    return raw


def _normalize_kkai_media_refs(values: object) -> list[str]:
    if isinstance(values, (list, tuple)):
        raw_values = values
    else:
        raw_values = re.split(r"[\s,]+", str(values or ""))
    deduped: list[str] = []
    for item in raw_values:
        ref = _normalize_kkai_media_ref(item)
        if ref and ref not in deduped:
            deduped.append(ref)
    return deduped


def _kkai_should_upload_public_refs() -> bool:
    return str(
        os.environ.get("XUNKE_UPLOAD_PUBLIC_IMAGE_REFS")
        or ""
    ).strip() == "1"


def resolve_tencent_cos_config() -> dict:
    load_env()
    bucket = str(os.environ.get("TENCENT_COS_BUCKET") or "").strip()
    region = str(os.environ.get("TENCENT_COS_REGION") or "").strip()
    secret_id = str(os.environ.get("TENCENT_SECRET_ID") or os.environ.get("TENCENT_COS_SECRET_ID") or "").strip()
    secret_key = str(os.environ.get("TENCENT_SECRET_KEY") or os.environ.get("TENCENT_COS_SECRET_KEY") or "").strip()
    prefix = str(os.environ.get("TENCENT_COS_PREFIX") or "seedance-face-review/").strip().lstrip("/")
    expires = int(os.environ.get("TENCENT_COS_SIGN_EXPIRES_SECONDS") or "3600")
    if prefix and not prefix.endswith("/"):
        prefix += "/"
    missing = [
        name
        for name, value in (
            ("TENCENT_COS_BUCKET", bucket),
            ("TENCENT_COS_REGION", region),
            ("TENCENT_SECRET_ID", secret_id),
            ("TENCENT_SECRET_KEY", secret_key),
        )
        if not value
    ]
    if missing:
        raise ValueError(f"Missing Tencent COS config: {', '.join(missing)}")
    return {
        "bucket": bucket,
        "region": region,
        "secret_id": secret_id,
        "secret_key": secret_key,
        "prefix": prefix,
        "expires": max(60, min(86400, expires)),
    }


def _cos_object_uri(object_key: str) -> str:
    return "/" + quote(str(object_key or "").lstrip("/"), safe="/-_.~")


def _cos_auth(secret_id: str, secret_key: str, method: str, object_key: str, host: str, expires: int) -> str:
    now = int(time.time())
    sign_time = f"{now};{now + expires}"
    key_time = sign_time
    header_list = "host"
    signed_headers = f"host={quote(host.lower(), safe='')}"
    http_string = f"{method.lower()}\n{_cos_object_uri(object_key)}\n\n{signed_headers}\n"
    string_to_sign = f"sha1\n{sign_time}\n{hashlib.sha1(http_string.encode('utf-8')).hexdigest()}\n"
    sign_key = hmac.new(secret_key.encode("utf-8"), key_time.encode("utf-8"), hashlib.sha1).hexdigest()
    signature = hmac.new(sign_key.encode("utf-8"), string_to_sign.encode("utf-8"), hashlib.sha1).hexdigest()
    return (
        "q-sign-algorithm=sha1"
        f"&q-ak={quote(secret_id, safe='')}"
        f"&q-sign-time={sign_time}"
        f"&q-key-time={key_time}"
        f"&q-header-list={header_list}"
        "&q-url-param-list="
        f"&q-signature={signature}"
    )


def _cos_signed_url(config: dict, method: str, object_key: str) -> str:
    host = f"{config['bucket']}.cos.{config['region']}.myqcloud.com"
    auth = _cos_auth(config["secret_id"], config["secret_key"], method, object_key, host, config["expires"])
    return f"https://{host}{_cos_object_uri(object_key)}?{auth}"


def _local_project_media_path(path_value: str) -> Path | None:
    parsed = urlparse(path_value)
    path = unquote(parsed.path or path_value)
    if path.startswith("/api/node/project/media/"):
        rest = path[len("/api/node/project/media/"):]
        parts = [p for p in rest.split("/") if p]
        if len(parts) >= 2:
            slug = parts[0]
            rel = "/".join(parts[1:])
            candidate = (PROJECTS_ROOT / slug / "assets" / rel).resolve()
            root = (PROJECTS_ROOT / slug / "assets").resolve()
            if str(candidate).startswith(str(root)) and candidate.is_file():
                return candidate
    if path.startswith("/api/project/media/"):
        rest = path[len("/api/project/media/"):]
        parts = [p for p in rest.split("/") if p]
        if len(parts) >= 2:
            slug = parts[0]
            rel = "/".join(parts[1:])
            candidate = (PROJECTS_ROOT / slug / "assets" / rel).resolve()
            root = (PROJECTS_ROOT / slug / "assets").resolve()
            if str(candidate).startswith(str(root)) and candidate.is_file():
                return candidate
    if path.startswith("/api/node/material-library/media/"):
        name = Path(path[len("/api/node/material-library/media/"):]).name
        candidate = (MATERIAL_LIBRARY_ROOT / "assets" / name).resolve()
        root = (MATERIAL_LIBRARY_ROOT / "assets").resolve()
        if str(candidate).startswith(str(root)) and candidate.is_file():
            return candidate
    if path.startswith("/api/material-library/media/"):
        name = Path(path[len("/api/material-library/media/"):]).name
        candidate = (MATERIAL_LIBRARY_ROOT / "assets" / name).resolve()
        root = (MATERIAL_LIBRARY_ROOT / "assets").resolve()
        if str(candidate).startswith(str(root)) and candidate.is_file():
            return candidate
    return None


def _read_image_source_bytes(image: str) -> tuple[bytes, str]:
    raw = str(image or "").strip()
    if raw.startswith("data:"):
        head, _, data = raw.partition(",")
        mime = head[5:].split(";")[0] or "image/png"
        if ";base64" in head:
            return base64.b64decode(data), mime
        return unquote(data).encode("utf-8"), mime
    local_path = _local_project_media_path(raw)
    if local_path:
        return local_path.read_bytes(), mimetypes.guess_type(str(local_path))[0] or "image/png"
    if raw.startswith(("http://", "https://")):
        parsed = urlparse(raw)
        if parsed.hostname in {"127.0.0.1", "localhost", "::1"}:
            local_path = _local_project_media_path(parsed.path)
            if local_path:
                return local_path.read_bytes(), mimetypes.guess_type(str(local_path))[0] or "image/png"
        response = REQUESTS_SESSION.get(raw, timeout=60)
        response.raise_for_status()
        mime = response.headers.get("Content-Type", "").split(";")[0].strip() or mimetypes.guess_type(parsed.path)[0] or "image/png"
        return response.content, mime
    candidate = Path(raw)
    if candidate.is_file():
        return candidate.read_bytes(), mimetypes.guess_type(str(candidate))[0] or "image/png"
    raise ValueError("Cannot read local image for Tencent COS upload.")


def _upload_image_source_to_cos(image: str, name: str = "") -> str:
    config = resolve_tencent_cos_config()
    data, mime = _read_image_source_bytes(image)
    ext = mimetypes.guess_extension(mime.split(";")[0].strip()) or Path(name).suffix or ".png"
    safe_stem = re.sub(r"[^a-zA-Z0-9._-]+", "-", Path(name or "seedance-face-review").stem).strip(".-") or "seedance-face-review"
    object_key = f"{config['prefix']}{datetime.utcnow().strftime('%Y%m%d')}/{safe_stem}-{uuid.uuid4().hex[:12]}{ext}"
    host = f"{config['bucket']}.cos.{config['region']}.myqcloud.com"
    upload_url = f"https://{host}{_cos_object_uri(object_key)}"
    auth = _cos_auth(config["secret_id"], config["secret_key"], "PUT", object_key, host, 600)
    response = REQUESTS_SESSION.put(
        upload_url,
        data=data,
        headers={
            "Authorization": auth,
            "Content-Type": mime,
        },
        timeout=120,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"Tencent COS upload failed: HTTP {response.status_code}: {response.text[:600]}")
    return _cos_signed_url(config, "GET", object_key)


def _is_public_http_url(url: str) -> bool:
    parsed = urlparse(str(url or "").strip())
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in {"http", "https"}:
        return False
    if host in {"localhost", "127.0.0.1", "::1"}:
        return False
    if host.startswith("127."):
        return False
    return True


def _kkai_upload_asset_url(url: str, asset_type: str = "Image", name: str = "") -> str:
    token = resolve_kkai_asset_token()
    if not token:
        raise ValueError(
            "Missing XUNKE_ASSET_TOKEN; XUNKE_API_KEY can be used if it has asset permission."
        )
    if not str(url or "").strip().startswith(("http://", "https://")):
        raise ValueError("Seedance face review requires a public http(s) image URL.")
    response = REQUESTS_SESSION.post(
        f"{resolve_kkai_asset_base_url()}/api/assets/upload",
        headers={
            "Authorization": _xunke_auth_header(token),
            "Content-Type": "application/json",
        },
        json={
            "URL": url,
            "AssetType": asset_type,
            "Name": name or Path(urlparse(url).path).name or asset_type.lower(),
        },
        timeout=60,
    )
    try:
        data = response.json()
    except ValueError:
        data = {"message": response.text[:800]}
    if response.status_code >= 400:
        raise RuntimeError(
            f"Xunke asset upload failed: HTTP {response.status_code}: {_kkai_error_message(data, response.text[:800])}"
        )
    if isinstance(data, dict) and data.get("code") not in (None, 0):
        raise RuntimeError(f"Xunke asset upload failed: {data.get('message') or data}")
    asset_id = _dig_first(data, [["Result", "Id"], ["Result", "id"], ["data", "Id"], ["data", "id"], ["Id"], ["id"]], "")
    if not asset_id:
        raise RuntimeError(f"Xunke asset upload succeeded but no Id was returned: {json.dumps(data, ensure_ascii=False)[:800]}")
    return _normalize_asset_id(asset_id)


def _kkai_get_asset(asset_id: str) -> dict:
    token = resolve_kkai_asset_token()
    if not token:
        raise ValueError(
            "Missing XUNKE_ASSET_TOKEN; XUNKE_API_KEY can be used if it has asset permission."
        )
    raw_id = str(asset_id or "").strip().replace("asset://", "")
    if not raw_id:
        raise ValueError("asset_id cannot be empty")
    response = REQUESTS_SESSION.post(
        f"{resolve_kkai_asset_base_url()}/api/assets/get",
        headers={
            "Authorization": _xunke_auth_header(token),
            "Content-Type": "application/json",
        },
        json={"Id": raw_id},
        timeout=30,
    )
    try:
        data = response.json()
    except ValueError:
        data = {"message": response.text[:800]}
    if response.status_code >= 400:
        raise RuntimeError(
            f"Xunke asset query failed: HTTP {response.status_code}: {_kkai_error_message(data, response.text[:800])}"
        )
    if isinstance(data, dict) and data.get("code") not in (None, 0):
        raise RuntimeError(f"Xunke asset query failed: {data.get('message') or data}")
    if isinstance(data, dict) and isinstance(data.get("Result"), dict):
        return data.get("Result")
    return data.get("data") if isinstance(data, dict) and isinstance(data.get("data"), dict) else {}


def review_seedance_face_asset(request_body: dict) -> dict:
    image = str(request_body.get("image") or request_body.get("url") or "").strip()
    name = str(request_body.get("name") or "seedance-face-review").strip()
    if not image:
        raise ValueError("image cannot be empty")

    if image.startswith("asset://"):
        asset_ref = image
    elif _is_public_http_url(image):
        asset_ref = _kkai_upload_asset_url(image, "Image", name)
    else:
        signed_url = _upload_image_source_to_cos(image, name)
        asset_ref = _kkai_upload_asset_url(signed_url, "Image", name)

    asset = _kkai_get_asset(asset_ref)
    status = str(asset.get("Status") or "Processing").strip() or "Processing"
    normalized = status.lower()
    if normalized == "active":
        review_status = "approved"
        message = "Review approved"
    elif normalized == "failed":
        review_status = "failed"
        message = "Review failed"
    else:
        review_status = "processing"
        message = "Review processing"

    return {
        "status": review_status,
        "asset_id": str(asset.get("Id") or asset_ref.replace("asset://", "")),
        "asset_ref": _normalize_asset_id(asset.get("Id") or asset_ref),
        "asset_status": status,
        "message": message,
        "updated_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }


def _build_kkai_video_payload(
    prompt: str,
    input_images: list,
    ratio: str,
    resolution: str,
    duration: int,
    ui_model: str,
    request_body: dict,
) -> dict:
    reference_images: list[str] = []
    for img in input_images:
        val = _normalize_kkai_media_ref(img)
        if val.startswith(("http://", "https://")) and _kkai_should_upload_public_refs():
            uploaded = _kkai_upload_asset_url(val, "Image")
            if uploaded:
                val = uploaded
        if val:
            reference_images.append(val)

    deduped_images: list[str] = []
    for val in reference_images:
        if val and val not in deduped_images:
            deduped_images.append(val)

    scenario = str(request_body.get("scenario") or "multimodal").strip().lower()
    reference_videos = _normalize_kkai_media_refs(
        request_body.get("reference_videos") or request_body.get("videos") or request_body.get("input_videos")
    )
    reference_audios = _normalize_kkai_media_refs(
        request_body.get("reference_audios") or request_body.get("audios") or request_body.get("input_audios")
    )
    first_frame_image = _normalize_kkai_media_ref(
        request_body.get("first_frame_image") or request_body.get("image") or (deduped_images[0] if deduped_images else "")
    )
    last_frame_image = _normalize_kkai_media_ref(
        request_body.get("last_frame_image") or (deduped_images[1] if len(deduped_images) > 1 else "")
    )

    resolution_l = str(resolution or "720p").strip().lower()
    duration_i = max(4, min(15, int(duration or 5)))
    force_vision_model = scenario in {"first_frame", "first_last_frame", "first-last-frame", "i2v_first", "i2v_first_last"}
    requested_model = str(
        request_body.get("seedance_model") or request_body.get("provider_model_hint") or ""
    ).strip()
    model = resolve_kkai_requested_video_model(requested_model, force_vision_model) or resolve_kkai_video_model(
        ui_model,
        resolution_l,
        duration_i,
        bool(deduped_images),
        force_vision_model,
    )

    ratio_s = str(ratio or "16:9").strip() or "16:9"
    metadata: dict = {
        "generate_audio": True,
        "ratio": ratio_s,
        "aspect_ratio": ratio_s,
        "duration": duration_i,
        "watermark": False,
        "resolution": resolution_l if resolution_l in {"480p", "720p", "1080p"} else "480p",
    }

    payload_images: list[str] = []

    if scenario in {"first_frame", "i2v_first"}:
        if not first_frame_image:
            raise ValueError("first_frame video generation requires image / first_frame_image")
        payload_images = [first_frame_image]
    elif scenario in {"first_last_frame", "first-last-frame", "i2v_first_last"}:
        if not first_frame_image or not last_frame_image:
            raise ValueError("first_last_frame video generation requires first_frame_image and last_frame_image")
        metadata["first_frame_image"] = first_frame_image
        metadata["last_frame_image"] = last_frame_image
    elif scenario == "edit":
        payload_images = deduped_images[:9]
    elif scenario == "extend":
        payload_images = deduped_images[:9]
    else:
        if deduped_images:
            payload_images = deduped_images[:9]

    payload: dict = {"model": model, "prompt": prompt, "metadata": metadata}
    if payload_images:
        payload["images"] = payload_images
    if reference_videos:
        payload["videos"] = reference_videos[:9]
    if reference_audios:
        payload["audios"] = reference_audios[:9]

    return payload


def submit_video_task_kkai(
    prompt: str,
    input_images: list,
    ratio: str,
    resolution: str,
    duration: int,
    ui_model: str,
    request_body: dict | None = None,
) -> dict:
    api_key = resolve_kkai_api_key()
    if not api_key:
        raise ValueError("Missing XUNKE_API_KEY")

    request_body = request_body or {}
    payload = _build_kkai_video_payload(prompt, input_images, ratio, resolution, duration, ui_model, request_body)
    response = REQUESTS_SESSION.post(
        resolve_kkai_video_endpoint(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "Accept": "*/*",
            "User-Agent": "Demiurge/1.0",
        },
        json=payload,
        timeout=45,
    )
    try:
        data = response.json()
    except ValueError:
        data = {"message": response.text[:800]}

    if response.status_code >= 400:
        raise RuntimeError(
            f"Submit Seedance 2.0 task failed: HTTP {response.status_code}: {_kkai_error_message(data, response.text[:800])}"
        )

    raw_task_id = _dig_first(data, [["id"], ["task_id"], ["data", "id"], ["data", "task_id"], ["data", "Id"]], "")
    if not raw_task_id:
        raise RuntimeError(f"Submit succeeded but no task id was returned: {json.dumps(data, ensure_ascii=False)[:800]}")
    raw_status = _dig_first(data, [["status"], ["task_status"], ["data", "status"], ["data", "Status"]], "pending")
    return {
        "task_id": f"xk:{raw_task_id}",
        "task_status": _kkai_status(raw_status),
        "provider": "xunke-seedance",
        "api_model": payload.get("model"),
    }


def _extract_kkai_video_url(data: dict) -> str:
    value = _dig_first(
        data,
        [
            ["video_url"],
            ["url"],
            ["output_url"],
            ["result_url"],
            ["content", "video_url"],
            ["result", "video_url"],
            ["data", "video_url"],
            ["data", "url"],
            ["data", "output_url"],
            ["data", "result_url"],
            ["data", "content", "video_url"],
            ["data", "result", "video_url"],
            ["data", "output", "video_url"],
            ["data", "output", 0, "url"],
            ["data", "outputs", 0, "url"],
            ["output", 0, "url"],
            ["outputs", 0, "url"],
        ],
        "",
    )
    if isinstance(value, list) and value:
        value = value[0]
    if isinstance(value, dict):
        value = value.get("url") or value.get("video_url") or ""
    return str(value or "").strip()


def query_video_task_kkai(raw_task_id: str) -> dict:
    api_key = resolve_kkai_api_key()
    if not api_key:
        raise ValueError("Missing XUNKE_API_KEY")

    response = REQUESTS_SESSION.get(
        f"{resolve_kkai_video_endpoint()}/{raw_task_id}",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Accept": "*/*",
            "User-Agent": "Demiurge/1.0",
        },
        timeout=45,
    )
    try:
        data = response.json()
    except ValueError:
        data = {"message": response.text[:800]}

    if response.status_code >= 400:
        raise RuntimeError(
            f"Query Seedance 2.0 task failed: HTTP {response.status_code}: {_kkai_error_message(data, response.text[:800])}"
        )

    raw_status = _dig_first(data, [["status"], ["task_status"], ["data", "status"], ["data", "Status"]], "")
    task_status = _kkai_status(raw_status)
    result: dict = {"task_status": task_status}

    if task_status == "SUCCEEDED":
        video_url = _extract_kkai_video_url(data)
        if not video_url:
            raise RuntimeError(f"Task succeeded but no video_url was returned: {json.dumps(data, ensure_ascii=False)[:800]}")
        result.update(_make_video_preview_result(video_url))
    elif task_status == "FAILED":
        result["error"] = _kkai_error_message(data, f"Seedance 2.0 generation failed: {raw_status}")

    return result


def submit_video_task_dashscope(
    prompt: str,
    input_images: list,
    resolution: str,
    duration: int,
) -> dict:
    """Submit a DashScope wan2.7-i2v task."""
    api_key = resolve_dashscope_api_key()
    if not api_key:
        raise ValueError("Missing DASHSCOPE_API_KEY")

    media: list[dict] = []
    frame_types = ["first_frame", "last_frame"]
    for i, img in enumerate(input_images[:2]):
        if img:
            media.append({"type": frame_types[i], "url": str(img).strip()})

    if not media:
        raise ValueError("wan2.7-i2v requires at least one reference image")

    payload = {
        "model": "wan2.7-i2v",
        "input": {
            "prompt": prompt,
            "media": media,
        },
        "parameters": {
            "resolution": resolution,
            "duration": duration,
            "prompt_extend": True,
            "watermark": False,
        },
    }

    response = REQUESTS_SESSION.post(
        DASHSCOPE_VIDEO_ENDPOINT,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "X-DashScope-Async": "enable",
        },
        json=payload,
        timeout=30,
    )
    if response.status_code >= 400:
        raise RuntimeError(
            f"Submit video task failed: HTTP {response.status_code}: {response.text[:600]}"
        )

    data = response.json()
    output = data.get("output") or {}
    raw_task_id = output.get("task_id") or ""
    task_status = str(output.get("task_status") or "PENDING").upper()

    return {"task_id": f"ds:{raw_task_id}", "task_status": task_status}


def query_video_task_dashscope(raw_task_id: str) -> dict:
    """Query a DashScope video task."""
    api_key = resolve_dashscope_api_key()
    if not api_key:
        raise ValueError("Missing DASHSCOPE_API_KEY")

    response = REQUESTS_SESSION.get(
        f"{DASHSCOPE_TASK_ENDPOINT}/{raw_task_id}",
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=30,
    )
    if response.status_code >= 400:
        raise RuntimeError(
            f"Query video task failed: HTTP {response.status_code}: {response.text[:600]}"
        )

    data = response.json()
    output = data.get("output") or {}
    task_status = str(output.get("task_status") or "").upper()

    result: dict = {"task_status": task_status}

    if task_status == "SUCCEEDED":
        video_url = output.get("video_url", "")
        if not video_url:
            raise RuntimeError("Task succeeded but no video_url was returned")
        result.update(_make_video_preview_result(video_url))

    elif task_status in ("FAILED", "CANCELED", "UNKNOWN"):
        result["error"] = output.get("message") or f"Video generation failed: {task_status}"

    return result


# Ark Seedance fallback when DashScope is unavailable

def submit_video_task_ark(
    prompt: str,
    input_images: list,
    ratio: str,
    resolution: str,
    duration: int,
    ui_model: str,
    provider_model_hint: str = "",
    request_body: dict | None = None,
) -> dict:
    """Submit a Volcengine Ark Seedance video task."""
    api_key = resolve_ark_api_key()
    if not api_key:
        raise ValueError("Missing ARK_API_KEY")

    request_body = request_body or {}
    subject = request_body.get("subject") if isinstance(request_body.get("subject"), dict) else {}
    subject_prompt = str(subject.get("prompt") or "").strip()
    if subject_prompt:
        prompt = f"{subject_prompt}\n\n{prompt}".strip()
    subject_request_fields = (
        subject.get("requestFields") if isinstance(subject.get("requestFields"), dict) else {}
    )
    subject_reference_image = str(subject.get("referenceImageUrl") or "").strip()
    if not input_images and subject_reference_image:
        input_images = [subject_reference_image]

    ark_model = resolve_ark_video_model(ui_model, provider_model_hint)
    task_endpoint = resolve_ark_video_tasks_endpoint()

    content: list[dict] = [{"type": "text", "text": prompt}]
    for img in input_images:
        val = str(img or "").strip()
        if val:
            content.append({"type": "image_url", "image_url": {"url": val}})

    payload: dict = {
        "model": ark_model,
        "content": content,
        "resolution": resolution.lower(),
        "ratio": ratio,
        "duration": duration,
        "watermark": bool(request_body.get("watermark", False)),
    }
    if request_body.get("generate_audio") is not None:
        payload["generate_audio"] = bool(request_body.get("generate_audio"))
    seed_raw = request_body.get("seed")
    if seed_raw not in (None, ""):
        try:
            payload["seed"] = int(seed_raw)
        except (TypeError, ValueError):
            raise ValueError("seed must be an integer")
    if subject_request_fields:
        payload.update(subject_request_fields)

    response = REQUESTS_SESSION.post(
        task_endpoint,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        json=payload,
        timeout=30,
    )
    if response.status_code >= 400:
        raise RuntimeError(
            f"Submit video task failed: HTTP {response.status_code}: {response.text[:600]}"
        )

    data = response.json()
    raw_task_id = data.get("id") or data.get("task_id") or ""
    raw_status = str(data.get("status") or "queued").lower()
    task_status = _ARK_STATUS_MAP.get(raw_status, raw_status.upper())

    return {"task_id": f"ark:{raw_task_id}", "task_status": task_status}


def query_video_task_ark(raw_task_id: str) -> dict:
    """Query an Ark Seedance video task."""
    api_key = resolve_ark_api_key()
    if not api_key:
        raise ValueError("Missing ARK_API_KEY")

    task_endpoint = resolve_ark_video_tasks_endpoint()
    response = REQUESTS_SESSION.get(
        f"{task_endpoint}/{raw_task_id}",
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=30,
    )
    if response.status_code >= 400:
        raise RuntimeError(
            f"Query video task failed: HTTP {response.status_code}: {response.text[:600]}"
        )

    data = response.json()
    raw_status = str(data.get("status") or "").lower()
    task_status = _ARK_STATUS_MAP.get(raw_status, raw_status.upper())
    result: dict = {"task_status": task_status}

    if task_status == "SUCCEEDED":
        video_url = (data.get("content") or {}).get("video_url", "")
        if not video_url:
            raise RuntimeError("任务成功但未返回 video_url")
        result.update(_make_video_preview_result(video_url))

    elif task_status == "FAILED":
        error_info = data.get("error") or {}
        msg = (
            error_info.get("message")
            if isinstance(error_info, dict)
            else str(error_info)
        ) or f"Video generation failed: {raw_status}"
        result["error"] = msg

    return result


# Unified entry points

def submit_video_task(request_body: dict) -> dict:
    """Submit a video task to the configured provider."""
    prompt = str(request_body.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("prompt 不能为空")

    ui_model = str(request_body.get("model") or "seedance-2.0").strip()
    ratio = str(request_body.get("ratio") or "16:9").strip()
    resolution = str(request_body.get("resolution") or "720P").strip()
    duration = int(request_body.get("duration") or 5)
    input_images: list = [i for i in (request_body.get("input_images") or []) if i]
    provider = resolve_video_provider(str(request_body.get("backend") or ""))

    if provider == "xunke_seedance":
        return submit_video_task_kkai(
            prompt,
            input_images,
            ratio,
            resolution,
            duration,
            ui_model,
            request_body,
        )

    if provider == "dashscope":
        if not resolve_dashscope_api_key():
            raise ValueError("当前视频通道被设置为 DashScope，但缺少 DASHSCOPE_API_KEY")
        return submit_video_task_dashscope(prompt, input_images, resolution, duration)

    return submit_video_task_ark(
        prompt,
        input_images,
        ratio,
        resolution,
        duration,
        ui_model,
        str(request_body.get("provider_model_hint") or ""),
        request_body,
    )


def query_video_task(task_id: str) -> dict:
    """Route a task id to the matching provider query function."""
    if task_id.startswith("kk:"):
        return query_video_task_kkai(task_id[3:])
    if task_id.startswith("xk:"):
        return query_video_task_kkai(task_id[3:])
    if task_id.startswith("ds:"):
        return query_video_task_dashscope(task_id[3:])
    if task_id.startswith("ark:"):
        return query_video_task_ark(task_id[4:])
    if resolve_video_provider() == "xunke_seedance":
        return query_video_task_kkai(task_id)
    if resolve_video_provider() == "dashscope":
        return query_video_task_dashscope(task_id)
    return query_video_task_ark(task_id)


def serve_video_file(handler: BaseHTTPRequestHandler, path_rest: str, head_only: bool = False) -> None:
    """Serve a generated video file from outputs or project assets."""
    segments = [s for s in path_rest.strip("/").split("/") if s]
    safe_name = Path(segments[-1]).name if segments else ""
    if not safe_name:
        send_json(handler, 404, {"error": "无效路径"})
        return

    if len(segments) == 2:
        slug, _fname = segments
        if re.fullmatch(r"[a-zA-Z0-9_-]{1,120}", slug):
            file_path = (PROJECTS_ROOT / slug / "assets" / safe_name).resolve()
            try:
                file_path.relative_to(PROJECTS_ROOT.resolve())
            except ValueError:
                send_json(handler, 404, {"error": "路径非法"})
                return
        else:
            file_path = OUTPUTS_DIR / safe_name
    else:
        file_path = OUTPUTS_DIR / safe_name

    if not file_path.exists():
        send_json(handler, 404, {"error": f"文件不存在：{safe_name}"})
        return

    content_type = mimetypes.guess_type(str(file_path))[0] or "video/mp4"
    file_size = file_path.stat().st_size
    range_header = handler.headers.get("Range", "")
    start = 0
    end = file_size - 1
    status = 200

    if range_header:
        match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
        if not match:
            handler.send_response(416)
            handler.send_header("Content-Range", f"bytes */{file_size}")
            handler.send_header("Accept-Ranges", "bytes")
            handler.end_headers()
            return

        start_raw, end_raw = match.groups()
        if start_raw == "" and end_raw == "":
            handler.send_response(416)
            handler.send_header("Content-Range", f"bytes */{file_size}")
            handler.send_header("Accept-Ranges", "bytes")
            handler.end_headers()
            return

        if start_raw == "":
            suffix_len = int(end_raw)
            if suffix_len <= 0:
                handler.send_response(416)
                handler.send_header("Content-Range", f"bytes */{file_size}")
                handler.send_header("Accept-Ranges", "bytes")
                handler.end_headers()
                return
            start = max(file_size - suffix_len, 0)
        else:
            start = int(start_raw)
            if end_raw:
                end = int(end_raw)

        end = min(end, file_size - 1)
        if start >= file_size or start > end:
            handler.send_response(416)
            handler.send_header("Content-Range", f"bytes */{file_size}")
            handler.send_header("Accept-Ranges", "bytes")
            handler.end_headers()
            return
        status = 206

    content_length = end - start + 1
    handler.send_response(status)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(content_length))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Accept-Ranges", "bytes")
    if status == 206:
        handler.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
    handler.end_headers()

    if head_only:
        return

    with open(file_path, "rb") as f:
        f.seek(start)
        remaining = content_length
        while remaining > 0:
            chunk = f.read(min(65536, remaining))
            if not chunk:
                break
            try:
                handler.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError):
                break
            remaining -= len(chunk)


# HTTP Handler

class ImageGenerateHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # suppress default access log noise
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def do_OPTIONS(self):
        send_json(self, 200, {"ok": True})

    def do_HEAD(self):
        tok = bind_outputs_from_request(self)
        try:
            path = normalize_http_path(self.path)
            if path.startswith("/api/video-file/"):
                rest = unquote(path[len("/api/video-file/"):])
                return serve_video_file(self, rest, head_only=True)
            self.send_response(404)
            self.end_headers()
        finally:
            reset_outputs_context(tok)

    def do_GET(self):
        tok = bind_outputs_from_request(self)
        try:
            path = normalize_http_path(self.path)

            if path == "/api/health":
                return send_json(
                    self,
                    200,
                    {
                        "ok": True,
                        "service": "python-media-generate-service",
                        "revision": MEDIA_SERVICE_REVISION,
                        "has_xunke_api_key": bool(resolve_kkai_api_key()),
                        "has_ark_api_key": bool(resolve_ark_api_key()),
                        "has_dashscope_api_key": bool(resolve_dashscope_api_key()),
                        "has_gemini_api_key": bool(resolve_gemini_api_key()),
                        "video_provider": resolve_video_provider(),
                    },
                )

            if path.startswith("/api/video-task/"):
                task_id = unquote(path[len("/api/video-task/"):])
                try:
                    return send_json(self, 200, query_video_task(task_id))
                except Exception as err:
                    return send_json(self, 500, {"error": str(err)})

            if path.startswith("/api/video-file/"):
                rest = unquote(path[len("/api/video-file/"):])
                return serve_video_file(self, rest)

            return send_json(self, 404, {"error": "Not found"})
        finally:
            reset_outputs_context(tok)

    def do_POST(self):
        tok = bind_outputs_from_request(self)
        try:
            path = normalize_http_path(self.path)
            if path == "/api/generate-image":
                return send_json(self, 200, route_image_generation(read_json_body(self)))
            if path == "/api/generate-video":
                return send_json(self, 200, submit_video_task(read_json_body(self)))
            if path == "/api/seedance-face-review":
                return send_json(self, 200, review_seedance_face_asset(read_json_body(self)))
            return send_json(self, 404, {"error": "Not found"})
        except Exception as error:
            return send_json(self, 500, {"error": str(error)})
        finally:
            reset_outputs_context(tok)


if __name__ == "__main__":
    server = ThreadingHTTPServer((PY_SERVICE_HOST, PY_SERVICE_PORT), ImageGenerateHandler)
    print(f"Python media generate service running at http://{PY_SERVICE_HOST}:{PY_SERVICE_PORT}")
    print(f"Image model routes: {list(IMAGE_MODEL_MAP.keys())}")
    print("Video model routes: ['seedance-2.0']")
    server.serve_forever()
