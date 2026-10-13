# Morrow 與 Thunderbird 的 IMAP 抓取比較

這份說明只比較 IMAP 抓取裡的旗標同步、增量抓取、CONDSTORE、QRESYNC、MODSEQ，以及有界發現。比較基準是 Morrow `main` 的 `9b04bdf279e586af193ffdcc3b152353e916a17b`。Thunderbird 只讀官方 desktop 樹，授權是 MPL 2.0。沒有把 Thunderbird 原始碼複製進這個倉庫。

Thunderbird 的 pin 用草稿 PR #34 已經寫下的 `30cdf5a03b41253e744bc058a699c1947a2b8123`。同一個日期較晚的 `4d8f5f89a54280d9e7df4fa692dc29e59add9b73` 對下面三個檔的 blob 完全相同，所以行號可以共用。那兩個 commit 的主題是篩選器全選與 NNTP 多行回應。

- `mailnews/imap/src/nsImapProtocol.cpp` blob `ff9cf6e4327ea015783f04a2b3f8126566ffae4a`
- `mailnews/imap/src/nsImapMailFolder.cpp` blob `364d67e7304dabf7f22aefb9b38162380332de66`
- `mailnews/imap/src/nsImapCore.h` blob `40b175dbb3ba5ceb1468269bd1d10f27bb981fba`

官方樹是 [thunderbird/thunderbird-desktop](https://github.com/thunderbird/thunderbird-desktop/tree/30cdf5a03b41253e744bc058a699c1947a2b8123)。兩份 C++ 檔的檔頭都是 Mozilla Public License 2.0。檢視副本留在這台機器的 `/tmp/tb-inspect`，沒有放進 Morrow 工作樹。

## 這裡的抓取指什麼

這裡的抓取分成三件事。

1. 已經在本地的信，之後旗標變了，或是從伺服器消失了。
2. 新 UID 怎麼被找到，以及找到之後要不要再下載正文。
3. 資料夾清單有沒有上限。

不比較畫面、搜尋、寄信、行事曆，也不把 Thunderbird 整份同步做成 Morrow 的目標。

協定依據是這次對過目錄的兩份 RFC。

- [RFC 7162](https://www.rfc-editor.org/rfc/rfc7162) 第 3.1.2 節定義 SELECT 與 EXAMINE 的 `HIGHESTMODSEQ` 與 `NOMODSEQ`。第 3.1.4.1 節是 `CHANGEDSINCE`。第 3.1.8 節是 SELECT 與 EXAMINE 的 `CONDSTORE` 參數。第 3.2.3 節要求 QRESYNC 走 `ENABLE`。第 3.2.5 節是 SELECT 與 EXAMINE 的 `QRESYNC` 參數。第 3.2.6 節是 `VANISHED`。第 3.2.1 節說明只有 CONDSTORE 的客戶端抓不到「只被 expunge、旗標沒變」的信。第 6 節要求客戶端快取開啟信匣時的 `HIGHESTMODSEQ`，而且若回應帶了這個代碼，即使看過更高的單封 MODSEQ 也要用這個代碼。
- [RFC 9051](https://www.rfc-editor.org/rfc/rfc9051) 第 2.3.1.1 節是 UID。第 6.4.4 節是 SEARCH。第 6.4.5 節是 FETCH。第 6.4.9 節是 UID 命令。第 6.4.8 節是 MOVE。

## Morrow 目前怎麼抓

Morrow 把「抓新信」和「對已快取的信做旗標」分成兩條路。CONDSTORE 與 QRESYNC 只出現在第二條。`docs/THUNDERBIRD_IMAP_SYNC.md` 不在這份 `main`。那份文件在未合併的草稿 [PR #34](https://github.com/Coke1120/Morrow-Mail/pull/34)，head 是 `0fee5cd5bbe4f3342801f98bc595d783dae69ca8`。下面先寫主線。

### 新 UID 與正文

`mail::sync` 在 `rust/src/mail.rs` 第 1023 到 1039 行先做可見頁優先對帳，再對資料夾抓一頁，最後做背景 50 列對帳。沒有匯入選項時只抓 inbox。有選項時只在 `allMail` 或該資料夾被勾選時加入 inbox 與 sent。`incremental` 固定為 true，checkpoint 來自 `settings.imapSync`。

`fetch_folder` 直接 `EXAMINE`。旗標路徑才走 `sync_examine`。有相符的 connection 與 UIDVALIDITY 時，從 `checkpoint.uid + 1` 往上掃。註解在 `rust/src/imap.rs` 第 1487 到 1493 行。每個視窗最多 8192 個 UID，SEARCH 回應暫時限 128 KiB，一頁最多 32 個視窗，留下最多 50 封。沒有可用 checkpoint 時從高水位往下掃。第一次成功的 incremental 水位寫在第 1718 行的 `syncCheckpoint`，欄位是 path、validity、uid、connection、more、bootstrapIncomplete。沒有 highestmodseq。

選中的 UID 抓的是標頭，見第 1568 到 1572 行。正文重用要同時滿足已快取、不是草稿、不是 drafts、大小不超過 5 MiB、`bodySize` 相同，而且這次標頭的 Message-ID 與快取相同且非空。否則才 `BODY.PEEK[]`，上限約 5 MiB。旗標單獨變化不會因為這條路重抓正文。大於 5 MiB 只留標頭與佔位句。

歷史匯入的全資料夾清單走 `LIST "" "*"`。超過 300 個名稱就失敗，見 `list_names` 第 417 到 451 行。週期同步不走這條全清單。

### 已快取信的旗標

背景批次在 `rust/src/reconcile.rs` 第 14 到 37 行。依 `rowid` 取下一個最多 50 列，帳號節點是 `settings.mailReconcile`。掃完不足 50 列就把游標歸零。可見頁優先在第 123 到 137 行，不推進這個游標。上限 51 是 50 列加目前讀取的那一封，見 `rust/src/sync_priority.rs` 第 15 行。

`sync_examine` 在 `rust/src/imap.rs` 第 873 到 942 行。

- `CAPABILITY` 被拒就普通 `EXAMINE`，不做延伸。
- 有 `QRESYNC` 才 `ENABLE QRESYNC`。只有 `* ENABLED` 真的含 `QRESYNC` 才算成功，見第 957 到 988 行。
- QRESYNC 成功後仍是普通 `EXAMINE`。讀取不用 `SELECT`，因為要避免改寫信匣狀態。註解在第 895 行。
- 只有 `CONDSTORE` 時送 `EXAMINE folder (CONDSTORE)`，並讀未標註的 `HIGHESTMODSEQ`。
- 兩者都沒有就普通 `EXAMINE`。

`reconcile_session` 在第 998 到 1194 行只對這批已知 UID 發 `UID FETCH`。`minimum` 是這批裡、連線版本相符的 `imapModseq` 最小值。沒有 proof 就當 0。`HIGHESTMODSEQ` 存在且 `minimum > 0` 且不大於信匣最高值時才走增量。

- QRESYNC 送 `(UID FLAGS MODSEQ) (CHANGEDSINCE n VANISHED)`。
- 只有 CONDSTORE 時先 `UID FETCH` UID 證明還在。水位沒變就不再抓旗標。變了才送不帶 `VANISHED` 的 `CHANGEDSINCE`。
- 其他情況抓 `(UID FLAGS MODSEQ)` 或 `(UID FLAGS)`。指令被拒就退回 `(UID FLAGS)`，而且不把省略當成未變更。
- `CHANGEDSINCE` 沒列出、且不在這批的 `VANISHED` 交集裡，視為沒變，不當刪除。見第 1177 到 1185 行。
- `VANISHED` 不展開任意範圍，只和這批 UID 相交。超過 50 個 range 直接失敗，見第 693 到 697 行。單次 FETCH 回應超過 50 列也失敗，見第 648 到 650 行。

寫回的 `imapModseq` 取 EXAMINE 當下的信匣 `HIGHESTMODSEQ`。FETCH 列上的單封 MODSEQ 留在檢查裡，不寫進這個欄位。見第 1171 到 1173 行。這和 RFC 7162 第 6 節「有 `HIGHESTMODSEQ` 代碼就用它」的方向相同。水位存在每一列，主線沒有資料夾級 checkpoint。

UIDVALIDITY 與 `imap:{validity}:{uid}` 不符時，只標 `providerFolderMissing`，不標 `providerDeleted`。`reconcile::save` 對刪除或消失只更新那兩個布林，保留快取正文與本地資料夾。見 `rust/src/reconcile.rs` 第 114 到 120 行。

未變更列把快取 JSON 送進 `import_messages`。`import_read_state` 在 `rust/src/mail.rs` 第 399 到 435 行把訊息上的 `read` 與 `starred` 當成這次遠端觀察。省略路徑沒有先用伺服器旗標蓋過這兩個欄位。星號只有在舊 `providerSnapshot` 與這次遠端值相同時才保留本地值。這次沒有跑測試證明使用者可見的星號被寫成遠端事實。路徑本身在上述兩段。

旗標寫入是另一條路。`write_flags_with_tls` 在第 750 到 820 行使用 `SELECT`，只 `UID STORE` `\Seen` 與 `\Flagged`。讀取路徑保持 `EXAMINE`。

週期同步要先拿到行程內的 `app.0.mailbox` 鎖，見 `rust/src/background.rs` 第 1287 行。鎖不住就留到下一輪。這把鎖只活在這個行程裡。每次讀取都新開 TLS，做完 `LOGOUT`。主線沒有 IDLE，也沒有把連線留在選定資料夾上。

`docs/SYNC_PERFORMANCE.md` 第 103 到 119 行描述的就是這套有界已知 UID 行為，並把範圍寫成已知 UID，不含全信匣 QRESYNC 與 IDLE。`FEATURE_COVERAGE.md` 第 26 行與 `CHANGELOG.md` 第 8 行同樣說 0.7.4 已做 capability gated 的已知 UID 對帳。`FEATURE_COVERAGE.md` 第 178 行與 `docs/USER_GUIDE.md` 第 263 行仍寫 QRESYNC 未實作。那兩句和目前 `imap.rs` 不一致。

`VERIFICATION.md` 第 606 行比較 Thunderbird Android `e3fb7f3341827eb756327e26198f97b7c3f1821e` 的佇列旗標對帳。desktop 樹的 pin 見上面的 `30cdf5a`。

## Thunderbird 目前怎麼抓

旗標決策在 `nsImapProtocol::ProcessMailboxUpdate`，函式從 `nsImapProtocol.cpp` 第 4212 行開始。第 4250 行只是新增與刪除計數。`UseCondStore` 在第 4255 行。三條路的註解在第 4257 到 4259 行。

`UseCondStore` 在第 8806 到 8811 行。三個條件都要成立，偏好 `m_useCondStore`、capability `CONDSTORE`，以及 parser 的 `fUseModSeq`。登入後若有 `ENABLE` 能力且 `UseCondStore` 為真，送 `ENABLE CONDSTORE`，見第 8178 到 8180 行與第 5634 到 5641 行。`SELECT` 在第 3581 到 3584 行，條件成立時加上 ` (CONDSTORE)`。這條讀取送 `SELECT`。Morrow 的讀取送 `EXAMINE`。

`ProcessMailboxUpdate` 的抓取沒有 UID 視窗。

- 沒有已存最高 UID，或旗標狀態是空的且沒用 CONDSTORE，就 `UID fetch 1:* (FLAGS)`。`kFlags` 只加 `(FLAGS)`，見第 3779 到 3781 行。
- 已有最高 UID、開啟 CONDSTORE、不是顯示已刪除模式，而且伺服器 `HIGHESTMODSEQ` 不等於資料庫的 `mFolderLastModSeq`，同一組 `1:*` 後面加 ` (CHANGEDSINCE n)`。見第 4311 到 4324 行。
- MODSEQ 沒變時，只抓 `highestRecordedUID + 1:*` 的旗標。見第 4430 到 4444 行。

`CHANGEDSINCE` 之後用新 UID 數對 EXISTS 的差值。不相等，或 UID 索引變成負的，就清空旗標狀態再抓一次沒有 modifier 的 `1:*` FLAGS。見第 4392 到 4401 行。這補上 RFC 7162 第 3.2.1 節說的缺口。只有 CONDSTORE 時，expunge 不會出現在 `CHANGEDSINCE` 裡。

`mailnews/imap` 在這個 pin 搜尋 `QRESYNC` 與 `VANISHED` 是 0 筆。沒有第 3.2.5 節的 QRESYNC 參數，也沒有第 3.2.6 節的 `VANISHED`。註解寫的是 RFC 4551，見 `nsIImapIncomingServer.idl` 第 50 行與 `nsIMailboxSpec.idl` 第 21 行。`nsImapCore.h` 第 132 行把 CONDSTORE 標成 RFC 3551。RFC 3551 是 RTP。RFC 7162 已取代 RFC 4551 與 RFC 5162。

旗標變更不在這條 `kFlags` 指令裡下載正文。`UpdateImapMailboxInfo` 在比完 UID 之後呼叫 `SyncFlags`，函式起點是 `nsImapMailFolder.cpp` 第 4732 行，呼叫點在第 2602 行。新 UID 才進入 `m_uidsToFetch`，見第 2571 到 2572 行與 `FindUidsToAdd` 第 4211 行。

資料夾 MODSEQ 寫進 `nsIDBFolderInfo` 的 `highestModSeq` 字串屬性，見第 2511 到 2520 行。UIDVALIDITY 改變時，第 2647 行的註解說明本地 UID 全部失效。`HandleUidInvalidation` 從第 2652 行起重建摘要資料庫，第 2717 到 2718 行清掉 `highestModSeq` 與 `highestRecordedUID`。

資料夾發現有兩段上限不同的清單。某個 namespace 迴圈把 prefix 加上 `*` 後做 LSUB 與 LIST，見第 7402 到 7411 行，這段沒有個數上限。`DiscoverMailboxList` 在有 XLIST 且使用訂閱時只列兩層，`%` 與再下一層，見第 7436 到 7446 行。

連線所有權看得到的部分是 `SelectMailbox` 把這次 URL 的 folder sink 存進 `m_imapMailFolderSinkSelected`，見第 3592 到 3595 行，讓之後的 idle 或 noop 用同一資料夾。這次沒有追連線池上限與離線旗標重播。

旗標陣列的序號上限是 `kMaxMessageIndex`，`1 << 24`，見 `nsImapFlagAndUidState.cpp` 第 15 行。離線正文分組預設 2 MiB，見 `nsAutoSyncManager.cpp` 第 54 行。這個 2 MiB 只切離線正文。旗標指令仍是 `1:*`。

## 差異

| 項目 | Morrow `9b04bdf` | Thunderbird `30cdf5a` |
| --- | --- | --- |
| 觸發 | 週期 tick、`POST /sync` 或 CLI。一次同步先做可見頁，再抓 inbox 與可能的 sent，再輪 50 列快取。 | 選定資料夾後進入 `ProcessMailboxUpdate`。SELECT 使用 CONDSTORE 參數。 |
| 視窗與上限 | 新 UID 每窗 8192、每頁 32 窗、SEARCH 128 KiB、最多 50 封。旗標每輪最多 50 或 51 個已知 UID，FETCH 回應最多 50 列。全清單最多 300 個資料夾。 | 旗標同步是 `UID fetch 1:* (FLAGS)`，或同一範圍加 `CHANGEDSINCE`。沒有 UID 個數窗。高水位路徑只抓最後 UID 之後的旗標。XLIST 特殊資料夾只列兩層。namespace 的 `prefix*` LIST 沒有個數上限。 |
| 失敗與退回 | 能力被拒、ENABLE 沒確認、`EXAMINE CONDSTORE` 被拒、FETCH 被拒或沒有 MODSEQ，都退回這批 UID 的 `(UID FLAGS)`。省略在增量成功時不當刪除。UIDVALIDITY 不符只標資料夾消失並保留快取。 | 沒有 CONDSTORE、偏好關閉或 `NOMODSEQ` 就全量 `1:*` FLAGS。`CHANGEDSINCE` 的計數對不上就再抓一次全量 FLAGS。UIDVALIDITY 改變會丟掉該資料夾摘要庫與 MODSEQ。 |
| 會不會重抓正文 | 旗標對帳不抓 RFC822。新信在大小與 Message-ID 都相符時重用正文。超過 5 MiB 不抓正文。 | `kFlags` 只抓 FLAGS。已存在 UID 的旗標變化不排 header。新 UID 才下載 header。正文是後來的離線分組。 |
| 持久化與 checkpoint | 新 UID 存在 `settings.imapSync`，綁 connection、folder、UIDVALIDITY 與 uid。旗標水位存在每一列的 `imapModseq`，值是信匣 `HIGHESTMODSEQ`。背景游標是 `mailReconcile.after` 的 rowid。沒有資料夾級 highestmodseq。 | 資料夾屬性 `highestModSeq` 與 `highestRecordedUID`，加上 UIDVALIDITY。UIDVALIDITY 一變就清掉前兩者。 |
| 競爭與所有權 | 讀取用 EXAMINE。寫入旗標才 SELECT，而且只寫 `\Seen` 與 `\Flagged`。行程內 mailbox 鎖讓同步與旗標寫入同時只做一件。每次讀取新連線，做完就登出。 | 讀取用 SELECT。選定後把 folder sink 留在這條連線上。同一條連線的後續 idle 或 noop 用那個 sink。這次沒有核對連線池的最大條數。 |
| CONDSTORE 與 QRESYNC | 已知 UID 上有 CONDSTORE。QRESYNC 要 `ENABLE` 成功才加 `VANISHED`，而且只和這 50 個 UID 相交。沒有 SELECT 或 EXAMINE 的 QRESYNC 參數。 | 有 CONDSTORE 與 `CHANGEDSINCE`。`mailnews/imap` 沒有 QRESYNC，也沒有 `VANISHED`。 |

## 主線沒有 PR 34 的發現層

PR #34 的 `docs/THUNDERBIRD_IMAP_SYNC.md` 描述另一層尚未進 `9b04bdf` 的行為。背景輪先在已快取資料夾用最多 1000 個 UID 的視窗找變更，回應最多 128 KiB，一輪最多掃 32 個空視窗，遇到非空就停，佇列最多 1000 個 UID。主線仍是 50 列 `rowid` 輪詢。Thunderbird 的旗標指令仍是 `1:*`。

`discover_changes`、`CHANGE_QUEUE_LIMIT` 與資料夾級 MODSEQ 進度在目前 `rust/src/imap.rs` 與 `rust/src/reconcile.rs` 都不存在。主線那組 8192 UID、32 個視窗與 128 KiB 用在新信的 `UID SEARCH`。PR 34 把相近的數字用在 `CHANGEDSINCE` 發現。

PR 正文把 RFC 9051 第 6.4.8 節說成 UID 命令。這份 RFC 的第 6.4.8 節是 MOVE，UID 命令是第 6.4.9 節。RFC 7162 第 6 節的標題是 Updated Synchronization Sequence。形式語法在第 7 節。

## 落差與風險

Morrow 的旗標輪詢沒有資料夾級 MODSEQ 游標。一個改過旗標的快取 UID 若離 `mailReconcile.after` 很遠，要等許多個 50 列回合才會被看到。可見頁的 51 列不受這個游標限制。這是輪詢延遲。無上限的 `1:*` 會拿掉 Morrow 現有的 50 列與 128 KiB 界限。

未變更的 `CHANGEDSINCE` 省略列仍帶著快取的 `read` 與 `starred` 進入 `import_read_state`。若本地星號與 `providerSnapshot.starred` 不同，這條路徑會把快取值當成遠端觀察。PR #34 要改的就是這件事。修法不在主線。這次沒有跑對應 fixture。

一批已知 UID 裡只要有一列沒有連線 proof，`minimum` 就是 0，整批退回完整 FLAGS。QRESYNC 的 `VANISHED` 也只覆蓋這一批。批次以外的 expunge 要等 rowid 輪到。這比 Thunderbird 的全量 FLAGS 省，也比 RFC 7162 第 3.2.5 節的信匣級 QRESYNC 窄。

Morrow 在 UIDVALIDITY 改變時保留快取並標成資料夾消失。Thunderbird 重建該資料夾資料庫。保留快取符合 Morrow 不把刪快取當成 onboarding 的規則。不應為了對齊 Thunderbird 而清掉使用者已下載的信。

主線文件有兩套說法。`docs/SYNC_PERFORMANCE.md` 與 `FEATURE_COVERAGE.md` 第 26 行說已知 UID 的 QRESYNC 已做。`FEATURE_COVERAGE.md` 第 178 行與使用指南仍說沒做。讀文件的人會把現行行為看成未實作。

## 可選的後續

這些都還沒做。這份 PR 只有比較。

- 若要縮短旗標延遲，做有界的資料夾 MODSEQ 發現，並保留 UID 數、回應大小與每輪寫入上限。
- 未變更列沿用已驗證的 provider snapshot。缺 snapshot 就重讀 FLAGS。
- 把使用指南與 `FEATURE_COVERAGE.md` 第 178 行改成和 `imap.rs` 相同的範圍，也就是已知 UID 的 CONDSTORE 與 QRESYNC。
- 後續實作繼續用 Morrow 的 Rust。UIDVALIDITY 改變時保留已下載正文。

## 證據

Morrow 這次讀過的範圍如下。

- `rust/src/imap.rs` 第 413 到 480 行、第 630 到 735 行、第 747 到 820 行、第 873 到 1194 行、第 1460 到 1721 行
- `rust/src/reconcile.rs` 全文，第 1 到 154 行
- `rust/src/mail.rs` 第 399 到 435 行、第 988 到 1039 行
- `rust/src/background.rs` 第 1287 到 1295 行
- `rust/src/sync_priority.rs` 第 15 到 16 行
- `docs/SYNC_PERFORMANCE.md` 第 103 到 119 行
- `FEATURE_COVERAGE.md` 第 26 行與第 178 行
- `docs/USER_GUIDE.md` 第 263 行

Thunderbird 在 `/tmp` 對過 `30cdf5a03b41253e744bc058a699c1947a2b8123`，並用 `git rev-parse` 確認上面三個 blob 與 `4d8f5f89a54280d9e7df4fa692dc29e59add9b73` 相同。`git grep` 在 `mailnews/imap` 沒有 `QRESYNC` 或 `VANISHED`。

沒有執行 `cargo test`，沒有登入郵件帳號，也沒有執行 Thunderbird。
