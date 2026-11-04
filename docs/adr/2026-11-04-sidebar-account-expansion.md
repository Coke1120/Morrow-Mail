# Per-account sidebar expansion

Account headers now use a native button for every provider. Provider-wide flags could not represent two Gmail accounts independently, and Yahoo/custom accounts had no collapse control.

Store explicit boolean choices by stable mailbox id in `settings.json` under `sidebarAccountFoldersExpanded`. The new getter returns the map; the setter accepts `{ accountId, expanded }` and synchronously patches just that entry into the latest store. Reads validate ids and booleans and bound the map like folder-collapse preferences. No credentials or provider writes are involved.

Migration is lazy: absence of a per-account entry retains the prior Gmail/Outlook flag; other providers remain expanded. Existing provider preference channels remain supported and the General controls are labeled as defaults. A deliberate header toggle saves an override, including explicit expansion, which survives changes to the defaults and application restart. Older versions ignore the new field.

Renderer acknowledgements update only the target account and discard older acknowledgements for that account. Failure recovery updates just that entry; preference snapshots cannot overwrite a newer or still-pending toggle. Filtering expands matches only in the display. Collapse All changes folder descendants and preserves both account expansion and the separate All Account Mail section. Arrow Left/Right use the same tree behavior for every account.
