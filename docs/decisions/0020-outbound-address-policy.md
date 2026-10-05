# 0020. Outbound address policy: no server-side requests to internal addresses

- **Status:** Accepted
- **Date:** 2026-10-05

## Context

xitl makes HTTP requests from inside the homelab cluster to URLs it did not
choose:

- the **upstream URL** a user enters (any http(s) address so far),
- every URL the upstream's **OAuth discovery** hands out (protected-resource
  metadata → authorization server → registration and token endpoints), which
  the upstream controls completely,
- the **Web Push endpoint** a browser subscription names (https only so far).

So far nothing stopped any of these from pointing at `127.0.0.1`, a cluster
service, the node's LAN or `169.254.169.254`. Responses aren't shown to the
caller, but status codes, timing and errors still let someone probe the
internal network, and the endpoint receives a request xitl made (and, for an
upstream, its credentials). Redirects are already refused everywhere (TC-47).
The threat that matters is a malicious or compromised upstream steering
discovery inward. A household user who types an internal URL is the lesser
case.

## Decision

- **All outbound HTTP goes through one guard** (`apps/api/src/lib/outbound.ts`):
  the upstream MCP fetch, the OAuth fetch and web push. Nothing else in
  `apps/api/src` calls `fetch` directly (a unit test scans for it).
- **Blocked destinations**, checked against the **address actually connected
  to**. The check sits in the DNS lookup of the connection, so a DNS answer
  that changes between check and connect (rebinding) can't slip past. IP-literal
  hosts are checked before connecting. The blocked ranges are:
  - IPv4: `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`,
    `192.0.0/24`, `192.168/16`, `198.18/15`, `224/4`, `240/4`.
  - IPv6: `::`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`.
  - IPv6 addresses with an embedded IPv4 address (`::ffff:0:0/96`,
    `64:ff9b::/96`, `2002::/16`): judged by that IPv4 address.

  If a name resolves to several addresses and **any** of them is blocked, the
  request is refused.
- **Exception per upstream, confirmed by the user** (Matthias, 2026-10-05):
  when an upstream's URL is internal at save time, the API refuses it with
  `code: "internal_address"` and the form explains why and offers
  "Trotzdem erlauben". Saving again with `allowInternal: true` stores
  `Upstream.allowInternal = true`, but **only if the URL really is internal at
  that moment**. A public URL never gets the flag, so a public host can't later
  re-point its DNS inward under it. A flagged upstream may reach **its own URL's
  host and port** at any address, including during OAuth discovery. Any other
  host stays guarded, so discovery steering to another internal host is still
  refused. A URL change recomputes the flag, which means re-confirming. The
  list shows a flagged upstream as "intern". No deploy config is needed.
- **Admin override `OUTBOUND_ALLOW_PRIVATE`** (optional, empty by default): a
  comma-separated list of `host` or `host:port` entries (exact hostname or IP
  literal, case-insensitive; IPv6 as `[::1]:3210`) that skip the address check
  for every user and for push. It matches the **name in the URL**, not the
  address, so `localhost` is still blocked when only `127.0.0.1` is listed.
  Malformed entries are ignored with a warning at boot. e2e uses it for the
  fake upstream.
- **Two enforcement points:**
  - **At save time** (create/edit an upstream URL, subscribe a push endpoint),
    xitl resolves the host and refuses with a German 400 if it's blocked. This
    is for UX only. A name that doesn't resolve may still be saved.
  - **At request time** (connect-level), which is the real enforcement. A
    blocked upstream request fails like any other unreachable upstream:
    generic error to the agent, OAuth connect shows a German `ConnectError`,
    and the log line names the hostname only (no path or query, which could
    carry secrets).
- Plain `http://` stays allowed for public addresses. Redirects stay refused.
  `HTTP(S)_PROXY` environment variables are not supported.

## Consequences

- **Deploy:** nothing to configure. If the siblings' public hostnames resolve
  to internal addresses inside the pod (split DNS or hairpin), their existing
  upstream rows stop working until each user opens the upstream, saves it and
  confirms "Trotzdem erlauben". (Existing rows are not flagged by the
  migration: nobody confirmed them.) `OUTBOUND_ALLOW_PRIVATE` is the
  alternative for an admin who prefers config.
- An existing upstream whose host became blocked stops working at the next
  call. It doesn't disappear and keeps its policies.
- Any user can open their own upstream's host to internal addresses, but only
  for their own calls, after an explicit confirmation, and only for that one
  host and port. That fits a two-person household where both users are trusted.
  The agent cannot do it (ADR-0005: no config through MCP).
- e2e lists only the fake upstream (`127.0.0.1:3210`); the sink port stays
  blocked and serves as the "internal" target.
- A URL on the env list counts as "not internal" at save time, so it never
  gets the flag. If the admin later removes that host from the list, the
  upstream stops working until its URL is changed and confirmed. Re-saving the
  same URL doesn't ask again, because an unchanged URL keeps its flag.
- Adds the `undici` package for a connect-time `lookup` on Node's fetch.

## Alternatives considered

- **Upstream hosts allowed automatically, without confirmation:** a public
  upstream could re-point its own DNS at `169.254.169.254` and xitl would
  follow.
- **A global host list in Einstellungen:** any user would open hosts for
  everyone.
- **Allowlist of upstream hosts only:** every new upstream would need a
  deploy, and discovery URLs would still need their own check.
- **Check once at save time:** DNS can change after the check, and
  discovery URLs never pass through a save.
- **Egress NetworkPolicy in the cluster only:** a good second layer
  (Matthias's side), but it lives outside the repo and the e2e can't test it.
  Recommended in addition, not instead.
