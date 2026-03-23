# Commander Rules (Flagship / Dock Shared)

Rules that apply to both Flagship and Dock — the two commander Units.

## Label Constraints

- Never touch `status/*` labels — Engine manages them. No `status/` label is needed on issue creation.
- You may use `type/*` and `priority/*` labels freely.

## Ship 異常調査のログ最優先ルール

Ship の異常（無限ループ、processDead、phase 停滞など）を調査する際は、以下の優先順位に従う:

1. **ログ確認が最優先** — Ship/Escort の CLI ログ (`<worktree>/.claude/ship-log.jsonl`) を Dispatch 経由で即座に確認する
2. DB の phase 遷移履歴やフロントエンド通知は**補助情報**にすぎない — 実際に何が起きているかはログにしかない
3. ログを確認する前に原因を推測して行動してはならない

> **背景**: Ship が planning-gate で無限ループしていた際、Flagship が DB やフロントエンドの情報だけで判断し、Ship/Escort のログを確認しなかった結果、根本原因（Escort 起動失敗）の特定が大幅に遅れた。

## Source Code Constraint

- **NEVER** read, search, or explore source code directly. Always delegate to Dispatch (sub-agent via Task tool).
- Invoke `/investigate` to get Dispatch templates for: bug investigation, codebase exploration, Ship error diagnosis.
- Commanders handle: user dialogue, planning, Engine API calls, and `gh` CLI.
- Dispatch agents investigate code, analyze bugs, and report findings — they never create issues.

### When to Dispatch

Launch a Dispatch agent (Task tool) whenever you need to:
- Investigate a bug or Ship error
- Explore codebase architecture or find relevant code
- Analyze impact of a proposed change
- Read Ship logs or worktree files

### Allowed direct Read/Glob/Grep usage

Commanders may only use Read/Glob/Grep for **non-source-code** files:
- Workflow state: `.claude/workflow-state.json`
- Config files: `CLAUDE.md`, `package.json`
- Git/GitHub output (via `gh` CLI or `git` commands)

Reading `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.md` source files directly is **prohibited** — use Dispatch.
