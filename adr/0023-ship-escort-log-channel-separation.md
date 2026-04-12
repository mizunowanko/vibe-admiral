# ADR-0023: Ship/Escort ログチャネル分離 + セッション登録一本化 + 通知 payload 自律化

- **Status**: Proposed
- **Date**: 2026-04-12
- **Issue**: [#938](https://github.com/mizunowanko/vibe-admiral/issues/938)（/audit-quality 監査枠）
- **Implementation Issue**: [#954](https://github.com/mizunowanko/vibe-admiral/issues/954)
- **Tags**: audit-quality, frontend, store-normalization, ui-consistency
- **Supersedes / Extends**: [ADR-0019](0019-frontend-store-normalization.md) Phase 5

## Context

/audit-quality 監査（Issue #938）で、UI 状態管理カテゴリの再発バグ 14+ 件（#944, #923, #902, #893, #860, #855, #817, #809, #788, #737, #729, #724, #704, #703, #699, #683）を分析した結果、**ADR-0019 の 4 Phase 実装済みにもかかわらず同系統バグが発生し続ける** 構造的要因として、以下 4 点が特定された（監査 Finding UI-1〜UI-4）。

### 構造的問題

**UI-1. Ship ログが Ship / Escort / 一部 system 通知の集約バッファ化**

`escort:stream` ハンドラが `shipStore.addShipLog(shipId, ...)` で Escort メッセージを **Ship の `shipLogs` Map に混入**させる。Ship 用ログチャネル（`shipLogs: Map<shipId, StreamMessage[]>`）が Ship + Escort 両方の集約バッファになっており、分離が存在しない。順序は WS 到着順に依存。`mergeShipHistory` はサーバ側 ship-log をベースに後追い append するだけなので、Escort メッセージが別ファイル（escort-log.jsonl）管理されていればリフレッシュで永遠に時系列が揃わない。

→ #902（Escort 順序）、#729（Escort を Ship 発言として表示）、#737（混在）、#817（片方しか表示されない）

**UI-2. Dispatch イベントの二重経路**

`dispatch:created` / `dispatch:completed` は `MessageHandlerMap` で意図的に no-op、`useDispatchListener` が別途 `wsClient.onMessage` で購読。ADR-0015（型安全ルーティング）の設計意図を破っている。`useDispatchListener` は `SessionCardList` にしか mount されず、unmount 中の `dispatch:completed` 取りこぼしが #703 を生む。`dispatch:stream` が `dispatch:created` より先に到達すると仮セッションが登録され、名前が更新されない。`parentRole` からの文字列合成で親紐付けしているため規約違反時に #788（独立セクション表示）が発生。

**UI-3. 通知 payload の自己完結性不足**

`ship:created` payload に fleetId を含まず、`handleShipCreated` は `updateShipFromApi(shipId)` を呼ぶだけ。`updateShipFromApi` は `existing.fleetId` を読むため新規 Ship（store 未登録）では早期 return → #944 の直接原因。副次的に #855, #683 にも寄与。通知イベントが「既に store にある」前提で動く逆転構造。

**UI-4. Session 登録が 5 経路に散在**

`createShipSession(...)` / `registerSession(...)` が ship:data / ship:created / ship:updated / onConnect 復帰 / fleet 切替の 5 経路に重複。新しい Ship イベント追加のたびに登録忘れリスクがあり、#855, #860, #683 を繰り返し生む。

### 既存 ADR との関係

- **ADR-0019** (Frontend store normalization): 4 Phase 実装済だが、本 4 問題はスコープ外 — 本 ADR は ADR-0019 の Phase 5 として位置付ける
- **ADR-0006** (SessionChat 表示ルール): 表示ルールは declarative 化されたが、**データチャネル自体が分離されていない**ためルールでは解決不能（UI-1 と直結）
- **ADR-0011** (Phase-driven communication): 通知 payload 自己完結性の決定が欠落（UI-3）
- **ADR-0015** (Typesafe message routing): UI-2 で意図的に破られており、補強が必要

## Decision

### 1. Ship / Escort ログチャネルの完全分離

`shipStore` に `escortLogs: Map<shipId, StreamMessage[]>` を新設し、`escort:stream` ハンドラは `addEscortLog` に向ける。`SessionChat` 側は Ship / Escort 両チャネルを **タイムスタンプで merge-sort** して表示する。

- Engine 側で既に `ship-log.jsonl` と `escort-log.jsonl` が分離している事実とフロントエンド store 構造を一致させる。
- `mergeShipHistory` も ship / escort それぞれに対して個別に history 取得する。

### 2. Dispatch イベント 3 種を `MessageHandlerMap` に一本化

- `dispatch:created` / `dispatch:stream` / `dispatch:completed` をすべて handler map 経由の単一経路にし、`useDispatchListener` を廃止。
- Dispatch セッションの親紐付けは Engine 側 `dispatch:created` payload に `parentSessionId` を含める（文字列合成をやめる）。
- これにより ADR-0015 の「全 WS message は単一 routing 層を通る」不変条件が回復。

### 3. WS 通知 payload を自己完結化

Ship 系 `ship:created` / `ship:updated` / `ship:data` の全 payload に以下を必須化:

```ts
{ shipId, fleetId, phase, issueNumber, issueTitle, repo, ... }
```

handler は API 往復なしで `upsertShip()` できる。`updateShipFromApi(shipId, fleetId?)` の fleetId は optional 化し、Engine 側でルックアップ。

→ #944（新規 Ship 消失）, #855（Fleet 切替で消える）, #683（resume 後不在）の同時撲滅。

### 4. Session 登録を `upsertShip` に内包

`useShipStore.upsertShip()` 内で `sessionStore.registerSession(createShipSession(...))` を自動呼出 するようストア間 subscribe / effect を一本化。handler 側からは `upsertShip` だけで十分にする。

- 5 経路の手動 `registerSession` 呼び出しを全削除。
- 新しい Ship 関連イベント追加時の登録忘れを構造的に不可能化。

### 代替案と却下理由

- **「`SessionChat` 側で後段 filter で Ship/Escort を分離」**: UI-1 の本質は「Ship chat が集約バッファ」である store 構造の問題。表示層で誤魔化すと `mergeShipHistory` の時系列問題は残る。
- **「`useDispatchListener` を残したまま `dispatch:completed` の購読を Ship store に移す」**: 二重経路構造は温存され ADR-0015 違反も放置になる。
- **「通知 payload に fleetId だけ追加」**: `handleShipCreated` の早期 return は fleetId 以外の 派生条件でも発生し得る。payload 自己完結を原則化する方が堅牢。

## Consequences

### Positive

- UI 14+ バグのうち約 80% を構造的に撲滅可能。
- ADR-0019 Phase 5 として継続性があり、既存 4 Phase の正規化投資を生かせる。
- ADR-0015 の「単一 routing 層」不変条件が回復し、将来の WS message 追加時の二重経路誘惑を除去。

### Negative

- `useDispatchListener` 廃止で `SessionCardList` 内の mount 前提コードが消え、dispatch 名不整合の既存回避コードも撤去が必要。
- Ship/Escort log 分離は type 変更を伴い、`StreamMessage` 利用側の import 更新が発生。
- WS payload 互換性: Engine と Frontend を同時に更新する必要あり（Engine 先行で payload 拡張、Frontend で新フィールド消費）。

### Migration Plan

1. Engine 側で `ship:created` / `ship:updated` payload に fleetId など拡張（Frontend は旧処理継続可能）
2. Frontend `upsertShip` に session 登録内包、handler 側 5 箇所の `registerSession` 削除
3. Dispatch 3 message を HandlerMap に統合、`useDispatchListener` 削除
4. `escortLogs` map 追加 + `escort:stream` ハンドラ切替 + `SessionChat` の merge-sort 実装
5. `mergeShipHistory` を ship/escort 両チャネル対応に改修
6. e2e で Fleet 切替 / Ship resume / Escort 並行表示を回帰検証
