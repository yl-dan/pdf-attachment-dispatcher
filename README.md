# PDF Attachment Dispatcher

A Google Apps Script web app that fetches remote PDF documents and dispatches
them as email attachments.

It solves a gap common to workflow automation platforms: they can generate or
locate a document URL, but many cannot attach a remote binary to an outbound
email. This service accepts a JSON request, retrieves the documents, and sends
them from a Google Workspace account.

## Why this exists

Most published examples of this pattern expose a public endpoint that will
fetch any URL and mail it to any address. That is an open relay and an SSRF
primitive at the same time. This implementation treats the endpoint as
untrusted input from the first line.

| Control | Purpose |
|---|---|
| Shared-secret authentication | Rejects unauthenticated callers before any field is parsed |
| Constant-time token comparison | Prevents timing-based token recovery |
| Source host allowlist | Blocks SSRF — only approved hosts can be fetched |
| Recipient domain allowlist | Prevents the endpoint being abused as a spam relay |
| Content-type verification | Rejects sources that do not return a real PDF |
| Per-file and total size caps | Bounds resource consumption |
| Filename sanitization | Strips path separators and control characters |
| Generic error responses | Failures are logged in full, disclosed minimally |
| No hardcoded configuration | All secrets and allowlists live in Script Properties |

## Setup

1. Create a new Apps Script project and paste `Code.gs`.
2. Open **Project Settings → Script Properties** and add:

   | Property | Example | Description |
   |---|---|---|
   | `SHARED_SECRET` | `<random 32+ char string>` | Token every caller must send |
   | `ALLOWED_SOURCE_HOSTS` | `docs.example.com,files.example.com` | Comma-separated hosts that may be fetched |
   | `ALLOWED_RECIPIENT_DOMAINS` | `example.com` | Comma-separated recipient domains |

   Optional, for monitoring:

   | Property | Example | Description |
   |---|---|---|
   | `CALLBACK_WEBHOOK_URL` | `https://automation.example.com/webhook/dispatch-monitor` | Endpoint notified after each dispatch. Skipped if unset. |
   | `CALLBACK_TOKEN` | `<random string>` | Sent as `Authorization: Bearer`. Skipped if unset. |

   The callback host must also appear in `ALLOWED_SOURCE_HOSTS`.

3. Deploy as **Web app**:
   - Execute as: *Me*
   - Who has access: *Anyone* (the shared secret is the access control)
4. Copy the deployment URL into your automation platform.

> Generate the shared secret with a password manager or
> `openssl rand -hex 32`. Never commit it.

## Request format

`POST` to the deployment URL with `Content-Type: application/json`:

```json
{
  "token": "<SHARED_SECRET>",
  "to": "recipient@example.com",
  "subject": "Monthly report",
  "body": "Please find the attached documents.",
  "documents": [
    { "url": "https://docs.example.com/report-01.pdf", "name": "Report 01" },
    { "url": "https://docs.example.com/report-02.pdf", "name": "Report 02" }
  ]
}
```

### Success

```json
{ "status": "success", "attachments": 2, "bytes": 184320 }
```

### Failure

```json
{ "status": "error", "message": "Request could not be processed." }
```

The specific cause is written to the Apps Script execution log, not returned
to the caller.

## Limits

| Setting | Default |
|---|---|
| Attachments per request | 5 |
| Size per file | 10 MB |
| Total size per request | 20 MB |
| Subject length | 200 characters |
| Body length | 20,000 characters |

Google Workspace also enforces its own daily sending quota, which varies by
plan and applies on top of these limits.

## Notes

- Redirects are not followed. An allowlisted host that redirects elsewhere
  would otherwise defeat the source allowlist.
- The body is sent as plain text. HTML bodies would require output encoding
  to avoid injection through the `body` field.
- Rotate `SHARED_SECRET` by updating the Script Property and the caller
  configuration. No redeployment is needed.
- The monitoring callback is fire-and-forget. Its failures are logged and
  swallowed, so a monitoring outage never turns a delivered email into a
  reported error.
- A webhook URL is itself a credential — unauthenticated by default, and
  anyone holding it can inject events. It belongs in Script Properties, not
  in source control.

## Tech

Google Apps Script (JavaScript), `UrlFetchApp`, `MailApp`, `PropertiesService`.

## License

MIT — see [LICENSE](LICENSE).
