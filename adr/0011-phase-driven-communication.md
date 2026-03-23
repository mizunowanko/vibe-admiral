# ADR-0011: Phase-Driven Communication — メッセージテーブル廃止とボール所有モデル

- **Status**: Accepted
- **Date**: 2026-03-23
- **Issue**: [#418](https://github.com/mizunowanko-org/vibe-admiral/issues/418)
- **Tags**: engine, communication, phase, gate, escort

## Context

Ship ↔ Engine ↔ Escort 間通信が DB の `messages` テーブルを介した非同期メッセージングで実装されていた。以下の問題が発生:

- **read_at 競合**: Ship と Engine が同じ `gate-response` を `WHERE read_at IS NULL` で取り合い、先に読んだ側が独占
- **消費者の曖昧さ**: メッセージの宛先（recipient）がなく、`(ship_id, type)` のみでルーティング
- **Escort が Ship の sub-agent**: Ship のコンテキストを消費し、Ship が死ぬと Escort も道連れ
- **admiral-request パターンの複雑さ**: Ship → stdout → Engine → DB → Ship のラウンドトリップが冗長

## Decision

「誰がボールを持っているか」を phase で表現し、メッセージテーブルを廃止する Phase-Driven Communication モデルを採用する。

### 設計原則

1. **phase = ボール所有者**: `planning` → Ship が作業中、`planning-gate` → Escort がレビュー中
2. **phase 遷移でポーリング**: 各 Unit は自分がボールを持つ phase への遷移を検知して動く
3. **具体情報は GitHub に記録**: plan → Issue comment、code → PR comment。DB は phase 状態のみ保持
4. **Escort は Engine が起動**: Ship の sub-agent ではなく、Engine が gate phase 検知時に独立プロセスとして起動

### Phase 遷移の権限

| 遷移 | 実行者 | 条件 |
|------|--------|------|
| `planning` → `planning-gate` | Ship | plan 完了、Issue に plan comment 投稿済み |
| `planning-gate` → `implementing` | Escort | approve |
| `planning-gate` → `planning` | Escort | reject（feedback は phase_transitions metadata に記録） |
| `implementing` → `implementing-gate` | Ship | code 完了、PR 作成済み |
| `implementing-gate` → `acceptance-test` | Escort | approve |
| `implementing-gate` → `implementing` | Escort | reject |
| `acceptance-test` → `acceptance-test-gate` | Ship | テスト準備完了 |
| `acceptance-test-gate` → `merging` | Escort | approve |
| `acceptance-test-gate` → `acceptance-test` | Escort | reject |
| `merging` → `done` | Ship | merge 完了 |

### 廃止されたもの

| 旧方式 | 新方式 |
|--------|--------|
| `messages` テーブル全体 | phase 遷移で表現 |
| `gate-response` メッセージ | Escort が phase を直接遷移 |
| `admiral-request` stdout パターン | REST API 経由（ADR-0007） |
| `acceptance-test-request/response` | phase 遷移で検知・報告 |
| gate reject feedback | `phase_transitions.metadata` に JSON で格納 |
| Ship 内 Escort sub-agent 起動 | Engine が独立プロセスとして起動 |

### 検討したが採用しなかった案

| 案 | 不採用理由 |
|----|----------|
| messages テーブルの改良（recipient カラム追加） | メッセージング自体が不要。phase 遷移で十分 |
| イベントキュー（Redis 等） | 外部依存の追加に見合う複雑さではない |
| WebSocket 双方向通信 | CLI subprocess は WebSocket クライアントを持てない |

## Consequences

- **Positive**: 通信が phase 遷移に集約され、「誰が何を待っているか」が DB の phase 値だけで判定可能
- **Positive**: `read_at` 競合のような消費者問題が構造的に排除される
- **Positive**: Gate reject feedback が `phase_transitions` テーブルに蓄積され、デバッグが容易
- **Positive**: Escort が独立プロセスになり、Ship 死亡に巻き込まれない
- **Negative**: Ship は自身の phase をポーリングする必要がある（REST API 経由で 60 秒間隔）
- **Negative**: 具体的な情報（plan、review コメント等）を phase_transitions metadata に収まらない場合は GitHub に書く必要があり、GitHub API 依存が増す
