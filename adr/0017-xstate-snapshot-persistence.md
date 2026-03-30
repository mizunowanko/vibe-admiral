# ADR-0017: XState を Single Source of Truth にした DB スナップショット設計

- **Status**: Proposed
- **Date**: 2026-03-30
- **Issue**: [#764](https://github.com/mizunowanko/vibe-admiral/issues/764)
- **Tags**: xstate, database, state-management, consistency

## Context

現在、Ship のライフサイクル状態は XState Actor と SQLite DB の二箇所で管理されている:

1. **XState Actor**（メモリ内）: phase 遷移の権威。`requestTransition()` がイベントを検証し、遷移の可否を判定
2. **SQLite DB**: phase の永続化。`persistPhaseTransition()` がトランザクションで phase 更新 + 監査ログ記録

同期パターンは「XState first → DB second」:
1. XState にイベントを送信し、遷移成功を確認
2. DB にトランザクションで phase 更新を書き込み

この設計の問題:
- **Split-brain リスク**: DB 書き込みが失敗すると XState だけが進み、再起動時に不整合が発生（#689, #694）
- **Replay のメンテナンス性**: `PHASE_REPLAY_EVENTS`（各 phase への到達イベント列）がハードコードされ、新しい phase 追加時に更新漏れリスク
- **Reconciliation の複雑性**: `reconcilePhase()` が DB phase から XState Actor を再構築するために、イベント列を順番に replay。中間状態で副作用（Escort 起動）を抑制する `suppressInitial` フラグが必要

ADR-0003 で DB を phase の SSoT として導入し、ADR-0008 で XState を遷移ロジックの権威として導入した結果、「遷移ロジックの権威」と「永続状態の権威」が分離して二重管理になっている。

## Decision

### 方針: XState Actor Snapshot の DB 永続化

XState v5 の `getPersistedSnapshot()` / `createActor({ snapshot })` API を活用し、Actor の完全な状態スナップショットを DB に保存する。

#### 設計

1. **スナップショット保存**: phase 遷移成功後、`actor.getPersistedSnapshot()` でシリアライズして DB に保存

```typescript
// ship-actor-manager.ts
async function persistTransition(shipId: string, event: ShipEvent): Promise<TransitionResult> {
  const result = this.requestTransition(shipId, event);
  if (!result.success) return result;

  const snapshot = actor.getPersistedSnapshot();
  db.persistActorSnapshot(shipId, result.toPhase, snapshot);
  return result;
}
```

2. **Actor 復元**: Engine 再起動時、DB スナップショットから直接 Actor を復元（replay 不要）

```typescript
// ship-actor-manager.ts
function restoreActor(ship: Ship): void {
  const snapshot = db.getActorSnapshot(ship.id);
  if (snapshot) {
    const actor = createActor(shipMachine, { snapshot });
    actor.start();
  } else {
    // フォールバック: 従来の replay 方式
    this.replayToPhase(ship.id, ship.phase);
  }
}
```

3. **DB スキーマ**: `ships` テーブルに `actor_snapshot` カラム（JSON TEXT）を追加。`phase` カラムはスナップショットから派生するが、クエリ利便性のため冗長に保持

```sql
ALTER TABLE ships ADD COLUMN actor_snapshot TEXT;
```

4. **`PHASE_REPLAY_EVENTS` の段階的廃止**: スナップショット復元が安定した後、replay ロジックをフォールバック専用に降格し、最終的に削除

#### 一貫性保証

- **同一トランザクション**: `phase` 更新と `actor_snapshot` 更新を同一 SQLite トランザクションで実行。部分的な書き込み失敗がない
- **Split-brain 防止**: XState 遷移成功 → DB スナップショット書き込み失敗の場合、次回 Engine 再起動時に前回のスナップショットから復元されるため、XState は前の状態に戻る
- **`reconcilePhase()` の簡素化**: スナップショットが DB phase と一致すれば reconciliation 不要。不一致時のみフォールバック replay

### 検討した代替案

- **DB を完全廃止して XState のみ**: Engine クラッシュ時に全状態が失われるため却下
- **Event Sourcing**: 全イベントを DB に記録し、replay で状態復元。イベント数増加に伴うスナップショット圧縮が結局必要になるため、最初からスナップショット方式を選択
- **Redis/外部ストアでの状態管理**: SQLite の WAL モードで十分な性能。外部依存を増やす理由がない

## Consequences

### Positive

- Engine 再起動時の状態復元が O(1)（replay の O(n) から改善）
- `PHASE_REPLAY_EVENTS` のメンテナンス不要に
- `suppressInitial` フラグと replay 中の副作用抑制が不要に
- Split-brain リスクの大幅低減（同一トランザクションで phase + snapshot を更新）

### Negative

- `actor_snapshot` のサイズ監視が必要（XState context が肥大化すると JSON サイズ増加）
- XState v5 の `getPersistedSnapshot()` API の安定性に依存
- マイグレーション期間中は snapshot あり/なしの Ship が混在

### Migration Strategy

1. `actor_snapshot` カラムを追加（nullable）
2. 新規 Ship は snapshot 付きで作成
3. 既存 Ship は次回 phase 遷移時に snapshot を保存開始
4. 全 Ship が snapshot を持つようになったら replay ロジックをフォールバック化
