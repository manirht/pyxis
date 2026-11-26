# Set up Pyxis

## Install the harness

Install Git, Node.js 24 or newer with npm, and the two agent CLIs you want to use. The default pair is Claude Code and Codex. Sign in to each selected CLI under the account that will start the service.

```powershell
git clone https://github.com/manirht/pyxis.git
cd pyxis
node --version
git --version
npm ci
npm link
rca --help
```

If your npm mirror reports a missing locked package, check `npm config get registry`. Where your environment permits the public registry, retry with `npm ci --registry=https://registry.npmjs.org`. On Windows, `npm.cmd` and `rca.cmd` are available when PowerShell script shims are disabled.

## Choose your reviewers

Edit [rca.config.json](rca.config.json) before starting the service. Each role accepts `claude`, `codex`, or `copilot`. For example, this pair uses Claude Code to draft and GitHub Copilot as the second reviewer.

```json
{
  "roles": { "A": "claude", "B": "copilot" },
  "stageTimeoutMs": 180000
}
```

Check the selected executables with `claude --version`, `codex --version`, or `copilot --version`. For Claude and Codex, check sign-in with `claude auth status` and `codex login status`. The Copilot adapter can use your GitHub CLI login (`gh auth status`) or a supported `COPILOT_GITHUB_TOKEN` from your environment. Keep credentials out of the config file.

Copilot requires a stable bundled CLI version **1.0.97 or newer** for its JSON event output. Check the binary Pyxis actually launches with `copilot --no-auto-update --version`; plain `copilot --version` can describe a newer auto-updated cache. Preflight rejects older, prerelease, or unrecognized versions before submitting a model prompt and also verifies the restricted-session flags. The live acceptance suite used bundled CLI 1.0.115. See the [1.0.97 release notes](https://github.com/github/copilot-cli/releases/tag/v1.0.97) for the JSON writer correction.

Copilot events are parsed incrementally. The independent limits are 32 MiB of total event bytes, 4 MiB per event, and 2 MiB for the final root answer. Tool-event content is discarded after validation rather than charged against the final-answer budget. Missing, malformed, or duplicate terminal events and structured session failures still stop the run. Other providers retain the 2 MiB stdout limit. The original stage deadline applies throughout.

## Start and use the service

In the first terminal, run `rca serve`. In a second terminal, change directory to the local Git repository you want to investigate, then run:

```powershell
rca run --repo . --issue "Describe the observed behavior and what you expected."
```

Open the [local dashboard](http://127.0.0.1:4317/) and enter the returned run ID. See the [README](README.md) for the diagram, Git comparison options, and a complete scripted example. If you skipped `npm link`, run `npm run rca -- serve` from the harness directory and submit with `npm run rca -- run --repo <absolute-target-path> --issue "…"` from that same harness directory.

Stop the service with Ctrl+C. Let active investigations finish before restarting to apply a configuration change. If port 4317 is occupied, use the same `--port` on both `serve` and `run`, and open the dashboard on that port.

## Settings and checks

Use `RCA_RUNS_DIR` to change the durable run directory, `RCA_TEMP_ROOT` for temporary worktrees, and `RCA_STAGE_TIMEOUT_MS` for stage deadlines in milliseconds. `RCA_CLAUDE_MODEL`, `RCA_CODEX_MODEL`, and `RCA_COPILOT_MODEL` override their respective CLI model defaults. Set these in the terminal that launches the service.

A stage permits at most three attempts per reviewer (the initial call plus up to two fresh calls) for recoverable model-output errors. `stageTimeoutMs` / `RCA_STAGE_TIMEOUT_MS` remains one deadline shared by all attempts in that stage, including both concurrent reviewers. Retries can consume additional provider quota. Inspect the run's `attempts/` artifacts for safe rejection feedback on every platform. Raw rejected responses are saved separately in owner-only POSIX `diagnostics/` files and are not returned by the API. Raw diagnostic persistence is disabled on Windows because POSIX file modes do not enforce private Windows ACLs. See the [README](README.md) for terminal failure conditions.

Run `npm run check` and `npm test` from the harness directory for type checking and local regression tests. `npm run test:live` runs a real investigation on a generated Git fixture. `npm run test:permissions -- copilot` checks the installed Copilot adapter. Both live commands can consume provider quota.

Pull requests run the local checks on Node.js 24 with standard Linux, macOS, and Windows GitHub runners. These checks use deterministic provider fixtures and do not access real model accounts. The separate opt-in live commands still require your local provider login.

The `willRetry` field records the retry plan when an answer is rejected. A later deadline or cancellation can prevent that call; it does not prove another attempt ran.
