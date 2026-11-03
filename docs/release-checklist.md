# Release checklist

Gates between stages. A gate passes only with evidence (test run, screenshot set, review record).
Owner of each gate: the integration lead, with security and product sign-off where marked.

## Gate 0 — Milestone 1 done (owner-only private build)

- [ ] Every item of the [vertical slice checklist](product/vertical-slice.md) ticked with evidence.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:integration`, `pnpm e2e` green in CI;
      `pnpm --filter @jarvis/api openapi --check` and token generation have no diff.
- [ ] Design review: 12-step checklist passed for all 10 screens across the matrix
      ([review process](design/review-process.md)); axe: 0 serious/critical.
- [ ] iOS app built and run on a device or simulator by someone with Xcode (not possible in the CI
      container used so far).
- [ ] Known issues triaged: `lib/net.ts` IPv4 classification (SMTP), decryption failure classified as
      `OUTCOME_UNKNOWN`, budget month boundary (UTC vs. user time zone)
      ([known limitations](known-limitations.md)).
- [ ] Docs reconciled with the integrated code (statuses updated from "in progress").

## Gate 1 — Private alpha (small invited group, Phase 7)

Security (sign-off: security):

- [ ] Threat model re-reviewed; no open high findings.
- [ ] Production deployment per the proposed topology: TLS everywhere, HSTS, private database network,
      secrets in a secret manager, `NODE_ENV=production` boot checks pass.
- [ ] Egress controls for the worker (proxy or network policy) in addition to in-process SSRF checks.
- [ ] Keyring-based secret rotation implemented and rehearsed.
- [ ] Rate limits backed by a shared store (multiple API instances); per-account login throttling.
- [ ] MFA for platform admins; admin actions audited (already) and reviewed weekly.
- [ ] Dependency scanning in CI; lockfile-frozen installs; Renovate (or equivalent) with review.
- [ ] Live-model evaluation suites run with an approved budget: planner golden set, injection corpus
      (100 %), detector false-positive rate ≤ 2 % ([agent runtime §13](architecture/agent-runtime.md#13-evaluation-framework-plan)).

Reliability (sign-off: engineering):

- [ ] Metrics and tracing live; SLO dashboards for the [proposed SLOs](runbooks/operations.md#slos-proposal--not-measured-yet);
      API p95 < 500 ms measured.
- [ ] Backups (PITR) configured; one restore drill completed and timed.
- [ ] On-call/incident procedure tested once (tabletop).
- [ ] Worker crash and deploy during an active task rehearsed in staging: no lost task, no duplicate
      email.

Product and privacy (sign-off: product):

- [ ] Invitation flow (no public sign-up), OIDC + Sign in with Apple available.
- [ ] Password reset / change.
- [ ] Privacy notice and terms; record of processing activities; Anthropic DPA and retention terms
      confirmed.
- [ ] Voice mode discloses the speech engine on every platform.
- [ ] Support channel and feedback capture (no content collected without consent).

## Gate 2 — Closed beta (Phase 8)

- [ ] DPIA completed and signed off; retention purge jobs implemented and monitored.
- [ ] Multi-member tenants (if offered): restricted `users` view, role model, sharing rules reviewed.
- [ ] Billing (`subscriptions`) with clear spend limits; per-user daily email cap.
- [ ] High availability: database failover tested; at least two API and two worker instances.
- [ ] Push notifications (APNs) with content-free payloads.
- [ ] Abuse handling: reporting path, account suspension (`tenants.status = suspended`) procedure.
- [ ] External penetration test; findings fixed or accepted with rationale.
- [ ] Accessibility audit with assistive-technology users (VoiceOver, TalkBack/NVDA).
- [ ] Error budget policy in force for one full month.

## Gate 3 — Public release (Phase 9)

- [ ] `public_registration` flag enabled only after sign-up abuse controls (email verification,
      bot protection, rate limits) are live.
- [ ] Security: SBOM, signed images, build provenance; bug bounty or disclosure programme.
- [ ] Compliance: EU AI Act transparency obligations reviewed (AI disclosure in calls and content),
      GDPR review refreshed, accessibility statement published.
- [ ] Capacity test at 10× expected peak; queue migration criteria (Temporal) re-evaluated
      ([ADR-0004](adr/0004-postgres-job-queue.md)).
- [ ] Multi-region or documented regional data residency.
- [ ] Pricing and cost model validated against measured cost per task ([costs](costs.md)).
- [ ] Support, status page and incident communication templates ready.
