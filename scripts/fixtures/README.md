# Historical bot Sent fixture

`legacy-bot-alias-sent.json` was captured by executing the unmodified v0.3.0
`host/bot/send.js`, `submitSmtp`, `fileSentMessage` and `noteBotSent` implementations
at `5f50132ec07d818330e12bd73f8f7b18d823d7d4`. The generator checks their source
hashes. SMTP is synthetic; all accounts, grants, recipients and receipts are local
test data. No real provider, listener, keychain or OAuth grant is used.

The two cases cover a normal local Sent insert and the bot fallback after a
synthetic local insertion failure. Both were sent from an explicitly configured
different-domain alias, so the original bot generated its RFC id from that alias.
The JSON contains the actual insertion inputs, old database columns, and durable
submitted receipts. It contains no bearer token or credential.

To regenerate with dependencies compatible with your Node version:

```bash
legacy_root=$(mktemp -d /tmp/morrow-legacy-source-XXXXXX)
git archive 5f50132ec07d818330e12bd73f8f7b18d823d7d4 | tar -x -C "$legacy_root"
ln -s "$PWD/node_modules" "$legacy_root/node_modules"
node scripts/fixtures/capture-legacy-bot-alias.js "$legacy_root" scripts/fixtures/legacy-bot-alias-sent.json
```

An optional third argument preserves the generated synthetic profile in an empty
directory, for opening the actual old SQLite database with a later implementation.
That profile includes newly generated synthetic bot grants; do not use a real
profile. The default removes the temporary profile after capture.

`check-fresh-review-fixes.js` imports these records, checks every original database
column, closes and reopens SQLite, and exercises real Reply/Reply All context and
recipient selection. The normal check needs neither Git history nor old modules.
Counterexamples retain unknown remote header requirements, and a provider fetch
can adopt the legacy alias row and replace the repaired empty Reply-To.
