# OpenGovAL IMAP multi-user beta

This is a separate Workers deployment, not an in-place change to the original single-user D1 instance.

## Model

- The mail provider authenticates existing @opengoval.org mailbox credentials over TLS at web.fxs.se:993.
- A successful IMAP login automatically creates a mailbox profile (IMAP 993 and SMTP 465) and a private SQLite-backed Durable Object, keyed by the normalized email address. No registration, separate application password, or administration panel.
- Every protected handler gets only that user's database. The legacy D1 database is never bound. Session cookies contain an authenticated routing envelope and an independent random session token; both must validate.
- The provider password is encrypted using a per-user key derived from TOKEN_ENC_KEY. A fixed five-minute verification lease prevents indefinite access to cached mail after provider revocation. Failed reauthentication invalidates sessions and halts the alarm. Sync alarms run while a session remains active.
- Additional password-authenticated IMAP accounts can be added within the user's isolated profile. The unified inbox uses only that user's accounts. No credentials or cached records are copied from the old deployment.
- The primary account's credentials, host and deletion are protected; management remains in Plesk. Configuration import/export, application TOTP, OAuth, external archives, push, and relay accounts are not enabled for this beta.
- True provider-delegated shared folders and ACLs remain future work, pending confirmation of No Ack's IMAP ACL support. Do not treat sharing a mailbox password as delegated access.
- Reassigning a deleted mailbox address to a different person requires a deliberate old-profile purge; IMAP login alone cannot distinguish a newly created mailbox with the same username. Do not recycle addresses during this beta.
- The master key is required for existing credentials and sessions. Store a private backup; do not rotate it without a migration plan.
- This beta is not yet verified against a real Durable Object runtime or No Ack login. Keep the current deployment until two independent test accounts prove isolation.

## Deploy the isolated beta

Copy deploy/opengoval/wrangler.jsonc.example to the repository root as
wrangler.opengoval.multiuser.local.jsonc. Add the local file to .git/info/exclude.
Set CLOUDFLARE_ACCOUNT_ID to the intended account and keep the Worker name distinct.

```sh
npm ci
VITE_OPENGOVAL_IMAP_LOGIN=1 npm run build
npx vitest run tests/opengoval-identity.test.ts
npx wrangler deploy --config wrangler.opengoval.multiuser.local.jsonc --secrets-file /path/to/private-secrets.json
```

The secrets JSON must contain a fresh TOKEN_ENC_KEY (base64, 32 random bytes).
No APP_PASSWORD or D1 database is necessary. Never commit the secrets file.

## Essential acceptance checks before replacing the live domain

1. Sign in as two existing mailboxes using separate browser profiles. Both should automatically receive their own mailbox. Verify actual IMAP retrieval and SMTP send.
2. Request account, message, attachment, thread, contact, label and settings APIs using the other user's identifiers. No foreign data or mutation may be possible. Tampered cookies, the old shared application password, and missing cookies must fail.
3. Change a test mailbox password in Plesk; the old session must lose access within five minutes and the new password must work. Verify wrong-password login and logout.
4. Verify extra accounts and the unified inbox within only one profile, and verify no duplicate or cross-user scheduled sync.
5. Inspect the Worker logs for unexpected SQLite compatibility errors and confirm no secrets in logs.

Do not attach mail.opengoval.org to the beta before these checks. The original Worker remains the rollback option. Existing contacts, filters and labels are not automatically migrated.
