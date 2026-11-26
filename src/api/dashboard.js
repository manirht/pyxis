const $ = (id) => document.getElementById(id);
const names = {
  codex: "Codex",
  copilot: "GitHub Copilot",
  claude: "Claude Code",
};
const statuses = {
  queued: "Queued",
  running: "In progress",
  finalized: "Finalized",
  unresolved: "Unresolved",
  failed: "Failed",
};
const validId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const state = {
  runs: [],
  storageRoot: "",
  reviewers: {},
  record: null,
  artifacts: {},
  tab: "findings",
  filter: "all",
  query: "",
  busy: false,
};
let historyController,
  runController,
  historyTimer,
  runTimer,
  toastTimer,
  lastFingerprint,
  historyFingerprint;
let observer;

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

function action(text, name, value, className = "button quiet") {
  const button = el("button", text, className);
  button.type = "button";
  button.dataset.action = name;
  if (value !== undefined) button.dataset.value = value;
  return button;
}

function reveal() {
  const blocks = document.querySelectorAll(".reveal:not(.is-visible)");
  if (!observer && "IntersectionObserver" in window)
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
      },
      { threshold: 0.02 },
    );
  for (const block of blocks)
    observer ? observer.observe(block) : block.classList.add("is-visible");
}

function basename(path = "") {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path || "Repository";
}
function folder(...parts) {
  const separator = state.storageRoot.includes("\\") ? "\\" : "/";
  return [state.storageRoot.replace(/[\\/]$/, ""), ...parts].join(separator);
}
function provider(role, record = state.record) {
  return (
    names[record?.agents?.[role]?.adapter] ||
    record?.agents?.[role]?.adapter ||
    `Reviewer ${role}`
  );
}
function active(record) {
  return record.status === "queued" || record.status === "running";
}
function date(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "Time unavailable"
    : parsed.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}
function shortDate(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? ""
    : parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function badge(status, label = statuses[status] || status) {
  const node = el("span", label, "badge");
  node.dataset.status = status;
  return node;
}
function code(text, label) {
  const node = el("pre", text);
  node.tabIndex = 0;
  if (label) node.setAttribute("aria-label", label);
  return node;
}
function notice(message = "", source = "run") {
  $("notice-text").textContent = message;
  $("notice").hidden = !message;
  $("notice").dataset.source = source;
}
function toast(message) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").hidden = false;
  toastTimer = setTimeout(() => {
    $("toast").hidden = true;
  }, 3800);
}
function connection(connected) {
  const indicator = el("span");
  indicator.setAttribute("aria-hidden", "true");
  $("connection").replaceChildren(
    indicator,
    document.createTextNode(
      connected ? "Connected to local service" : "Local service unavailable",
    ),
  );
  $("connection").dataset.state = connected ? "ready" : "offline";
}

async function json(path, options = {}) {
  const response = await fetch(path, options);
  let value;
  try {
    value = await response.json();
  } catch {
    throw new Error("The local service returned an unreadable response.");
  }
  if (!response.ok) {
    const error = new Error(
      value.error || "The local service could not complete the request.",
    );
    error.status = response.status;
    throw error;
  }
  return value;
}

function showHistory(open) {
  $("sidebar").classList.toggle("is-open", open);
  $("history-toggle").setAttribute("aria-expanded", String(open));
  if (open) $("search").focus();
}

function renderHistory() {
  const runs = state.runs;
  const counts = {
    all: runs.length,
    finalized: runs.filter((r) => r.status === "finalized").length,
    active: runs.filter(active).length,
    attention: runs.filter(
      (r) => r.status === "failed" || r.status === "unresolved",
    ).length,
  };
  for (const node of document.querySelectorAll("[data-count]"))
    node.textContent = counts[node.dataset.count] ?? 0;
  $("total-count").textContent = counts.all;
  $("final-count").textContent = counts.finalized;
  $("active-count").textContent = counts.active;
  $("history-count").textContent =
    `${runs.length} record${runs.length === 1 ? "" : "s"}`;
  for (const node of document.querySelectorAll("[data-filter]")) {
    const selected = node.dataset.filter === state.filter;
    node.classList.toggle("active", selected);
    node.setAttribute("aria-pressed", String(selected));
  }
  const query = state.query.toLowerCase();
  const filtered = runs.filter((run) => {
    const match =
      !query ||
      `${run.id} ${run.input?.issue} ${run.input?.repo}`
        .toLowerCase()
        .includes(query);
    const filter =
      state.filter === "all" ||
      (state.filter === "active"
        ? active(run)
        : state.filter === "attention"
          ? ["failed", "unresolved"].includes(run.status)
          : run.status === state.filter);
    return match && filter;
  });
  const list = $("run-list");
  const existing = new Map(
    [...list.children].map((node) => [node.dataset.run, node]),
  );
  const focused = document.activeElement?.closest?.("[data-run]")?.dataset.run;
  const scroll = $("sidebar").querySelector(".sidebar-content").scrollTop;
  for (const [index, run] of filtered.entries()) {
    let item = existing.get(run.id);
    if (!item) {
      item = el("li", undefined, "run-item");
      item.dataset.run = run.id;
    }
    let link = item.firstElementChild;
    if (!link) {
      link = el("a", undefined, "run-link");
      link.href = "#" + run.id;
      link.append(
        el("p", "", "run-link-title"),
        el("div", undefined, "run-link-meta"),
      );
      item.append(link);
    }
    link.classList.toggle("selected", run.id === state.record?.id);
    if (run.id === state.record?.id) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
    link.title = run.input?.issue || run.id;
    link.querySelector(".run-link-title").textContent =
      run.input?.issue || run.id;
    const dot = el("span", undefined, "status-dot");
    dot.dataset.status = run.status;
    dot.setAttribute("aria-hidden", "true");
    const label = el("span", basename(run.input?.repo), "run-repo");
    label.title = `${statuses[run.status] || run.status} · ${run.input?.repo || ""}`;
    const stamp = el("time", shortDate(run.createdAt), "run-time");
    stamp.dateTime = run.createdAt;
    link.querySelector(".run-link-meta").replaceChildren(dot, label, stamp);
    if (list.children[index] !== item)
      list.insertBefore(item, list.children[index] || null);
    existing.delete(run.id);
  }
  for (const item of existing.values()) item.remove();
  if (focused && !document.activeElement?.closest?.("[data-run]"))
    list
      .querySelector(`[data-run="${CSS.escape(focused)}"] a`)
      ?.focus({ preventScroll: true });
  $("sidebar").querySelector(".sidebar-content").scrollTop = scroll;
  $("history-empty").hidden = filtered.length !== 0;
  $("history-empty").textContent = runs.length
    ? "No investigations match this search or filter."
    : "Your first investigation will appear here.";
}

function list(parent, heading, values) {
  if (!Array.isArray(values) || !values.length) return;
  const block = el("section", undefined, "supporting-note");
  block.append(el("h4", heading));
  const items = el("ul", undefined, "plain-list");
  for (const value of values) items.append(el("li", value));
  block.append(items);
  parent.append(block);
}

function evidence(parent, entries = []) {
  for (const [index, item] of entries.entries()) {
    const detail = el("details", undefined, "evidence-item");
    detail.dataset.key = `evidence:${item.commit}:${item.path}:${item.startLine}:${index}`;
    const summary = el("summary", item.path);
    summary.append(
      el(
        "span",
        `Lines ${item.startLine}${item.startLine === item.endLine ? "" : "–" + item.endLine}`,
      ),
    );
    detail.append(
      summary,
      el("p", item.commit, "commit-note"),
      code(item.excerpt, `Source excerpt from ${item.path}`),
    );
    parent.append(detail);
  }
}

function resultProposal() {
  const result = state.artifacts["result.json"];
  if (result?.proposal)
    return {
      proposal: result.proposal,
      version: result.version,
      digest: result.digest,
    };
  for (const version of [2, 1])
    if (state.artifacts[`proposals/v${version}.json`])
      return {
        proposal: state.artifacts[`proposals/v${version}.json`],
        version,
        digest: state.record.proposalDigests?.[`v${version}`],
      };
  return null;
}

function pending(parent, title, explanation) {
  const block = el("div", undefined, "empty-content");
  block.append(el("h3", title), el("p", explanation));
  parent.append(block);
}

function renderFindings(parent) {
  const record = state.record,
    result = state.artifacts["result.json"],
    saved = resultProposal();
  if (record.status === "failed") {
    const error = record.error || result?.error;
    pending(
      parent,
      "The investigation stopped here.",
      `${error?.role ? provider(error.role) + ": " : ""}${error?.message || "The run could not finish."}`,
    );
    const note = el(
      "p",
      "Accepted reports and rejection history are still available in the other tabs.",
      "prose",
    );
    parent.append(note);
  }
  if (!saved) {
    if (record.status !== "failed")
      pending(
        parent,
        record.status === "queued"
          ? "Waiting for the reviewers."
          : "The evidence is taking shape.",
        record.status === "queued"
          ? "This investigation is in the local queue. Reports will appear as each reviewer finishes."
          : "You can read accepted reports as they arrive. The shared explanation will appear here after peer review.",
      );
    showAttempts(parent);
    return;
  }
  const { proposal, version, digest } = saved;
  const grid = el("div", undefined, "findings-grid"),
    copy = el("div", undefined, "finding-copy");
  const title =
    record.status === "finalized"
      ? "Agreed explanation"
      : record.status === "unresolved"
        ? "Proposal with open objections"
        : record.status === "failed"
          ? "Last saved proposal"
          : "Proposal under review";
  copy.append(
    el("p", `${title} · version ${version}`, "section-kicker"),
    el("h3", proposal.cause, "finding-title"),
    el("p", proposal.explanation, "prose"),
  );
  if (record.status === "unresolved")
    list(copy, "Open objections", result?.objections);
  list(copy, "Evidence gaps", proposal.gaps);
  if (digest)
    copy.append(el("p", `Proposal v${version} · SHA-256 ${digest}`, "digest"));
  const source = el("aside", undefined, "source-column");
  source.setAttribute("aria-label", "Supporting source evidence");
  source.append(
    el("p", "Pinned source", "section-kicker"),
    el("p", proposal.evidence?.length || 0, "source-count"),
    el(
      "p",
      "Source citations attached to this explanation. Open a file to inspect the exact excerpt.",
      "source-note",
    ),
  );
  evidence(source, proposal.evidence);
  const location = el("div", undefined, "file-location");
  location.append(
    el("p", "The complete local record"),
    el(
      "code",
      `${basename(state.storageRoot) || "runs"}/${record.id.slice(0, 8)}…/`,
    ),
    action("View saved files", "tab", "files", "text-button"),
  );
  source.append(location);
  grid.append(copy, source);
  parent.append(grid);
  showAttempts(parent);
}

function showAttempts(parent) {
  const attempts = Object.entries(state.artifacts).filter(([name]) =>
    name.startsWith("attempts/"),
  );
  if (!attempts.length) return;
  const block = el("section", undefined, "attempt-note");
  block.append(
    el(
      "h4",
      `${attempts.length} rejected answer${attempts.length === 1 ? "" : "s"} recorded`,
    ),
  );
  for (const [, item] of attempts)
    block.append(
      el(
        "p",
        `${provider(item.role)} · ${item.stage} · attempt ${item.attempt}: ${item.message}`,
      ),
      el(
        "p",
        item.willRetry
          ? "A replacement attempt was planned."
          : "No further attempt was planned.",
        "meta",
      ),
    );
  block.append(action("Inspect attempt files", "tab", "files", "text-button"));
  parent.append(block);
}

function renderReviewers(parent) {
  const grid = el("div", undefined, "review-grid");
  for (const role of ["A", "B"]) {
    const card = el("article", undefined, "review-card"),
      heading = el("div", undefined, "review-card-heading");
    const identity = el("div");
    identity.append(
      el("h3", provider(role)),
      el(
        "p",
        `Reviewer ${role} · ${state.record.agents?.[role]?.model || "Provider default model"}`,
      ),
    );
    heading.append(
      el("span", role, `role-letter ${role === "B" ? "role-b" : ""}`),
      identity,
    );
    card.append(heading);
    const report = state.artifacts[`reports/${role}.json`],
      peer = role === "A" ? "B" : "A";
    if (!report)
      card.append(
        el(
          "p",
          active(state.record)
            ? "The independent report has not arrived yet."
            : "No independent report was published.",
          "prose",
        ),
      );
    else {
      card.append(
        el("p", "Independent investigation", "section-kicker"),
        el("p", report.hypothesis, "prose"),
      );
      evidence(card, report.evidence);
      list(card, "Reported gaps", report.gaps);
    }
    const critique = state.artifacts[`critiques/${role}-on-${peer}.json`];
    if (critique) {
      card.append(
        el("h4", `Review of ${provider(peer)}’s report`),
        el("p", critique.assessment, "prose"),
      );
      list(card, "Objections", critique.objections);
      if (!critique.objections?.length)
        card.append(el("p", "No objections recorded.", "source-note"));
      evidence(card, critique.evidence);
    }
    grid.append(card);
  }
  parent.append(grid);
}

function renderVotes(parent) {
  let rounds = 0;
  for (const version of [1, 2]) {
    const proposal = state.artifacts[`proposals/v${version}.json`];
    if (!proposal) continue;
    rounds++;
    const round = el("section", undefined, "vote-round"),
      heading = el("div", undefined, "votes-heading");
    heading.append(
      el("h3", version === 1 ? "The first proposal" : "The revised proposal"),
      el("span", `VERSION ${version}`, "eyebrow"),
    );
    round.append(heading);
    round.append(el("p", proposal.cause, "prose"));
    const votes = el("div", undefined, "vote-grid");
    const digest = state.record.proposalDigests?.[`v${version}`];
    for (const role of ["A", "B"]) {
      const card = el("article", undefined, "vote-card"),
        vote = state.artifacts[`votes/v${version}/${role}.json`];
      card.append(
        vote
          ? badge(
              vote.decision,
              vote.decision === "approve" ? "Approved" : "Objected",
            )
          : badge("queued", active(state.record) ? "Awaiting vote" : "No vote"),
      );
      card.append(el("h4", `${provider(role)} · reviewer ${role}`));
      if (vote) {
        list(card, "Objections", vote.objections);
        if (!vote.objections?.length)
          card.append(
            el("p", "No objections to this proposal.", "source-note"),
          );
        const bound =
          vote.version === version &&
          vote.digest === digest &&
          vote.runId === state.record.id &&
          vote.role === role;
        card.append(
          el(
            "p",
            bound
              ? `Bound to saved proposal v${version}.`
              : "The saved vote binding needs inspection.",
            "vote-note",
          ),
          el("p", `SHA-256 ${vote.digest}`, "digest"),
        );
      } else
        card.append(
          el("p", "Only accepted ballots are saved as votes.", "source-note"),
        );
      votes.append(card);
    }
    round.append(votes);
    const details = el("details", undefined, "artifact");
    details.dataset.key = `proposal-v${version}`;
    details.append(
      el("summary", `Inspect proposal v${version} and its source evidence`),
      code(
        JSON.stringify(proposal, null, 2),
        `Saved proposal version ${version}`,
      ),
    );
    round.append(details);
    parent.append(round);
  }
  if (!rounds)
    pending(
      parent,
      "Voting comes after peer review.",
      "The drafting reviewer combines both investigations and critiques. Both reviewers then vote on the same saved proposal and digest.",
    );
  else
    parent.append(
      el(
        "p",
        "Both reviewers must approve the same version and digest. An objection permits one revision; remaining disagreement is saved as unresolved.",
        "vote-note",
      ),
    );
}

function renderFiles(parent) {
  const heading = el("div", undefined, "files-header"),
    copy = el("div");
  copy.append(
    el("h3", "The complete record"),
    el(
      "p",
      "Accepted outputs, critiques, proposals, votes and safe retry metadata. Private prompts and diagnostics are available only in the local folder, where retained.",
    ),
  );
  const downloads = el("div", undefined, "download-actions");
  downloads.append(
    action("Download report", "download", "report"),
    action("Export JSON", "download", "json"),
  );
  heading.append(copy, downloads);
  parent.append(heading);
  const location = el("div", undefined, "path-card"),
    label = el("div");
  label.append(
    el("p", "Run folder on this machine", "section-kicker"),
    el(
      "code",
      state.storageRoot ? folder(state.record.id) : `runs/${state.record.id}/`,
    ),
  );
  location.append(
    label,
    action("Copy folder path", "copy-path", undefined, "text-button"),
  );
  parent.append(location);
  parent.append(
    el(
      "p",
      "Open the copied path in your file manager for REPORT.md, events.jsonl and the original artifact files. Historical runs may have fewer record types.",
      "source-note",
    ),
  );
  const entries = [
    ["run.json", state.record],
    ...Object.entries(state.artifacts),
  ];
  for (const [name, value] of entries) {
    const detail = el("details", undefined, "artifact");
    detail.dataset.key = "artifact:" + name;
    detail.append(
      el("summary", name),
      code(JSON.stringify(value, null, 2), name),
    );
    parent.append(detail);
  }
}

function renderTab() {
  if (!state.record) return;
  const panel = $("panel-" + state.tab);
  const expanded = new Set(
    [...panel.querySelectorAll("details[open]")].map(
      (node) => node.dataset.key,
    ),
  );
  const activeElement = panel.contains(document.activeElement) ? document.activeElement : null;
  const detail = activeElement?.closest("details[data-key]");
  const focused = activeElement ? {
    detail: detail?.dataset.key,
    tag: activeElement.tagName.toLowerCase(),
    action: activeElement.dataset.action,
    value: activeElement.dataset.value,
  } : null;
  panel.replaceChildren();
  ({
    findings: renderFindings,
    reviewers: renderReviewers,
    votes: renderVotes,
    files: renderFiles,
  })[state.tab](panel);
  for (const details of panel.querySelectorAll("details"))
    if (expanded.has(details.dataset.key)) details.open = true;
  if (focused) {
    const scope = focused.detail
      ? panel.querySelector(`[data-key="${CSS.escape(focused.detail)}"]`)
      : panel;
    const selector = focused.action
      ? `[data-action="${CSS.escape(focused.action)}"]${focused.value ? `[data-value="${CSS.escape(focused.value)}"]` : ""}`
      : focused.detail ? focused.tag : null;
    if (selector) scope?.querySelector(selector)?.focus({ preventScroll: true });
  }
}

function setTab(tab, focus = false) {
  if (!["findings", "reviewers", "votes", "files"].includes(tab)) return;
  state.tab = tab;
  for (const button of document.querySelectorAll("[data-tab]")) {
    const selected = button.dataset.tab === tab;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    $("panel-" + button.dataset.tab).hidden = !selected;
  }
  renderTab();
  if (focus) $("tab-" + tab).focus();
}

function renderRecord(record, artifacts) {
  state.record = record;
  state.artifacts = artifacts;
  const result = artifacts["result.json"];
  $("repo-name").textContent = basename(record.input.repo);
  $("repo-name").title = record.input.repo;
  $("short-id").textContent = record.id.slice(0, 8);
  const status = $("status-badge");
  status.textContent = statuses[record.status] || record.status;
  status.dataset.status = record.status;
  $("record-updated").textContent =
    `${active(record) ? "Created" : "Finished"} ${date(active(record) ? record.createdAt : record.finishedAt || record.updatedAt)}`;
  $("issue").textContent =
    record.input.issue.length > 320
      ? record.input.issue.slice(0, 317) + "…"
      : record.input.issue;
  $("issue-details").hidden = record.input.issue.length <= 320;
  $("full-issue").textContent = record.input.issue;
  const revisions = $("revision-meta");
  revisions.replaceChildren();
  for (const [label, value] of [
    ["Head", record.input.headSha],
    ["Base", record.input.baseSha],
  ])
    if (value) {
      const node = el("span");
      node.append(el("b", label), document.createTextNode(value.slice(0, 12)));
      node.title = value;
      revisions.append(node);
    }
  const stages = [
    ["prepare", "Workspace"],
    ["investigate", "Investigate"],
    ["critique", "Peer review"],
    ["draft", "Draft RCA"],
    ["vote-v1", "Vote"],
  ];
  if (
    record.stage === "revise" ||
    record.stage === "vote-v2" ||
    artifacts["proposals/v2.json"]
  )
    stages.push(["revise", "Revise"], ["vote-v2", "Revote"]);
  const current = stages.findIndex(([name]) => name === record.stage);
  const timeline = $("timeline");
  timeline.replaceChildren();
  for (const [index, [name, label]] of stages.entries()) {
    const done = record.status === "finalized" || index < current;
    const isCurrent = index === current && !done;
    const step = el(
      "li",
      undefined,
      done
        ? "done"
        : isCurrent
          ? ["failed", "unresolved"].includes(record.status)
            ? record.status
            : "current"
          : "",
    );
    if (isCurrent) step.setAttribute("aria-current", "step");
    step.append(el("span", index + 1, "step-number"), el("span", label));
    step.setAttribute(
      "aria-label",
      `${label}: ${done ? "complete" : isCurrent ? (record.status === "failed" ? "stopped" : record.status === "unresolved" ? "unresolved" : "current") : "pending"}`,
    );
    timeline.append(step);
  }
  const reviewers = $("reviewer-strip");
  reviewers.replaceChildren();
  for (const role of ["A", "B"]) {
    const card = el("div", undefined, "reviewer-mini"),
      info = el("div", undefined, "reviewer-info");
    info.append(
      el("strong", provider(role)),
      el("p", record.agents?.[role]?.model || "Provider default model"),
    );
    const voted =
      artifacts[
        `votes/v${result?.version || (artifacts["proposals/v2.json"] ? 2 : 1)}/${role}.json`
      ];
    const label = voted
      ? voted.decision === "approve"
        ? "Approved"
        : "Objected"
      : artifacts[`reports/${role}.json`]
        ? "Report saved"
        : record.status === "running"
          ? "Investigating"
          : record.status === "queued"
            ? "Waiting"
            : "No report";
    card.append(
      el("span", role, `role-letter ${role === "B" ? "role-b" : ""}`),
      info,
      el("span", label, "reviewer-status"),
    );
    reviewers.append(card);
  }
  $("file-count").textContent = Object.keys(artifacts).length;
  $("cleanup-note").textContent = record.cleanupError
    ? `Cleanup needs attention: ${record.cleanupError}`
    : record.status === "queued"
      ? "Waiting in the local queue"
      : record.cleanupPending
        ? active(record)
          ? "Temporary source checkout in use"
          : "Cleaning temporary checkout"
        : "Temporary checkout removed";
  $("run-panel").hidden = false;
  $("loading-panel").hidden = true;
  $("empty-state").hidden = true;
  setTab(state.tab);
  renderHistory();
  reveal();
}

async function refreshRun(id, signal) {
  try {
    const path = "/runs/" + encodeURIComponent(id);
    const record = await json(path, { signal });
    const fingerprint = JSON.stringify([
      record.status,
      record.stage,
      record.updatedAt,
      record.artifacts,
      record.error,
      record.cleanupPending,
      record.cleanupError,
    ]);
    if (fingerprint !== lastFingerprint) {
      const artifacts = await json(path + "/artifacts", { signal });
      if (signal.aborted) return;
      renderRecord(record, artifacts);
      lastFingerprint = fingerprint;
    }
    if (signal.aborted) return;
    connection(true);
    notice();
    if (active(record) || record.cleanupPending)
      runTimer = setTimeout(() => refreshRun(id, signal), 1500);
  } catch (error) {
    if (signal.aborted) return;
    $("loading-panel").hidden = true;
    notice(
      error.status === 404
        ? "That run was not found. Choose a recent investigation or check the ID."
        : `${error.message} Your saved details remain available; try refreshing.`,
    );
    if (error.status !== 404) {
      connection(false);
      runTimer = setTimeout(() => refreshRun(id, signal), 5000);
    }
  }
}

function selectRun(id) {
  clearTimeout(runTimer);
  runController?.abort();
  runController = new AbortController();
  lastFingerprint = undefined;
  notice();
  $("run-id").value = id;
  $("run-panel").hidden = true;
  state.record = null;
  state.artifacts = {};
  if (id && !validId.test(id)) {
    notice("Enter a run ID using letters, numbers, hyphens or underscores.");
    $("loading-panel").hidden = true;
    return;
  }
  if (!id) {
    const first =
      state.runs.find((run) => run.status === "finalized") || state.runs[0];
    if (first) {
      history.replaceState(null, "", "#" + first.id);
      selectRun(first.id);
    } else {
      $("loading-panel").hidden = true;
      $("empty-state").hidden = false;
      reveal();
    }
    return;
  }
  $("empty-state").hidden = true;
  $("loading-panel").hidden = false;
  showHistory(false);
  refreshRun(id, runController.signal);
}

async function loadHistory(initial = false) {
  clearTimeout(historyTimer);
  historyController?.abort();
  historyController = new AbortController();
  const signal = historyController.signal;
  try {
    const response = await json("/runs", { signal });
    if (signal.aborted) return;
    const fingerprint = JSON.stringify(response);
    if (fingerprint !== historyFingerprint) {
      state.runs = Array.isArray(response.runs) ? response.runs : [];
      state.storageRoot = response.storageRoot || "";
      state.reviewers = response.reviewers || {};
      $("copy-root").disabled = !state.storageRoot;
      $("configured-reviewers").textContent = ["A", "B"]
        .map((role) => {
          const binding = state.reviewers[role];
          return binding
            ? `${names[binding.adapter] || binding.adapter}${binding.model ? ` · ${binding.model}` : ""}`
            : `Reviewer ${role}`;
        })
        .join(" + ");
      renderHistory();
      historyFingerprint = fingerprint;
      if (state.record && state.tab === "files") renderTab();
    }
    connection(true);
    if ($("notice").dataset.source === "history") notice();
    if (initial || (!state.record && !location.hash))
      selectRun(location.hash.slice(1));
    if (!state.record && !state.runs.length && !location.hash) {
      $("empty-state").hidden = false;
      $("loading-panel").hidden = true;
    }
    historyTimer = setTimeout(() => loadHistory(false), 5000);
  } catch (error) {
    if (signal.aborted) return;
    connection(false);
    notice(
      `${error.message} Start or reconnect the local Pyxis service, then try again.`,
      "history",
    );
    $("loading-panel").hidden = true;
    historyTimer = setTimeout(() => loadHistory(initial), 7000);
  }
}

function openDialog() {
  $("form-error").hidden = true;
  $("new-run-dialog").showModal();
  $("repo").focus();
}
function closeDialog() {
  if (!state.busy) $("new-run-dialog").close();
}
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied to clipboard.");
  } catch {
    toast("Clipboard unavailable. You can select and copy this value: " + text);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      $("toast").hidden = true;
    }, 15_000);
  }
}

async function download(kind) {
  const record = state.record,
    artifacts = state.artifacts;
  if (!record) return;
  try {
    let blob;
    if (kind === "report") {
      const response = await fetch(
        `/runs/${encodeURIComponent(record.id)}/report`,
      );
      if (!response.ok)
        throw new Error("The report could not be downloaded. Try again.");
      blob = new Blob([await response.text()], {
        type: "text/markdown;charset=utf-8",
      });
    } else
      blob = new Blob(
        [JSON.stringify({ run: record, artifacts }, null, 2) + "\n"],
        { type: "application/json" },
      );
    const url = URL.createObjectURL(blob),
      link = el("a");
    link.href = url;
    link.download = `pyxis-${record.id}.${kind === "report" ? "md" : "json"}`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(
      kind === "report"
        ? "Report downloaded."
        : "Public run record exported. Original proposal bytes stay in the local folder.",
    );
  } catch (error) {
    toast(error.message);
  }
}

document.addEventListener("click", (event) => {
  const button = event.target.closest?.("[data-action]");
  if (!button) return;
  const name = button.dataset.action;
  if (name === "tab") {
    setTab(button.dataset.value);
    $("tab-" + state.tab).focus();
  }
  if (name === "copy-path")
    state.storageRoot && state.record
      ? copy(folder(state.record.id))
      : toast("Folder path unavailable. Try refreshing the workspace.");
  if (name === "download") download(button.dataset.value);
});
for (const button of document.querySelectorAll("[data-filter]"))
  button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    renderHistory();
  });
for (const button of document.querySelectorAll("[data-tab]"))
  button.addEventListener("click", () => setTab(button.dataset.tab));
document.querySelector(".tabs").addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const tabs = [...document.querySelectorAll("[data-tab]")],
    current = tabs.findIndex((tab) => tab.dataset.tab === state.tab);
  const index =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
          tabs.length;
  setTab(tabs[index].dataset.tab, true);
});
document.querySelector(".skip-link").addEventListener("click", (event) => {
  event.preventDefault();
  $("main").focus();
  $("main").scrollIntoView({ block: "start" });
});
$("run-list").addEventListener("click", (event) => {
  const link = event.target.closest?.("a");
  if (link?.hash === location.hash) {
    event.preventDefault();
    selectRun(location.hash.slice(1));
  }
});
$("search").addEventListener("input", (event) => {
  state.query = event.target.value.trim();
  renderHistory();
});
$("history-toggle").addEventListener("click", () =>
  showHistory(!$("sidebar").classList.contains("is-open")),
);
$("lookup").addEventListener("submit", (event) => {
  event.preventDefault();
  const id = $("run-id").value.trim();
  if (!validId.test(id)) {
    $("run-id").setCustomValidity(
      "Use letters, numbers, hyphens or underscores.",
    );
    $("run-id").reportValidity();
    return;
  }
  if (location.hash === "#" + id) selectRun(id);
  else location.hash = id;
});
$("run-id").addEventListener("input", () => $("run-id").setCustomValidity(""));
$("copy-id").addEventListener(
  "click",
  () => state.record && copy(state.record.id),
);
$("copy-root").addEventListener(
  "click",
  () => state.storageRoot && copy(state.storageRoot),
);
for (const id of ["new-run", "empty-new-run"])
  $(id).addEventListener("click", openDialog);
for (const id of ["close-dialog", "cancel-dialog"])
  $(id).addEventListener("click", closeDialog);
$("new-run-dialog").addEventListener("cancel", (event) => {
  if (state.busy) event.preventDefault();
});
function refresh() {
  historyFingerprint = undefined;
  loadHistory(false);
  if (state.record || location.hash) selectRun(location.hash.slice(1));
}
$("refresh").addEventListener("click", refresh);
$("retry").addEventListener("click", refresh);
window.addEventListener("hashchange", () => selectRun(location.hash.slice(1)));
document.addEventListener("keydown", (event) => {
  if (
    event.key.toLowerCase() === "n" &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !$("new-run-dialog").open &&
    !event.target.closest?.('input,textarea,select,[contenteditable="true"]')
  ) {
    event.preventDefault();
    openDialog();
  }
  if (event.key === "Escape" && !$("new-run-dialog").open) showHistory(false);
});

$("create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.busy || !$("create-form").reportValidity()) return;
  const repo = $("repo").value.trim(),
    issue = $("new-issue").value.trim();
  if (!repo || !issue) {
    $("form-error").textContent =
      "Provide a repository path and an issue description.";
    $("form-error").hidden = false;
    return;
  }
  const input = { repo, issue };
  if ($("head").value.trim()) input.head = $("head").value.trim();
  if ($("base").value.trim()) input.base = $("base").value.trim();
  state.busy = true;
  $("form-error").hidden = true;
  for (const node of $("create-form").querySelectorAll("button,input,textarea"))
    node.disabled = true;
  $("create-submit").textContent = "Starting…";
  try {
    const result = await json("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(20_000),
    });
    state.busy = false;
    $("new-run-dialog").close();
    $("create-form").reset();
    state.tab = "findings";
    historyFingerprint = undefined;
    loadHistory(false);
    if (location.hash === "#" + result.runId) selectRun(result.runId);
    else location.hash = result.runId;
  } catch (error) {
    $("form-error").textContent =
      error.status && error.status < 500
        ? error.message
        : "Could not confirm submission. Check recent runs before trying again.";
    $("form-error").hidden = false;
  } finally {
    state.busy = false;
    for (const node of $("create-form").querySelectorAll(
      "button,input,textarea",
    ))
      node.disabled = false;
    $("create-submit").textContent = "Start investigation";
  }
});

document.documentElement.classList.add("js-ready");
reveal();
loadHistory(true);
