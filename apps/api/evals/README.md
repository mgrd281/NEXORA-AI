# JARVIS agent evals

Versioned scenarios that check what JARVIS plans, what the policy engine decides, what it refuses
and when it asks. Full documentation: [docs/evals.md](../../../docs/evals.md).

```bash
pnpm --filter @jarvis/api eval                         # offline: deterministic, no database (default)
pnpm --filter @jarvis/api eval --mode model            # scripted model output, or the real model with ANTHROPIC_API_KEY
pnpm --filter @jarvis/api eval --mode pipeline         # full worker pipeline on jarvis_test_evals (reset first)
pnpm --filter @jarvis/api eval --mode all --suite spec --verbose
pnpm --filter @jarvis/api eval --filter injection-     # scenario ids containing the text
pnpm --filter @jarvis/api eval --list                  # every scenario and its modes
pnpm --filter @jarvis/api eval --mode offline,model --update-baseline   # after an intended change
```

Options: `--mode offline|model|pipeline|all` (comma list allowed), `--suite s[,s]`, `--filter text`,
`--out dir` (default `evals/reports`), `--baseline file|none`, `--update-baseline`,
`--max-cost-usd n` (real model spend cap, default 2), `--verbose`, `--list`. Exit code 1: a scenario
failed or a regression against the baseline; 2: usage or setup error.

## Layout

```text
run.ts                   CLI
src/scenario.ts          scenario schema (Zod), loader, placeholders
src/expect.ts            Observed shape + comparison with expectations
src/capabilities.ts      `requires` probes (pending instead of failing for missing features)
src/runners/offline.ts   offline planner + policy (no DB)
src/runners/model.ts     model planner: Anthropic adapter (key) or scripted plans
src/runners/pipeline.ts  AgentServices + worker runOnce on the eval database
src/runners/common.ts    planner input, agent context, policy pass with taint simulation
src/report.ts            JSON/Markdown reports, baseline, regression gate
src/interop.mjs          rrule ESM interop for tsx (see docs/evals.md "Known issues")
scenarios/<suite>/*.json one scenario per file, named <id>.json
fixtures/                pages/, documents/ (PDF/DOCX as JSON specs), injection/ corpora
reports/baseline.*       committed baseline (everything else in reports/ is gitignored)
bench/                   telemetry overhead benchmark
```

## Adding a scenario

1. Pick the suite and an id (`[a-z0-9-]+`); create `scenarios/<suite>/<id>.json` with `version: 1`.
2. `given.request` in the user's words; use `{{site}}` for fixture pages (add the page under
   `fixtures/pages/` and map it in `given.pages`), `{{me}}` for the owner's address.
3. `modes`: `offline` whenever the offline planner can handle it; add `pipeline` when execution
   matters (side effects, approvals, failures), `model` with `given.model.plans` for model behaviour.
4. Expect only what the scenario is about (`result` always; then tools, recipients, URLs, policy
   decisions and reasons, flags, pipeline status/side effects).
5. Feature not in the build yet? Add `requires` (`tool:…`, `export:…#…`, `service:…`, `storage`):
   the scenario is pending until it lands.
6. Run `pnpm --filter @jarvis/api eval --filter <id> --mode all --verbose`, then update the baseline
   (`--update-baseline` per mode) in the same change. Bump `version` when you change a scenario's
   meaning.

Reading a report: `reports/latest.md` — summary per mode and suite, then every failure with each
mismatched expectation (`policy[2] (email.send): reasons [...] lack ["UNTRUSTED_CONTENT"]`), then
pending scenarios with their reasons. `latest.json` has the observed plan of every scenario
(`results[].observed`) for debugging.
