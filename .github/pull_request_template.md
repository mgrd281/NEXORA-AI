## Summary

<!-- What changes and why. Link the issue, ADR or doc section this implements. -->

## Screenshots

<!-- UI changes only: before/after for light and dark, en and ar (RTL), mobile and desktop.
     See docs/design/review-process.md. Delete this section otherwise. -->

## Tests

<!-- What you ran and what it showed. Name new or changed tests. Say plainly what you could not test. -->

- [ ] `pnpm typecheck && pnpm lint && pnpm test`
- [ ] `pnpm test:integration` (schema, RLS, queue or API changes)
- [ ] `pnpm e2e` (user-facing flows)

## Security considerations

<!-- Answer each, or write "n/a" with a reason. See docs/security/threat-model.md. -->

- Tenant isolation: do new queries run through `withContext` and respect RLS?
- Untrusted input (user text, fetched pages, model output): validated, and never treated as instructions?
- Side effects: still planned, policy-checked, approval-gated where required, and idempotent?
- Secrets and personal data: nothing new logged, returned or stored in plain text?
- Outbound connections: SSRF rules still apply?
- New dependencies: why needed, maintained, licence OK, `pnpm audit` clean?

## Checklist

- [ ] Frozen contracts (`packages/contracts`), tokens and applied migrations are unchanged, or the change is deliberate and explained above
- [ ] New migration instead of editing an applied one
- [ ] No placeholder data or simulated progress; every status shown reflects real system state
- [ ] User-facing copy in en, de and ar; accessible (labels, focus, contrast, reduced motion)
- [ ] Docs updated (`docs/`, README, `docs/known-limitations.md`) and `pnpm openapi` re-run if routes changed
- [ ] No secrets, `.env` files or real personal data committed
