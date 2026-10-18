# AI Emaily 複查與 Morrow 採用範圍 — 2026-10-03

本次查看官網、互動展示、產品文件，以及 [App Store 的公開介面截圖與版本紀錄](https://apps.apple.com/us/app/ai-emaily-unified-ai-inbox/id6781540532)。沒有登入 AI Emaily、連接真實信箱或測試其寄信能力；以下把可觀察的 UI 與文件宣稱分開記錄。

## UI 與流程觀察

官網使用淡 mint green、綠色主要按鈕、圓角卡片與短標籤。功能頁把輸入、答案及來源放在同一張展示卡中；Ask 有範例問題入口。這比單列功能名稱更容易讓新使用者知道第一次要做什麼。[Smart Search 展示](https://aiemaily.com/features/smart-search)

App Store 截圖顯示深色郵件列表及淺色首頁、Ask 面板、整理進度與撰信畫面；版本紀錄提到更突出的 Needs you、依日期分組的 triage、密集列與浮動回覆工具列。這是官方提供的 iPhone 截圖，不能據此認定 macOS／Windows 的實際 UI 或功能相同。[App Store](https://apps.apple.com/us/app/ai-emaily-unified-ai-inbox/id6781540532)

最值得採用的是三個連接：首頁摘要 → 原信；需要回覆 → 待審草稿；答案 → 來源郵件。回覆佇列先解釋原因，再讓使用者 review/edit/dismiss。來源和待審內容應在同一個視線範圍。[Living Brief](https://aiemaily.com/docs/living-brief)、[Agent Runs](https://aiemaily.com/docs/agent-runs)、[Ask AI](https://aiemaily.com/docs/ask-ai)

展示的輸入會自行輪換，閱讀時也出現遮住內容的宣傳影片視窗。Morrow 的範例問題只填入輸入框，保留使用者的輸入，按下執行才呼叫模型；既有原生列表、鍵盤操作及可選取文字繼續使用。

## 六項實作

| 學到的做法 | 本 PR 的 Morrow 實作 | 範圍與限制 |
| --- | --- | --- |
| 把首頁變成可行動的 brief | Today 顯示每個信箱最多五個有效待審回覆，含原因與草稿；摘要可開啟原信 | 沿用既有摘要與回覆工作，不在讀取 Today 時觸發 AI。macOS 可直接開啟審閱草稿，Windows 連到該信箱的回覆佇列 |
| Ask 結合 semantic retrieval | 原生 Ask 增加「使用已核准 Smart Search index」選項、範例問題及編號來源 | 預設 keyword；明確勾選才使用既有檢索。可能產生 query embedding 費用，不在此建立 index；只用擁有者及 AI 權限允許的郵件 |
| 單一待審回覆佇列 | 顯示草稿前四行、判斷原因、來源與已核准 style 是否使用 | 沿用 review/edit/ignore；macOS 與 Windows 都在準備草稿後重新驗證建議。沒有信心百分比或自動寄信 |
| Brain 區分 facts/style/guardrails | 手動 writing voice、business facts/notes、writing guardrails 分開輸入與儲存 | 每個信箱獨立；保留既有已核准 style、來源驗證及 memory 權限。不是客戶 CRM；限制不得捏造價格、日期或承諾 |
| 規則先具體再執行 | 原生 sender address／exact domain／subject contains 表單；預覽命中，再明確套用並保存 | 手動檢查最新 500 封已下載 Inbox；每條規則只含一個條件和一個 marker。每信箱最多 30 條；十分鐘單次預覽，郵件或 connection 變更須重審 |
| 冷郵件與垃圾郵件分開 | Later 本地閱讀檢視；郵件可手動加入或返回 | `lowPriority` 獨立於 Star/Pending，匯入與重啟保留；只顯示 Inbox/Archive。原 provider folder 保留，不自動判斷 cold email、刪信或標記 spam |

規則與背景資料的參考：[Inbox Rules](https://aiemaily.com/docs/inbox-rules)、[Context Engine](https://aiemaily.com/docs/context-engine)、[Cold Email Filter](https://aiemaily.com/features/cold-email-filter)。本 PR 採最小的可審閱表單，不建立另一套自然語言規則編譯器或自動執行器。

Start here 增加 Today 入口，文案改為「連接信箱 → 查看需要處理的郵件 → 審閱第一封回覆」。模型與權限設定維持按需要使用的既有入口。[Onboarding 文件](https://aiemaily.com/docs/onboarding)

## 來源與可信度

Ask 的來源清單由伺服器從實際提供給模型、經權限過濾的郵件建立。模型輸出的不存在編號會被拒絕。清單標示為「提供的上下文」：有效編號不代表模型對該郵件的解讀已經證實，仍須閱讀原信。

AI Emaily 官網的範例評價仍有待替換成驗證評價的說明；App Store 未有足夠評分顯示總覽。官網對 local/on-device AI 的敘述與 [roadmap](https://aiemaily.com/roadmap) 的探索項目也不完全一致。這些不能用作真實採用率或離線能力的證據。[官網](https://aiemaily.com/)

所謂可撤回寄送應理解為寄送前的 staged window，不能當成傳送後可收回。Morrow 保留自己的 uncertain-send 與重試審閱規則，不擴張寄信承諾。[Undo 與 audit 文件](https://aiemaily.com/docs/audit-log)

## 驗證

實際命令與結果記在 [VERIFICATION.md](../VERIFICATION.md)；fixture 測試不代表真實郵件帳戶或 AI Emaily 的實機驗收。本 PR 沒有更新公開 release、安裝包或擁有者的私人信箱資料。
