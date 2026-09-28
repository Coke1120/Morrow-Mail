# Google / Outlook OAuth 設定

核對日期：2026-09-28。以下依照 Morrow Mail 的 Rust 正式服務與 Node 相容服務目前實際要求的權限整理；不代表已登入驗證你的 Google Cloud／Entra 專案設定。

## 先確認要修改哪個專案

- **Google**：使用內建登入時，修改發佈版本所打包的 Google Desktop OAuth client 所屬專案。使用自訂 client 時，修改該 client 的專案。單純增加 scopes **不用重新建立 client 或下載新的 JSON**。
- **Outlook**：目前使用 **Microsoft Graph v1.0**。Windows 改為 WinUI／Rust 不會要求更換 OAuth app。內建的公開 Application (client) ID 為 `2ca9ca19-add5-4807-bfa1-c2a7ac3cc6bf`，兩個平台及 mail/calendar 共用；它不是 secret。請修改這個 Entra app，或你在 Advanced 輸入的自訂 app。
- 若你只是使用者、不是內建 client 的擁有人，不需要為內建登入另建專案；雲端設定由發佈者處理，你在 app 內完成同意即可。

## Google：新增 Out of Office 與 Calendar

1. 開啟 [Google Cloud Console](https://console.cloud.google.com/)，選取現有 Desktop OAuth client 的專案。
2. 在 **APIs & Services → Library** 啟用 **Gmail API**；使用 Calendar 時再啟用 **Google Calendar API**。
3. 到 **Google Auth Platform → Data Access → Add or remove scopes**，按功能加入下列 scopes 並儲存。若清單搜尋不到，可在手動輸入欄貼上完整 scope URL。

| 功能 | Morrow 要求的 scopes |
| --- | --- |
| 基本郵件登入、讀取、寄送 | `openid`、`email`、`https://www.googleapis.com/auth/gmail.readonly`、`https://www.googleapis.com/auth/gmail.send` |
| 移動郵件／管理 labels | `openid`、`email`、`https://www.googleapis.com/auth/gmail.modify`；勾選移動權限時，Morrow 以此取代上述 readonly/send 組合 |
| **Out of Office 額外權限** | **`https://www.googleapis.com/auth/gmail.settings.basic`** |
| Calendar 的獨立授權 | `openid`、`email`、`https://www.googleapis.com/auth/calendar.calendarlist.readonly`、`https://www.googleapis.com/auth/calendar.events` |

`gmail.modify` 本身不足以設定自動回覆；Gmail 的 `users.settings.updateVacation` 明確要求 `gmail.settings.basic`。不需要為這項功能加入 `gmail.settings.sharing` 或建立 service account。[Google vacation API](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.settings/updateVacation)、[Calendar scopes](https://developers.google.com/workspace/calendar/api/auth)

4. 在 **Audience** 確認：外部 app 若仍在 **Testing**，將要登入的帳號加入 **Test users**。這些非基本 scopes 的測試 refresh token 通常會在 **7 天**到期，屆時需要重新連線。公開提供其他人使用時，依 Google 要求完成敏感／受限制 scopes 驗證；切換 In production 並不等於通過驗證。[Google token 到期規則](https://developers.google.com/identity/protocols/oauth2#expiration)、[OAuth verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)
5. 在 **Clients** 保留 **Desktop app** 類型。Morrow 使用本機 loopback callback；不要改成 Web application，也不用設定 Web client 的 Authorized redirect URIs。Google Desktop loopback 適用於 macOS／Windows。[Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)
6. 回到 Morrow，先選取**個別 Gmail 帳號**，開啟 **Out of Office → Allow Out of Office settings…**，確認後在瀏覽器登入同一個帳號，接受新增權限。
7. 回到 Out of Office，按 **Refresh provider settings**（macOS 的重新整理按鈕），填寫內容及日期，檢查預覽後確認儲存。**授權本身不會啟用自動回覆。**
8. Calendar 另外到 **Settings → Calendar → Google Calendar** 登入。Mail 與 Calendar 是獨立授權；成功開啟 Out of Office 不代表已連接 Calendar。

若你更換了 Google client，而不只是增加 scopes，才需要更新打包用的 GitHub Actions secret `GOOGLE_DESKTOP_OAUTH_JSON`，或自訂 client 的 ID/secret。JSON 必須是下載檔內含 `installed` 的 Desktop client；不要把使用者 access/refresh tokens 放進去，也不要提交至 Git。

## Outlook / Microsoft 365：Microsoft Graph 設定

1. 開啟 [Microsoft Entra admin center](https://entra.microsoft.com/) → **App registrations → All applications**，依上方 client ID 找到 Morrow 的 app。不要只在 Enterprise applications 修改使用者指派；OAuth 設定位於 App registrations。
2. 在 **Supported account types** 確認選擇 **Accounts in any organizational directory and personal Microsoft accounts**，才能同時支援工作／學校及 Outlook.com 個人帳號。
3. 在 **Authentication → Add a platform → Mobile and desktop applications**，保留／加入以下兩個 custom redirect URIs：

   ```text
   http://localhost:3001/api/oauth/microsoft/callback
   http://localhost:3001/api/calendar-oauth/microsoft/callback
   ```

   Morrow 桌面版會選擇可用的隨機本機 port；Microsoft 比對 `localhost` redirect 時忽略 port，但 **path 必須符合**。郵件及 Calendar 的 callback 不相同，兩個都要登記；不要用 `https`、SPA 或 Web 平台取代它們。[Redirect URI 規則](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url)

4. 在 Authentication 的進階設定啟用 **Allow public client flows**。這是 public desktop client，Morrow 不需要 Microsoft client secret。[Microsoft desktop registration](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-registration)
5. 到 **API permissions → Add a permission → Microsoft Graph → Delegated permissions**，按實際功能加入：

   | 功能 | Delegated permissions |
   | --- | --- |
   | 基本讀信／寄信 | `User.Read`、`Mail.Read`、`Mail.Send`、`offline_access` |
   | 移動郵件、Junk 等操作 | `Mail.ReadWrite`，保留 `User.Read`、`Mail.Send`、`offline_access` |
   | **Out of Office** | **`MailboxSettings.ReadWrite`** |
   | Calendar | `Calendars.ReadWrite`，以及 `User.Read`、`offline_access` |

   請選 **Microsoft Graph／Delegated**，不是 Office 365 Exchange Online 的舊權限，也不是 Application permissions。`Mail.ReadWrite` 不包含寄信或修改自動回覆所需權限。`MailboxSettings.ReadWrite` 支援工作／學校及個人 Microsoft 帳號。[Graph permissions](https://learn.microsoft.com/en-us/graph/permissions-reference)、[Mailbox settings API](https://learn.microsoft.com/en-us/graph/api/user-update-mailboxsettings?view=graph-rest-1.0)

6. 儲存。若組織限制使用者 consent，請該租戶管理員批准實際要求的權限；是否需要 admin consent 取決於租戶政策。
7. 回到 Morrow：需要移動郵件時，在 **Settings → Mail** 勾選 provider moves 權限並重新登入；需要 Out of Office 時，選取原 Outlook 帳號 → **Out of Office → Allow Out of Office settings…**，完成額外同意後重新整理。Calendar 仍從 **Settings → Calendar → Outlook Calendar** 單獨登入。

## 設好後怎樣確認

- Out of Office 顯示原帳號的 provider 設定，且不再要求新增權限，才代表這個帳號的授權已完成。先檢查讀取結果；只有你確認儲存，才會修改 provider 的自動回覆。
- 只在 Cloud／Entra console 加入權限，不會更新已發出的 token。使用上面的新增同意流程；不必先 Disconnect，也不用清除本機快取或草稿。
- `redirect_uri_mismatch`／`AADSTS50011`：核對 client 類型、實際 client ID，以及 callback 的 host/path；郵件與 Calendar 不可混用 path。
- `access_denied`／app blocked：核對 Google Test users／驗證狀態，或 Microsoft 租戶 consent 政策。
- 同意後仍要求權限：核對是否修改了正在使用的 client，以及瀏覽器是否登入原郵箱。Morrow 會拒絕不完整授權或錯誤帳號，保留原連線。
- IMAP／Yahoo 不支援 app 內的 provider Out of Office；請到該郵件服務網站設定。

本次提供設定指引，沒有修改你的 Cloud／Entra 後台，也沒有寄送郵件或開啟真實自動回覆。
