# Commander Rules (Flagship / Dock Shared)

Rules that apply to both Flagship and Dock — the two commander Units.

## Label Constraints

- Never touch `status/*` labels — Engine manages them. No `status/` label is needed on issue creation.
- You may use `type/*` and `priority/*` labels freely.

## Ship 異常調査のログ最優先ルール

Ship の異常（無限ループ、processDead、phase 停滞など）を調査する際は、以下の順序を**厳守**する:

1. **Engine ログ** — Engine の stdout/stderr を確認。クラッシュ、未捕捉例外、WS エラー等
2. **Ship chat log** — `<worktree>/.claude/ship-log.jsonl` を確認。Ship が何をしていたか、どこで止まったか
3. **Escort chat log** — `<worktree>/.claude/escort-log.jsonl` を確認。Gate の判定内容、reject 理由等
4. **DB の状態** — phase_transitions テーブルで遷移履歴を確認
5. **ソースコード** — 上記 1〜4 で得た情報をもとに、初めてソースコードを読む

### ソースコードを先に読んではいけない理由

- ログなしの仮説は「こうなりそう」という推測にすぎず、精度が低い
- ログを見れば「実際に何が起きたか」がわかり、仮説の質が格段に上がる
- ソースコードは仮説の**検証**に使うもので、仮説の**生成**に使うものではない

> **背景**: Ship が planning-gate で無限ループしていた際、Flagship が DB やフロントエンドの情報だけで判断し、Ship/Escort のログを確認しなかった結果、根本原因（Escort 起動失敗）の特定が大幅に遅れた。

## Read-Only Constraint

- Commander's `allowedTools` does NOT include `Write`, `Edit`, or `Agent`. Commanders are strictly read-only operators.
- Dispatch is an independent Engine-managed process (not a sub-agent). Use `POST /api/dispatch` to launch.
- If a code change is needed, launch a Dispatch via Engine API — never write code directly as Commander.

> **背景**: #693 で Dispatch は Agent sub-agent から Engine 管理の独立プロセスに移行。Commander の allowedTools から Write/Edit/Agent を削除。

## Source Code Constraint

- **NEVER** read, search, or explore source code directly. Always delegate to Dispatch via `POST /api/dispatch`.
- Invoke `/investigate` to get Dispatch request templates for: bug investigation, codebase exploration, Ship error diagnosis.
- Commanders handle: user dialogue, planning, Engine API calls, and `gh` CLI.
- Dispatch processes investigate code, analyze bugs, and report findings — they never create issues.

### When to Dispatch

Launch a Dispatch process via `POST /api/dispatch` whenever you need to:
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

## Ship 状況確認の /ship-inspect 必須ルール

Ship の状況を確認・報告する際は、**必ず \`/ship-inspect\` スキルを使用する**。

### 必須使用の場面

- Ship の進捗・状況をユーザーに報告するとき
- Ship の異常（processDead, phase 停滞, 無限ループ等）を調査するとき
- Ship を pause/resume/abandon する判断を行うとき
- Lookout Alert を受けて Ship の状態を確認するとき

### 禁止事項

- **API の phase 情報だけで Ship の状態を判断・報告してはならない。** phase は「どのフェーズにいるか」であり、「何をしているか」ではない。
- **chat log（ship-log.jsonl）を読まずに Ship の状況を報告してはならない。**
- **/ship-inspect を省略して「phase が coding だから実装中です」等と報告してはならない。**

> **背景**: commander-rules.md の「Ship 異常調査のログ最優先ルール」だけでは Flagship がルールに従わないケースが繰り返し発生した。スキル化することでログ読み取りを強制する。
