# Settings UI／UX review — 2026-09-27

範圍：實際檢視已安裝的 macOS beta.14 八個設定分頁，並交叉閱讀目前 SwiftUI 與 React 原始碼。只切換分頁，沒有修改真實帳戶、權限、模型設定或學習提案，沒有觸發模型測試、匯入、寄信或日曆寫入。Windows 本輪為原始碼檢視，未作 Windows 執行驗收。

## 實作更新（0.6.0-beta.16）

以下 review 已落實到 SwiftUI 與 React：新增／重新連接帳戶入口置頂，匯入範圍可收合；Model 改為 Chat／Embedding 切換且保留各自草稿；General 按用途分組並顯示自動儲存狀態；AI Permissions 的 Save／Discard 固定可見，排程按需顯示，simulation 獨立收合。Search 統一 Review & Index，Rust 批次控制與 Clear index 分開；Learning 提案／已核准狀態置頂，身份和設定分開收合，加入前置設定連結。日曆明示每供應商一個連線；About 將目前版本和上次安裝紀錄分開。

原生 sheet 改為有界彈性尺寸；小視窗仍可捲動，權限儲存與 General 儲存狀態在固定頁尾。React 保留可鍵盤操作的分頁，加入響應式模型切換與固定儲存列。沒有新增 UI framework，沒有改變供應商/API/權限授權。

## 原始 review 優先順序

1. **讓新增帳戶與帳戶狀態先出現。** Mail 頁首是大型匯入設定區，兩個帳戶已足以把新增帳戶入口推到首屏以外。這正好會令人誤以為不能再加入同一供應商的帳戶。建議頁首放「新增帳戶」，下方列已連線帳戶與狀態；匯入範圍在對應帳戶的 Import 操作內設定。
2. **Model 的兩種模型要在首屏可辨認。** 實際 900×700 設定視窗首屏只看到聊天模型；Embedding 在下面，容易被漏掉。建議使用「聊天／回覆模型」與「搜尋 Embedding 模型」兩張摘要卡，各自提供連線狀態、Test、Edit／Save；temperature、token limit 放進進階選項。
3. **減少設定之間的來回尋找。** 學習與索引需要模型、權限、已下載郵件等前置條件，但現在分散在多頁的長說明。應在被停用的主要按鈕旁列出缺少的條件及直接前往設定的入口。
4. **讓明確儲存的操作保持可見。** 原生設定固定 900×700；AI Permissions 的 19 個功能、資料範圍與 Save 在很長的頁面下方。建議可調大小的設定視窗，以及只在有變更時出現的固定 Save／Discard 區。General 繼續自動儲存；權限、憑證與付費操作保留明確確認。

## 逐頁建議

| 分頁 | 目前觀察 | 建議 |
| --- | --- | --- |
| General | 外觀、同步、身份名稱、簽名與 AI 語言混在單一長表單；自動儲存提示在頁尾。 | 分成「外觀與閱讀」「收信與同步」「寫信與語言」；持續顯示儲存狀態，明示名稱／簽名目前跨帳戶共用。保留自動儲存。 |
| Mail | 匯入設定先於帳戶；新增／登入在底部；長帳戶卡把進度、錯誤與多個操作擠在一起。 | 新增帳戶置頂；每張帳戶卡先顯示 email、provider、連線與匯入狀態，再展開進度及設定。錯誤旁直接放適用的 Resume／Reconnect／Restart，避免每張卡總是顯示重開匯入的主要按鈕。 |
| Model | 聊天設定佔滿首屏，Embedding 需向下捲動。兩組 Test／Save 的對象不夠醒目。 | 兩張明確命名的模型卡；各自顯示已儲存模型、endpoint 類型與測試結果。只在所屬卡上顯示對應操作。 |
| Search | 現已有 Test Connection 與 Edit in Model。Save、Index Now、Preview Next Batch、Index Reviewed Batch 是相近但不同的入口；「Clear Semantic Index / Cancel Batch」把停止工作和清除資料合併。 | 保留連線摘要；主要操作採「檢查範圍 → Review & Index」。把 Pause／Resume／Cancel job 與 Clear index 分開，Clear 放進次要操作及確認。進度保留在 Activity，不能因離開頁面而停止。 |
| Learning | 身份表單佔首屏大部分；學習設定、Ready 提案及套用操作在下面。Learn Now、Preview、Generate、Save Approved Style 容易混淆。 | 頁首先顯示目前帳戶、「尚未學習／有待審閱提案／已套用」與下一步。身份確認和寫作風格是兩件事，分成可收合區塊；明示產生提案不等於已套用。 |
| AI Permissions | 長清單混合自動觸發、排程、真實 AI 能力與 simulation；排程即使未啟用也佔空間。 | 分為「自動觸發」「允許讀取的資料」「可用功能」。僅在排程啟用時展開排程欄位；simulation 放獨立可收合群組。改變權限仍需 Save，不能由 UI 自動擴大資料存取。 |
| Calendar | 已連線時仍完整顯示登入說明和登入按鈕；沒有醒目說明與郵件帳戶数量限制不同。 | 已連線時先顯示帳戶與「重新授權／更換帳戶／斷線」，新增登入表單按需展開。清楚標明現在可同時連接一個 Google 和一個 Outlook 日曆帳戶，每個帳戶可顯示多個日曆。 |
| About | 目前版本在底部；實際介面同時出現 beta.14 與「Updated to beta.13」舊安裝結果；「Nothing sends automatically」也容易與已授權的 Scheduled 功能衝突。 | 目前版本與更新狀態置頂；把歷史結果標為「上次安裝紀錄」。備份與支援資訊分組；寄信說明改為需要明確寄送或排程確認。本輪前已完成的每小時檢查／紅色 ! 徽章已納入 beta.16；發佈驗證見 VERIFICATION.md。 |

建議導覽順序：General → Mail → Calendar → Model → AI Permissions → Search → Learning → About。此順序已在兩個客戶端採用。

## 本輪已完成的 Yahoo 入口

兩個介面的 Mail 分頁新增「Yahoo / IMAP」入口及「Use Yahoo Mail / HK Settings」。沿用原本的帳戶隔離、加密憑證與 IMAP／SMTP，沒有新增供應商後端或自動連線。套用預設保留完整地址、填入 Yahoo TLS 伺服器並清空已輸入的密碼，避免把其他伺服器的密碼帶過去。

官方依據：[Yahoo 香港 IMAP 設定](https://hk.help.yahoo.com/kb/SLN4075.html)、[Yahoo app password](https://hk.help.yahoo.com/kb/SLN15241.html)。需要用戶自己建立 app password；尚未用真實 Yahoo HK 帳戶驗收，也未發佈／安裝這個新入口。

## 原始碼依據

- [原生設定頁與固定視窗大小](../macos/Sources/MorrowMail/SettingsView.swift)：`body`、`mailPage`、`modelPage`、`permissionsPage`、`calendarPage`、`aboutPage`。
- [原生搜尋／Embedding 設定](../macos/Sources/MorrowMail/SearchSettingsView.swift)：`configuration`、`jobPanel`。
- [原生 Learning](../macos/Sources/MorrowMail/StyleLearningView.swift)：身份、設定與提案的顯示順序。
- [React 設定](../src/Settings.jsx)、[Learning](../src/StyleLearning.jsx)、[Calendar](../src/CalendarSettings.jsx)。
- [郵件多帳戶儲存](../rust/src/service.rs)：`connections`、`canonical_address`、`save_connection`；[日曆連線](../rust/src/calendar.rs)：`state`、`save_connection` 以 provider 為鍵。
