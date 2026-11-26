# Collaborator reviews

The [review-request workflow](../.github/workflows/collaborator-reviews.yml) requests every current collaborator with write access except the PR author. An outside contributor's PR requests all of them. The list comes from GitHub on each run, including the owner; there is no hardcoded roster or extra secret.

Requests run when a PR opens, reopens, becomes ready for review, or receives new commits. Already pending requests are left alone. Draft PRs wait until ready for review. After new commits, collaborators who already reviewed are requested again. GitHub permits review requests to users with write access; read-only users cannot satisfy this policy.

This workflow uses `pull_request_target` so it can request reviews on fork PRs. It never checks out or executes PR code. Keep it that way. It becomes active after merging it into the repository's default branch, `main`.

## Required owner setup

Automatic requests notify reviewers. **GitHub branch protection must separately enforce the approval requirement.** A repository administrator must open [Settings → Branches](https://github.com/manirht/pyxis/settings/branches) and create a protection rule for `main`:

- Enable **Require a pull request before merging**.
- Enable **Require approvals**, with **1** required approval.
- Enable **Dismiss stale pull request approvals when new commits are pushed**.
- Enable **Do not allow bypassing the above settings**, including administrators.

Leave force pushes and branch deletion disabled. Preserve any other existing protections. Apply the same rule to any additional integration or release branches that must require review; ordinary feature branches can still accept pushes.

One approval from another collaborator with write access then satisfies the approval count. All eligible collaborators receive requests, but they do not all have to approve. Authors cannot approve their own PRs. New commits require a fresh approval when GitHub dismisses the stale review.

Changing this rule requires admin access. Merging the workflow does not enable branch protection; verify the rule in Settings before relying on it. See GitHub's [protected-branch documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches) and [review-request API](https://docs.github.com/en/rest/pulls/review-requests).
