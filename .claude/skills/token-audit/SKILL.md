---
name: token-audit
description: トークン消費を分析し、節約方法の issue を起票する。Dispatch で全 Unit を調査
user-invocable: true
argument-hint: []
---

# /token-audit — 総合トークン消費監査 & 節約 Issue 起票

チャットログ分析・ソースコード分析・トークン集計データの 3 観点から総合的にトークン消費を監査し、削減可能な箇所を特定して issue を起票する。

## 前提

- Commander（Dock）から呼び出される
- ソースコードの調査は全て Dispatch 経由（Commander はコードを直接読まない）
- Issue 起票は Commander が `gh issue create` で行う（Dispatch は起票しない）

## Step 1: Dispatch 起動（3 種の調査を並行実行）

3 つの Dispatch を起動して、それぞれの観点からトークン消費を調査する。

### Dispatch 1: チャットログ分析（Y）

Ship のチャットログからトークン消費パターンと「使い方ミス」を検出する。

まず Ship 一覧を取得する:

```bash
SHIPS_JSON=$(curl -sf "http://localhost:$VIBE_ADMIRAL_ENGINE_PORT/api/ships?fleetId=<fleet-id>")
```

ランダムに 2-3 隻を選び、各 Ship の `worktreePath` を取得してプロンプトに含める。

```bash
curl -s -X POST "http://localhost:$VIBE_ADMIRAL_ENGINE_PORT/api/dispatch?fleetId=<fleet-id>" \
  -H 'Content-Type: application/json' \
  -d '{
    "fleetId": "<fleet-id>",
    "parentRole": "dock",
    "name": "token-audit-chatlog",
    "type": "investigate",
    "cwd": "<repo>",
    "prompt": "You are a Dispatch agent analyzing Ship chat logs for token consumption patterns.\n\nRepo: <repo>\n\n## Task\n\nAnalyze the following Ship chat logs for token usage anomalies and misuse patterns.\n\n### Target Ships\n<list worktree paths of 2-3 selected ships>\n\n### Steps\n\n1. For each Ship, read the chat log:\n   `cat <worktree>/.claude/ship-log.jsonl`\n\n2. **Token usage anomaly detection**:\n   - Parse `result` messages for `usage` fields (input_tokens, output_tokens)\n   - Identify turns where token consumption spikes significantly (>2x average)\n   - Note which tool calls or content caused the spike\n\n3. **Misuse pattern detection** — check for these patterns:\n   a. **Unnecessary file reads**: Reading files unrelated to the issue being worked on\n   b. **Out-of-scope work**: Performing refactoring, documentation generation, or other tasks not specified in the issue\n   c. **Gate reject loops**: Repeating the same approach after a gate rejection without meaningful changes\n   d. **Excessive tool calls**: Overuse of Read/Glob/Grep (e.g., reading the same file multiple times, searching for things already found)\n   e. **Rule violations**: Not following VIBE_ADMIRAL skills/rules (e.g., skipping plan-gate, not posting plan to issue, not using Engine API for phase transitions)\n\n### Output format\n\n```\n## Chat Log Analysis Report\n\n### Ship: <ship-id> (Issue #<number>)\n\n#### Token Usage Timeline\n| Turn | Tool/Action | Input Tokens | Output Tokens | Notes |\n|------|-----------|-------------|--------------|-------|\n| N | <action> | NNNN | NNNN | <spike?> |\n\n#### Detected Misuse Patterns\n| Pattern | Severity | Description | Estimated Waste |\n|---------|----------|-------------|----------------|\n| <type> | high/medium/low | <details> | ~NNNN tokens |\n\n### Summary\n- Total ships analyzed: N\n- Total misuse patterns found: N\n- Estimated total waste: NNNN tokens\n- Most common misuse: <pattern>\n```\n\nDo NOT create issues or make any changes. Only investigate and report."
  }'
```

### Dispatch 2: ソースコード分析（Z）

各 Unit のプロンプトサイズ、重複コンテンツ、キャッシュ効率、不要スキル deploy を分析する。

```bash
curl -s -X POST "http://localhost:$VIBE_ADMIRAL_ENGINE_PORT/api/dispatch?fleetId=<fleet-id>" \
  -H 'Content-Type: application/json' \
  -d '{
    "fleetId": "<fleet-id>",
    "parentRole": "dock",
    "name": "token-audit-source",
    "type": "investigate",
    "cwd": "<repo>",
    "prompt": "You are a Dispatch agent analyzing source code for token optimization opportunities.\n\nRepo: <repo>\n\n## Task\n\nPerform a comprehensive source code analysis of the prompt/skill/rule structure for token optimization.\n\n### A. Prompt Size Measurement\n\n1. For each Unit type, glob and read the relevant files from the `units/` directory:\n   - **Ship**: `units/ship/skills/*/SKILL.md`, CLAUDE.md, `.claude/rules/*.md`\n   - **Escort**: `units/escort/skills/*/SKILL.md`, CLAUDE.md, `.claude/rules/*.md`\n   - **Commander (Flagship)**: `units/flagship/skills/*/SKILL.md`, `units/flagship/rules/*.md`, CLAUDE.md, `.claude/rules/*.md`\n   - **Commander (Dock)**: `units/dock/skills/*/SKILL.md`, `units/dock/rules/*.md`, CLAUDE.md, `.claude/rules/*.md`\n   - **Shared skills/rules**: `units/shared/skills/*/SKILL.md`, `units/shared/rules/*.md`\n2. Count approximate tokens for each file (1 token ≈ 4 chars for English, ≈ 2 chars for Japanese)\n3. Sum totals per Unit type (including shared files loaded by each)\n\n### B. Duplicate Content Detection\n\n1. Read all files identified in step A\n2. Identify content that appears in multiple files (exact or near-duplicate paragraphs, code blocks, templates)\n3. For each duplicate: calculate wasted tokens = (copy count - 1) × size\n4. Check known duplication areas:\n   - Admiral-protocol API docs across skills\n   - Gate verdict templates in gate skills\n   - Common notes in implement sub-skills\n   - CLI subprocess rules overlapping with CLAUDE.md\n\n### C. Cache Efficiency Analysis\n\n1. Check file stability: `git log --oneline -10 -- <file>` for each skill/rule file\n2. Identify cache-busting patterns:\n   - Frequently changed files loaded early (breaks cache for everything after)\n   - Dynamic content in otherwise static files\n   - Inconsistent file loading order across Unit types\n\n### D. Unnecessary Skill Deploy Detection\n\n1. Read `engine/src/ship-manager.ts` and find the `deploySkills()` method\n2. Identify which skills are deployed to each Unit type\n3. Cross-reference with actual skill usage in chat logs or skill invocation patterns\n4. Flag skills that are deployed but never or rarely invoked\n\n### Output format\n\n```\n## Source Code Analysis Report\n\n### A. Unit Token Summary\n| Unit | File | Tokens (approx) |\n|------|------|------------------|\n| Ship | units/ship/skills/implement/SKILL.md | NNNN |\n\n| Unit | Total Tokens |\n|------|-------------|\n| Ship | NNNN |\n| Escort | NNNN |\n| Flagship | NNNN |\n| Dock | NNNN |\n\n### B. Duplicate Content\n| Content | Files | Tokens/copy | Wasted |\n|---------|-------|-------------|--------|\nTotal Wasted: NNNN tokens\n\n### C. Cache Efficiency\n| File | Changes (30d) | Cache Impact |\n|------|--------------|-------------|\nCache-busting risks: ...\n\n### D. Unnecessary Deploys\n| Skill | Deployed to | Usage | Recommendation |\n|-------|------------|-------|---------------|\n\n### Top Optimization Opportunities (sorted by impact)\n1. ...\n2. ...\n```\n\nDo NOT create issues or make any changes. Only investigate and report."
  }'
```

### Dispatch 3: トークン集計データ分析（U）

ADR-0020 の Escort トークン計測基盤のデータと Ship ごとのトークン消費を分析する。

まず Fleet の全 Ship 一覧を取得し、各 Ship の escort-usage を集める:

```bash
curl -s -X POST "http://localhost:$VIBE_ADMIRAL_ENGINE_PORT/api/dispatch?fleetId=<fleet-id>" \
  -H 'Content-Type: application/json' \
  -d '{
    "fleetId": "<fleet-id>",
    "parentRole": "dock",
    "name": "token-audit-aggregation",
    "type": "investigate",
    "cwd": "<repo>",
    "prompt": "You are a Dispatch agent analyzing token consumption aggregation data.\n\nRepo: <repo>\nEngine port: <engine-port>\nFleet ID: <fleet-id>\n\n## Task\n\nAnalyze the Escort token tracking data (ADR-0020) and Ship-level token consumption.\n\n### A. Escort Token Data Collection\n\n1. Get all Ships in the fleet:\n   `curl -sf \"http://localhost:<engine-port>/api/ships?fleetId=<fleet-id>\"`\n2. For each Ship, get Escort usage:\n   `curl -sf \"http://localhost:<engine-port>/api/ship/<ship-id>/escort-usage\"`\n3. Collect: total_input_tokens, total_output_tokens, cache_read_input_tokens, cache_creation_input_tokens, cost_usd\n\n### B. Gate-level Analysis\n\nFrom the collected data:\n1. Group by gate phase (plan-gate, coding-gate, qa-gate)\n2. Calculate averages and medians for each gate\n3. Identify if later gates consume more tokens (session accumulation effect)\n4. Estimate savings if sessions were reset between gates vs current resume approach\n\n### C. Ship-level Variance Analysis\n\n1. Compare total token consumption across Ships\n2. Identify outlier Ships (>1.5x median consumption)\n3. For outliers, check:\n   - Number of gate rejections (more rejections = more tokens)\n   - Issue complexity (larger PRs may justify higher consumption)\n   - Re-sortie count\n4. Correlate token consumption with issue labels (type/feature vs type/bug vs type/skill)\n\n### D. Cost Summary\n\n1. Calculate total cost across all Ships\n2. Average cost per Ship, per gate, per sortie\n3. Project monthly cost at current usage rate\n\n### Output format\n\n```\n## Token Aggregation Analysis Report\n\n### A. Escort Usage by Ship\n| Ship ID | Issue # | Input Tokens | Output Tokens | Cache Read | Cache Creation | Cost |\n|---------|---------|-------------|--------------|-----------|---------------|------|\n\n### B. Gate-level Averages\n| Gate | Avg Input | Avg Output | Avg Cache Read | Avg Cost |\n|------|----------|-----------|---------------|----------|\n| plan-gate | NNNN | NNNN | NNNN | $X.XX |\n| coding-gate | NNNN | NNNN | NNNN | $X.XX |\n| qa-gate | NNNN | NNNN | NNNN | $X.XX |\n\nAccumulation rate: X% increase per gate\nEstimated savings with per-gate reset: NNNN tokens ($X.XX)\n\n### C. Ship Variance\n| Metric | Value |\n|--------|-------|\n| Median tokens/Ship | NNNN |\n| Mean tokens/Ship | NNNN |\n| Std deviation | NNNN |\n| Outlier Ships | <list> |\n\nOutlier analysis: ...\n\n### D. Cost Summary\n| Metric | Value |\n|--------|-------|\n| Total cost | $X.XX |\n| Avg cost/Ship | $X.XX |\n| Projected monthly | $X.XX |\n```\n\nIf the escort-usage API returns no data or 404 for some Ships, report those Ships as having no tracking data and suggest enabling token tracking.\n\nDo NOT create issues or make any changes. Only investigate and report."
  }'
```

## Step 2: 調査結果の分析

全 Dispatch の結果が揃ったら、以下の観点で分析する:

Dispatch 完了を確認:

```bash
curl -sf "http://localhost:$VIBE_ADMIRAL_ENGINE_PORT/api/dispatches?fleetId=<fleet-id>" | \
  python3 -c "import sys,json; data=json.load(sys.stdin); [print(f'{d[\"name\"]}: {d[\"status\"]}') for d in data.get('dispatches',[]) if d['name'].startswith('token-audit-')]"
```

各 Dispatch の結果を取得:

```bash
curl -sf "http://localhost:$VIBE_ADMIRAL_ENGINE_PORT/api/dispatches?fleetId=<fleet-id>" | \
  python3 -c "import sys,json; data=json.load(sys.stdin); [print(f'=== {d[\"name\"]} ===\n{d.get(\"result\",\"(no result)\")}') for d in data.get('dispatches',[]) if d['name'].startswith('token-audit-') and d['status']=='completed']"
```

分析の手順:

1. **削減量の大きい順** にソート
2. **実装容易性** を評価:
   - 容易: スキル・ルールファイルの編集のみ
   - 中: Engine コード変更が必要
   - 難: アーキテクチャ変更が必要
3. **優先度 = 削減量 × 実装容易性** でランキング
4. 過去の関連 issue（#798, #799, #800, #811, #900）の対応状況を `gh issue view` で確認し、既に対応済みの項目は除外

## Step 3: Issue 起票

各削減ポイントについて、以下のフォーマットで issue を起票する:

```bash
gh issue create \
  --title "<type>: <改善内容の要約>" \
  --label "<type/skill または type/refactor>" \
  --body "$(cat <<'ISSUEEOF'
## 概要

<何を改善するか、1-2 文で>

## 現状のトークン数

| 対象 | 現在のトークン数 |
|------|----------------|
| <ファイルや領域> | <N tokens> |

## 削減案

<具体的な変更内容>

- [ ] <実装ステップ 1>
- [ ] <実装ステップ 2>

## 期待効果

- 削減量: **<N tokens>** (per <unit/sortie/gate>)
- 並列 6 Ship 時の効果: **<計算結果>** tokens/batch

## 関連

- #912 — /token-audit 総合監査スキルによる調査結果
ISSUEEOF
)"
```

### ラベル選択基準

| 変更内容 | ラベル |
|---------|--------|
| CLAUDE.md / skills / rules の変更 | `type/skill` |
| Engine コードの変更 | `type/refactor` |

## Step 4: サマリ報告

全ての issue を起票したら、ユーザーに以下のサマリを報告する:

```
## トークン消費監査サマリ

### 調査結果

#### Dispatch 1: チャットログ分析
- 分析した Ship 数: N
- 検出した使い方ミスパターン: N 件
- 推定無駄トークン: NNNN tokens

#### Dispatch 2: ソースコード分析
- 全 Unit 合計コンテキストサイズ: N tokens
- 重複コンテンツ: N tokens
- キャッシュ効率: <説明>
- 不要スキル deploy: N 件

#### Dispatch 3: トークン集計データ
- Escort 蓄積影響: <説明>
- Ship 間のばらつき: <説明>
- 月間推定コスト: $X.XX

### 起票した Issue
| # | タイトル | 期待削減量 | ラベル |
|---|---------|-----------|--------|
| #NNN | ... | N tokens | type/skill |

### 期待される総削減効果
- 合計: **N tokens** per sortie
- 6 Ship 並列時: **N tokens** per batch
```
