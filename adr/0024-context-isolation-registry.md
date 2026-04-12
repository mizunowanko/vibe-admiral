# ADR-0024: Fleet / cwd / SystemPrompt の Context Isolation Registry

- **Status**: Proposed
- **Date**: 2026-04-12
- **Issue**: [#938](https://github.com/mizunowanko/vibe-admiral/issues/938)（/audit-quality 監査枠）
- **Implementation Issue**: [#955](https://github.com/mizunowanko/vibe-admiral/issues/955)
- **Tags**: audit-quality, context-isolation, fleet, session, system-prompt

## Context

/audit-quality 監査（Issue #938）で、Context Isolation / Session Resume カテゴリの再発バグ 9 件（#814, #787, #867, #865, #881, #736, #895, #855, #859）を分析した結果、**Fleet / cwd / customInstructions / session の各文脈境界が複数モジュールで独自管理されており、境界チェックのタイミングと場所が経路ごとに異なる** ことが根本原因と特定された（監査 Finding 1〜6）。

### 構造的問題

**1. Fleet-Repo Orphan Adoption**（#814, #895）

`engine/src/ship-manager.ts:565` の `ensureRepo()` が insert 時のみ `fleet_id` を書き込み、既存 repo の `fleet_id` を silently 上書き。`UNIQUE(owner, name, fleet_id)` 制約なし → 別 Fleet の Ship が repo を奪える。#814 の Fleet コンテキスト混入はこの構造欠陥が最短経路。

**2. Bimodal Session Resume**（#867, #865）

- `commander.ts:69-72` の `launch` パスは cwd 不一致を検出して fresh launch へ fallback
- `process-manager.ts:285` の `resumeIfDead()` パスは同じ検証を持たず、invalid session のまま resume → exit 1
- `ship-lifecycle.ts:430` のコメント「infinite resume failures」は構造的欠陥の自認

**3. Dual Escort State Sources**（#787, #895）

`escort-manager.ts:56-61, 87-102, 146` の `escorts` / `shipCustomInstructions` / `gateIntents` 3 つの in-memory Map + DB が並列。Dedup キーが `parentShipId` のみで **Fleet 境界を含まない** → #787 の Escort cache hit cross-Ship の構造的原因。

**4. 散在する customInstructions 注入経路**（#881, #736）

`commander.ts:55-61`, `ship-manager.ts:121`, `escort-manager.ts:148-149,241,295`, `prompt-loader.ts:17-33` に注入経路が分散。Ship → Escort stash → restore の race condition、audit トレースなし。単一レジストリなし → #881 の customInstructions 反映不全、#736 の Ship 口調 Flagship 波及の根本。

**5. Unit Lifecycle エラーハンドリングの非対称性**（#859, #855）

Commander は resume 失敗時 fresh launch fallback、Ship は同等 fallback なし。process exit event dispatch 前に fleetId context 検証なし → #855（Fleet 切替で Ship 消失）, #859（Commander in Fleet repo refactor）。

**6. 暗黙的な Fleet state 直列化**（#814, #865）

`VIBE_ADMIRAL_FLEET_ID` は env dict で渡され型契約なし。Commander は `fleetPath`、Ship は `cwd` と保存フィールドがズレる → subprocess 起動時の文脈誤注入リスク。

### 既存 ADR との関係

- **ADR-0007** (Engine REST API 統一): API 層は統一済、**実行時の文脈検証**は未統一（本 ADR の対象）
- **ADR-0010** (Bridge → Flagship/Dock 分離): Unit 境界は整理済、Fleet 境界の徹底は未解決
- **ADR-0012** (Unit terminology): 用語は整理、**属性チェック**の強制がコードレベルで不在
- **ADR-0015** (Typesafe message routing): WS 層の型安全は確立、subprocess env 層は `as` / 型なし dict のまま

## Decision

### 1. `ContextRegistry` を Engine の文脈単一参照点として導入

Fleet / cwd / customInstructions / session の 4 次元を集約した型安全レジストリを導入:

```ts
interface UnitContext {
  fleetId: FleetId;                 // branded type
  unitKind: "ship" | "commander" | "escort" | "dispatch";
  unitId: string;
  cwd: AbsolutePath;                // branded
  sessionId: ClaudeSessionId | null;
  customInstructionsSource: "fleet" | "global" | "ship-override" | "escort-stash";
  customInstructionsHash: string;   // audit 用
}

class ContextRegistry {
  get(unitId): UnitContext | null;
  assertBoundary(unitId, expected: Partial<UnitContext>): void; // 不一致は throw
  swap(unitId, field, newValue, reason): void;                   // 監査ログ付き
}
```

全 subprocess 起動（Ship, Commander, Escort, Dispatch）および resume 経路は `ContextRegistry.get(unitId)` を参照し、env へシリアライズする `LaunchEnvironment` 型を経由する。手書きの env dict 組み立ては禁止。

### 2. `fleet_id` の UNIQUE 制約 + repo 所有権境界

- `repos` テーブルに `UNIQUE(owner, name, fleet_id)` を追加（migration）。
- `ensureRepo(owner, name, fleetId)` は既存行の `fleet_id` 不一致を **silent update せず throw**。Dock 経由で明示的な fleet move を提供する場合のみ `transferRepoFleet()` を通す（audit log 必須）。

### 3. cwd 検証を `SessionResumer.validateOrFresh()` に共通化

`launch` / `resumeIfDead` / `resumeCommander` の 3 経路を同一ヘルパーに束ねる:

```ts
SessionResumer.validateOrFresh(unitId, { expectedCwd, sessionId }): "resume" | "fresh"
```

cwd / sessionId 整合性チェックの基準を一本化し、#867/#865 の経路ごとの挙動差を消滅させる。

### 4. Escort 状態を DB 正規化 + Fleet 境界キー化

- `escorts` / `escort_custom_instructions` / `gate_intents` を **全て DB 正規化**（in-memory Map 廃止）
- dedup キーを `(fleetId, parentShipId, gatePhase)` に拡張して Fleet 間キャッシュヒットを構造的に禁止（#787 撲滅）
- ADR-0021（PhaseTransactionService）と連携して gate_intents は同一トランザクションで consume

### 5. `SystemPromptRegistry` で customInstructions 注入元を一元管理

- `prompt-loader.ts` を昇格し、全 Unit の customInstructions / systemPrompt 組成を 1 メソッドに集約:

```ts
SystemPromptRegistry.compose({
  fleetId, unitKind, unitId, baseInstructions, overrides
}): { systemPrompt: string, sourceAudit: SystemPromptSource[] }
```

- Ship / Escort / Commander / Dispatch の差し替え経路は全てこのメソッド経由。worktree ファイルへの直接書き込み（stash/restore）は **SystemPromptRegistry の transport 実装** として閉じ込める。
- sourceAudit を chat log に記録し、#881 / #736 のような「どこから差し込まれたかわからない」状態を根絶。

### 6. `LaunchEnvironment` 型化で env 直列化を封印

```ts
type LaunchEnvironment = {
  VIBE_ADMIRAL: "true";
  VIBE_ADMIRAL_FLEET_ID: FleetId;
  VIBE_ADMIRAL_SHIP_ID?: ShipId;
  VIBE_ADMIRAL_MAIN_REPO: `${string}/${string}`;
  VIBE_ADMIRAL_ENGINE_PORT: string;
  ... (readonly, strict)
};
```

`ContextRegistry` → `LaunchEnvironment` の変換は 1 関数に閉じる。hash 検証で subprocess 側が env 改竄を検知できる（#924 の triggeredBy 偽装と同系の対策）。

### 代替案と却下理由

- **「個別バグごとに cwd check 追加」**: 3 経路の非対称が残り、4 経路目が追加された時に再発。構造解決にならない。
- **「Frontend で fleetId filter を強化」**: バックエンド側の文脈境界が崩れている限り、frontend 側の検証は post-hoc。根本解決にならない。
- **「環境変数契約を README で規定」**: 型レベル保証がないと regression で破られる。ADR-0015 の教訓を活かし型強制する。

## Consequences

### Positive

- Fleet 境界侵害バグ 9 件（#814, #787, #867, #865, #881, #736, #895, #855, #859）の構造的撲滅。
- 将来 Unit 種類追加時（例: 新 Commander 亜種）も ContextRegistry 経由で必然的に境界が保たれる。
- customInstructions の注入元 audit が可能になり、#881 系調査時間が激減。

### Negative

- 既存 subprocess 起動パスの全面置換（中〜大規模リファクタ）。LaunchEnvironment 型化だけでも ship-manager / commander / escort-manager / dispatch-manager の env 組み立て全置換が必要。
- `repos` テーブル UNIQUE 追加は既存データの整合性チェックと cleanup migration が必要。
- `escort-custom-instructions` / `gate-intents` の DB 正規化は ADR-0021 と同じ PR で入れないと中間状態が壊れる → ADR-0021 と合同で実装計画を組む必要がある。

### Migration Plan

1. `ContextRegistry` / `LaunchEnvironment` 型導入（使い始めは ship-manager の新規 ship のみ）
2. `repos` UNIQUE migration + `ensureRepo` throw 化 + Dock 経由の `transferRepoFleet` API 提供
3. `SessionResumer.validateOrFresh()` 導入、3 resume 経路を置換
4. `SystemPromptRegistry` 導入、Ship/Commander/Escort/Dispatch の注入経路を順次移行
5. Escort in-memory Map 群の DB 正規化（ADR-0021 と連携）
6. 残りの手書き env 組み立てを全除去、lint で回帰防止
