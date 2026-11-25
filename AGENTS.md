# Working on Pyxis

Start with the [README](README.md) for the workflow diagram, request lifecycle, and code map. Follow [SETUP.md](SETUP.md) to install the project and run its checks. `PLAN.md` records the original proposal. The implemented CLI and API are the source of truth for current behavior.

- Distinguish the **harness repository** (this project) from the **target repository** supplied by an RCA user. The harness stores run data under its own `runs/` directory by default.
- For workflow changes, trace [the runner](src/workflow/rca.ts), [stage outputs](src/workflow/outputs.ts), and [their regression tests](tests/workflow.test.ts). For provider changes, start at [the registry](src/adapters/index.ts).
- Use `npm run check` and `npm test` for routine verification. The live tests invoke real provider accounts and can consume quota.
