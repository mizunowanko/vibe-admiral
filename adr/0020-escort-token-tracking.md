# ADR-0020: Escort セッション蓄積のトークン追跡と最適化方針

- **Status**: Accepted
- **Date**: 2026-04-01
- **Issue**: [#800](https://github.com/mizunowanko/vibe-admiral/issues/800)
- **Tags**: escort, token, cost, optimization

## Context

Escort は `--resume` でセッションを跨いで再開し、gate 間のレビュー文脈を保持する（ADR-0014 参照）。
しかし、plan-gate → coding-gate → qa-gate と進むたびにコンテキストが蓄積し、後半の gate ほどトークン消費が大きくなる可能性がある。

### 調査で判明した事実

1. **トークン計測基盤が存在しなかった** — `compact_boundary` の `pre_tokens` は表示のみで永続化されず、Escort の gate ごとのトークン使用量を追跡する手段がなかった
2. **Claude CLI の `result` メッセージに usage/cost 情報が含まれる** — セッション終了時に `cost_usd` と `usage` (input_tokens / output_tokens) が出力される
3. **Escort は 1 Ship につき 1 レコード** — `escorts` テーブルで `ship_id` + `phase != 'done'` で管理。session resume で同一 Escort が複数 gate を担当

### セッション戦略の比較

| 方式 | Pros | Cons |
|------|------|------|
| **現状（全 gate resume）** | 文脈保持、plan→code review の整合性チェック可能 | 後半 gate ほどトークン蓄積大 |
| **gate ごとに新規セッション** | コンテキストクリーン、一定コスト | キャッシュミス、文脈喪失（plan review の知見が code review に活きない） |
| **ハイブリッド（plan+code は resume、QA は新規）** | plan→code の整合性は保持、QA は独立で軽量 | 実装複雑度が上がる |
| **明示的 compaction トリガー** | gate 前にコンテキスト圧縮 | CLI 側の制約（`/compact` は manual trigger のみ、プログラマティック制御不可） |

## Decision

### Phase 1: 計測基盤の構築（本 ADR のスコープ）

**計測なくして最適化なし。** まずトークン消費の実態を把握する基盤を構築する。

1. **`stream-parser.ts` に `extractResultUsage()` を追加** — Claude CLI の `result` メッセージから `cost_usd` と `usage` を抽出
2. **`escorts` テーブルに `total_input_tokens`, `total_output_tokens`, `cost_usd` カラムを追加** — gate ごとの結果を累積記録
3. **`ship-lifecycle.ts` で Escort の result メッセージを検出し DB に記録** — ストリーム処理パイプラインに自然に組み込み
4. **`GET /api/ship/:shipId/escort-usage` API エンドポイントを追加** — Frontend やログから確認可能に

### Phase 2: データ駆動の最適化判断（将来 PR）

計測データが蓄積された後、以下を判断する:
- gate 間のトークン増加率が許容範囲内なら現状維持
- 増加率が大きい場合、ハイブリッド方式（QA のみ新規セッション）への移行を検討
- compaction の自動トリガーが CLI 側でサポートされれば、gate 前 compaction を検討

### 設計方針

- **記録ロジックは `ship-lifecycle.ts` に集約** — Escort のストリームデータ処理は既にここで行われており、責務の分離が明確
- **累積記録（COALESCE + 加算）** — gate ごとに result が発行されるため、各 gate の使用量を合算
- **nullable カラム** — 既存データへの後方互換性を維持

## Consequences

### Positive

- Escort のトークン消費を定量的に把握できるようになる
- gate ごとのコスト傾向を分析し、データ駆動で最適化判断を下せる
- Engine ログに gate ごとの使用量が出力され、運用時のコスト可視性が向上

### Negative

- `result` メッセージの `cost_usd` / `usage` フィールドは Claude CLI の出力形式に依存 — CLI のフォーマット変更時に追従が必要
- DB スキーマの変更（V12 マイグレーション）が必要 — ただし nullable カラム追加のみでリスクは低い
