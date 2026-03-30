# ADR-0019: Frontend ストア正規化と楽観的更新パターン

- **Status**: Proposed
- **Date**: 2026-03-30
- **Issue**: [#764](https://github.com/mizunowanko/vibe-admiral/issues/764)
- **Tags**: frontend, zustand, state-management, normalization

## Context

Frontend の Zustand ストアに以下の構造的問題がある:

### 1. サーバー同期の無条件上書き

`shipStore.syncShips()` がサーバー状態で `ships` Map を無条件に上書きする。ユーザーの楽観的操作（Ship 選択、phase フィルタリング等）がサーバー push で破棄される。代表例: #437（画面リセット）、#548（画面トップ飛ばし）。

### 2. Commander メッセージの分散管理

Commander（Dock/Flagship）のメッセージが `useCommander()` フック内のローカル `useState` で管理されており、グローバルストアに統合されていない。history merge ロジック（タイムスタンプベースの重複排除、楽観的メッセージ保持）が各フックインスタンスに分散。

### 3. メッセージフィルタリングの手動同期

`SessionChat.tsx` の `RENDERED_SYSTEM_SUBTYPES` がハードコードされ、Engine 側で新しいシステムメッセージタイプが追加された際に手動更新が必要。コメントに「Keep in sync with: SessionMessage.tsx render-level guards & SystemMessageCard routing」と警告あり。

### 4. フォーカス管理の副作用

`focusedSessionId` が Fleet 切替・Ship 作成・Commander 再起動時に副作用的に変更される。ユーザーが意図しないセッションにフォーカスが移動する。

過去 66 件の UI 状態管理バグのうち約 30 件がこれらのパターンに該当する。

## Decision

### 方針: 段階的な正規化 + Diff-based 同期

#### 1. Diff-based サーバー同期

`syncShips()` の無条件上書きを diff-based merge に変更:

```typescript
// shipStore.ts
syncShips(serverShips: ShipData[]) {
  set((state) => {
    const newShips = new Map(state.ships);
    const serverIds = new Set(serverShips.map(s => s.id));

    // 削除: サーバーにない Ship を削除
    for (const id of newShips.keys()) {
      if (!serverIds.has(id)) newShips.delete(id);
    }

    // 更新/追加: サーバー状態をマージ（ローカル状態を保持）
    for (const serverShip of serverShips) {
      const existing = newShips.get(serverShip.id);
      if (existing) {
        // サーバー由来のフィールドのみ更新（phase, branch, prUrl 等）
        // ローカル由来のフィールドは保持（UI 選択状態等）
        newShips.set(serverShip.id, { ...existing, ...serverShip });
      } else {
        newShips.set(serverShip.id, serverShip);
      }
    }

    return { ships: newShips };
  });
}
```

#### 2. Commander メッセージのストア統合

`useCommander()` のローカル `useState` をグローバルストアに移行:

```typescript
// sessionStore.ts
interface SessionStore {
  commanderMessages: Map<string, StreamMessage[]>;  // sessionId → messages
  commanderLoading: Map<string, boolean>;           // sessionId → isLoading

  addCommanderMessage(sessionId: string, msg: StreamMessage): void;
  setCommanderLoading(sessionId: string, loading: boolean): void;
  mergeCommanderHistory(sessionId: string, history: StreamMessage[]): void;
}
```

利点:
- セッション切替時にメッセージが保持される（ローカル state のアンマウントによる消失を防ぐ）
- history merge ロジックがストア内に集約され、テスタブルに
- `useCommander()` はストアのセレクターとして薄くなる

#### 3. メッセージフィルタリングの宣言的定義

ハードコードされた `RENDERED_SYSTEM_SUBTYPES` を宣言的ルールテーブルに変更:

```typescript
// message-filters.ts
const MESSAGE_FILTER_RULES: FilterRule[] = [
  { subtype: "ship-status", contexts: ["ship", "command"], render: true },
  { subtype: "escort-log", contexts: ["ship"], render: true },
  { subtype: "commander-status", contexts: ["command"], render: true },
  { subtype: "lookout-alert", contexts: ["command"], render: true },
  // ...
];

function shouldRenderMessage(msg: StreamMessage, context: SessionContext): boolean {
  const rule = MESSAGE_FILTER_RULES.find(r => r.subtype === msg.subtype);
  if (!rule) return msg.meta?.category != null;  // デフォルト: category あればレンダリング
  return rule.render && rule.contexts.includes(context);
}
```

#### 4. フォーカス管理の明示化

暗黙的なフォーカス変更を明示的なアクションに限定:

```typescript
// sessionStore.ts
setFocus(sessionId: string, source: FocusSource): void;

type FocusSource =
  | "user-click"         // ユーザーの明示的操作
  | "keyboard-shortcut"  // Ctrl+N
  | "fleet-change"       // Fleet 切替時の自動フォーカス
  | "session-created";   // 新セッション作成時（auto-focus しない）
```

`session-created` 時は auto-focus しない（ユーザーが作業中の場合にフォーカスを奪わない）。`fleet-change` 時のみ自動的に Flagship にフォーカス。

### 検討した代替案

- **Jotai/Valtio への移行**: アトミックな状態管理は魅力的だが、5 つの Zustand ストアの全面書き換えはリスクが大きい。Zustand の正規化で同等の効果が得られる
- **React Server Components**: Tauri デスクトップアプリのため、RSC のサーバーサイドレンダリングの恩恵がない
- **Zustand Immer middleware**: 不変性の簡略化には有効だが、正規化とは直交する問題。必要に応じて後から追加可能
- **Redux Toolkit (RTK Query)**: 正規化と楽観的更新の実績があるが、Zustand エコシステムからの全面移行コストが高い

## Consequences

### Positive

- サーバー同期によるローカル状態の意図しない破棄が解消
- Commander メッセージがセッション切替で消失しなくなる
- メッセージフィルタリングの追加・変更がルールテーブルの 1 行追加で完了
- フォーカス変更の原因がトレース可能に（デバッグ容易性向上）

### Negative

- Commander メッセージのストア移行により、既存の `useCommander()` 利用箇所の全修正が必要
- diff-based 同期のエッジケース（サーバーとローカルの競合解決ルール）の設計が必要
- メッセージフィルタリングルールテーブルのメンテナンスコスト（ただしハードコードよりは低い）

### Migration Strategy

1. **Phase 1**: `syncShips()` の diff-based merge 導入（最も影響範囲が広いバグパターンを先に解消）
2. **Phase 2**: フォーカス管理の明示化（`FocusSource` 導入）
3. **Phase 3**: Commander メッセージのストア統合
4. **Phase 4**: メッセージフィルタリングの宣言的定義

各 Phase は独立して実装・マージ可能。Phase 1 だけでも約 12 件のバグパターンを構造的に解消できる。
