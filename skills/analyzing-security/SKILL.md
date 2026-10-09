---
name: analyzing-security
description: "This skill should be used when auditing code, configuration, dependencies or frontend markup for vulnerabilities, tracing untrusted input to sinks, confirming exploitability, rating severity, or writing security findings."
---

# Analyzing Security

Report only vulnerabilities with a plausible attack path. Without one, label the item a hardening concern, not a vulnerability. Never infer safety without file/line or config evidence.

## Process

1. Map the attack surface: routes and API handlers; auth, session, reset, MFA and admin flows; uploads, downloads and file paths; webhooks, queues, cron, CLI and IPC inputs; server-side fetches; templates, database, shell, deserializers, redirects.
2. Trace each untrusted value (user, tenant, role, object ID, URL, path, serialized data, upload): `source → validation/canonicalization → authorization → transform/store → sink`.
3. Mark each OWASP category pass, fail or N/A with evidence.
4. Run available static and dependency scanners. Verify every finding manually; suppress only with a written justification.
5. Confirm exploitability; rate severity.
6. Repeat until no new sources, sinks, auth paths, dependency alerts or design flaws appear.

## OWASP Checks

| Category | Required checks |
|---|---|
| A01 Access Control | authz on every sensitive endpoint; horizontal (object) and vertical (role) escalation blocked; path traversal blocked; no wildcard credentialed CORS |
| A02 Cryptography | TLS 1.2+; no secrets/PII in source, logs, URLs or errors; passwords hashed with Argon2/bcrypt/scrypt/PBKDF2; CSPRNG for tokens; no ECB or static IVs |
| A03 Injection | parameterized queries; no shell with user input (argv arrays, allowlists); no user-controlled eval; output encoding matches the sink |
| A04 Insecure Design | threat model for sensitive features; rate limits; server-side business rules; re-auth for dangerous operations |
| A05 Misconfiguration | defaults and unused features removed; debug off; production hides stack traces; security headers set |
| A06 Components | dependency audit run; critical/high CVEs and abandoned packages assessed for reachability |
| A07 Authentication | throttled login; time-limited single-use reset tokens; logout invalidates session; long random session IDs; MFA for privileged users |
| A08 Integrity | no deserialization of untrusted data into objects; pinned/signed CI actions, artifacts and images |
| A09 Logging | auth, authz failures and admin actions logged and alerted; no secrets/PII in logs |
| A10 SSRF | server-side fetches use host allowlists; block localhost, private, link-local and metadata ranges, including after redirects and DNS rebinding |

Baseline headers: nonce/hash `Content-Security-Policy` (no `'unsafe-inline'`/`'unsafe-eval'`, with `base-uri`, `form-action`, `frame-ancestors`); `X-Content-Type-Options: nosniff`; HSTS; `Referrer-Policy: strict-origin-when-cross-origin`; restrictive `Permissions-Policy`.

## Severity

Use the highest level that applies.

| Severity | Criteria | Examples |
|---|---|---|
| Critical | easy or unauthenticated exploit, catastrophic impact | RCE, auth bypass, SQLi data dump, exposed credential |
| High | major data or system impact under conditions | privilege escalation, sensitive-data exposure, privileged XSS, unsafe deserialization |
| Medium | limited or interaction-dependent impact | CSRF state change, weak reset, information leak |
| Low | defense in depth | verbose errors, weak cookie flags, missing rate limits |

Fix Critical before deploy, High in the current cycle, Medium/Low in the backlog.

## Finding Format

Order findings Critical → Low; use this structure for each:

```text
SEVERITY: Critical | High | Medium | Low
TYPE: <class> (CWE-NNN)
LOCATION: <file:line>
VULNERABLE CODE: <exact snippet>
ATTACK SCENARIO: <step-by-step exploitation path>
IMPACT: <specific consequence>
REMEDIATION: <fixed code or exact corrective action>
REFERENCES: OWASP <AXX:YYYY category>; CWE-NNN; CVE (if any)
```
