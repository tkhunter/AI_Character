"""Local Kokoro-82M (v1.1-zh) TTS service for Shiori.

POST /tts     {"text": str, "voice": str, "speed": float} -> audio/wav (24 kHz, 16-bit mono)
GET  /voices  -> {"voices": [{"id", "label"}], "default": str}
GET  /health  -> {"status", "device", "repo"}

Binds to 127.0.0.1 only. The Shiori backend calls it server-side; browsers on other origins are refused.
"""
from __future__ import annotations

import io
import json
import os
import re
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
os.environ.setdefault("HF_HOME", str(ROOT / "hf-cache"))
# The Xet transfer backend is not reachable on every network; plain HTTPS from huggingface.co is.
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

import numpy as np  # noqa: E402
import torch  # noqa: E402
from huggingface_hub import snapshot_download  # noqa: E402
from kokoro import KModel, KPipeline  # noqa: E402

REPO_ID = "hexgrad/Kokoro-82M-v1.1-zh"
SAMPLE_RATE = 24000
HOST, PORT = "127.0.0.1", int(os.environ.get("KOKORO_PORT", "8880"))
DEFAULT_VOICE = os.environ.get("KOKORO_VOICE", "zf_001")
MAX_CHARS = 4000


def log(message: str) -> None:
    print(f"[kokoro] {message}", flush=True)


def pick_device() -> str:
    wanted = os.environ.get("KOKORO_DEVICE", "").strip().lower()
    if wanted in ("cpu", "cuda"):
        return wanted if wanted == "cpu" or torch.cuda.is_available() else "cpu"
    return "cuda" if torch.cuda.is_available() else "cpu"


# Prefer a local copy (tts/models/Kokoro-82M-v1.1-zh: config.json, *.pth, voices/*.pt), e.g. fetched by
# download-model.ps1 or copied from another machine; then nothing is downloaded at all.
LOCAL = ROOT / "models" / "Kokoro-82M-v1.1-zh"
if (LOCAL / "config.json").is_file() and any(LOCAL.glob("*.pth")) and any((LOCAL / "voices").glob("*.pt")):
    os.environ["HF_HUB_OFFLINE"] = "1"
    snapshot = LOCAL
    log(f"using local model files in {LOCAL}")
else:
    log(f"downloading/locating {REPO_ID} (first run only)…")
    snapshot = Path(snapshot_download(REPO_ID, allow_patterns=["config.json", "*.pth", "voices/*.pt"]))
VOICE_FILES = {p.stem: str(p) for p in (snapshot / "voices").glob("*.pt")}
# Chinese female, then Chinese male voices first; the few English voices last.
VOICES = sorted(VOICE_FILES, key=lambda v: ({"zf": 0, "zm": 1}.get(v[:2], 2), v))
if DEFAULT_VOICE not in VOICES and VOICES:
    DEFAULT_VOICE = next((v for v in VOICES if v.startswith("zf_")), VOICES[0])
DEVICE = pick_device()
log(f"loading model on {DEVICE}…")
MODEL = KModel(repo_id=REPO_ID, config=str(snapshot / "config.json"), model=str(next(snapshot.glob("*.pth")))).to(DEVICE).eval()

# English words inside Chinese replies are phonemised by the English G2P; if it cannot load
# (it fetches a small spaCy model on first use), English is simply skipped rather than failing.
try:
    _en = KPipeline(lang_code="a", repo_id=REPO_ID, model=False)

    def en_callable(text: str) -> str:
        return next(_en(text)).phonemes
except Exception as error:  # pragma: no cover - depends on optional download
    log(f"English G2P unavailable ({error}); English words will be skipped.")
    en_callable = None

ZH = KPipeline(lang_code="z", repo_id=REPO_ID, model=MODEL, en_callable=en_callable)

# Kokoro's Chinese G2P is built on simplified text; convert for pronunciation only.
try:
    from opencc import OpenCC

    _t2s = OpenCC("t2s")

    def to_simplified(text: str) -> str:
        return _t2s.convert(text)
except Exception:  # pragma: no cover
    def to_simplified(text: str) -> str:
        return text

EMOJI = re.compile("[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0000FE0F\U0000200D]")


def clean(text: str) -> str:
    """Strip things that should not be read aloud: URLs, markdown marks, emoji, stray tags."""
    text = re.sub(r"https?://\S+", "", text)
    text = re.sub(r"\[(?:表情[:：])?[^\]\n]{1,12}\]", "", text)
    text = re.sub(r"[*_`#>~|]+", "", text)
    text = EMOJI.sub("", text)
    text = re.sub(r"[ \t]+", " ", text)
    return re.sub(r"\n{2,}", "\n", text).strip()


def speed_for(base: float):
    """Model-card pacing: long sentences slightly slower, scaled by the character's speed."""
    def callable_(len_ps: int) -> float:
        speed = 0.8
        if len_ps <= 83:
            speed = 1.0
        elif len_ps < 183:
            speed = 1.0 - (len_ps - 83) / 500
        return speed * 1.1 * base
    return callable_


LOCK = threading.Lock()


def synthesize(text: str, voice: str, speed: float) -> bytes:
    chunks: list[np.ndarray] = []
    with LOCK, torch.inference_mode():
        for result in ZH(to_simplified(text), voice=VOICE_FILES[voice], speed=speed_for(speed)):
            if result.audio is not None:
                chunks.append(result.audio.detach().cpu().numpy())
                chunks.append(np.zeros(int(SAMPLE_RATE * 0.12), dtype=np.float32))  # short pause between sentences
    if not chunks:
        raise ValueError("沒有可朗讀的內容。")
    audio = np.clip(np.concatenate(chunks), -1.0, 1.0)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(SAMPLE_RATE)
        out.writeframes((audio * 32767).astype("<i2").tobytes())
    return buffer.getvalue()


def label(voice: str) -> str:
    kind = {"zf": "中文女聲", "zm": "中文男聲", "af": "英文女聲", "am": "英文男聲", "bf": "英式女聲", "bm": "英式男聲"}.get(voice[:2], "聲音")
    return f"{kind} {voice[3:]}"


class Handler(BaseHTTPRequestHandler):
    server_version = "ShioriKokoro/1.0"

    def log_message(self, format: str, *args) -> None:  # quieter default logging
        pass

    def send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def json(self, status: int, value: object) -> None:
        self.send(status, json.dumps(value, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def refused(self) -> bool:
        origin = self.headers.get("Origin")
        if origin and not re.match(r"^http://(127\.0\.0\.1|localhost)(:\d+)?$", origin):
            self.json(403, {"error": "不允許此來源。"})
            return True
        return False

    def do_GET(self) -> None:
        if self.refused():
            return
        if self.path == "/health":
            self.json(200, {"status": "ok", "device": DEVICE, "repo": REPO_ID, "voices": len(VOICES)})
        elif self.path == "/voices":
            self.json(200, {"default": DEFAULT_VOICE, "voices": [{"id": v, "label": label(v)} for v in VOICES]})
        else:
            self.json(404, {"error": "找不到此路徑。"})

    def do_POST(self) -> None:
        if self.refused():
            return
        if self.path != "/tts":
            self.json(404, {"error": "找不到此路徑。"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 64 * 1024:
                raise ValueError("請求內容大小不正確。")
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            text = clean(str(body.get("text", "")))[:MAX_CHARS]
            voice = str(body.get("voice") or DEFAULT_VOICE)
            speed = float(body.get("speed") or 1.0)
            if not text:
                raise ValueError("沒有可朗讀的內容。")
            if voice not in VOICES:
                raise ValueError(f"沒有這個聲音：{voice}")
            if not 0.5 <= speed <= 2.0:
                raise ValueError("語速須介於 0.5 到 2。")
        except (ValueError, json.JSONDecodeError) as error:
            self.json(400, {"error": str(error)})
            return
        started = time.perf_counter()
        try:
            audio = synthesize(text, voice, speed)
        except Exception as error:
            log(f"synthesis failed: {error}")
            self.json(500, {"error": "語音生成失敗。"})
            return
        log(f"{voice} {len(text)} chars -> {len(audio) / 2 / SAMPLE_RATE:.1f}s audio in {time.perf_counter() - started:.2f}s")
        self.send(200, audio, "audio/wav")


if __name__ == "__main__":
    log(f"ready on http://{HOST}:{PORT}  device={DEVICE}  voices={len(VOICES)}  default={DEFAULT_VOICE}")
    try:
        ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)
