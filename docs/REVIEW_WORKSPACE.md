# Today／Reply suggestions：帳戶分頁與就地檢閱（未發佈）

本分支保留 SwiftUI、WinUI 與 Rust service。只以虛構資料檢查，沒有讀取真實郵件、憑證或使用者資料庫；尚未合併，也沒有發佈新版。

## 已觀察到的舊行為

- `Open source` 會取得指定帳戶的原信，驗證擁有者，再切換全域帳戶、資料夾與郵件選取。它指的是「查看原信」，不是開啟程式原始碼。舊摘要詳細列已改用 `View original message`。
- Today 原本把摘要全文與每封郵件摘要按鈕重複排列。每日內容是已儲存分析按 message ID 合併，不能當成已完成事件追蹤。
- macOS Reply suggestions 原本跟隨全域帳戶，沒有自己的帳戶切換入口；切換帳戶必須離開頁面。載入失敗也可能留下 Loading。

## 本分支的具體改動

Today 與 Reply suggestions 共用 `All accounts`／各帳戶分頁。分頁範圍和全域 mailbox 分開，讀取 All 不選擇寄件身分，也不啟動 AI。跨帳戶同 ID 用 `(account, messageId)` 保留檢閱草稿；每個準備、儲存、核對請求都帶指定帳戶，並檢查回應擁有者。

Today 先顯示決策、待檢閱回覆、已下載未讀數，再顯示最多三個需要本人決定／尚未明確的項目與三個回覆捷徑。其他項目、等待他人、已完成／取消、資訊和完整摘要預設收合。時間與時區顯示在頁首；未讀數涵蓋所有日期，不把它稱作今天的新郵件。帳戶徽章使用實際待檢閱總數，而非預覽列數。

`View original message` 在當頁取得原信。Reply suggestions 同時顯示原信、收件人、可編輯回覆、待回答問題及可展開的依據。使用既有隔離 reader 和附件控制；不把 service token、JavaScript 或新 script bridge 放進郵件 HTML。

文字編輯會重設事實／承諾核對。仍有 `[decision needed…]`、來源變更、帳戶斷線或準備尚未完成時，不能進入送出檢閱。Save draft 只儲存擁有帳戶的草稿；Review sending 再交給既有 composer，保留收件人、Bcc、頁尾、排程、明確確認和 uncertain-send 流程。讀取／使用建議並不代表完成事件，也不會自動寄信。

每帳戶的草稿、選取、捲動和未儲存自動檢查／預算設定在本次 app session 中保留；輪詢和切換分頁不覆蓋修改。退出／更新 guard 涵蓋這些未儲存編輯。需要跨重啟保留的回覆應按 Save draft。來源或建議版本更新會保留文字並撤回舊核對，使用者可明確選擇換成最新建議；換稿前有確認。

載入時顯示進度；空結果提供帳戶／設定入口；錯誤停止 Loading，保留舊結果與修改並提供重試。缺少身分、模型或允許的 AI 欄位時指出所需設定。自動檢查／付費預算仍必須在單一帳戶儲存並檢閱；All 只提供唯讀結果。

## 決策資料的能力與限制

新摘要可包含 `title/action/state/replyNeeded/evidence/deadline/questions`。service 檢查來源 ID、允許欄位、逐字引文及長度；deadline 保留來源文字和郵件日期，不猜測時區或承諾時間。`completed` 需要正文中明確的完成／取消陳述，並拒絕被截去條件的句子、否定、疑問、未來承諾等。這是保守的格式及來源檢查，仍需本人判斷上下文。

Today 用帳戶內已知 provider thread/conversation ID 或 RFC References/In-Reply-To 分組已儲存摘要，較新來源優先；同寄件人或同主旨不構成同一討論。每帳戶投影仍受最新二十個有效摘要工作限制。舊摘要沒有新結構時標為 uncertain，不補造 action、deadline 或完成狀態。

回覆生成仍以最近二百封已下載 Inbox 和最多十封有權限的同聯絡人往來為基礎；本分支加入待回答問題／來源引文及避免未確認承諾的指示，並檢查引文。**尚未實作完整討論脈絡的回覆去重、所有後續信件到達時自動撤回舊建議，以及真實模型品質評估。** 原先的已寄回覆排除只依明確 `replyToId`。因此不能宣稱已消除所有過時、重複或已解決的回覆建議。All 結果最多二百項並明示截斷；切換單一帳戶可查看該帳戶結果。

## 鍵盤、窄版與驗證

原生按鈕／文字欄位可用 Tab 與 Enter；帳戶分頁用左右方向鍵，Windows 另有 Home/End；編輯區提供儲存快捷鍵，Windows 有 Ctrl+Enter 進入檢閱。窄版 Escape／Back 返回列表，保留文字。檢閱內容寬度小於 780 單位時改成列表／詳細單欄；Windows 的窄版操作列垂直排列。主視窗既有最小尺寸沒有改動。

macOS 合成檢查編譯實際 production views，只在暫存編譯副本初始化 fixture transport，禁止外部目的地／寄送／模型呼叫。它覆蓋同 ID 跨帳戶、A/B/A 保留、錯帳戶草稿拒絕、載入失敗、預算編輯保留、新建議重設核對與明確儲存／送出檢閱。

Windows source 已有相同檢閱頁面，但本機 Parallels Standard 不支援 CLI 執行；編譯與既有 native acceptance 交由 PR CI。VoiceOver／Narrator、實際鍵盤與焦點切換、窄視窗大字體、輪詢時的焦點穩定性和真實帳戶／模型品質仍需驗收。合成截圖與 state assertions 不等同這些手動驗收。

主要來源：`rust/src/mail_review.rs`、`reply_suggestions.rs`、`background.rs`、`providers.rs`、`service.rs`；`macos/Sources/MorrowMail/ReviewWorkspace.swift`、`TodayView.swift`、`ReplySuggestionsView.swift`；`windows/Review.cpp`、`Reader.cpp`、`Ui.h`。檢查記錄見 [VERIFICATION.md](../VERIFICATION.md#unreleased-today-and-reply-review-workspace)。
