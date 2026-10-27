# Live2D 本機試演安裝

已完成 B1 獨立試演與 B2 角色綁定。完整批次見 [LIVE2D_PLAN.md](LIVE2D_PLAN.md)。

## 取得免費模型

建議先採用官方 SDK 內附的 **Haru**，同一個下載包可取得 Core、Framework 與可執行範例模型，不需要先購買模型或安裝 Cubism Editor。

- [官方免費模型頁](https://www.live2d.com/en/learn/sample/)
- [官方 Web SDK 下載](https://www.live2d.com/en/sdk/download/web/)
- [官方範例 GitHub](https://github.com/Live2D/CubismWebSamples)

GitHub 範例不含 Core；僅下載範例原始碼不足以顯示模型。不同模型有各自使用條件，請一併閱讀。

## 安裝

1. 自行開啟官方 SDK 下載頁，閱讀並同意條款，下載 **Cubism SDK for Web** 並解壓。
2. 找到包含以下檔案的 SDK 根目錄：

   ```text
   Core/live2dcubismcore.js
   Framework/src/live2dcubismframework.ts
   Samples/Resources/Haru/Haru.model3.json
   ```

3. 在本專案根目錄執行：

   ```powershell
   npm run live2d:prepare -- "C:\Downloads\CubismSdkForWeb"
   ```

   將引號內改成實際 SDK 目錄。指令不接受 zip 檔，請先解壓。它只讀取本機 SDK，不下載、不填 email、不代勾授權條款。

4. 開啟 app 頂端的「Live2D」，按「檢查本機安裝」，再按「載入試演」。如果是使用 `npm run preview`，請先重新執行 `npm run build`。

## 產出與範圍

```text
public/live2d/local/
├─ core/                 # 本機 SDK Core
├─ models/Haru/          # 官方模型包
├─ runtime/adapter.js    # 由本機 Framework 建置
├─ runtime/shaders/      # SDK 有提供時複製
└─ INSTALLATION.json
```

此目錄已加入 `.gitignore`，不要把產生的 Core 或模型包當成自有素材公開散布。準備指令採 staging 後才搬入目標，不會覆寫已存在的 local 目錄。若需更換 SDK，先保留／移走舊目錄再執行。

目前接入眨眼、呼吸、輕微晃動、姿勢可見性、模型物理資料、角色綁定與可選視線跟隨；表情映射、待機動作檔、嘴型留到後續批次。模型沒有相應參數／物理檔時會省略該效果。

## B2 角色綁定與保存

1. 開啟「角色與素材」，選擇角色，找到「角色呈現」。
2. 呈現模式選 `Live2D`，模型選 `Haru · 官方範例`。
3. 可調整縮放（0.5～3）、水平／垂直位置（-1～1），以及視線跟隨舞台游標。先按「預覽模型」確認效果，再按「保存變更」。
4. 關閉設定後主舞台會套用；刷新與重啟後保留綁定。原立繪作為載入中與載入失敗時的回退。
5. 回到靜態模式可保留模型選擇；要解除引用，將模型改為「未綁定」並保存。仍有角色引用時不能移除模型索引。

「本機模型索引」可登錄已完整放入 `public/live2d/local/models/` 的模型包：輸入名稱及 `/live2d/local/models/模型目錄/名稱.model3.json`。系統會檢查 moc3、PNG、物理與姿勢引用，拒絕離開模型包的路徑。移除只刪除 SQLite 索引，保留檔案，可重新登錄；ZIP／目錄匯入介面預計在 B5。

SQLite 使用 v4 資料表版本，工作區 JSON 格式仍為 v3；新增設定放在角色 `presentation`，模型索引獨立存於 `live2d_models`。舊角色遷移為靜態模式；舊視窗若遇保存衝突需刷新。

更新本專案後，可只重新編譯執行器，保留 Core 與模型：

```powershell
npm run live2d:prepare -- "G:\Workspace\AI_Character\CubismSdkForWeb-5-r.5" --runtime-only
```

此指令會確認 SDK Core 與已安裝版本相同，再更新執行器。更新後刷新瀏覽器；正式 preview 請再執行 `npm run build`。本次開發已代為完成執行器更新。

## 本機驗證紀錄（2026-10-19）

- SDK：`G:\Workspace\AI_Character\CubismSdkForWeb-5-r.5`；Core、Haru、著色器與執行器已準備。
- Haru 畫面與貼圖正常，姿勢檔已載入，互斥手臂不再重疊；前景試演顯示約 30 FPS。
- 已操作停止再載入、關閉再開啟；Canvas 會移除，重載可繼續顯示，瀏覽器未回報警告或錯誤。這是生命週期功能驗證，不代表已完成 GPU 記憶體分析。
- `npm test` 56 項與 `npm run build` 通過。長時間／同時 AI 生成的效能驗證留到 B5。

## 排錯

- 三項都未安裝：先執行準備指令；原聊天與靜態立繪可照常使用。
- Core 缺少：確認下載的是 Web SDK，且非僅 GitHub 範例。
- model3.json 缺少：檢查解壓目錄層級及 Haru 模型是否完整。
- 型別／moc3 不支援：Core 與 Framework 應來自同一份 SDK；不可混用下載來源。
- WebGL 失效：停止試演後重試；切換／關閉會清理已建立的模型資源。
- 畫面只顯示載入成功但沒有模型：先停止再重試；本機執行器已修正 Vite public 匯入與模型座標。更新 adapter 原始碼後需重新建置本機執行器，單純一般 build 不會重新編譯 SDK。
