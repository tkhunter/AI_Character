# Kokoro-82M 本機語音

Shiori 使用 [hexgrad/Kokoro-82M-v1.1-zh](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh)（Apache-2.0）作為本機 TTS。服務只綁定 `127.0.0.1:8880`，由 Shiori 後端轉呼叫，不經過雲端。

## 組成

- `tts/.venv`：Python 3.11 專用環境（系統的 Python 3.14 尚未被 Kokoro 支援）。
- `tts/server.py`：本機服務。
  - `POST /tts {text, voice, speed}` 回傳 24 kHz WAV。
  - `GET /voices` 回傳聲音清單，`GET /health` 回傳服務狀態。
- `tts/hf-cache`：第一次啟動時下載的模型與聲音（約 330 MB）。
- `tts/start-tts.bat`：單獨啟動語音服務。`start.bat` 偵測到已安裝時也會自動啟動它。

`tts/.venv` 與 `tts/hf-cache` 不進版本控制。

## 安裝（已完成，重裝時參考）

```bat
uv venv tts\.venv --python 3.11
uv pip install --python tts\.venv\Scripts\python.exe torch --index-url https://download.pytorch.org/whl/cu128
uv pip install --python tts\.venv\Scripts\python.exe "kokoro>=0.9.4" "misaki[zh]>=0.9.4" opencc-python-reimplemented
```

- 預設使用 GPU（CUDA），約佔 1 GB 顯存。
- 要讓顯存留給 llama.cpp，改用 CPU：在 `tts\start-tts.bat` 加上 `set KOKORO_DEVICE=cpu`。生成會慢一些。

## 模型檔案

服務啟動時，若 `tts/models/Kokoro-82M-v1.1-zh/` 內有 `config.json`、`kokoro-v1_1-zh.pth`、`voices/*.pt`，就會完全離線載入；否則才嘗試從 Hugging Face 下載到 `tts/hf-cache`。

取得檔案的方式：

- 執行 `powershell -ExecutionPolicy Bypass -File tts\download-model.ps1`（約 330 MB；已下載的檔案會略過，可中斷後重跑）。
- 或在其他電腦從 https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh/tree/main 下載上述檔案，複製到 `tts\models\Kokoro-82M-v1.1-zh\`（`voices` 子資料夾保持原樣）。

> 2026-10-19 起初本機只有 IPv6 能連外，修好 IPv4 後已用 `download-model.ps1` 下載完成（105 個檔案，權重 312 MB）。當時記錄：本機只有 IPv6 能連外：中華電信連線的 IPv4 閘道為 `0.0.0.0`，1.1.1.1、8.8.8.8 都連不上。Hugging Face 的模型 CDN（`us.aws.cdn.hf.co`）只有 IPv4，所以模型無法下載。PyPI、PyTorch 套件支援 IPv6，因此已安裝完成。恢復 IPv4 連線後，重跑下載腳本即可。

## 接到 Shiori

1. `.env` 加入 `TTS_URL=http://127.0.0.1:8880/tts`，然後重新啟動 Shiori 後端（`npm run dev` 或 `start.bat`）。
2. 設定 → 語音引擎選「本機 TTS」。
3. 角色與素材 → 角色 → 語音 →「本機 TTS 聲音」，從清單選擇聲音：
   - `zf_` 開頭為女聲，`zm_` 開頭為男聲。
   - 語速滑桿會一起套用。
4. 本機 TTS 播放時，Live2D 角色會依實際音量開合嘴巴（「♪ 音訊嘴型」）。

## 處理方式

- 台詞會先轉成簡體，只用來決定讀音，畫面上的文字不變。
- 朗讀前會去掉網址、Markdown 符號、表情標籤與 emoji。
- 英文單字由英文 G2P 處理；第一次使用時會下載一個小型 spaCy 英文模型。下載失敗時會略過英文，中文照常朗讀。
- 一次處理一個請求；長回覆會整段生成完才開始播放。

## 實測（2026-10-19，RTX 3090，CUDA）

- 啟動：從 `tts/models` 離線載入，103 種聲音（中文女聲 55、男聲 45、英文 3），預設 `zf_001`。
- 速度：第一次請求含暖機約 3 秒；之後 2.6 秒音訊 0.14 秒、11.5 秒音訊 0.18 秒、48.5 秒音訊 0.97 秒。
- 混合文字：繁體中文夾英文與 emoji 可正常生成，表情標籤與 emoji 不會被念出。
- Shiori 介接：
  - 角色設定的「本機 TTS 聲音」選單列出全部聲音並能保存。
  - 朗讀依序顯示「… 準備中」→「■ 停止」，按下後約 1.2 秒開始播放，並顯示「♪ 音訊嘴型」。
- 修正：llama.cpp 未啟動時，`/api/status` 仍會回報 TTS 與搜尋是否可用，所以模型沒開也能朗讀舊台詞。

## 日常使用

- 雙擊 `start.bat`：偵測到 `tts\.venv` 就會自動在「Shiori TTS (Kokoro)」視窗啟動語音服務。
- 單獨啟動：`tts\start-tts.bat`。
- 停止：關閉「Shiori TTS (Kokoro)」視窗。

## 邊生成邊朗讀（2026-10-20）

設定 →「自動朗讀」選「邊生成邊朗讀」，並勾選「文字跟著語音顯示」（兩者預設開啟，需要本機 TTS）。

- **分句**（`src/chat/sentences.ts`）：
  - 模型吐字時依「。！？…」與換行切句，太短的片段（少於 6 字）併入下一句。
  - 第一段只要滿 8 字、遇到逗號就先送出，讓聲音更早開始。
  - 句子邊界剛好在已收到文字的最後一個字時先等下一段文字，避免把「……」或「。」」拆開。
  - 文字一個字都不會遺失或重排。
- **語音佇列**（`src/chat/voice.ts`）：
  - 每句一完成就向 Kokoro 要音訊，播放嚴格依照順序；前一句播放時，後面的句子已經在生成。
  - 空白行不念出來，但仍計入文字進度。
- **文字同步**：
  - 正在朗讀的那則回覆，文字顯示依「已念完的句子＋正在念的句子 × 播放進度」揭露，所以念到哪、字就出到哪。
  - 單位是句子，句內平均分配時間。
  - 語音失敗或中途停止時，自動改回固定速度顯示。
  - 第一句還在合成時，提示「澪準備開口…」。
- **停止與切換**：
  - 停止生成或按「■ 停止」會清空佇列並閉嘴。
  - 切到其他對話時，原對話的朗讀立即停止，背景生成照常但不再發聲。

實測（Haru／zf_003，llama.cpp 與 Kokoro 同時用 GPU）：
- 90 字回覆念了約 21 秒，文字以每秒約 4.3 字跟著語音出現，和聲音同時結束。
- 加入「第一段可在逗號斷開」後，送出到第一聲從 2.8 秒縮短為 2.0 秒，且在模型生成完（約 3 秒）之前就開始朗讀。
- 模型生成速度沒有明顯受影響（73 tokens 約 4 秒內完成）。
- 生成中切到其他對話時，朗讀停止，背景生成繼續。
