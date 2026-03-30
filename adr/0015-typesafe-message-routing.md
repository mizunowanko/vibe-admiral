# ADR-0015: 型安全なメッセージルーティング層の導入

- **Status**: Proposed
- **Date**: 2026-03-30
- **Issue**: [#764](https://github.com/mizunowanko/vibe-admiral/issues/764)
- **Tags**: frontend, engine, message-routing, type-safety

## Context

Engine → Frontend のメッセージルーティングが文字列ベースの switch 文に依存しており、型安全性がない。具体的には:

1. **Engine 側**: `ws-server.ts`（1699 行）内でプロセス ID の文字列 prefix（`flagship-`, `dock-`, `escort-`, `dispatch-`）でメッセージタイプを判別。prefix が一致しない場合は暗黙的に Ship として扱う（フォールバック）
2. **Frontend 側**: `useEngine()` フック（250 行超）が巨大な switch 文でメッセージをディスパッチ。メッセージタイプと payload の型対応がランタイムでのみ検証される
3. **メッセージフィルタリング**: `SessionChat.tsx` の `RENDERED_SYSTEM_SUBTYPES` が手動同期を要求し、Engine 側の変更が Frontend に反映漏れする

この構造により、過去 112 件のバグのうち約 15 件がメッセージの誤ルーティングやフィルタ漏れに起因している。代表例: #672（チャット混在）、#468（リアルタイム反映なし）。

## Decision

### 方針: Discriminated Union + Handler Registry パターン

#### 1. 共有メッセージ型定義

Engine と Frontend で共有する discriminated union 型を導入する:

```typescript
// shared/messages.ts
type ServerMessage =
  | { type: "ship:stream"; shipId: string; message: StreamMessage }
  | { type: "escort:stream"; shipId: string; escortId: string; message: StreamMessage }
  | { type: "flagship:stream"; fleetId: string; message: StreamMessage }
  | { type: "dock:stream"; fleetId: string; message: StreamMessage }
  | { type: "dispatch:stream"; dispatchId: string; fleetId: string; message: StreamMessage }
  | { type: "ship:updated"; ship: ShipData }
  | { type: "ship:gate-pending"; shipId: string; gateCheck: GateCheck }
  // ... 全メッセージタイプを網羅
```

#### 2. Engine 側: 型チェック付きメッセージ送信

```typescript
function broadcast<T extends ServerMessage["type"]>(
  type: T,
  payload: Extract<ServerMessage, { type: T }>
): void
```

プロセス ID による文字列判別を型ガード関数に置換:

```typescript
function classifyProcess(id: string): ProcessKind {
  if (id.startsWith("dispatch-")) return { kind: "dispatch", id };
  if (id.startsWith("escort-")) return { kind: "escort", id };
  // ...
}
```

#### 3. Frontend 側: Handler Registry

switch 文を宣言的なハンドラ登録に置換:

```typescript
const registry = createMessageRegistry<ServerMessage>();
registry.on("ship:stream", (msg) => shipStore.addLog(msg.shipId, msg.message));
registry.on("escort:stream", (msg) => shipStore.addLog(msg.shipId, msg.message));
// ...
```

### 検討した代替案

- **GraphQL Subscription**: 型安全性は高いが、リアルタイムストリーミングのレイテンシ要件と WS の既存投資を考慮して却下
- **tRPC**: サーバー・クライアント間の型共有に優れるが、Engine が Node.js + ws であり React フレームワーク非依存のため過剰
- **Protocol Buffers**: バイナリ効率は高いが、開発体験と既存の JSON エコシステムとの親和性を優先して却下

## Consequences

### Positive

- メッセージタイプと payload の型不一致がコンパイル時に検出可能
- 新しいメッセージタイプ追加時に Frontend のハンドラ漏れが型エラーとして検出可能
- `useEngine()` の巨大 switch 文が宣言的なハンドラ登録に置換され、可読性向上
- Engine 側のプロセス分類が型ガードとして明示化

### Negative

- 共有型定義のメンテナンスコスト（Engine と Frontend の両方で import）
- 既存の全メッセージハンドラの移行作業
- `shared/` ディレクトリの追加による monorepo 構成の複雑化

### Migration Strategy

段階的移行: 新規メッセージから Registry パターンを適用し、既存メッセージは switch 文と並行運用。全移行完了後に switch 文を削除。
