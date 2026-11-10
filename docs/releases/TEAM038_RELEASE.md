# TEAM-038 reliability release — V2.4.3

This branch archives the source of the TEAM-038 Demo release: TEAM-031 V2 lifecycle fixes plus TEAM-038 controlled maintenance and conflict isolation. The trading strategy remains V2.4.3. This is not the exact f97a8b3 base commit.

## Changes and validation
- Maintenance admission, execution draining and graceful shutdown; unknown submission and incomplete protection block safe completion.
- Explicit controlled Demo reset with current-account safety gates, consistent backups, immutable evidence and guarded lock handoff.
- Append-only FACT_CONFLICT_TERMINAL classification: retain original records, exclude conflicted history from performance and learning, keep unknown outcomes null.
- Separate performance epochs and forward-window records, with conservative learning eligibility.

No strategy, Score, factor weights, risk parameters, TP/SL/BE rules, position sizing, leverage or cost parameters changed. Real-money execution is not enabled.

The exact isolated source copy was retested on 2026-11-10, Beijing time 20:45:16–20:45:32: **488/488 tests passed**, no failures/skips/cancellations; syntax checks passed. Deployment reliability has bounded independent verification.

**Clean Forward Validation remains NOT_PASSED.** Ten natural settlements and Stop / TP1→BE / TP2 evidence are a separate acceptance stage. Factor learning remains disabled. Funding-query trace completeness and entry-snapshot freshness still require verification; hash validity alone does not establish timing completeness. No profitability or permanent stability claim is made.

Protection acceptance follows the existing workflow, with build delays disclosed separately. Actual missing protection, wrong identity/direction/quantity or cancelling the old SL before confirming BE remain failures.

## Source identity and operation boundary
The 265 release-source files have canonical SHA256 manifest **981555ef203392f8c86230236caf7f08a704691450456b7123dbd00e86d25a9a**. [TEAM038_MANIFEST.json](TEAM038_MANIFEST.json) lists all raw file hashes and the digest algorithm. These two documentation files are additional to that source manifest.

The archive excludes active databases, runtime backups/logs/locks, live environment files, API credentials, new raw account responses, the unreleased V2.4.4 draft and undeployed Factor Intelligence wiring. Existing governance/history among the 265 files is inherited from the prior public tree; old operational statuses are historical.

Publishing this branch does not deploy, merge main, change an account or authorize future reset/restart/unlock. A checkout is not a backup of the running account. Databases with maintenance classifications require compatible code and a reviewed migration procedure; do not blindly restore old code or databases. The guarded reset CLI is not a routine startup step.

