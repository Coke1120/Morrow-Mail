# Morrow Mail — Rust 核心與原生平台封裝遷移計畫

日期：2026-09-28

狀態：遷移方向與 review 修訂已核准；各階段的實作、平台驗收及發佈門檻仍須逐項完成。

2026-09-28 候選實作進度（`codex/native-migration`，尚未切換正式 Windows 產品）：

- N1：共用草稿準備已移至 Rust；catalog／OpenCC 來源固定、5,343 筆正規化 golden 與授權內容比對通過。
- N2／N3：WinUI host、原生功能頁與隔離 HTML reader 已落盤並通過編譯。CI 已通過啟動、Fresh onboarding、重複關窗的服務排空保護、視窗精確還原、前景操作 guard、owned-mailbox 分頁、草稿、工作頁與 Settings。初始及攻擊文件的完全比對導覽、inline script 阻擋，以及停用腳本時的 native CSP 觀測均已通過。CI 36354783178 確認目前失敗是純文字 TextBlock 弱參照失效；候選修正保留可見頁面的 label 並在卸載時釋放，仍待 runtime 驗證。完整 reader／walkthrough 尚未通過，不能以編譯或啟動代替驗收。
- N4：新 Node-free macOS candidate 經固定 beta.16 舊 installer 實際升級／啟動及備份通過，包括 Scheduled、Pending、Learning、Reply Suggestions 與中斷 claim 不重播。Windows 尚待 runtime／upgrade gate。
- N6：macOS／Windows 的 Node-inaccessible Rust fmt／Clippy／tests 已通過；新版 macOS canonical ZIP／checksum、Models、HTML／network-zero、視窗與 Rust native integration 已在 macOS 15 通過。Rust resources／notices／macOS builder／native acceptance driver 已驗證無 Node 路徑；Rust benchmark 的 1k smoke 通過。共用 assets 與 production 公鑰已解除對 React／Node 來源目錄的依賴。新 publisher 已補上同 run artifact 來源綁定，七項 focused checks 與真實 GitHub ZIP 唯讀解析通過；尚未接正式發佈。
- N5 與所有乾淨最低 OS／IME／Narrator／DPI／真實 provider／正式簽章門檻保持未完成。既有 Electron／Node 相容路徑與發佈資產沒有刪除或替換。

逐次證據與限制以 [VERIFICATION](../VERIFICATION.md) 為準；上述進度不是所有 gate 已完成的宣告。

## 1. 目標與決策

目標是 **Rust 負責全部共用業務邏輯，macOS 使用 SwiftUI，Windows 使用 WinUI 3／C++/WinRT 原生封裝**。Windows 原生化是本計畫必要階段，不再只是效能不足時的候選方案。

「Rust only」在本計畫中的具體意思：

- 郵件、同步、SQLite、搜尋、AI、OAuth、權限、排程、備份與更新驗證只有一份 Rust 實作。
- Swift／C++ 只處理原生 UI、呈現狀態、輸入、無障礙、系統 API 及 Rust service 的啟停與通訊。
- 最終產品不包含 Electron、React、Node.js runtime 或 JavaScript 業務服務。
- 正常開發、建置、測試及發佈最終不需要 Node.js。歷史 Node 相容性驗收可暫時保留於隔離 CI，退場條件另行列明。
- 不追求把 SwiftUI／WinUI 控制項也重寫成 Rust。郵件 HTML 閱讀仍可使用系統 WebKit／WebView2；這不是把整個介面改回 Web App，也不表示允許郵件執行 JavaScript。

本文件接續 [原 Rust 遷移計畫](RUST_MIGRATION_PLAN.md)。原計畫記錄的 M0–M5 實作與歷史驗收保留；未執行的 M6「React／Tauri」方向由本計畫取代。**不安排 Electron → Tauri → WinUI 的兩次介面遷移。**

本次修訂更新計畫與來源盤點；不改動產品、發佈流程或使用者工作區。盤點基準為已發佈的 `v0.6.0-beta.16`（`7ab30cbb3e496118513a98f8211ec66481e282c4`）；既有雙平台證據見 [VERIFICATION](../VERIFICATION.md)。該版本仍是 SwiftUI／Electron＋Rust，不是 WinUI 驗收結果。

## 2. 現況與剩餘工作

以下是程式結構盤點，不是全功能已達穩定版標準的宣告。

| 部分 | 現況 | 目標與處置 |
| --- | --- | --- |
| 共用核心 | `rust/src/` 已有 service、providers、資料層、AI、搜尋及 updater | 沿用；補足差異，不重新移植一次 |
| macOS | `macos/Sources/MorrowMail/` 原生 SwiftUI＋Rust service | 保留；移走剩餘共用業務判斷，保留平台互動 |
| Windows | `src/` React＋`desktop/` Electron＋Rust service | 以 WinUI 3／C++/WinRT 取代 React／Electron |
| 相容後端 | `server/`；開發入口仍可啟動 Node service | 遷移 caller、測試及備份工具後退役 |
| 開發工具 | `scripts/dev.js` 啟動 Node service 與 Vite | 改為啟動 Rust service 及原生 client；React 過渡期間保留既有開發路徑 |
| 產生資源 | `scripts/rust-resources.js` 依賴 `shared/features.js`、`server/demo.js`、OpenCC npm 資料 | 拆除對舊服務的隱性依賴；版本化靜態資料與 Rust 產生／檢查工具 |
| 測試 | Rust、Node、Swift 與跨語言相容性 harness | 核心測試以 Rust 為主，UI 以平台測試為主；保留必要歷史相容驗收 |
| 打包／發佈 | Node scripts；`package.json` 是共同版本來源 | 最後遷移 orchestration；共同版本來源與更新契約保持相容 |

刪除 `server/` 前必須追蹤所有 import、工具、fixture 與 CI caller。不能只看桌面包已經沒有 Node，就假設整個 repository 已無依賴。

## 3. 最終架構與責任邊界

```text
macOS：SwiftUI / AppKit host ─────┐
                               ├─ 私有 loopback API ─ Rust service ─ SQLite
Windows：WinUI 3 / C++/WinRT host ┘                              └─ 郵件 / 日曆 / AI

郵件閱讀器：系統 WebKit / WebView2；僅顯示 Rust 淨化後的 HTML，無業務 bridge
```

維持現有獨立 Rust service，沿用私有 stdin bootstrap、隨機 bearer、host-only update token、loopback／Host／Origin 驗證及 parent／EOF 關閉機制。**獨立程序仍然符合 Rust-only 核心，不需要改成 FFI 才算完成。**

| Rust 必須擁有 | 平台封裝可以擁有 |
| --- | --- |
| 帳戶 owner、權限、provider 操作與可重試條件 | 視窗、選取、焦點、佈局及未儲存編輯狀態 |
| 資料庫、加密、migration、備份、鎖與 durable operation 記錄 | 原生檔案選擇器、外部瀏覽器、通知、Dock／工作列整合 |
| 收件人正規化、Reply All／Forward 草稿規則、寄件 fingerprint | 顯示及編輯草稿、確認畫面、鍵盤／IME／無障礙 |
| AI context、預算、撤權失效、學習與索引狀態機 | 顯示進度與錯誤、操作取消；不得推測後端進度 |
| HTML sanitizer、連結／圖片政策的可共用判斷 | 實際攔截 WebView 請求、導覽與權限；每封郵件圖片同意 |
| 更新來源、簽章、下載、安裝準備與結果 | 未儲存工作確認、交接退出、平台程序啟動 |

封裝層不得直接寫 SQLite、重做 provider retry，或以 UI 隱藏取代 server 授權。帳戶與 Model 表單可暫存使用者剛輸入的密碼／API key，經已驗證的私有 API 提交；不得持久化、記錄、回讀已儲存的秘密或交給郵件 WebView。儲存成功、捨棄或關閉表單後釋放輸入狀態；不宣稱 Swift／C++ 字串副本可保證記憶體清零。加密保存、OAuth token 與 refresh 仍由 Rust 管理。Host 啟動時持有的 service bearer／update token 是獨立的通訊憑證，不是 provider secrets。UI 可做即時輸入提示，Rust 仍須獨立驗證所有輸入。

先沿用現有一個 Cargo package 與 `lib.rs`；不預先建立通用插件、跨平台 widget framework 或另一套 command backend。直接嵌入 Rust library／FFI 不在本計畫必要路徑，只有 IPC 量測證明需要時才另開設計。

## 4. 分階段執行

所有階段均未因本文件建立而視為完成。依序交付可驗證的小改動，先建立替代路徑，再移除舊路徑。

### N0 — 凍結行為清單與量測基準

工作：

- 以 [功能清單](../FEATURE_COVERAGE.md)、[Rust 相容性清單](RUST_MIGRATION_INVENTORY.md) 及現有實際操作盤點路由、設定、CLI、UI 與持久資料。
- 每個功能記錄 Rust 實作位置、兩端 caller、驗收方法及已知限制；區分原生必備功能與現有不支援功能。
- 以更新後的 [功能與 caller 矩陣](RUST_MIGRATION_INVENTORY.md#native-migration-parity-matrix) 作起點；已存在的測試不能代替新 WinUI client 的實際驗收，整個 N0 尚未因文件盤點而完成。
- 用隔離 workspace 建立 1k／10k／50k 郵件、重複 provider ID、離線帳戶、草稿及未確認寄件的固定資料集。
- 固定 release binary hash、OS、硬體及依賴版本，分開量測 service 和整個 App 的程序樹。
- 保留舊 Electron 版的可重現 build／tag，作 Windows 行為與升級對照；不要依賴持續改動的 main。

完成門檻：

- [ ] 行為／資料／caller 清單可逐項追蹤，沒有把現存功能當成重寫時可略過的項目。
- [ ] macOS 與 Windows 各有基準；啟動、記憶體、搜尋、閱讀及索引中互動都有明確測法。
- [ ] 設定可接受的效能回歸範圍後才比較新實作，不在看完結果後改門檻。

### N1 — 共用業務邏輯只留 Rust

2026-09-28 首批實作（未發佈）：新增 `POST /api/drafts/prepare`，Rust 從指定 owner 的原郵件建立 Reply／Reply All／Forward／provider draft copy，兩個 client 與 AI 結果插入改用此 API。保留本機草稿解碼、表單及過時回應保護；Node 相容 service 暫留同契約。此批不代表 N1 全部完成，catalog／工具依賴與 Windows host 仍依後續門檻處理。

此批已通過 21 組共用行為案例、Rust HTTP／Clippy、45 項相關 Node／React 檢查、React build、完整 macOS checks 及 SwiftUI＋Rust harness；範圍與限制見 [VERIFICATION](../VERIFICATION.md)。

工作：

- 審查 Swift／React 中的收件人、草稿建立、帳戶選擇、索引資格、學習啟動及 workflow 規則；區分 UI 呈現與真正業務判斷。
- 從 [已核對的 N1 清單](RUST_MIGRATION_INVENTORY.md#n1-shared-logic-audit) 逐項處理；已有 Rust 授權的表單提示不另造狀態機，日期呈現、確認畫面與舊回應淘汰仍留在 client。
- 優先重用 Rust 現有函式與 API。只有缺少共用操作時才擴充窄 API，並同時更新既有 caller。
- 明確固定 account、viewId、cursor、錯誤碼、operation ID 及部分設定更新契約，保留帳戶切換時淘汰舊回應的 UI 保護。
- 把有效業務測試移到 Rust；跨 client 仍需要的少量端到端測試保留，避免只是刪除 Node 測試以取得綠燈。
- 將 catalog／fixture 資料與 Node service 解耦。現有資源先保持值與版本相同，不順便改 policy 預設或搜尋正規化。

完成門檻：

- [ ] 相同行為由同一 Rust 實作決定；兩個原生 host 不需要複製規則。
- [ ] 多帳戶隔離、Bcc、Reply All／Forward、provider draft 複製、未確認寄件及設定 field diff 契約通過。
- [ ] 所有敏感操作在 server 端驗權；舊 UI 可繼續使用過渡版本。

### N2 — Windows 原生 host 與第一條完整讀取路徑

部署決策：第一版採 **unpackaged、Windows x64、self-contained Windows App SDK**，沿用 ZIP 更新；不在本次切換導入 MSIX 或依賴 updater 安裝 framework。保留 archive root `Morrow Mail-win32-x64`、`Morrow Mail.exe`、`resources/app/backend/package.json` 與 `resources/app/runtime/morrow-service.exe` 相容路徑；保留目錄契約不代表保留 Electron。

開始 N2 實作前鎖定 SDK／C++ toolchain 版本及最低 Windows 版本，列清 Windows App SDK、VC++ runtime 與 WebView2 各自的部署／授權需求。App SDK self-contained 不代表包含 WebView2：首版缺少或無法初始化 WebView2 時使用 plain text，核心操作不得依賴啟動時下載 runtime。需要完整離線 HTML reader 時，先決定受支援的 WebView2 redistribution，再驗證打包；不得默默提高最低 OS。既有 updater 只替換目錄及啟動 EXE，不能當成 MSIX registration 或 runtime installer。

工作：

- 新增獨立 Windows 原生專案，採 WinUI 3／C++/WinRT；不把 Rust 核心搬進 C++。
- 實作 single-instance、沿用既有 workspace、啟動 Rust、私有 pipe、健康檢查、退出等待及 crash recovery。保留 `org.morrowmail.desktop` identity 及既有 userData 路徑；驗證新 WinUI 與舊 Electron 同時啟動時的拒絕／交接，不能只依賴新 framework 自己的 single-instance。重用現有 service bootstrap 與 writer lock，不引入第二個寫入程序。
- 完成 Add account 起始畫面、帳戶／資料夾導覽、分頁清單及完整郵件讀取。Demo 維持隱藏，fixture 使用虛構已連接帳戶。
- 清單採原生 virtualization；保留選取、捲動、manual unread、六種排序、跨帳戶重複 ID 及慢回應淘汰。
- 原生閱讀器使用隔離 WebView2，提供 plain-text fallback。測試 WebView2 runtime 缺少、初始化失敗及離線部署。
- 使用獨立候選輸出與 fixture workspace；候選 host 不與舊 host 同時開啟同一 SQLite。

完成門檻：

- [ ] Windows 真實 packaged executable 能啟動、讀信、關閉與重啟；Rust service 無遺留程序或雙 writer。
- [ ] 在無 Visual Studio／Windows App SDK、離線、一般使用者權限的乾淨支援版本 Windows 驗證首次啟動及舊版升級；WebView2 缺少時仍可讀取純文字。所需 native runtime 不依賴開發機預裝內容。
- [ ] 清單切換不整頁閃爍／重載，owner 與 viewId 一致，正文按需載入。
- [ ] 郵件腳本、frames、forms、host objects、web messages、未同意的外部請求均無法越過 reader 邊界。
- [ ] 中文 IME、鍵盤導覽、Narrator、高對比、DPI／縮放與文字選取完成第一輪實機驗證。

### N3 — Windows 全功能對等與 macOS 收斂

依操作路徑逐批完成，不一次重寫所有畫面：

1. 寫信、儲存草稿、Reply／Reply All／Forward、From owner、To／Cc／Bcc、關閉確認與未確認寄件恢復。
2. Scheduled：凍結 owner／收件人／footer／headers／時間、相同 UUID 重試、草稿鎖、取消及重新排程；App 開啟才寄、15 分鐘 late grace，missed／blocked／uncertain 與中斷後不自動重寄。
3. Google／Microsoft／IMAP／SMTP（含 Yahoo HK preset）連線、系統瀏覽器 OAuth、refresh、斷線、重新連線、全部歷史與排除範圍、checkpoint／bounded retry／Activity。
4. Pending 的本機標記、跨帳戶計數／清單／清除、匯入保留；Today 的既有摘要、帳戶導覽與空狀態，不因開頁啟動 AI。
5. 搜尋、篩選、分頁、embedding 連線測試、review／run／pause／resume／cancel 與預算；離開設定頁仍可在背景執行。
6. 郵件 AI popup／Suggest with History、workflow、Email Brain、Learn Now proposal／explicit apply；逐帳戶確認 identity，不能從簽名推斷姓名。Reply Suggestions 的預覽／費用確認／背景批次／取消／來源撤權失效／使用為草稿，不能自動寄出。
7. Out of Office 的 provider capability、額外 OAuth consent、讀取與明確確認寫入；保留錯 owner／部分授權／過期授權拒絕，不宣稱 IMAP／Yahoo 支援。
8. 日曆月曆、checkbox 可見範圍、跨日／exclusive all-day end、讀取唯讀日曆；建立與 provider reminder review、原 request ID／payload 的失敗與重啟恢復。
9. 設定自動儲存、主題、佈局、擴大閱讀區、Spam／Junk provider move、備份、每小時更新檢查／徽章與需確認的安裝、系統整合。

每批沿用 Rust 的完整授權及操作狀態。macOS 保留 SwiftUI，只替換 N1 識別出的重複業務判斷；原生控制項和平台互動不為了語言比例而重寫。

完成門檻：

- [ ] N0 功能矩陣逐項通過，缺失功能不能以隱藏入口冒充對等。
- [ ] 草稿／設定在取消、切換帳戶、關窗與重啟時符合既有保存規則。
- [ ] 已有 provider 限制維持如實呈現；附件、CID、phishing report、sender block 等未實作能力不宣稱已支援。
- [ ] macOS 原生 integration 與 Windows 原生 packaged walkthrough 同時通過。

### N4 — 資料、安裝、更新與回退驗收

工作：

- 新 Windows host 明確沿用既有 workspace 與應用程式 identity；不採 framework 預設位置另建空 workspace。
- 盤點並保留 SQLite、encryption key、`pending-calendar.json`、`client-state.json`、window state 及其他已識別的復原資料。
- 對 client-state 逐原 key 保留使用者內容；新 UI 可增加自身顯示設定，不可覆蓋原 pending-calendar review／requestId。
- 升級 fixture 同時保留 `scheduledSends`、草稿 `scheduledSend` marker、`deliveryAttempts`、訊息 `pending`、逐帳戶 `styleLearning` identity／proposal／approved profile 及 `replySuggestions`。已 claim 的寄件／model 工作沿用中斷恢復規則，啟動不得自動重播。排程驗收用遠期時間或隔離傳輸，不能因升級測試產生真實寄件。
- 先驗證舊 updater 對 archive root、exe 名稱、`resources/app/backend/package.json` 及 runtime 路徑的假設。必要時保留相容 layout，不因改用 WinUI 直接改名。
- 沿用 pinned signing key、簽署 manifest、host-only token、雙 PID 等待及 retained previous app。不能改用另一套 framework updater 跳過原 trust chain。
- 實際演練舊 Node/Electron → Rust/Electron → Rust/WinUI，以及目前可支援的直接升級路徑；舊 API URL 等既有限制另行披露。

完成門檻：

- [ ] 真正的候選 App 升級與重啟成功，不僅是 generated fixture 成功。
- [ ] credentials 可解密；owner、完整草稿、deliveryAttempts、Bcc、Scheduled／Pending／Learning／Reply Suggestions、calendar retry 與備份還原均逐記錄驗證；Out of Office 仍由 provider 保存，升級不得觸發寫入。
- [ ] installer 等待 host／service 關閉，遭中斷可恢復，不覆寫私有 workspace。
- [ ] 回退只在資料格式相容時換回 binary；不得用舊備份覆蓋新版已產生的使用者資料。

### N5 — 切換 Windows 原生產品並移除舊 runtime

前置條件：N0–N4 通過，取得原生候選的人工使用驗收及雙平台同 tag 綠燈。

- 先發 paired prerelease，明示 WinUI host 變更、可支援的升級／回退路徑及未驗證平台範圍。
- 保持 `package.json` 為唯一產品版本來源，既有 publisher 契約不變；不在 UI 切換時順便更換版本／簽署機制。
- 確認新 host 穩定與支援政策後，移除 `src/` React App、Electron host、Vite 及只供它們使用的依賴。仍使用的 assets／資料先移到共用資源位置。
- 移除 Node 相容 service 之前，先替換 `npm start`／dev／backup／CLI 及所有 service caller。可重用現有 Rust CLI 與 `--backup`，不另寫一套儲存工具。
- N5 只移除產品 runtime 與已替代的 caller，**不直接刪除整個 `server/`、`shared/` 或 npm graph**。N6 尚在使用的工具模組明列保留；它們不能進入產品或成為 runtime fallback。
- Optional browser UI 隨 React 退役；如日後仍需要 browser 產品，另開需求，不在 Rust-only 計畫內暗中保留另一套正式後端。

完成門檻：

- [ ] macOS／Windows 產品都只有原生 host＋Rust 業務 service；無 Electron／React／Node runtime。
- [ ] 移除前每個 caller 已有替代或明確退役決定；正常使用不會 fallback 到 Node。
- [ ] README、AGENTS、FEATURE_COVERAGE、VERIFICATION 與操作指令符合新架構。

### N6 — 正常工具鏈移除 Node，保留必要歷史證據

這是最後階段，不阻塞前面原生 host 開發，也不以重寫工具冒充使用者效能改善。

目前已確認的刪除前置條件（每次移除仍須重查 caller）：

| 現有依賴 | 替換／刪除順序與驗證 |
| --- | --- |
| `scripts/publish-release.js` → `server/update-trust.js` | 先以固定 manifest／簽章及 paired gate fixture 驗證替代 publisher；N5 仍使用現有 publisher 時保留 trust 模組。 |
| `scripts/build-rust.js`、`scripts/test-rust.js` → `scripts/rust-resources.js` → `shared/features.js`、`server/demo.js`、`opencc-js` | 先固定 catalog／fixture／OpenCC 原始值與版本，再替換 generator/check caller；比對輸出與搜尋 golden corpus 後才移除來源依賴。 |
| `scripts/build-rust.js` notices collector → `node_modules/opencc-js` 授權與套件資料 | 先保存可追溯的版本、授權、第三方 notices 及來源；新 collector 等價後才移除 npm 資料來源。 |
| 共用品牌／字型原位於 `src/assets/`、Windows icon 原位於 `desktop/` | 已移至 `assets/` 並更新原生及相容 build callers；檔案 bytes 不變，React build 通過。 |
| `scripts/build-windows.js` → Electron packager／`desktop/`／React `dist/` | N2–N4 候選 build 與實際升級通過後，N5 才切換正式打包與移除 Electron 依賴。 |
| `scripts/test-macos*.js`、`scripts/test-rust-upgrade.js`、`scripts/benchmark-rust-service.js` → Node harness／fixture store | 正常驗收先有替代 driver；歷史 Node decrypt／installer 證據轉入固定版本 compatibility job，不以刪除測試解除依賴。 |

- 依實際依賴順序遷移資源產生／校驗、license 收集、backup／benchmark driver、build orchestration、release publisher。
- 使用既有 Rust CLI／Cargo binaries 與平台命令；只在工作確實需要時新增小工具，不建立通用 task framework。
- OpenCC 字典與第三方 notices 必須保留精確資料版本、來源及授權；驗證正規化 golden corpus，不能因移除 npm 改變搜尋結果。
- 新 publisher 先以本機／draft fixture 驗證 asset 名稱、paired gates、manifest、簽章與失敗恢復，確認等價才替換既有 publisher；不得借測試發佈真實 release。
- `package.json` 可暫留為純版本 metadata，Rust 直接解析 JSON 不需要 Node。若要改版本來源，另做舊 updater 相容遷移，不與本階段綁定。
- 歷史 Node installer／storage reader 可在獨立 compatibility job 使用固定已發佈版本；正常 build 不依賴它。只有明確停止支援該升級路徑、保留證據並更新支援政策後，才移除此測試。

完成門檻：

- [ ] 乾淨環境不安裝 Node／npm，也能完成正常 Rust／Swift／WinUI build、測試與候選打包。
- [ ] 資源、授權、版本與簽署 manifest 可重現；沒有遺留指向已刪除 Node 檔案的腳本或 CI step。
- [ ] 保留的歷史 compatibility job 有明確用途；不會把 Node service 帶回產品。

## 5. 必須保留的安全與資料不變量

- `(account,id)`、`viewId`、`X-Genmail-Account` 與已有 `genmail` 儲存名稱保持相容；品牌改名不等於資料 migration。
- 多帳戶 reconnect／disconnect 僅影響指定 owner；不得刪除快取、草稿或其他帳戶 credentials。
- 未確認寄件只允許完整原 payload 的明確 retry；日曆重試保留原 request ID／payload。不可 shadow 執行兩次外部寫入。
- Scheduled 凍結完整 review，保留草稿鎖與 15 分鐘 late grace；中斷 claim 轉為 uncertain，不自動重寄。Pending 是獨立於 star 的本機欄位，匯入不得清除。
- Learning identity 需逐帳戶由使用者確認；Reply Suggestions 只使用已下載且允許的內容，來源／style／identity 改變須失效，只能產生待確認草稿。Out of Office 需額外 OAuth consent 及明確 provider 寫入確認。
- 歷史匯入只對允許的純讀 transient fetch 做有界 retry；public error 不包含 provider 原文或秘密。
- AI／embedding／learning 保留 source hash、generation、欄位 redaction、費用 review 與撤權後失效。Activity 不啟動工作。
- 保留 TLS 驗證、OAuth PKCE／state／browser 綁定、canonical repository、archive／簽章檢查與私人目錄 ACL。
- WebView 不載入可信 App 控制介面、不接受任意 native commands，且不可取得 service／update token。外部圖片預設關閉，連結須審視目的地。
- 保留 SQLite durability、單 writer、bounded worker、consistent backup。不得用降低 fsync／關閉授權換取效能數字。

## 6. 量測與驗收方式

| 面向 | 必須記錄／驗證 |
| --- | --- |
| 整體資源 | UI、Rust service、WebView 與其他 child processes；Windows private working set／commit、macOS memory footprint 分開列出，不把跨 OS 指標當同一數字 |
| 啟動 | 安裝後首次 migration、既有 workspace reopen、OS cache 條件與 ready-to-interact；至少多次獨立啟動，記錄原始資料 |
| 互動 | 開信、快速切換、捲動、搜尋、寫草稿；同步與索引執行中也測試，分開 API 與畫面完成時間 |
| 資料規模 | 1k／10k／50k；完整索引、部分缺失及全部 derived index 缺失分別測試 |
| 統計 | 足夠樣本後報 p50／p95／max；少量樣本只列實測，不用五次啟動推論穩定 tail latency |
| 外部等待 | 使用隔離 TLS／model fixture 重現延遲與失敗；provider／AI 網路時間不能算作 UI framework 的改善 |
| 平台 | 支援的最低 OS、實機、DPI、IME、無障礙、離線安裝及 reader runtime 缺失 |

現有 service 效能預算可沿用原計畫：10k warm lexical search p95 ≤ 200 ms、50k ≤ 500 ms，不含 UI。其他數值在 N0 固定，這些門檻均不是所有使用者硬體的保證。

Windows 原生化仍為目標；若資源或互動表現回歸，先診斷並修正，不因換了語言便宣稱成功。macOS 不預期因 repository 減少 JavaScript 而自動加速。安全、資料、操作對等或可及性失敗，一律阻擋切換。

## 7. 測試、發佈與停止條件

過渡期重用現有 Rust／Node／Swift／desktop／updater 測試及 CI，不在建立計畫時執行或改動它們。測試名稱和指令只在替代已存在後調整；仍有 caller 時不能先刪舊 harness。

每個實作階段至少留下對應的可執行驗證；優先擴充既有測試，不另建框架。所有 fixture 使用獨立絕對 workspace，禁止使用擁有者資料或未授權的真實寄件／日曆寫入。

以下任一項失敗即停止該階段的切換：

- owner／credentials 洩漏、資料遺失、重複外部副作用、未儲存草稿被捨棄。
- updater 無法從支援的舊版安全升級，或 workspace／pending operation 遺失。
- 任一平台的必要功能、最低系統、鍵盤／IME／無障礙未達已定義門檻。
- paired build／tests 未全部通過，或 release assets、版本、簽章不一致。

Rust-only 並不完成 Developer ID notarization、Windows signing、OAuth provider verification 或真實帳戶驗收。這些必須另有證據；未完成時保持 prerelease 並如實披露。

## 8. 第一個實作里程碑

先交付 **N0 行為矩陣＋N1 重複業務邏輯清單**，隨後做 N2 的 Windows「啟動 → Add account／fixture 帳戶 → 分頁 → 讀信 → 關閉重啟」完整路徑。

Windows 第一條路徑尚未通過前，不刪 Electron、不更換公開更新包、不大量改寫 macOS。N1–N3 可逐批交付；N4 是 release 阻擋門檻，N5 是產品切換，N6 是工具鏈收尾。排期應在 N0 盤點及 N2 技術驗證後估算，不把未知工作量寫成承諾日期。

## 9. 平台參考

- [Microsoft：WinUI 3／C++ 與 C# 原生桌面開發](https://learn.microsoft.com/en-us/windows/apps/winui/winui3/)
- [Microsoft：Windows App SDK 部署選擇](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/deploy-overview)
- [Microsoft：Self-contained 部署與 unpackaged 初始化](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/self-contained-deploy/deploy-self-contained-apps)
- [Microsoft：WebView2 安全邊界與設定](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security)
- [既有 Rust 遷移與資料相容性清單](RUST_MIGRATION_INVENTORY.md)
- [驗證記錄與未完成限制](../VERIFICATION.md)

平台 SDK／runtime 版本及最低 OS 在 N2 開始時重新確認並鎖定；不因文件提及框架就自動提高既有產品的最低系統需求。
