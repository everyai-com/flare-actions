# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's
private vulnerability reporting instead: **Security tab → Report a
vulnerability** on this repository. We aim to acknowledge reports within a
few days and will coordinate a fix and disclosure with you.

Include, when possible:

- the affected route / component and a minimal reproduction,
- the impact you believe it has,
- any suggested remediation.

## Supported versions

Only the `main` branch is supported — fixes land there and are deployed by
pulling the latest commit.

## Design notes for reporters

Some behavior is deliberate, so reports are most useful when they go beyond
these boundaries:

- **Pre-claim bootstrap is open by design.** On a fresh deploy, until the
  first admin claims (`/v1/admin/bootstrap`, first GitHub login, or
  `/v1/admin/github/connect`), those endpoints are unauthenticated so a
  one-click deploy can be set up with no terminal access. Claim the admin
  account immediately after deploying a public URL.
- **Secrets at rest use a two-tier key ladder.** Repo secrets and
  dashboard-managed GitHub App credentials are AES-GCM encrypted; the data
  key comes from the `SECRETS_KEY` secret when set (real at-rest
  protection), otherwise from an auto-generated D1 value (protects only
  against casual reads). Set `SECRETS_KEY` for production use.
- **Auth endpoints are rate-limited** per email and per hashed client IP
  (`auth_attempts`); one-time tokens (invites, OAuth state, GitHub connect
  state) are consumed atomically.
- **The status badge endpoint is public by default** (like GitHub's own
  badges). Private repos should be listed under Settings → Status badges,
  which makes the endpoint serve `unknown`.

## Hardening checklist for self-hosters

- Claim the admin account immediately after the first deploy; share the
  URL only with your team until then.
- Set `SECRETS_KEY` (recommended) or accept the D1-held fallback with its
  weaker threat model.
- Scope your Cloudflare API token to the Worker + D1 + Queues it needs —
  never account-wide credentials.
- Scope your GitHub App to the repos it needs, with the minimum
  permissions (the manifest sets contents read, pull requests read,
  commit statuses write).
