# ADR-0016: Engine プロセス分離と Supervisor パターン

- **Status**: Proposed
- **Date**: 2026-03-30
- **Issue**: [#764](https://github.com/mizunowanko/vibe-admiral/issues/764)
- **Tags**: engine, reliability, process-isolation, supervisor

## Context

Engine は単一の Node.js プロセスで以下の全責務を担っている:

- WebSocket サーバー（クライアント管理、heartbeat）
- HTTP API サーバー（Ship/Escort/Fleet 操作）
- プロセスマネージャー（Claude CLI の spawn/kill/stream）
- 状態管理（XState Actor、DB 同期）
- ヘルスモニタリング（Lookout、liveness check）

`ws-server.ts` は 1699 行に肥大化し、関心の分離が不十分。1 つの `uncaughtException` で Engine 全体が crash し、全 Unit（Ship, Escort, Commander）が停止する。過去 16 件のバグのうち約 9 件がこの monolithic 構造に起因している。

代表例: #690（エラーハンドラ欠落でクラッシュ）、#632（CLI 頻繁に落ちる）、#674（再起動時 Actor 不一致）。

現在の対策:
- `uncaughtException` / `unhandledRejection` → crash-log.json → `engine.shutdown()` → exit(1)
- Frontend が Engine 再起動を検知して自動再接続
- `reconcileOnStartup()` で XState/DB 一貫性を回復

## Decision

### 方針: ws-server.ts のモジュール分割（Phase 1）+ 将来的なプロセス分離の検討（Phase 2）

現時点ではプロセス分離（Supervisor パターン）は**実装しない**。代わりに ws-server.ts の責務分割を先行する。

#### Phase 1: モジュール分割（推奨）

`ws-server.ts`（1699 行）を以下のモジュールに分割:

| モジュール | 責務 | 推定行数 |
|-----------|------|---------|
| `ws-server.ts` | WS 接続管理、heartbeat、メッセージルーティング | ~300 |
| `api-handlers.ts` | HTTP API リクエストハンドラ | ~400 |
| `ship-lifecycle.ts` | Ship/Escort のライフサイクルイベント処理 | ~400 |
| `startup.ts` | 起動シーケンス、reconciliation | ~200 |
| `health-monitor.ts` | Lookout、liveness check の統合 | ~200 |

分割の基準: 「1 つの `uncaughtException` の影響範囲を特定しやすくする」こと。モジュール境界で try-catch を配置し、非致命的エラーの伝播を防ぐ。

#### Phase 2: プロセス分離（将来検討）

Phase 1 の分割が安定した後、以下を検討:

1. **Supervisor プロセス**: 軽量な親プロセスが Engine 本体を子プロセスとして管理。crash 時に自動再起動
2. **IPC 分離**: ProcessManager を別プロセスに分離し、Claude CLI の stdout/stderr パースを Engine 本体から切り離す

### 検討した代替案

- **即座のプロセス分離**: Erlang/OTP 的な Supervisor tree の導入。効果は高いが、IPC オーバーヘッド・デバッグ複雑性・Tauri との統合問題で時期尚早と判断
- **Worker Threads**: Node.js の `worker_threads` で ProcessManager を分離。SharedArrayBuffer の制約と、XState Actor との同期問題で却下
- **現状維持 + エラーハンドリング強化のみ**: 根本的な肥大化問題を解決しないため不十分

## Consequences

### Positive

- ws-server.ts の可読性・テスタビリティが大幅に向上
- エラーの影響範囲が特定しやすくなる
- 各モジュールの独立したユニットテストが可能に
- Phase 2 への移行パスが明確

### Negative

- モジュール間のインターフェース設計が必要
- 循環依存のリスク（特に Ship lifecycle ↔ WS broadcast）
- Phase 1 だけでは uncaughtException での即死問題は解決しない

### Risk Mitigation

- Phase 1 は既存の関数境界に沿って分割するため、ロジック変更は最小限
- 分割後もエクスポートは `ws-server.ts` 経由で後方互換を維持可能
