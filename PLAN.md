# RCA harness MVP implementation plan

This document preserves the original design proposal. For the implemented interface, supported adapters, and current run protocol, see the [README](README.md) and [setup guide](SETUP.md).

Build a local TypeScript runner that takes a Git repository, a base ref and a head ref. Two independent agent sessions investigate the change, critique each other's findings and vote on one written root cause analysis (RCA). The runner owns the workflow and the files. A and B are roles that can use any configured adapter.

## Project and storage locations

Use `C:\Users\roopeshs\opensource\Jarvis\rca-harness\` as the project root. The repository to investigate is supplied on each run. For example, `C:\Users\roopeshs\opensource\datafusion-spark\` can be the input to a run.

| Location | Purpose |
| --- | --- |
| `src/cli.ts` | Start the local service or submit a run from the terminal. |
| `src/api/` | Expose the three run endpoints and serve a small run-status dashboard. |
| `src/workflow/rca.ts` | Own stage order, parallel calls, deadlines, the revision limit and the approval rule. |
| `src/workflow/prompts.ts` | Build the investigation, critique, draft, revision and vote prompts. |
| `src/adapters/` | Define the adapter contract and registry. Add a provider implementation here when selected. |
| `src/workspace.ts` | Resolve Git refs, prepare the checkout, serve read-only repository evidence and clean up. |
| `src/store.ts` | Save and read run status and artifacts as local JSON. |
| `schemas/` | Define the report, critique, proposal and vote outputs that every adapter must produce. |
| `rca.config.json` | Map roles A and B to adapter profiles and set stage deadlines. Credentials come from the adapter's environment or login store. |
| `tests/` | Hold a small Git fixture, scripted adapters and end-to-end acceptance cases. |
| `runs/<run-id>/` | Keep the durable record of one run. Resolve this relative to the harness root and exclude it from Git. |

### What one run keeps

| File under `runs/<run-id>/` | Contents |
| --- | --- |
| `run.json` | Request, original refs and resolved commit IDs, optional symptom, role-to-adapter bindings, status, current stage, timestamps, published artifact IDs and failure details when applicable. |
| `reports/A.json`, `reports/B.json` | Each agent's independent hypothesis, supporting evidence and gaps. |
| `critiques/A-on-B.json`, `critiques/B-on-A.json` | Findings each reviewer could verify and specific objections to the peer report. |
| `proposals/v1.json`, `proposals/v2.json` | Immutable proposals. Create v2 only when A revises. Record the SHA-256 digest of each saved version in the run record. |
| `votes/v1/A.json`, `votes/v1/B.json` | Decision and objections from each role, bound to the run, proposal version and digest. Use the same layout under `votes/v2/` for a second vote. |
| `result.json` | For agreement, reference the exact approved proposal and its evidence. For disagreement, include both positions and outstanding objections. For failure, record the stage, affected role if applicable, error and available artifact IDs. |

Keep evidence beside the claim it supports. For source evidence, save the commit ID, repository-relative path, line range and a short excerpt. Check those references against the pinned source before publishing. The result remains readable after checkout cleanup.

## Run protocol

1. **Pin the inputs.** At submission, resolve the base and head refs once and persist their commit IDs. Compare those two commits directly. Accept an optional symptom, failing test name or log excerpt so the agents know which behavior to explain. With refs alone, an agent can identify missing evidence and raise an objection. [Git diff documentation](https://git-scm.com/docs/git-diff)
2. **Prepare one read-only checkout.** Create a detached worktree at the head commit under `%TEMP%\rca-harness\<run-id>\repo\`. A detached worktree is writable by default. Give both agents scoped read, search and diff operations over the pinned source. An adapter that needs native file tools requires an enforced read-only sandbox that exposes the checkout and protects Git metadata, the caller's checkout and the run store. Give each role a private session. [Git worktree documentation](https://git-scm.com/docs/git-worktree)
3. **Investigate independently.** Launch A and B in parallel with the same incident input and evidence access. Validate and save each report as it arrives. Release the peer reports only after both are saved.
4. **Cross-critique.** A checks B's report against the repository and B checks A's. Run these calls in parallel and save both critiques.
5. **Draft and freeze v1.** Give A the two reports and the two critiques. Save A's evidence-backed proposal once and hash the exact saved bytes. Both agents receive the same saved proposal to review.
6. **Vote and conclude.** Collect a separate `approve` or `object` vote from each role. Two approvals for the current version and digest finalize that exact proposal. If either agent objects to v1, A uses the objections to write v2. Both agents vote again on v2. Any remaining objection ends the run as `unresolved`. Votes for an earlier version never contribute to a later decision.
7. **Handle failure at any stage.** A stage error, invalid active response or timeout ends an accepted run as `failed`. Stop outstanding calls, ignore late results and preserve outputs already published. Record the terminal outcome before cleaning up the temporary checkout with Git.

## Adapter contract

Give the runner one typed operation, `execute(stageRequest, signal)`. The request identifies the run, role, stage, expected output schema, pinned evidence access and inputs released for that stage. A vote request also identifies the frozen proposal and digest. The adapter translates the request into its CLI or service call and returns the stage output or a typed error. The runner validates the output and associates it with the originating call.

Claude Code, OpenCode or another backend can implement this contract. A and B may select the same adapter with separate sessions, or different adapters. The first deliverable uses a scripted adapter that returns fixtures. The first real integration must demonstrate independent sessions, read-only investigation, validated outputs and cancellation.

## CLI, API and dashboard

Use one local service as the writer. `rca serve` starts the loopback API and a worker that handles one run at a time. A run still executes its paired agent calls concurrently. `rca run --repo <path> --base <ref> --head <ref> [--symptom <text>]` submits to the service and prints the run ID.

| Endpoint | Behavior |
| --- | --- |
| `POST /runs` | Validate the request, pin the refs, persist the queued run and return HTTP 202 with its ID. Invalid inputs get an input error before queueing. |
| `GET /runs/{id}` | Return `queued`, `running`, `finalized`, `unresolved` or `failed`, with the current or last stage and any recorded error. |
| `GET /runs/{id}/artifacts` | Return the published artifacts and their contents, including available partial results. |

The dashboard opens by run ID, polls these endpoints and displays the stage, outcome and evidence. Write each artifact to a temporary sibling file and rename it into place before updating `run.json` atomically. On service restart, reconcile published files, pick up queued requests and mark an interrupted active run as failed at its last recorded stage.

## Build order and acceptance

| Milestone | Completion check |
| --- | --- |
| 1. Define the schemas, adapter contract, role configuration and file store. | A scripted adapter can produce all four output types. A saved run can be reopened by ID. |
| 2. Implement Git preparation and the TypeScript workflow using scripted A and B. | A two-commit fixture covers approval on v1, approval after one revision, and unresolved objections on v2. Stale or duplicate votes cannot supply the second approval. |
| 3. Connect the CLI, local worker, API and dashboard. | Submit from the CLI and inspect the same run through HTTP. Exercise a timeout after one report is saved and a service restart. Verify that the stage, surviving artifacts and checkout cleanup are correct. |
| 4. Integrate the first chosen real adapter. | Run both roles on a small known regression, inspect the cited evidence and verify that the displayed result matches the voted proposal. Confirm read-only access and cancellation in the live integration. |

The first provider decision is needed for milestone 4. The full workflow, storage layout and three outcomes can be exercised before that choice.
