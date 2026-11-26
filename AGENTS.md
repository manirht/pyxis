# Working on Pyxis

Start with the [README](README.md) for the workflow diagram, request lifecycle, and code map. Follow [SETUP.md](SETUP.md) to install the project and run its checks. `PLAN.md` records the original proposal. The implemented CLI and API are the source of truth for current behavior.

- Distinguish the **harness repository** (this project) from the **target repository** supplied by an RCA user. The harness stores run data under its own `runs/` directory by default.
- For workflow changes, trace [the runner](src/workflow/rca.ts), [stage outputs](src/workflow/outputs.ts), and [their regression tests](tests/workflow.test.ts). For provider changes, start at [the registry](src/adapters/index.ts).
- Use `npm run check` and `npm test` for routine verification. The live tests invoke real provider accounts and can consume quota.
- Keep changes minimal across the repository. Prefer existing code and platform features; add abstractions, options, or dependencies only when the requested behavior needs them.

- Keep future validation logs, screenshots, RCA reports, provider outputs, and other detailed execution artifacts under this repository’s ignored `/runs/` folder. Use `runs/validation/<date>-<purpose>/` for supplementary checks and `runs/archive/` for imported evidence. Do not force-add run data to Git. See [the run record guide](docs/RUN-RECORDS.md); when present locally, `runs/START-HERE.md` indexes the imported history.
- Preserve immutable JSON artifacts and proposal bytes/digests. Read role/provider/model bindings from `run.json`; a null model means the provider default was requested. Do not persist workflow prompts. Legacy private prompts and rejected diagnostics must stay out of the artifacts API and generated reports. Omit new raw diagnostics on Windows; POSIX file modes do not enforce private Windows ACLs. Do not capture credentials or native private CLI dumps, or claim to capture hidden model reasoning.
