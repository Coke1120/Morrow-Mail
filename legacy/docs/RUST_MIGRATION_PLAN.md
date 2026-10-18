# Morrow Mail — Rust 遷移計劃

> Historical migration record. The owner subsequently authorized JavaScript source retirement; see [current source/tooling policy](JAVASCRIPT_RETIREMENT.md). Old JS paths and npm commands below refer to their recorded commits, not current build instructions. Outstanding acceptance gates are unchanged.

日期：2026-09-24

狀態：2026-09-25 已實作 M0 量測工具、M1 分頁介面、M2 唯讀試點及 M3–M5 完整 Rust service 候選版本。同一 commit 的 macOS／Windows Rust 桌面建置、實際升級與備份還原自動化驗收已通過；使用者已明確批准 0.6.0-beta.1 切換 Rust 預設並以 prerelease 發佈，仍須同 tag 雙平台檢查全部通過。穩定版簽署、最低 OS、完整人工 UI 與真實帳戶驗收尚未完成。M6 依本計劃的 M5 穩定條件另行評估。詳見 [相容性清單](RUST_MIGRATION_INVENTORY.md) 與 [實際驗證記錄](../VERIFICATION.md)。

本計劃保留 macOS 原生 SwiftUI 介面，逐步將共用 Node.js 服務遷移至 Rust。Windows 先保留 React / Electron，待 Rust 後端穩定後，另行評估 React / Tauri。Node.js 仍可用於 React 建置；「移除 Node.js」指最終桌面產品不再需要捆綁或啟動 Node.js runtime。

全文搜尋及智慧搜尋已在 `6428c67` 合併，既有跨平台搜尋驗收記錄位於 VERIFICATION.md；本次以 `585fe1d` 為量測基準。新的 Rust 及分頁變更仍需各自驗收。

## 1. 目標與邊界

- 改善大量郵件下的清單載入、搜尋、索引建立、記憶體使用及介面回應。
- macOS 與 Windows 共用帳戶、郵件、搜尋、AI、日曆及資料保存邏輯。
- 保留既有帳戶、加密設定、快取、草稿、寄件不確定狀態及日曆重試記錄。
- 沿用現有版本來源、成對發佈、簽署更新清單與 App 內更新流程。
- 每一階段都可獨立驗證；未達驗收條件，不進入下一個切換階段。

不在本次遷移範圍：重畫介面、以 WebView 取代 SwiftUI、新增雲端同步、重寫 Gmail/Outlook 協定，或以遷移名義新增附件及其他產品功能。Windows Tauri 是獨立階段，不是 Rust 後端的前置條件。

## 2. 現況與瓶頸假設

| 部分 | 現有位置及行為 | 評估重點 |
| --- | --- | --- |
| macOS | `macos/Sources/MorrowMail/`；SwiftUI 啟動私有 Node.js 服務 | 保留原生介面及生命週期保護 |
| Windows | `desktop/`、`src/`；Electron / React 加私有 Node.js 服務 | 後端與 Electron 各自量測，避免混淆 |
| 共用 API | `server/app.js` | `/api/state` 載入郵件並重複計算帳戶及資料夾統計 |
| 資料層 | `server/store.js`；SQLite、JSON 郵件及加密設定 | 全量讀取、JSON 解析、日期排序、同步查詢時間 |
| 搜尋 | 正在開發的全文及智慧搜尋 | 完成後凍結查詢語法、權限、排名及索引版本 |
| 外部服務 | `server/providers.js`、`server/integrations.js`、`server/calendar-*.js` | 將網絡等待、限流與本機 CPU 時間分開記錄 |
| 更新及發佈 | `server/update-*.js`、`server/updater.js`、`scripts/`、GitHub workflow | 舊客戶端必須可以驗證及安裝新架構 |

這些是程式觀察形成的瓶頸假設，不是效能測試結論。Rust 不會直接縮短外部 AI、Gmail 或 Outlook 的回應時間；SQLite 查詢及資料流仍須改善。

### 2.1 已在程式中觀察到的三個主要問題

目前 macOS 是 **SwiftUI 原生介面＋Node.js 後端**。以下結構已由程式確認；實際耗時、記憶體影響及嚴重程度仍須用 M0 量測。

1. **更新狀態時全量讀取，重複計算資料夾數量。** [server/app.js](../server/app.js) 的 `state()` 為所有已連接帳戶呼叫 `store.listMessages()`，在 JavaScript 中計算 unread 及各資料夾數量；建立目前檢視的 `rows()` 時再讀取郵件。即使只查看單一帳戶，側欄統計仍會遍歷其他帳戶。建議改為 SQL 統計、有界清單、正文按需載入，並合併同一請求中的重複讀取。
2. **JSON 郵件的全量解析及日期排序。** [server/store.js](../server/store.js) 的 `listMessages()` 使用 `.all()` 取得所有符合帳戶的記錄，再逐封 `JSON.parse`；清單 SQL 使用 `ORDER BY json_extract(data, '$.date')`。JSON 儲存本身不代表錯誤，問題是把完整正文、解析和排序放在常用清單路徑。應優先重用適合的已存在 metadata／搜尋表，或新增必要的可索引欄位，以 `EXPLAIN QUERY PLAN` 確認查詢是否使用索引，而不是憑語法推斷。
3. **同步 SQLite 工作佔用後端執行緒。** `DatabaseSync` 的 API 同步執行；大型查詢、排序及其後的 JSON 解析可能延遲同一服務的其他請求。先減少工作量，再把確有需要的重工作放到有界 worker／DB executor。遷移至 Rust async runtime 後，同步 SQLite 和 CPU 密集工作同樣不能直接佔住 async executor。[Node.js DatabaseSync 官方文件](https://nodejs.org/api/sqlite.html#class-databasesync)

不能由以上觀察推斷「Node.js 一定是主要瓶頸」或「Rust 一定改善某個百分比」。必須分開量測 SQL、JSON 編解碼、IPC、UI 更新與外部網絡等待。

### 2.2 其他已觀察到、值得量測的路徑

下列項目的優先次序是調查順序，不是已量測的嚴重程度。程式正持續變動，M0 須重新確認哪些仍存在。

| 優先次序 | 程式觀察／位置 | 改善方向 | 驗證方式 |
| --- | --- | --- | --- |
| 高 | `AppModel.swift` 的 periodic task 與 `src/App.jsx` 的 refresh effect，在既有 guards 允許時每 30 秒呼叫 `/api/state` | 先拆出輕量 metadata / revision 檢查，只更新有變化的清單；背景或未使用頁面降低刷新頻率。沒有必要時不另建事件推送系統 | 比較完全閒置及有新郵件時的請求數、payload、CPU、喚醒次數；確認 OAuth 返回及恢復前景仍刷新 |
| 高 | `AppModel` 為 `@MainActor`；`request()` 在 await 網絡後同步 `JSONDecoder().decode`，回應大小檢查上限為 32 MiB | 先限制 payload；大型解碼移到受控背景工作，只有 UI 狀態套用留在 MainActor。不要以提高 32 MiB 上限解決全量載入 | Instruments 觀察大郵箱刷新時的主執行緒卡頓；用大型 fixture 驗證頁面仍可載入，而非撞上大小限制 |
| 中 | `state()` 的 `rows()` 逐封使用 `summaries.find()` 及 `messageIds.includes()`；`automation.reports()` 又會檢查 eligible mail 與 source digest | 同一請求建立按 message ID 查詢的摘要 Map，合併重複資格查詢，僅處理必要郵件及報告；保留全部權限／來源失效檢查 | 記錄每次刷新讀取郵件／解密設定次數；權限撤回及郵件修改後，舊摘要仍必須失效 |
| 中 | `getSettings()` 每次讀取並解密整份設定；狀態、automation 及 learning helper 會再次呼叫 | 量測後優先使用短生命週期的 request snapshot；不要先建立跨請求的全域憑證 cache。外部操作前後仍重新驗證權限及連接 | 比較單次請求解密次數與耗時；測試 token refresh、撤權及 disconnect 不會因快照而被忽略 |
| 中 | `mailboxOperation()` 使用全域 `mailboxBusy`，`syncAccounts()` 逐一處理帳戶；一個慢帳戶可能令其他操作暫時收到 409 | 只有確認影響後才改為帳戶級有界調度；同一帳戶的重要操作保持互斥，資料庫交易由單一擁有者管理 | 用一個慢／離線 fixture 帳戶及一個正常帳戶，觀察讀取及操作延遲；不得以並行化引入重寄或 token refresh 競態 |

摘要報告目前有數量上限，因此不能直接把摘要比對描述為無界的平方級問題；優先量測全量郵件讀取及重複工作。

### 2.3 其他改善與驗收事項

以下是建議納入的品質要求，不表示已證實目前每項都有缺陷：

- **搜尋取消與舊回應淘汰：** 一般搜尋 debounce、取消不再需要的查詢；快速切換帳戶、篩選及分頁時，舊結果不得覆蓋新檢視。付費智慧搜尋只由明確操作觸發，翻頁不重複付費生成相同 query embedding。
- **增量索引與資源限制：** read／starred 等 metadata 改動不應重新生成正文 embedding；以內容及模型版本判斷失效。索引分批、可暫停／續作、有記憶體及併發上限，優先保留互動查詢的回應能力；避免每次開啟 App 全量重建。
- **穩定分頁與結果身份：** 日期相同、跨帳戶 provider ID 重複、同步時新增郵件及修改排序，都不能造成錯誤 owner、漏頁或重複頁。選擇合適的穩定 cursor，定義資料變動時重新整理行為。
- **同步完整性：** 現有 release 文件指出 periodic refresh 主要取得最新 50 封。另行評估 provider 支援的增量同步、刪除／移動對帳、游標失效恢復及限流 backoff；這屬同步功能改善，不能宣稱換 Rust 就會自動解決，也不應擴大 M2 的只讀試點。
- **資料耐久性：** 不以關閉 `synchronous=FULL`、跳過 fsync、取消交易或縮減寄件確認檢查換取 benchmark 分數。WAL 是否適合須測試 Windows locking、backup、checkpoint、crash recovery 及遷移相容性後再決定。
- **可診斷性：** 增加選擇性、去識別化的 phase timing、query count、queue wait、取消及失敗分類；不得記錄正文、搜尋原句、地址、tokens 或 API key。離線、權限、schema 及 provider 錯誤須能區分，不只呈現一般性失敗。
- **無障礙與恢復 UX：** 慢查詢／索引顯示進度、取消及可恢復錯誤；切換引擎或 Windows host 後保留鍵盤操作、中文輸入法、焦點、選取位置及未儲存內容。
- **本機安全與維護：** 新增 Rust／Tauri 邊界的 parser、IPC、TLS 及依賴檢查；保留 SQLite/key 檔案權限、Windows ACL 評估與敏感衍生索引的清除策略。不要把語言的記憶體安全視為帳戶授權或加密已正確的證明。

上述項目先加入 M0 inventory，再依量測及對應責任安排於 M1、M2、M4 或 M6；不把所有改善綁成一次大改寫。

## 3. 目標架構及過渡原則

```text
macOS：SwiftUI ─────────────────┐
                              ├─ 私有本機 API ─ Rust 共用核心 ─ SQLite
Windows：React / Electron ─────┘                         └─ 郵件 / 日曆 / AI
         後續可改 React / Tauri
```

最終以一個 Rust service executable 提供現有本機 API。先沿用 loopback HTTP / JSON 契約，避免同時改 UI、傳輸協定和業務邏輯。服務只綁定 loopback，沿用每次啟動的 bearer authentication、Host / Origin 檢查及受限 OAuth callback 例外。

Rust 先使用一個 Cargo package、按責任劃分模組；不預先建立多套 crate、通用 provider framework 或新的插件系統。實作前核對所選依賴的授權、維護狀態、TLS、SQLite FTS5 及兩個目標平台支援。

**任何時間只有一個邏輯上的資料庫寫入服務。** 過渡期 Node.js 與 Rust 可以同時存在，但不得各自執行同步、寄件、日曆寫入、排程或資料遷移。桌面 shell 也不得自行修改業務資料。

## 4. 分階段工作與驗收

### M0 — 基準、相容性清單及搜尋契約

工作：

- 待目前搜尋工作通過既定檢查，記錄可重現的基準 commit。
- 盤點 SwiftUI、React、desktop bridge 及 scripts 使用的 API、狀態碼、欄位、錯誤與帳戶 header。
- 記錄資料 schema、SQLite functions / triggers、加密格式、資料目錄及所有持久化重試檔案。
- 使用虛構資料建立 1,000 / 10,000 / 50,000 封、多帳戶、中英混合及重複 provider ID 的 benchmark workspace。
- 記錄冷／熱啟動、第一頁郵件、搜尋、索引、RSS、CPU、API payload 大小及服務進程數。
- 分別記錄 SQL 次數／時間、設定解密次數、JSON 編解碼、MainActor 卡頓、閒置刷新及 mailbox lock 等待／拒絕情況，為第 2 節的每個候選瓶頸留下證據。
- 將既有 API 測試整理為可分別針對 Node.js 與 Rust 執行的同一組契約檢查；沿用現有測試工具。

驗收：

- [x] 每個預計遷移模組均有對應呼叫者與相容性要求；見 RUST_MIGRATION_INVENTORY.md。
- [x] 同一 mail-v1 corpus 的 Node baseline 可在 Mac 與 Windows fixture workspace 重現；CI 保存 1,000／10,000／50,000 封量測，硬體與平台結果分開記錄。
- [x] 搜尋語法、繁簡處理、範圍、分頁、智慧搜尋授權及失效規則已有測試依據；見既有 search tests 與新增 Rust 差異測試。

### M1 — 改善資料流，保留 Node.js

工作：

- 清單改用有界分頁；正文在開啟郵件時載入，避免每次刷新傳送整個郵箱。
- 帳戶／資料夾數量改用 SQL 統計，避免為計數解析所有郵件。
- 為帳戶、資料夾、日期及穩定分頁鍵建立合適索引；驗證查詢計劃。
- 正文、搜尋結果及統計的更新分開；以穩定的 `(account, id)` / `viewId` 保留選取狀態。
- 減少不變狀態的週期性全量刷新；在同一請求內合併摘要及設定讀取，大回應解碼不佔用 SwiftUI 主執行緒。
- 大型索引工作離開處理 UI 請求的執行路徑，加入進度、取消及重啟恢復。
- 配合現有搜尋工作實作，避免建立第二份搜尋引擎或重複索引。

驗收：

- [x] 新版兩個介面使用有界 metadata 頁面；1,000／10,000／50,000 封 fixture 均不傳送未開啟正文。舊 API 相容路徑仍保留。
- [ ] 所有原有排序、跨帳戶檢視、搜尋分頁及讀取正文通過兩個介面的回歸檢查。
- [ ] 大型 fixture 不再依賴提高回應大小上限；刷新、索引及慢帳戶情境下，UI 回應與資料正確性達到記錄的驗收門檻。
- [x] 記錄相對 M0 的 payload／查詢改善、完整與部分索引重建，以及剩餘文字排序掃描；不把 service RSS 當成整個 App 的用量。量測限制見 VERIFICATION.md。

### M2 — Rust 搜尋核心試點

工作：

- 新增最小 Rust binary，先承接本機全文查詢、相關度計算及向量相似度計算。
- Node.js 暫時保留 API、provider 工作與唯一資料寫入權；Rust 不執行寄件或外部 AI 請求。
- SQLite FTS5 仍是全文索引；先量測受範圍限制的精確向量搜尋，再決定是否需要 ANN，避免先引入獨立向量資料庫。
- Rust 可使用受控唯讀 SQLite connection 查詢相容索引；如向量格式或加密尚不相容，改由 Node.js 提供有界批次。不得每次搜尋把整個郵箱 JSON 傳入子程序。
- 範圍和允許欄位在產生候選前限制，回傳結果前再次確認帳戶、權限及來源有效性。
- 過渡 worker 僅接受固定操作、參數及大小限制；資料位置由可信 host 提供，不接受 renderer 指定 SQL、路徑或命令。
- 以內部開發開關選擇引擎，差異測試只跑純讀取 fixture，禁止雙重執行任何外部操作。

驗收：

- [x] 全文精確條件、日期邊界、中文一／二字詞、繁簡字、地址及編號結果符合既有契約。
- [x] 混合搜尋保留原始郵件及帳戶識別；相關度調整有固定查詢集與預期相關結果。
- [x] 無跨帳戶／未授權資料洩漏；關閉 AI 後普通搜尋仍可使用。
- [x] 同時量測 Node.js + Rust 的總記憶體和 IPC 成本，不只展示 Rust worker 的用量。
- [x] 只讀試點故障可回到 Node.js 搜尋；fixture 驗證資料 checksum 不變，也不重複 embedding 呼叫。

### M3 — Rust 接管資料及本機 API

工作：

- Rust 實作 SQLite 交易、帳戶、設定、郵件、草稿、搜尋資料及備份／還原。
- 保留 `/api` 契約及帳戶 header，讓 SwiftUI / React 僅更換後端啟動路徑。
- 如 Node.js provider 暫時保留，將它限制為受控 adapter：不直接開啟業務資料庫，只透過 Rust 的私有內部操作提交結果。
- 切換資料寫入權時停止舊服務、排空操作、取得 workspace lock；成功後才啟動新的寫入者。
- 保留加密設定的既有 AES-256-GCM 相容格式，使用測試 key 驗證 Node.js → Rust 與 Rust → Node.js 解密；不接觸或輸出真實憑證。
- 移植索引所需 SQLite functions / triggers；不能只複製 schema 而遺漏註冊函式。
- 重建索引屬可恢復工作，郵件及草稿保持可讀；顯示索引覆蓋率與進度。

驗收：

- [x] 新、舊及部分遷移 fixture workspace 都有確定行為；不支援的 schema 清楚拒絕開啟。
- [x] 帳戶重連／大小寫、disconnect 隔離、重複 ID、交易回滾、草稿及復原記錄通過。
- [x] 備份可還原且資料庫完整性、設定解密、client recovery metadata 均有效。
- [x] 隔離 fixtures 通過中途終止／rollback journal recovery、磁碟滿交易回滾、權限／key 拒絕及第二個 writer 排除；不將這些案例宣稱為任意硬體故障保證。

### M4 — 遷移外部服務、AI 及排程

依序移植，完成一項才停止其 Node.js 實作：

1. Gmail / Outlook OAuth、token refresh、唯讀同步及歷史匯入。
2. IMAP 同步、UIDVALIDITY、provider mailbox / label 映射。
3. SMTP / Gmail / Outlook 寄件及明確確認的 provider 組織操作。
4. Google / Outlook Calendar 連接、查詢、事件建立及重試恢復。
5. 模型呼叫、embedding、智慧搜尋索引、AI 權限、語言、摘要及風格學習。
6. 背景排程、取消、失敗恢復及服務關閉。

驗收：

- [x] OAuth PKCE、state、browser-bound callback、refresh rotation 與錯誤恢復保留。
- [x] 寄件保留 To/Cc/Bcc fingerprint、owner 及 uncertain-send review；timeout／切換後不自動重寄。
- [x] 日曆 request ID 與 payload 在重啟及遷移後完全保留；不重建為新 request。
- [x] IMAP MOVE + UIDPLUS、UIDVALIDITY、明確目的地及 provider write permission 與既有行為一致。
- [x] 遠端模型仍限制 HTTPS、禁止 redirect 洩露 key、限制回應大小／時間並保留取消。
- [x] 先套用 AI account / folder / field 權限才建構內容；權限、連接、模型或來源改變時丟棄進行中的結果。
- [x] 模型、dimension、內容或清理規則改變時，embedding 正確失效；不因升級默默把整個郵箱送到遠端重建。
- [x] 排程只有一個擁有者，不會因進程交接而重複觸發；保持原有失敗不自動重試語意。

provider acceptance 先使用隔離 fixture；真實寄件、建立事件及付費模型測試需另有明確授權。fixture 通過不等於真實帳戶驗收。

### M5 — 桌面生命週期、更新及正式切換

工作：

- SwiftUI 與 Electron 啟動單一 Rust service；沿用私有啟動設定、隨機埠、健康就緒訊號及父程序退出處理。
- 移植 backup、updater、installer helper 和啟動診斷，避免主服務換成 Rust 後仍暗中依賴捆綁 Node.js。
- 保持更新簽章的 pinned public key、manifest 格式、平台標識、檔名及版本來源。
- 在相容期保留舊 installer 依賴的 bundle metadata 路徑：macOS 的 `Contents/Resources/backend/package.json` 及 Windows 的 `resources/app/backend/package.json`。它們可只作版本 metadata，不代表仍有 Node.js runtime。
- 保留舊 updater 要求的 archive root、App／exe 名稱及啟動位置；如必須更改，先發佈相容 bridge release，不能直接破壞已安裝客戶端。
- 測試 `beta.2 型舊 updater → 首個 Rust 版本 → 後續 Rust 版本`。測試使用複製的隔離 App、fixture key 和資料，不使用使用者安裝的 App。
- 延用 existing publisher 的兩平台成功後才公開、禁止覆寫公開檔案及 draft-first 規則。

驗收：

- [x] 同一 commit 的兩平台自動化 fixtures 通過啟動、關閉、in-flight guards、更新取消、雙 PID 等待、實際套件安裝／UI 重啟及備份還原；見 CI run 36050110233。
- [x] manifest、checksum、ZIP 路徑／symlink、平台與版本檢查通過兩平台 fixtures。
- [x] binary rollback 保留目前 workspace，新增 schema 的 Node↔Rust 寫入及備份還原分別驗證；不自動覆寫為遷移前資料。
- [x] 候選套件不需要系統 Node.js、不含 backend Node runtime；Windows Electron 自身的 Node runtime 仍存在。
- [ ] 最低 OS／其他硬體、unsaved UI、中文輸入法、焦點與無障礙完成完整人工驗收；正式簽署／notarization 及真實帳戶另外驗收。
- [x] 0.6.0-beta.1 的 Mac / Windows 同 tag build、packaged smoke、migration 及 updater checks 全數通過，已成對發佈 prerelease；CI 與下載資產驗證見 VERIFICATION.md。

### M6 — Windows Tauri，獨立評估與切換

只有在 M5 穩定後才開始。若主要效能目標已達成，可延後；若目標是 Windows 安裝包完全不含 Node.js / Electron，則本階段為必要工作。

工作：

- 保留 React，替換 Electron host；共用 Rust 業務服務維持單一實作，不複製到另一套 Tauri commands。
- desktop bridge 僅提供需要的少量操作，驗證來源及 frame，設定最小 capabilities；不授予 renderer 任意 shell／filesystem 權限。
- 遷移 window bounds、sidebar preferences、pending calendar request、外部連結及 OAuth browser handoff。
- 明確沿用 `%APPDATA%\Morrow Mail` 與既有 identity；不可讓新 framework 預設建立另一個空資料目錄。
- 驗證 WebView2 存在／缺少、離線安裝、最低 Windows 版本及資源載入行為。
- 延用同一套簽署更新發佈契約；不並行啟用第二套不同簽章／channel 的 updater。

驗收：

- [ ] 兩套 Windows shell 的 feature parity 清單通過，包含鍵盤、中文輸入法、無障礙、主題及縮放。
- [ ] OAuth、寄件復原、日曆復原、backup、更新及舊 Electron → Tauri 升級路徑通過。
- [ ] 記錄與 Electron 相比的安裝包、啟動、整體 RSS；未驗證前不宣稱節省比例。
- [ ] macOS 保持原生 SwiftUI；兩平台維持相同版本及成對發佈。

## 5. 資料相容及回退規則

1. **資料遷移前建立一致、可解密的備份。** 包含 SQLite、匹配的 encryption key、pending-calendar、client-state 及當時版本使用的其他復原檔案；禁止只複製正在寫入的 SQLite 檔案。
2. **前期採用可向後相容的新增欄位／表。** 不直接刪除舊結構；記錄 schema version、支援的最低／最高 reader version 及每一步 migration 狀態。
3. **app binary 可回退，不代表資料可任意回退。** 若新版已新增郵件、草稿或外部操作記錄，不可直接以遷移前備份覆蓋現有 workspace。
4. **不相容時停止寫入並提供復原路徑。** 保留當前 workspace，再以已驗證轉換工具處理，或修正後 roll forward。過渡版本必須能辨識新 schema；在此條件達成前，不發佈不可逆 schema。
5. **索引與原始資料分離。** 全文索引可由原文重建；embedding 屬敏感衍生資料，保留版本、來源 hash 及權限／模型資訊，重建遠端索引須符合原有同意和預算。
6. **不以重新連接帳戶作資料遷移方案。** 保留既有加密格式與 credential mapping；若個別 provider 必須重新授權，先在測試中確認原因並清楚說明。

## 6. 效能量測與品質門檻

M0 先記錄 hardware、OS、build mode、資料集、索引狀態及量測腳本；比較同一台機器、同一份 fixture、相同搜尋條件及 release build。macOS 和 Windows 的結果分開報告。

| 指標 | 驗收方式 |
| --- | --- |
| API payload | 第一頁及一般刷新有大小上限，不隨總正文容量線性增長 |
| 精確搜尋 | 固定 query corpus 的 expected IDs 完全符合，包含中文、繁簡、引號、篩選及重複 ID |
| 智慧搜尋 | 固定相關性標註集，比較 top-k 命中與不相關結果；不得用速度掩蓋品質下降 |
| 搜尋延遲 | 分開冷／熱及 lexical／semantic；多次取樣記錄 p50 / p95，另列 embedding 網絡時間 |
| 介面回應 | 索引與 sync 執行時仍能輸入、切換、取消；記錄主執行緒卡頓 |
| 記憶體 | 計算 UI、服務及所有 worker 的合計 RSS；含高峰、取消後與長時間運行 |
| 寫入正確性 | crash、restart、timeout、重連、重試下零已確認的重複副作用及資料隔離違規 |

效能預算：10,000 封已索引郵件的 warm lexical search 服務端 p95 ≤ 200 ms；50,000 封 ≤ 500 ms，不含 UI rendering。本機及 macOS／Windows CI 的固定 fixture 量測均達標，硬體、取樣與限制見 VERIFICATION.md；不視為所有機器或 UI 的效能保證。涉及資料安全、權限或重複寄件的測試失敗，一律阻擋切換，不以平均效能抵銷。

## 7. 測試與發佈清單

- 延用 `npm run check`、`npm run macos:test`、Windows packaged smoke 及 `npm run updater:test`，依 Rust 切換逐步調整實際實作。
- Rust package 存在後加入 `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`cargo test --locked` 及 release build；提交 `Cargo.lock`，避免建置時解析到不同依賴。
- 契約測試使用同一批 fixture 分別啟動新／舊引擎；比較結果、錯誤、身份隔離及資料內容，不比較非必要的時間戳／隨機 ID。
- migration、crypto 和 update 相容性用最小可執行 fixtures；不建立會執行真實 provider 副作用的 shadow mode。
- 保留原 macOS / Windows 目標與最低 OS，新增 Rust dependencies 不可默默提高最低系統需求。
- package.json 保持唯一產品版本來源，build 驗證 Rust binary、Swift bundle、Windows package 與 manifest 的版本一致。
- 每一階段更新 README、FEATURE_COVERAGE、VERIFICATION 及 changelog；區分 fixture、手動 UI 與真實 provider 驗收。
- Rust 並不解決 Developer ID notarization、Windows signing 或 Google provider verification；未完成時繼續以 prerelease 如實披露。

## 8. 下一個可執行里程碑

M0–M5 的實作已整合。同一 commit 的 macOS／Windows Rust 套件、原有 Node 安裝器升級至實際 Rust 套件、UI／service 重啟與備份還原已由非發佈 CI 驗證。使用者已明確批准 0.6.0-beta.1 的 Rust 預設切換與 prerelease 發佈；同 tag 雙平台檢查仍為發佈必要條件。下一步保留最低 OS／其他硬體、完整人工 UI、真實帳戶及正式簽署驗收；效能記錄不外推到未量測的平台或硬體。M6 Tauri 維持獨立、以 M5 穩定為前提。

本次保持一個 Cargo package，完成 Rust service、相容儲存／備份、provider／AI／排程／更新與預設 Rust 桌面套件。上列未勾選項代表完整驗收尚未達成；M6 尚未實作。跨平台自動化、最低 OS、真實帳戶及正式簽署必須分別留下證據。本次明確授權僅涵蓋 Rust prerelease，不表示穩定版驗收已完成。
