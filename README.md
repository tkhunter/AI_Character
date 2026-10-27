# 栞 Shiori

Vue 3 + TypeScript + Vite 的 Galgame AI 對話服務，以 Node.js 本機後端串接既有 llama.cpp。

## 啟動

### 一鍵啟動（Windows）

雙擊專案根目錄的 `start.bat`：第一次會自動 `npm install`，之後依序執行正式編譯、啟動後端（`start:api`）與前端預覽（http://127.0.0.1:4173），就緒後自動開啟瀏覽器。已在執行的服務會直接沿用；連不到 llama.cpp 時只顯示提醒。要停止服務，關閉「Shiori API」與「Shiori UI」兩個視窗。

### 手動啟動

需要 Node.js 24 或更新版本。先啟動 llama.cpp（預設 http://127.0.0.1:8080，無 API key），然後：

```sh
npm install
npm run dev
```

開啟終端顯示的前端網址，預設 http://127.0.0.1:5173。`dev` 同時啟動前端與 http://127.0.0.1:3001 的 API；兩者只綁定本機迴圈位址。

如已在執行前端，可以另開終端執行 `npm run dev:api`；只開前端則使用 `npm run dev:ui`。不要在原 API 未關閉時重複啟動同一個 port。

自訂設定：將 `.env.example` 複製為 `.env`，調整 `LLAMA_BASE_URL`、`API_PORT`、`CONTEXT_LIMIT`、`DATABASE_PATH`（素材存放在資料庫同層的 `assets/`），以及選用的 `TTS_URL`、`MCP_SEARCH_URL`；修改後重新啟動服務。預設上下文上限 8192，並取 llama.cpp 實際回報上限與設定值的較小者；無法取得實際上限時使用保守的 4096。

```sh
npm test
npm run build
```

正式建置後可分別執行 `npm run start:api` 與 `npm run preview`。Preview 仍透過相同的 API 代理連接本機後端，不是單獨雙擊 dist/index.html。

## 已實作

### Phase 01 — 介面

- 雙欄舞台、條件展開第三欄、窄螢幕 CSS 抽屜。
- 新增、搜尋、切換對話與歷史閱讀。
- SVG 角色與 CSS 書店背景，台詞分頁、逐字播放、空白鍵繼續。
- 收藏、移除、來源跳轉、速度與門檻設定。

### Phase 02 — 真實本機 AI

- Node 原生 HTTP 後端與 llama.cpp `/v1/chat/completions` SSE 串流。
- `/api/status` 提供健康狀態與模型名稱，介面支援定期與手動重連。
- 前端中止請求會取消後端與上游生成；已收到的文字保留並可閱讀。
- 生成失敗或停止可重新生成；保留原嘗試於歷史，不重複新增使用者訊息。
- 台詞逐字播放與模型生成分離；串流新增文字不會重設已閱讀的文字或重排前面頁面。
- 生成上限 256/512/1024/2048，可與右欄觸發門檻分開設定。
- 使用角色 system prompt，透過 `/apply-template` + `/tokenize` 計算上下文，預留生成空間與 128 tokens 緩衝；超限時移除最舊完整回合。最新輸入本身太長時回傳明確錯誤。
- `/tokenize` 每約 700ms 計算可見台詞，完成後再次計數；不把 SSE 片段數當成 token，也不將 reasoning_content 當作台詞。模型 completion usage 另行顯示。
- tokenizer 不可用或停止／中斷時明確標示估算；停止後的估算不作為完整實際計數。
- 右欄超過門檻時自動展開一次；本次生成中手動關閉後不再自動打開。
- 未完成或失敗的 AI 嘗試不加入後續模型上下文；原始內容仍保留在畫面歷史。

字型可選擇性從 Google Fonts 載入，離線時使用系統字型。

### Phase 03 — 長文與收藏

- 每段對話各自保存本次開啟期間的草稿、台詞頁數、逐字閱讀位置、右欄來源及上下文資訊。
- 右欄台詞來源固定，中央開始新回覆或切換收藏分頁時不會換掉正在讀的內容。
- 背景長回覆或閱讀收藏時收到的長文只增加「長文待讀」提示；點擊提示才開啟，不強制跳走。
- 門檻採嚴格大於；調低門檻會檢查最新回覆，調高或最終計數校正會移除不適用的待讀提示。手動關閉過的回覆不反覆打開。
- 收藏顯示開場、完成、生成停止、失敗或達上限；部分內容明確標示，重試不覆寫舊收藏。
- 搜尋收藏文字／對話名稱，切換全部故事／目前對話範圍；來源跳轉關閉右欄以露出原始台詞。
- 右欄串流時只在讀者留在底部時跟隨；向上閱讀後提供「回到最新內容」按鈕。換來源從頂端開始。
- 分頁與逐字播放支援完整 emoji 字素；右欄分頁支援方向鍵、Home／End。

### Phase 04 — SQLite 保存、角色與素材

- 對話、收藏、草稿、閱讀進度與偏好自動保存於本機 SQLite（`data/shiori.sqlite`），重新開啟時還原；多視窗以 revision 防止互相覆寫。
- 舊版資料庫自動遷移，既有對話歸屬預設角色「澪」。
- 「角色與素材」視窗：新增／編輯角色名稱、副標、標籤、場景、開場台詞與 system prompt，選用立繪與背景；與指定角色開始新對話。
- 素材庫：上傳 PNG／JPEG／WebP／GIF（8 MB 以內），檔案存於 `data/assets/`；使用中的素材不能刪除。
- 生成時後端從資料庫讀取對話所屬角色的 system prompt。

### Phase 05 — 表情、語音、轉場、長期記憶

- 模型在回覆開頭標表情（8 種），後端在串流時拿掉標籤，舞台即時換表情；每個角色可為每種表情設定立繪。
- 換表情有淡入與彈跳，換場景有交叉淡入淡出；每段對話可以點舞台左上角的場景名稱切換背景。
- 「♪ 朗讀」使用瀏覽器內建語音，角色可設定聲音、語速、音高；設定 `TTS_URL` 後可以改用本機 TTS（後端 POST `{text, voice, speed}`，需回傳 `audio/*`）。
- 網路搜尋：後端以 MCP 連接本機 Brave Search MCP 服務（預設 `http://127.0.0.1:8081/mcp`，`MCP_SEARCH_URL` 設定、`off` 關閉），模型需要即時資訊時會自行搜尋，回覆附上來源。
- 台詞框取消分頁：整則回覆連續逐字播放，超出框高時跟著游標逐行往下捲；往上捲回去閱讀時暫停跟隨，捲回底部恢復。點擊文字、空白鍵或「顯示全部」可立即顯示整則。
- 長期記憶：每 8 則新訊息自動整理一次，也可以手動整理、新增、編輯、刪除；生成時帶入角色的 system prompt。

## 結構

- `src/App.vue`：介面組合。
- `src/composables/useChat.ts`：對話、串流、取消、重試、獨立閱讀狀態、待讀與收藏；可注入測試傳輸。
- `src/chat/model.ts`：資料型別、字素分頁與回覆狀態標籤。
- `src/components/DetailSidebar.vue`：右欄來源、收藏搜尋與串流跟隨。
- `src/components/CharacterManager.vue`：角色編輯、表情立繪、語音、素材庫與記憶。
- `src/components/ScenePicker.vue`：每段對話的場景切換。
- `src/chat/voice.ts`：瀏覽器語音與本機 TTS 播放。
- `src/chat/persistence.ts`：前端自動保存、重試與衝突處理。
- `server/app.ts`：API 驗證、SSE 轉發、取消與單一生成控制。
- `server/llama.ts`：模型轉接、角色提示、上下文與 token 計數。
- `server/storage.ts`：SQLite 結構遷移、工作區保存、角色與素材檔案。
- `shared/workspace.ts`、`shared/characters.ts`：保存資料驗證、角色預設與圖片格式判斷。
- `shared/sse.ts`：前後端共用串流解碼。
- `tests/stream.test.ts`：7 項本機假服務測試，驗證中斷、取消、上下文與計數。
- `tests/chat-state.test.ts`：10 項可控制串流的前端狀態回歸。
- `tests/storage.test.ts`：11 項 SQLite 保存、衝突與還原測試。
- `tests/characters.test.ts`：5 項遷移、角色、素材與角色 prompt 測試。
- `tests/p5.test.ts`：7 項表情、記憶、TTS 與場景測試；所有測試都不消耗模型推論。
- `docs/PROGRESS.md`：階段進度與驗證紀錄。

## llama.cpp 參考

實作依據 [llama.cpp server 官方說明](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)，並對本機服務實測 health、models、props、apply-template、tokenize 與 chat stream。

## 後續

下一步可考慮：GPT-SoVITS 等 TTS 轉接器、朗讀與逐字播放同步、記憶相關度檢索。


## Live2D 分批導入（B1／B2）

- 開發計畫：[docs/LIVE2D_PLAN.md](docs/LIVE2D_PLAN.md)
- 免費模型與安裝：[docs/LIVE2D_SETUP.md](docs/LIVE2D_SETUP.md)
- 頂端「Live2D」提供獨立試演與安裝檢查，不更換既有角色或改寫 SQLite。
- 自行從官方下載並解壓 Web SDK 後：`npm run live2d:prepare -- "SDK 根目錄"`。
- 指令使用本機 SDK 編譯適配器並準備 Haru；不下載 Core、不代替使用者同意條款。
- 產物在忽略版本控制的 `public/live2d/local/`；沒有安裝 SDK 仍可正常建置與聊天。
- 已以真實 SDK 與 Haru 驗證；在「角色與素材 → 角色呈現」切換 Live2D、選擇模型並保存，可設定縮放、位置與視線跟隨。
- SQLite v4 保存角色綁定及模型索引；舊角色預設保留靜態立繪。模型失敗回到原立繪，引用中的模型索引不能移除。
- 更新適配器：`npm run live2d:prepare -- "SDK 根目錄" --runtime-only`，保留 Core 與模型，更新後刷新頁面。
- 後續 B3 接表情／動作，B4 接語音嘴型，B5 接通用模型匯入。
