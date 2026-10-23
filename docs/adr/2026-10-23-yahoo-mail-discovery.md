# Yahoo Mail and address discovery

Yahoo Mail is a provider button beside Google and Microsoft. It uses the existing IMAP app-password path (`imap.mail.yahoo.com:993` implicit TLS, `smtp.mail.yahoo.com:465` implicit TLS). There is no Yahoo OAuth client in this repo.

Yahoo's IMAP server advertises `SASL-IR` and `AUTH=PLAIN`, then answers a second empty challenge when PLAIN is sent without the initial response. ImapFlow waits on that challenge, so a correct app password never finishes. Those hosts use the IMAP `LOGIN` command, which completes with the same app password.

Other typed addresses reuse that form. Discovery follows neverest's order for mail only: known domain, one MX suffix check, Thunderbird autoconfig (ISP, `/.well-known`, ISPDB), then RFC 6186 SRV. PACC, JMAP, CalDAV, and CardDAV are not used. Proton Bridge is loopback-only, so discovered loopback hosts are ignored.
