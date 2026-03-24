# ADR-0008: XState v5 による Ship/Escort ライフサイクル管理

- **Status**: Accepted
- **Date**: 2026-03-23
- **Issue**: [#538](https://github.com/mizunowanko-org/vibe-admiral/issues/538)
- **Tags**: engine, xstate, ship, escort, state-machine

## Context

Ship/Escort のライフサイクル管理が `db.ts`、`ship-manager.ts`、`api-server.ts`、`escort-manager.ts`、`lookout.ts`、`state-sync.ts` に分散しており、以下の問題が繰り返し発生していた:

- Gate 進入時に Escort が起動されない
- Escort 死亡時にリカバリされない
- Phase 遷移を Ship が検知できない
- Lookout の監視がアドホックで状態と乖離
- `updateShipPhase()` が `transitionPhase()` をバイパスして不整合を起こす

根本原因は **状態機械が手書きで複数ファイルに散在している** ことにあった。

## Decision

[XState v5](https://stately.ai/docs/xstate) を導入し、Ship 1台 = Actor 1つとして、状態・遷移・副作用を1箇所に定義する。

### Ship Machine の設計

```
planning → planning-gate → implementing → implementing-gate
→ acceptance-test → acceptance-test-gate → merging → done
```

- 各 gate 状態で `invoke` により Escort プロセスを自動起動
- `after` ディレイで gate タイムアウトを状態に内蔵
- Escort 死亡は `ESCORT_DIED` イベントとして処理し、自動リカバリ
- `stopped` 状態からの `RESUME` イベントで復帰

### 移行による改善

| 観点 | 移行前（手書き） | 移行後（XState） |
|------|----------------|-----------------|
| Phase 遷移定義 | db.ts + api-server.ts + ship-manager.ts に分散 | shipMachine 1ファイルに集約 |
| Gate → Escort 起動 | 接続されていない | `invoke` で自動 |
| Escort 死亡回復 | Map 削除のみ | `ESCORT_DIED` イベントで自動遷移 |
| タイムアウト | Lookout が別途ポーリング | `after` で状態に内蔵 |
| 不正遷移防止 | SQL の手動バリデーション | 定義にない遷移は構造的に不可能 |
| テスト | 結合テスト不足 | `@xstate/test` でモデルベーステスト |
| 可視化 | なし | Stately Inspector でリアルタイム表示 |

### 移行フェーズ

1. **Phase 1**: Ship Machine 定義 — 現在の phase 遷移ロジックを集約。SQLite は Actor の状態永続化に使用
2. **Phase 2**: Escort を invoke で統合 — Gate 状態の invoke で Escort プロセスを起動
3. **Phase 3**: Lookout を Actor に内蔵 — `after` ディレイで gate タイムアウト、独立 Lookout ループを廃止
4. **Phase 4**: Fleet Actor（親）— `maxConcurrentSorties` の強制、Ship Actor の spawn/destroy を管理

### 検討したが採用しなかった案

| 案 | 不採用理由 |
|----|----------|
| 手書き状態機械の改良 | 状態遷移・副作用・タイムアウトの結合が複雑化の根本原因。構造的に解決できない |
| 他の状態管理ライブラリ（Robot, Machina） | XState v5 が Actor モデル、永続化、テスト支援で最も成熟 |
| イベント駆動のみ（状態機械なし） | 不正遷移の防止が構造的に保証されない |

## Consequences

- **Positive**: 状態遷移の全定義が1ファイルに集約され、理解・保守・テストが容易
- **Positive**: Escort の起動・監視・死亡回復が状態機械に組み込まれ、漏れが構造的に不可能
- **Positive**: `@xstate/test` によるモデルベーステストで、全状態パスの網羅的検証が可能
- **Positive**: Stately Inspector で開発中のリアルタイム状態可視化が利用可能
- **Negative**: XState v5 への依存が追加（ただし zero dependencies、3.7M+ weekly downloads）
- **Negative**: 既存の分散したロジックの移行に相応の工数が必要
