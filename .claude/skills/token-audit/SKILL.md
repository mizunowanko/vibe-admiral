---
name: token-audit
description: トークン消費を分析し、節約方法の issue を起票する。Dispatch で全 Unit を調査
user-invocable: true
argument-hint: []
---

# /token-audit — トークン消費分析 & 節約 Issue 起票

全 Unit（Ship, Escort, Commander, Dispatch）のトークン消費を Dispatch で調査し、削減可能な箇所を特定して issue を起票する。

## 前提

- Commander（Dock）から呼び出される
- ソースコードの調査は全て Dispatch 経由（Commander はコードを直接読まない）
- Issue 起票は Commander が `gh issue create` で行う（Dispatch は起票しない）

## Step 1: Dispatch 起動（トークン消費調査）

4 種類の Dispatch を順次起動して調査する。各 Dispatch の結果を待ってから次に進む。

### 1a. プロンプトサイズ計測

各 Unit に読み込まれるファイルのトークン数を計測する。

```bash
curl -s -X POST http://localhost:$VIBE_ADMIRAL_ENGINE_PORT/api/dispatch \
  -H 'Content-Type: application/json' \
  -d '{
    "fleetId": "<fleet-id>",
    "parentRole": "dock",
    "name": "token-audit-prompt-size",
    "type": "investigate",
    "cwd": "<repo>",
    "prompt": "You are a Dispatch agent measuring token consumption of each Unit in the Admiral system.\n\nRepo: <repo>\n\n## Task\n\nMeasure the token size of all files that each Unit type loads into its context.\n\n### Unit types and their loaded files\n\n1. **Ship**: CLAUDE.md, .claude/rules/*.md, .claude/skills/ship-*/*.md, .claude/skills/shared-*/*.md\n2. **Escort**: CLAUDE.md, .claude/rules/*.md, .claude/skills/escort-*/*.md, .claude/skills/shared-*/*.md\n3. **Commander (Flagship/Dock)**: CLAUDE.md, .claude/rules/*.md, units/flagship/ or units/dock/ skills\n4. **Dispatch**: CLAUDE.md, .claude/rules/*.md (minimal skills)\n\n### Steps\n\n1. For each Unit type, glob and read the relevant files from the canonical source at `units/` directory\n2. Count approximate tokens for each file (1 token ≈ 4 chars for English, ≈ 2 chars for Japanese)\n3. Sum totals per Unit type\n4. Identify the largest files and biggest contributors to context size\n\n### Output format\n\n```\n## Unit Token Summary\n\n| Unit | File | Tokens (approx) |\n|------|------|------------------|\n| Ship | units/ship/skills/implement/SKILL.md | NNNN |\n| ... | ... | ... |\n\n## Totals\n| Unit | Total Tokens |\n|------|-------------|\n| Ship | NNNN |\n| Escort | NNNN |\n| Commander | NNNN |\n| Dispatch | NNNN |\n\n## Top 10 Largest Files\n| File | Tokens | Loaded by |\n|------|--------|----------|\n```\n\nDo NOT create issues or make any changes. Only investigate and report."
  }'
```

### 1b. 重複コンテンツ検出

スキル・ルール間で重複している内容を検出する。

```bash
curl -s -X POST http://localhost:$VIBE_ADMIRAL_ENGINE_PORT/api/dispatch \
  -H 'Content-Type: application/json' \
  -d '{
    "fleetId": "<fleet-id>",
    "parentRole": "dock",
    "name": "token-audit-duplicates",
    "type": "investigate",
    "cwd": "<repo>",
    "prompt": "You are a Dispatch agent detecting duplicate content across skills and rules.\n\nRepo: <repo>\n\n## Task\n\nFind content that is duplicated across multiple skill files and rules, wasting tokens.\n\n### Steps\n\n1. Read all files under `units/` directory (skills and rules for all Unit types)\n2. Read `.claude/rules/*.md`\n3. Read `CLAUDE.md`\n4. Identify sections, paragraphs, or code blocks that appear in multiple files (exact or near-duplicate)\n5. For each duplicate found, calculate the wasted tokens (duplicate count - 1) × size\n\n### Known areas to check (from past investigations #798, #799)\n\n- admiral-protocol API docs duplicated across skills\n- Gate verdict submission templates repeated in gate skills\n- Common rules/notes repeated in implement sub-skills\n- CLI subprocess rules that might overlap with CLAUDE.md\n\n### Output format\n\n```\n## Duplicate Content Report\n\n| Content | Files | Tokens per copy | Wasted Tokens |\n|---------|-------|-----------------|---------------|\n| API endpoint docs for X | skill-A, skill-B, skill-C | NNN | NNN×2 |\n\n## Total Wasted Tokens: NNNN\n\n## Consolidation Suggestions\n- [ ] Move X to shared location, saving NNNN tokens\n```\n\nDo NOT create issues or make any changes. Only investigate and report."
  }'
```

### 1c. Escort セッション蓄積の影響計測

ADR-0020 の計測基盤を使って Escort のトークン消費パターンを分析する。

```bash
curl -s -X POST http://localhost:$VIBE_ADMIRAL_ENGINE_PORT/api/dispatch \
  -H 'Content-Type: application/json' \
  -d '{
    "fleetId": "<fleet-id>",
    "parentRole": "dock",
    "name": "token-audit-escort",
    "type": "investigate",
    "cwd": "<repo>",
    "prompt": "You are a Dispatch agent analyzing Escort session token accumulation.\n\nRepo: <repo>\n\n## Task\n\nAnalyze Escort token consumption patterns using the ADR-0020 measurement infrastructure.\n\n### Steps\n\n1. Check the escorts table schema for token tracking columns (total_input_tokens, total_output_tokens, cost_usd)\n2. Query recent escort data to find token consumption per gate:\n   - Run: curl -s http://localhost:${VIBE_ADMIRAL_ENGINE_PORT:-9721}/api/fleet/<fleet-id>/ships to get recent ships\n   - For each ship with escort data, check escort usage via: curl -s http://localhost:${VIBE_ADMIRAL_ENGINE_PORT:-9721}/api/ship/<ship-id>/escort-usage\n3. Analyze the pattern: do later gates (coding-gate, qa-gate) consume more tokens than earlier gates (plan-gate)?\n4. Calculate the token growth rate across gates\n5. Estimate potential savings if sessions were reset between gates\n\n### Output format\n\n```\n## Escort Token Accumulation Analysis\n\n### Per-Gate Average (from N ships)\n| Gate | Avg Input Tokens | Avg Output Tokens | Avg Cost |\n|------|-----------------|-------------------|----------|\n| plan-gate | NNNN | NNNN | $X.XX |\n| coding-gate | NNNN | NNNN | $X.XX |\n| qa-gate | NNNN | NNNN | $X.XX |\n\n### Accumulation Pattern\n- Growth rate: X% per gate\n- Estimated savings with per-gate reset: NNNN tokens\n\n### Recommendation\n- [keep-resume / hybrid / per-gate-reset]\n```\n\nIf the escort-usage API is not available or returns no data, report that and suggest manual measurement steps instead.\n\nDo NOT create issues or make any changes. Only investigate and report."
  }'
```

### 1d. キャッシュ効率分析

プロンプトキャッシュの効率を分析する。

```bash
curl -s -X POST http://localhost:$VIBE_ADMIRAL_ENGINE_PORT/api/dispatch \
  -H 'Content-Type: application/json' \
  -d '{
    "fleetId": "<fleet-id>",
    "parentRole": "dock",
    "name": "token-audit-cache",
    "type": "investigate",
    "cwd": "<repo>",
    "prompt": "You are a Dispatch agent analyzing prompt cache efficiency.\n\nRepo: <repo>\n\n## Task\n\nAnalyze how well the current skill/rule structure enables Claude API prompt caching.\n\n### Background\n\nClaude API caches prompt prefixes. Files loaded in consistent order across sessions get cached. Files that change frequently or are loaded in varying order cause cache misses.\n\n### Steps\n\n1. Identify which files are loaded for each Unit type (from units/ directory)\n2. Analyze file stability:\n   - Run: git log --oneline -10 -- <file> for each skill/rule file\n   - Files changed frequently = poor cache candidates\n3. Check file loading order consistency:\n   - Are CLAUDE.md and rules loaded before skills? (good for caching)\n   - Are shared skills loaded in consistent order? (good for caching)\n4. Identify cache-busting patterns:\n   - Dynamic content in otherwise static files\n   - Frequently updated files loaded early in the prompt (breaks cache for everything after)\n\n### Output format\n\n```\n## Cache Efficiency Analysis\n\n### File Stability (last 30 days)\n| File | Changes | Cache Impact |\n|------|---------|-------------|\n| CLAUDE.md | N | High (loaded first, breaks all cache if changed) |\n\n### Cache-Busting Risks\n- [ ] Description of issue and estimated token cost\n\n### Optimization Suggestions\n- [ ] Suggestion with estimated improvement\n```\n\nDo NOT create issues or make any changes. Only investigate and report."
  }'
```

## Step 2: 調査結果の分析

全 Dispatch の結果が揃ったら、以下の観点で分析する:

1. **削減量の大きい順**にソート
2. **実装容易性**を評価（スキルファイル編集のみ = 容易、Engine 変更 = 中、アーキ変更 = 難）
3. **優先度 = 削減量 × 実装容易性** でランキング
4. 過去の issue（#798, #799, #800, #811）の対応状況を確認し、既に対応済みの項目は除外

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

- #900 — token-audit スキルによる調査結果
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
## トークン消費分析サマリ

### 調査結果
- 全 Unit 合計コンテキストサイズ: <N tokens>
- 重複コンテンツ: <N tokens>
- Escort 蓄積影響: <説明>
- キャッシュ効率: <説明>

### 起票した Issue
| # | タイトル | 期待削減量 | ラベル |
|---|---------|-----------|--------|
| #NNN | ... | N tokens | type/skill |

### 期待される総削減効果
- 合計: **<N tokens>** per sortie
- 6 Ship 並列時: **<N tokens>** per batch
```
