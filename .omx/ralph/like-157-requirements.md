# LIKE-157 requirement and evidence matrix

## Evidence rules

This inventory covers `.omx/prd.json`, the original Security and SSO request, the reopened review findings, and the Enterprise-mode request. It cites only allowed paths and does not inspect, quote, or modify `apps/server/src/ee`, `apps/client/src/ee`, `packages/ee`, or `packages/base-formula`.

Each status is exactly one of:

- **existing**: an allowed-root capability pre-existed this work; no new behavior is claimed.
- **independently-implemented**: allowed implementation and focused-test source exist, and an earlier focused run is recorded.
- **missing**: the allowed-root inventory has no implementation and focused-test source for the requested behavior.
- **runtime-unverified**: source and, where listed, focused tests exist, but fresh late-fix execution is unavailable or incomplete.

Local explicit regressions passed: 82 allowed server suites / 495 tests, 18 allowed client test files / 33 tests, server/client/editor builds, and server lint on 247 allowed TypeScript files. Completion remains `false`: restored acceptance gates require exact locked TanStack 5.94.4 client lint without bypass, substitution, fabrication, or registry probe; live independent Authentik OIDC and SCIM; migration/runtime evidence on issue-isolated parameterized resources; reproducible image identity; exact pushed SHA and PR; and manager review.

## Documentation and protocol evidence

- [Snapshot artifact](../../docs/LIKE-157-DOCS-SNAPSHOT.json) embeds normalized official excerpts with SHA-256 digests. It is a content-addressed excerpt pin, not an upstream-revision pin; capture time is evidence time.
- [Docmost Editions](https://docmost.com/docs/editions), [feature list](https://docmost.com/docs/), [OIDC](https://docmost.com/docs/user-guide/authentication/oidc), [SAML](https://docmost.com/docs/user-guide/authentication/saml), [LDAP](https://docmost.com/docs/user-guide/authentication/ldap), and [SCIM](https://docmost.com/docs/user-guide/authentication/scim) support product-surface rows.
- [OAuth 2.0 Security BCP](https://www.rfc-editor.org/rfc/rfc9700), [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html), [SAML Core](https://docs.oasis-open.org/security/saml/v2.0/saml-core-2.0-os.pdf), [SAML Profiles](https://docs.oasis-open.org/security/saml/v2.0/saml-profiles-2.0-os.pdf), [LDAP](https://www.rfc-editor.org/rfc/rfc4511), [LDAP filters](https://www.rfc-editor.org/rfc/rfc4515), [SCIM schema](https://www.rfc-editor.org/rfc/rfc7643), [SCIM protocol](https://www.rfc-editor.org/rfc/rfc7644), and [TOTP](https://www.rfc-editor.org/rfc/rfc6238) support protocol rows.
- [Authentik OAuth/OIDC](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/) and [Authentik SCIM](https://docs.goauthentik.io/docs/providers/scim/) establish configuration-shape compatibility only. No live Authentik login, SCIM provisioning, deployment, credential, or vendor-account result is claimed.

## Security and SSO

| Requirement | Allowed implementation evidence | Focused test evidence | Status |
| --- | --- | --- | --- |
| Self-hosted SSO capability is independent of vendor license validation | `integrations/environment`; `core/auth-provider/sso-capability.service.ts` | `environment.service.spec.ts`; `sso-capability.service.spec.ts` | independently-implemented |
| Provider CRUD has workspace authorization, encrypted secrets, redacted responses, and persisted `allowSignup` | `core/auth-provider`; `database/repos/auth-provider`; Security settings form | `auth-provider.service.spec.ts`; `provider-input.test.ts` | independently-implemented |
| Enabled providers appear at login; Enforce SSO retains owner recovery; provider-gated signup is enforced | provider login, auth utility, signup service | `provider-login.test.ts`; `auth.util.spec.ts`; `auth.service.spec.ts` | independently-implemented |
| OIDC uses authorization code, PKCE, state, nonce, verified identity, and `email_verified` before linking or signup | `oidc.service.ts`; `federated-identity.ts`; `sso.controller.ts` | `oidc.service.spec.ts`; `federated-identity.spec.ts`; `sso.controller.spec.ts` | independently-implemented |
| SAML verified identity reaches domain, matching-email link, profile update, and signup policy | `saml.service.ts`; `federated-identity.ts`; `federation.config.ts` | `saml.service.spec.ts`; `federated-identity.spec.ts`; `federation.config.spec.ts` | independently-implemented |
| LDAP authenticates before mapped identity attributes reach matching-email link, profile update, domain policy, and signup | `ldap.service.ts`; `federated-identity.ts`; `federation.config.ts` | `ldap.service.spec.ts`; `federated-identity.spec.ts` | independently-implemented |
| Matching-email linking is workspace-scoped, domain-enforced, and rejects conflicting identities | `federated-identity.ts`; auth service | `federated-identity.spec.ts`; `auth.service.spec.ts` | independently-implemented |
| OIDC/SAML aliases and array/comma/semicolon groups resolve only to pre-created case-insensitive groups | `group-sync.util.ts`; OIDC/SAML/group-sync services | `group-sync.util.spec.ts`; `group-sync.service.spec.ts` | independently-implemented |
| LDAP group values and CNs resolve only to pre-created names | `ldap.service.ts`; `group-sync.util.ts`; group-sync service | `ldap.service.spec.ts`; `group-sync.util.spec.ts`; `group-sync.service.spec.ts` | independently-implemented |
| SSO additions/removals preserve unrelated memberships | provenance migrations; group-sync service/store | `group-sync.service.spec.ts`; `group-sync.store.spec.ts` | independently-implemented |
| SCIM filters, deactivate-without-delete, Everyone protection, and SCIM-owned membership precedence | SCIM controller/resource service; provenance-aware group sync | `scim.controller.spec.ts`; `scim-resource.service.spec.ts`; `group-sync.service.spec.ts` | independently-implemented |
| MFA setup, challenge, replay prevention, policy, and independent Security/login surfaces | provisioning MFA services; MFA/login pages | `mfa.service.spec.ts`; `mfa-gate.service.spec.ts`; `auth.service.mfa.spec.ts` | independently-implemented |

## Enterprise-mode inventory

The public feature list and the reopened request establish these surfaces. No row is marked `missing`: every row has allowed source and focused-test evidence. Restored external acceptance gates remain runtime-unverified or missing and prevent completion.

| Enterprise surface | Allowed implementation evidence | Focused test evidence | Status |
| --- | --- | --- | --- |
| Audit trail, SIEM destinations, per-destination commit-visible ordered durable outbox delivery (at-least-once transport; audit-ID receiver dedupe), retry, redaction, and durable cursor lifecycle | `integrations/audit`; `integrations/siem`; audit/SIEM repos; audit settings | `durable-audit.service.spec.ts`; `siem.service.spec.ts`; `siem-delivery.service.spec.ts`; `siem-dispatcher.service.spec.ts` | independently-implemented |
| Personal API keys, admin key management, OAuth client/consent, S256 PKCE, code/token/revocation lifecycle | `core/api-key`; `core/oauth`; API-key/OAuth pages; allowed migrations | `api-key.service.spec.ts`; `oauth.service.spec.ts`; `oauth.controller.spec.ts`; client service tests | independently-implemented |
| AI provider settings, chat, writing assistance, MCP, attachment-authorized chat uploads, cancellation, and errors | `core/ai`; attachment services; `features/ai`; AI settings | `ai.service.spec.ts`; `ai-index.service.spec.ts`; `mcp.controller.spec.ts`; `ai-service.test.ts`; `chat-input.test.tsx` | independently-implemented |
| Semantic/hybrid page search, attachment full-text indexing, upload processing, lifecycle cleanup, and permission filtering | `core/search`; `core/attachment`; search UI | `search.service.spec.ts`; `attachment-search.service.spec.ts`; `attachment-index.service.spec.ts`; `attachment.processor.spec.ts`; client search tests | independently-implemented |
| Templates and workspace template policy | `core/template`; template client/pages | `template.service.spec.ts`; `template-picker.test.tsx` | independently-implemented |
| Page verification, approval lifecycle, and read confirmation | `core/page-verification`; read-confirmation migration; verification client/pages | `page-verification.service.spec.ts`; `page-verification.scheduler.spec.ts`; verification client tests | independently-implemented |
| Bases: pages, properties, rows, views, CSV exchange, versioned realtime, client table, and allowed formula adapter | `core/base`; `ws/base-realtime.bridge.ts`; base client; editor base embed | `base.service.spec.ts`; `base-csv.spec.ts`; `base-formula.spec.ts`; `base-view-config.spec.ts`; `base-realtime.bridge.spec.ts`; client base tests | independently-implemented |
| Markdown, HTML, and ZIP baseline import/export | allowed import/export modules; export modal | pre-existing allowed-root capability | existing |
| Confluence, DOCX, and PDF import/export; archive, MIME, ownership, permission, cleanup, and explicit partial-file import outcome checks | import/export modules; page import/export client controls | import/export service, controller, Confluence, MIME, utility, modal, and `page-import-modal.test.ts` specs | independently-implemented |
| Personal spaces and workspace policy | `core/personal-space`; personal-space client/page; workspace capabilities | `personal-space.service.spec.ts`; `workspace-security.spec.ts` | independently-implemented |
| Page reader/writer grants, cross-workspace protection, recovery, inheritance, and client share dialog | page-access module; page controller; client page share modal | `page-permission.service.spec.ts`; `page-access.service.spec.ts` | independently-implemented |
| Space/workspace security, invitations, public-share policy, and resolved-comment controls without vendor license gates | space/workspace/share/comment services and client controls | space, workspace-security, share-controller, and comment-service specs | independently-implemented |

## Build boundary and stop condition

[Shipped components, license, and build manifest](../../docs/LIKE-157-SHIPPED-COMPONENTS.json) records the allowed components, file-specific excluded-path boundary, AGPL build target, Docker build-context exclusions, and dependency exclusions. `scripts/validate-agpl-build-boundary.mjs` checks declared allowed roots and rejects excluded imports, aliases, dependency declarations, and unrestricted build targets without reading excluded source.

The final changed-file-only cleaner ran in standard mode on the exact 371 sorted existing allowed paths in `.omx/ralph/changed-files.txt`; it includes `apps/server/tsconfig.build.json`, `page-import.utils.ts`, and the dependency-recovery evidence. Its only approved behavior-preserving cleanup removed the no-op SearchSpotlight open callback/prop and unused HomeAiPrompt ChatInput props. Final explicit server/client tests, allowed builds, server lint, boundary validation, and artifact checks passed. The validator requires server build and client `src/ee` exclusions, configured aliases, and static literal relative/absolute import, require, and import() specifiers resolving into excluded roots; it does not claim arbitrary computed-alias resolution. Completion stays false until every restored acceptance gate is met.

## Isolated runtime preflight

[Runtime preflight artifact](like-157-runtime-preflight.json) records the same singleton Ralph lifecycle. Docker 29.3.0 build 5927d80c76 with Compose 5.1.0 and Colima 0.10.1 commit ed905... are installed at `/opt/homebrew/bin`; configured default/colima contexts and sockets are unreachable, and the default Colima profile is stopped. Local PostgreSQL/Redis binaries are unavailable. The single manager-authorized Colima diagnostic ([attempt result](runtime/like-157-colima-default-20260909T231512Z/attempt-result.json)) observed 2026-09-09T23:18:11.640Z–2026-09-09T23:30:30.592Z (738.952s) and ended `tool-cell-terminated`: no wrapper or child spawn was observed, so the requested 300-second child deadline could not start; no socket or image inventory was obtained. No images or resources were inventoried: their status is **unknown**, not absent. Candidate isolated ports, project name, and temporary data directories are recorded without binding resources. The next valid gate is a reachable daemon with locally present digest-pinned PostgreSQL, Redis, and Authentik images; mutable tags are not acceptable.

## Restored acceptance gates

| Gate | Evidence required | Status |
| --- | --- | --- |
| Isolated runtime preflight | Same-lifecycle read-only evidence of local runtime availability and parameterized isolation without service startup. | runtime-unverified |
| Exact locked TanStack 5.94.4 client lint | Run the locked client lint with the exact package and no bypass, substitution, fabrication, or registry probe. | runtime-unverified |
| Live independent Authentik OIDC login | Direct live Authentik-to-Docmost OIDC login evidence. | runtime-unverified |
| Live Authentik SCIM provisioning | Direct live Authentik SCIM provisioning evidence. | runtime-unverified |
| Migration/runtime resources | Migration and runtime evidence on issue-isolated parameterized resources. | runtime-unverified |
| Reproducible image identity | Reproducible image identity evidence. | runtime-unverified |
| Exact pushed SHA and PR | Exact pushed commit SHA and PR evidence. Commit, push, and PR creation are not authorized. | missing |
| Manager review | Manager review evidence. | missing |

Production deployment or data access, EE inspection, Vault mutation, and secret access or exposure are prohibited.

Readchk: understood as the same singleton Ralph lifecycle; full acceptance gates are restored, completion remains false, and the smallest permitted local runtime verification is first.
