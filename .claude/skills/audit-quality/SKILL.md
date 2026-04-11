---
name: audit-quality
description: コード品質監査とアーキテクチャ改善提案。バグ傾向分析→ソースコード精査→ADR+issue起票
user-invocable: true
argument-hint: []
---

# /audit-quality — コード品質監査 & アーキテクチャ改善提案

過去のバグ傾向を分析し、ソースコードを精査して、抜本的な設計改善を ADR + issue として起票する。

## 前提

- Commander（Dock）から呼び出される
- ソースコードの調査は全て Dispatch 経由（Commander はコードを直接読まない）
- ADR ファイル作成は Dispatch 経由で行う
- Issue 起票は Commander が `gh issue create` で行う（Dispatch は起票しない）

## Step 1: バグ傾向分析

### 1a. バグ一覧の取得

直近の closed bug を取得する。

```bash
gh issue list --label type/bug --state closed --limit 50 --json number,title,body,labels,closedAt
```

### 1b. カテゴリ分類

取得したバグを以下のカテゴリに分類する（カテゴリは柔軟に追加してよい）:

| カテゴリ | 判定基準 |
|---------|---------|
| **UI 状態管理** | フロントエンド Store、React 状態、表示不整合 |
| **Engine 安定性** | プロセス管理、WS 接続、クラッシュ、メモリ |
| **XState/DB 同期** | phase 遷移、Actor 管理、DB との整合性 |
| **Escort ライフサイクル** | Gate 起動/終了、セッション管理、verdict |
| **Ship ライフサイクル** | Sortie、pause/resume、worktree、cleanup |
| **スキル/プロンプト** | スキル定義の不備、プロンプト起因の挙動 |
| **CLI 連携** | Claude CLI のサブプロセス管理、stdin/stdout |
| **その他** | 上記に当てはまらない |

### 1c. 再発パターン検出

- 同じカテゴリのバグが **3 件以上** → 構造的問題の可能性あり（Step 2 の調査対象）
- 時系列で見て同じカテゴリが **短期間に集中** → 特定の変更が原因の可能性
- 過去の ADR（ADR-0015〜0020 等）で対策済みの問題が再発していないかチェック

### 1d. バグ傾向レポート

分析結果を以下のフォーマットで整理する:

```
## バグ傾向レポート

### カテゴリ別件数
| カテゴリ | 件数 | 代表的な Issue |
|---------|------|---------------|
| UI 状態管理 | N | #xxx, #yyy |
| Engine 安定性 | N | #xxx |
| ... | ... | ... |

### 再発パターン
| パターン | 件数 | 根本原因の仮説 |
|---------|------|---------------|
| <パターン名> | N | <仮説> |

### Step 2 調査対象
- <カテゴリ 1>: <調査の方向性>
- <カテゴリ 2>: <調査の方向性>
```

## Step 2: ソースコード精査（Dispatch）

Step 1 で特定されたバグ多発領域ごとに Dispatch を起動して精査する。

### Dispatch テンプレート

バグ多発カテゴリごとに 1 つの Dispatch を起動する（最大 4 並列）。

```bash
curl -s -X POST http://localhost:$VIBE_ADMIRAL_ENGINE_PORT/api/dispatch \
  -H 'Content-Type: application/json' \
  -d '{
    "fleetId": "<fleet-id>",
    "parentRole": "dock",
    "name": "audit-quality-<category>",
    "type": "investigate",
    "cwd": "<repo-path>",
    "prompt": "You are a Dispatch agent performing a code quality audit.\n\nRepo: <repo-path>\n\n## Audit Target\n\nCategory: <カテゴリ名>\nRelated bugs: <#xxx, #yyy, #zzz（Step 1 で特定した issue 番号）>\n\n## Task\n\nInvestigate the source code related to these recurring bugs and identify structural problems.\n\n### Investigation Areas\n\n1. **責務の肥大化**: 1 ファイルが担っている責務を列挙し、Single Responsibility Principle に違反しているか判定\n2. **抽象化の欠如**: 同じパターン（エラーハンドリング、状態更新、API 呼び出し等）が複数箇所にコピペされていないか\n3. **状態管理の不整合リスク**: 同じ情報が複数箇所で管理されていないか（二重管理）。同期漏れのリスクがあるか\n4. **エラー伝播の経路**: 例外やエラーがどこで捕捉され、どこで上位に漏れるか。未処理の経路がないか\n\n### Related Files to Check\n\n<Step 1 の分析から推定される関連ファイルのリスト>\n\n### Output Format\n\n```\n## Audit Report: <カテゴリ名>\n\n### Files Analyzed\n| File | Lines | Responsibilities |\n|------|-------|------------------|\n\n### Structural Problems Found\n\n#### Problem 1: <問題名>\n- **Type**: 責務肥大化 | 抽象化欠如 | 状態不整合 | エラー伝播\n- **Location**: <file:line>\n- **Description**: <問題の説明>\n- **Impact**: <この問題が引き起こすバグのパターン>\n- **Suggested Fix**: <改善の方向性>\n- **Effort**: S | M | L\n- **Priority**: High | Medium | Low\n\n### Summary\n- Total problems found: N\n- High priority: N\n- Estimated effort for all fixes: <S/M/L>\n```\n\nDo NOT create issues, ADRs, or make any changes. Only investigate and report."
  }'
```

### Dispatch 結果の統合

全 Dispatch の結果が揃ったら、以下の観点で統合分析する:

1. **問題の深刻度順**にソート（High → Medium → Low）
2. **問題間の依存関係**を特定（問題 A を解決すれば問題 B も解消される等）
3. **ADR にすべき問題**を選定（構造的な設計変更が必要なもの）
4. **Issue だけで対応できる問題**を選定（局所的なリファクタリング）
5. 過去の ADR（特に ADR-0015〜0020）との整合性を確認

## Step 3: ADR + Issue 起票

### 3a. ADR 作成（Dispatch 経由）

構造的な設計変更が必要な問題について、ADR を Dispatch で作成する。

```bash
curl -s -X POST http://localhost:$VIBE_ADMIRAL_ENGINE_PORT/api/dispatch \
  -H 'Content-Type: application/json' \
  -d '{
    "fleetId": "<fleet-id>",
    "parentRole": "dock",
    "name": "audit-quality-adr-<number>",
    "type": "investigate",
    "cwd": "<repo-path>",
    "prompt": "You are a Dispatch agent creating an ADR (Architecture Decision Record).\n\nRepo: <repo-path>\n\n## Task\n\nCreate an ADR file based on the following audit findings.\n\n### ADR Content\n\n- **Number**: <NNNN>\n- **Title**: <kebab-case-title>\n- **Status**: Proposed\n- **Issue**: Will be linked after issue creation\n- **Tags**: audit-quality, <category>\n\n### Context (Problem)\n<Step 2 の調査で特定された構造的問題の説明。バグの再発パターン、影響範囲、現状のコード構造の問題点>\n\n### Decision (Proposed Solution)\n<改善案の具体的な説明。代替案とその却下理由も含める>\n\n### Consequences\n<改善による正の影響と負の影響（移行コスト等）>\n\n## Steps\n\n1. Read the ADR template at adr/TEMPLATE.md\n2. Check existing ADRs in adr/ to determine the next number\n3. Create the ADR file at adr/<NNNN>-<title>.md following the template\n4. Report the created file path\n\nYou MUST create the ADR file. This is the one time you are authorized to write files."
  }'
```

**NOTE**: ADR 作成の Dispatch は `type: "investigate"` だが、ファイル書き込みが必要。Dispatch の allowedTools にはデフォルトで Write が含まれるため、ADR ファイルの作成は可能。

### 3b. Issue 起票

各改善提案について issue を起票する。

**ADR に紐づく Issue（設計変更レベル）**:

```bash
gh issue create \
  --title "refactor: <改善内容の要約>" \
  --label "type/refactor" \
  --body "$(cat <<'ISSUEEOF'
## 概要

<何を改善するか、1-2 文で>

## 背景

- **関連バグ**: <#xxx, #yyy, #zzz>
- **バグカテゴリ**: <カテゴリ名>
- **再発回数**: N 回
- **ADR**: [ADR-NNNN](adr/NNNN-title.md)

## 構造的問題

<Step 2 で特定された問題の説明>

## 改善案

<ADR で提案された解決策の要約>

### 実装ステップ

- [ ] <ステップ 1>
- [ ] <ステップ 2>
- [ ] <ステップ 3>

## 優先順位と期待効果

- **優先度**: High | Medium | Low
- **工数**: S | M | L
- **期待効果**: <この改善で防げるバグのカテゴリと件数>

## 関連

- #914 — audit-quality スキルによる調査結果
- ADR-NNNN — <ADR タイトル>
ISSUEEOF
)"
```

**ADR 不要の Issue（局所リファクタリング）**:

```bash
gh issue create \
  --title "refactor: <改善内容の要約>" \
  --label "type/refactor" \
  --body "$(cat <<'ISSUEEOF'
## 概要

<何を改善するか、1-2 文で>

## 背景

- **関連バグ**: <#xxx, #yyy, #zzz>
- **バグカテゴリ**: <カテゴリ名>
- **再発回数**: N 回

## 問題

<特定された問題の説明>

## 改善案

- [ ] <実装ステップ 1>
- [ ] <実装ステップ 2>

## 優先順位と期待効果

- **優先度**: High | Medium | Low
- **工数**: S（1 Ship sortie 以内）
- **期待効果**: <改善効果>

## 関連

- #914 — audit-quality スキルによる調査結果
ISSUEEOF
)"
```

## Step 4: サマリ報告

全ステップ完了後、ユーザーに以下のサマリを報告する:

```
## コード品質監査サマリ

### バグ傾向（直近 50 件）
| カテゴリ | 件数 | 傾向 |
|---------|------|------|
| <カテゴリ> | N | <増加/安定/減少> |

### 構造的問題
| # | 問題 | 深刻度 | 対象領域 | ADR |
|---|------|--------|---------|-----|
| 1 | <問題名> | High | <ファイル群> | ADR-NNNN |
| 2 | <問題名> | Medium | <ファイル群> | — |

### 起票した Issue
| Issue | タイトル | 優先度 | ADR |
|-------|---------|--------|-----|
| #NNN | refactor: ... | High | ADR-NNNN |

### 過去の ADR との関係
| 新規 ADR | 関連する既存 ADR | 関係 |
|---------|----------------|------|
| ADR-NNNN | ADR-0015 | 発展 / 補完 / 独立 |

### 推奨アクション順序
1. <最優先で対応すべき Issue>
2. <次に対応すべき Issue>
3. ...
```
