# Run records and local evidence

Pyxis stores detailed execution records in the harness repository’s `runs/` directory by default. This location belongs to the harness, not to the target repository supplied with `--repo`. `/runs/` is ignored by Git. From now on, keep validation logs, screenshots, RCA reports, provider outputs, and detailed run artifacts here so they remain easy to find alongside the project.

Start `rca serve` and open the [local dashboard](http://127.0.0.1:4317/) to browse recent investigations and their stage outputs. A run’s **Download report** action saves a readable Markdown copy. If a local `runs/START-HERE.md` exists, it indexes imported evidence. That index is not included in Git clones.

## Folder layout

```text
runs/                              # ignored; local and potentially sensitive
  START-HERE.md                    # index of imported reports and evidence
  <run-id>/
    run.json                       # issue, pinned commits, bindings and status
    REPORT.md                      # readable view of accepted review history
    events.jsonl                   # lifecycle and provider-call metadata
    reports/A.json, B.json         # independent accepted reports
    critiques/A-on-B.json          # A checks B
    critiques/B-on-A.json          # B checks A
    proposals/v1.json, v2.json     # exact immutable proposal versions, if reached
    votes/v1/A.json, B.json        # exact-version and digest-bound ballots
    result.json                    # finalized, unresolved, or failed outcome
    attempts/<stage>/...json       # safe validation feedback and retry metadata
    diagnostics/<stage>/...json    # private rejected responses; POSIX only
  validation/<date>-<purpose>/     # local tests, screenshots and supplementary checks
  archive/<date>/                 # original imported evidence snapshots
```

Each stage publishes only the files it reaches. Failed runs can retain useful reports or proposals without votes. Older imported runs do not gain events that were never recorded. `REPORT.md` is a generated reading view; the accepted JSON artifacts and proposal bytes remain the authoritative evidence. The report is refreshed after terminal state or cleanup changes and on explicit download, rather than after every active-stage mutation. Terminal history is not rewritten at startup. Report saves and event appends are best effort: failures log a warning without rejecting an already saved run transition. Downloads still return the rendered report if saving its local copy fails. Unreadable or corrupt canonical records can fail that report request; they are never replaced by stale report content.

`run.json` identifies the actual role bindings. A and B are workflow roles; consult their `adapter` and `model` fields instead of assuming which provider filled a role. A null model records that the provider’s default was requested; it does not establish the exact model ID used.

The accepted history follows this sequence:

| Step | Records | What to inspect |
| --- | --- | --- |
| Independent investigation | `reports/A.json`, `reports/B.json` | Each provider’s hypothesis, source citations, and evidence gaps. |
| Peer critique | `critiques/A-on-B.json`, `critiques/B-on-A.json` | Assessment and objections to the other report. |
| Shared RCA | `proposals/v1.json`, optionally `v2.json` | Causal explanation, exact source excerpts, and remaining gaps. |
| Ballots | `votes/v<version>/A.json`, `B.json` | Approval or objection targeting the exact version and SHA-256. |
| Outcome | `result.json` | Final agreement, unresolved positions, or the failure stage and error. |
| Validation retries | `attempts/` | Rejection categories, feedback, and retry decisions. |

These records capture accepted structured model outputs. They do not expose or reconstruct the providers’ hidden internal reasoning. `events.jsonl` records orchestration facts such as lifecycle transitions and provider-call starts/finishes; it is not a full native CLI transcript. Workflow prompts are not recorded. Routine run storage does not collect native CLI stderr, credentials, or private provider session dumps.

## API access

| Request | Response |
| --- | --- |
| `GET /runs` | `{ runs, storageRoot, reviewers }`: up to 100 records, newest first; the active absolute storage directory; and configured `A`/`B` adapter/model bindings for new submissions. |
| `GET /runs/{id}` | The complete run record and its current stage/status. |
| `GET /runs/{id}/artifacts` | Published, allowlisted JSON stage artifacts, including accepted partial outputs and safe retry metadata. |
| `GET /runs/{id}/report` | A Markdown attachment named `pyxis-<id>-report.md`. |

Only direct UUID-named run folders are live history. Archive and validation subdirectories are supplementary local evidence. Reading a terminal record does not submit it again. Queued work can run at startup, so import only terminal records (`finalized`, `unresolved`, or `failed`) with `cleanupPending: false` into direct run folders. Keep active, queued, or cleanup-pending historical snapshots under `archive/` instead.

## Choose another storage directory

Set `RCA_RUNS_DIR` in the terminal that starts the service. The setting resolves to an absolute directory; without it, the harness installation’s `runs/` directory is used regardless of your current target repository. The history API reports the active `storageRoot`.

From the harness root on macOS/Linux:

```sh
RCA_RUNS_DIR="$PWD/runs" rca serve
```

From the harness root in PowerShell:

```powershell
$env:RCA_RUNS_DIR = Join-Path (Get-Location) "runs"
rca serve
```

A custom location outside this repository needs its own ignore rule and appropriate access controls. `RCA_TEMP_ROOT` controls disposable worktrees separately; it is not the durable evidence directory.

## Keep and share records carefully

Run records can contain issue text and source code. On POSIX, rejected diagnostics use owner-only directories (mode `0700`) and files (mode `0600`). They stay out of the allowlisted artifacts API and generated reports. Legacy prompt files are preserved locally and remain excluded from both. Accepted reports, proposals, votes, safe attempt metadata, and lifecycle/call metadata remain available on every platform.

On Windows, new rejected responses are omitted because POSIX file modes do not restrict inherited Windows ACLs. No opt-in bypass enables raw persistence there. This omission does not remove accepted review history or safe retry metadata.

Save future supplementary validation under `runs/validation/<date>-<purpose>/` and add a short `REPORT.md` describing what ran, the exact revision, observed results, and limitations. Keep copied historical snapshots under `runs/archive/` and link them from `runs/START-HERE.md`. Use relative links within the local evidence tree. Never force-add this data to Git. Review any report or artifact before sharing it outside the machine; ignore rules and file modes do not sanitize its contents.

Safe rejection metadata uses `willRetry` for the plan at rejection time. A subsequent deadline or cancellation can prevent the next attempt; call audit events, when available, show actual calls. History reads records sequentially, skips unreadable entries with a warning, and sorts by recorded creation time; no extra cache or index is maintained.
