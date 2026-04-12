# ADR-0021: PhaseTransactionService による XState/DB/Long-poll/Escort の単一原子トランザクション

- **Status**: Proposed
- **Date**: 2026-04-12
- **Issue**: [#938](https://github.com/mizunowanko/vibe-admiral/issues/938)（/audit-quality 監査枠）
- **Implementation Issue**: [#952](https://github.com/mizunowanko/vibe-admiral/issues/952)
- **Tags**: audit-quality, escort-lifecycle, xstate, phase-transition

## Context

/audit-quality 監査（Issue #938）で、Escort ライフサイクル / Gate verdict 系の再発バグ 9+ 件（#947, #896, #853, #861, #835, #830, #695, #696, #751 ほか）を分析した結果、根本原因は個別の Escort バグではなく **「phase 更新」という同一ロジックが 7 箇所に散在し、各所で XState / DB / long-poll waiter / gate-intent / Flagship 通知 の 5 チャンネルを手動で整合させている** 構造にあることが判明した。

### 症状

- **#947**: `notifyPhaseWaiters` が active waiter を Map ごと削除し、同一 phase 継続待機中の long-poll も破壊。
- **#830**: `plan → coding` の一歩で done に飛ぶ。persist の順序違反で XState/DB 乖離。
- **#694**: XState と DB の split-brain。persist 失敗時の rollback が場所ごとに違う。
- **#853**: Ship resume 後に Escort が起動されない。phase-transition API と ship-lifecycle.ts の resume path で Escort launch trigger がバラバラ。
- **#696**: coding-gate ループ。`clearGateCheck` 漏れ。
- **#751 / #781**: gate-intent が commentUrl 要求なし、in-memory のみで Engine 再起動で消滅。

### 構造的問題（監査 Finding F1–F2, F5, F7, F8）

同じ 6〜8 ステップの phase 遷移シーケンスが以下 7 箇所に手書き転記されている:

| 箇所 | Lines |
|---|---|
| `ship-internal-api.ts` `phase-transition` | L404-447 |
| `ship-internal-api.ts` `gate-verdict` | L511-544 |
| `ship-internal-api.ts` `nothing-to-do` | L560-573 |
| `ship-internal-api.ts` `launchEscortForGate` skip | L74-88 |
| `ship-internal-api.ts` `launchEscortForGate` 失敗 revert | L139-157 |
| `escort-manager.ts` `onEscortExit` 保安承認 | L640-663 |
| `escort-manager.ts` `onEscortExit` 通常 revert | L673-707 |

さらに `reconcilePhase` による緊急避難が「XState と DB は乖離するもの」という前提を固定化し、**`actor.send → XState 即時通知 → long-poll 解決 → DB persist 失敗 → reconcile が XState を戻す** 窓で Ship が先に進んでしまう**（#853 の原因系）。

gate-intent は commentUrl を要求せず in-memory。Escort が "approve" 宣言して死亡 → commentUrl 無しで phase 遷移 → audit log 契約を破る。

Escort 起動 trigger も phase-transition API / ship-lifecycle resume / XState entry の 3 系統に分散し、resume 経路での起動忘れ (#853) を招いている。

## Decision

### 1. `PhaseTransactionService` を単一原子境界として導入

Engine 内部で phase を変更する全経路を、以下の 1 メソッドに集約する:

```ts
PhaseTransactionService.commit(shipId, {
  event,                // XState event (APPROVE / REJECT / PHASE_NEXT 等)
  triggeredBy,          // "ship" | "escort" | "flagship" | "engine-recovery"
  commentUrl,           // audit log 必須（gate-intent 経由でも強制）
  metadata,             // qaRequired 等
}): Promise<PhaseCommitResult>
```

`commit` の内部シーケンスを 1 トランザクションとして以下の順序で実行する:

1. `assertPhaseConsistency`（DB ↔ XState）
2. `actor.send(event)` を dry-run して next state を取得（subscribe による副作用通知を **発火させない**）
3. DB へ `persistPhaseTransition` + `actor_snapshot` を書き込む（同一 SQLite tx）
4. DB 成功後に初めて XState actor を正式 transition（subscribers に通知）
5. `clearGateCheck` / `clearGateIntent` を同 tx の最後に実行
6. `notifyPhaseWaiters` を **DB persist 成功後のみ** 呼び出す

失敗時は XState を戻す reconcile 経路を廃し、「DB が真実、XState は DB から再構築」を原則とする（ADR-0017 の延長）。

### 2. Escort 起動 trigger を XState entry 1 本に統合

`ship-machine` の `<gate-phase>` state に `entry: "launchEscort"` を設定し、`ShipActorSideEffects.onLaunchEscort` を唯一の trigger とする。phase-transition API と resume path は XState にイベントを送るだけの薄層に退化し、Escort 起動は XState の state 遷移副作用として必ず発火する（#853 撲滅）。

### 3. `notifyPhaseWaiters` のバグを PhaseTransactionService 導入と同時に修正

`pendingPhaseWaiters.delete(shipId)` を一律削除から「個別 `waiters.delete(waiter)` + `waiters.size === 0` の時のみ Map key 削除」に修正（F1）。ロジックは PhaseTransactionService の通知ステップに内包する。

### 4. `gate-intent` を DB 永続化し commentUrl 必須化

`gate-intents` テーブルを新設し、in-memory Map を廃止。`PhaseTransactionService.commit` が intent を consume する際に commentUrl 検証を通す（#751 構造的防止）。

### 代替案と却下理由

- **「現行 7 箇所の caller ごとに null 安全化 + 順序統一」**: 散在構造を温存し、次の新規 caller で同じ問題が再発するため却下。
- **「XState machine 内で全て表現」**: actor の副作用境界を広げすぎ、DB tx との二相コミットが表現困難。State machine は「ルール」、PhaseTransactionService は「実行境界」として分離する。
- **「reconcilePhase をより賢くする」**: split-brain を許容した上で事後修復する設計を続けることになり、#853 のような先進的遷移窓は閉じられないため却下。

## Consequences

### Positive

- phase 遷移の caller 7 箇所が 3〜4 行に圧縮され、同一バグの集合的撲滅（#830, #694, #696, #853, #947）。
- Escort 起動忘れが構造的に不可能になる（entry action の副作用として強制）。
- gate-intent が audit log 契約を満たし、Engine 再起動で消えない。
- ADR-0017 の「DB を SoT」原則を実行レベルまで貫徹。

### Negative

- 既存 phase-transition caller の全面置換が必要。中規模リファクタ（L）。移行中は 2 系統併存期間を設けず、1 PR で swap する（中間状態が split-brain を生むため）。
- XState subscriber の副作用順序が変わるため、ShipActorManager の listener 側テスト全面見直し。
- `gate-intents` テーブル追加で migration が 1 本増える。

### Migration Plan

1. `PhaseTransactionService` 実装 + 単体テスト
2. `gate-intents` テーブル migration
3. 7 箇所の caller を一括置換（同一 PR）
4. `reconcilePhase` は deprecated として残し、読み取り専用の drift 検出ロガーに格下げ
5. e2e で plan-gate / coding-gate / resume 経路を網羅検証
