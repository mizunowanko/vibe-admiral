# ADR-0004: XState 状態機械の可視化

- **Status**: Proposed
- **Date**: 2026-03-22
- **Issue**: [#561](https://github.com/mizunowanko-org/vibe-admiral/issues/561)
- **Tags**: engine, ship, escort, xstate, visualization, mermaid

## Context

[#538](https://github.com/mizunowanko-org/vibe-admiral/issues/538) で Ship/Escort ライフサイクルを XState v5 状態機械に移行した。ライフサイクル管理はシステムの根幹であり、状態遷移の正しさをユーザーが視覚的にレビューできる手段が必要。

状態遷移は基本的に直列（planning → planning-gate → implementing → ... → done）で、異常系として stopped/resume サイクル、gate rejection、process death がある。可視化ツールとしては Mermaid stateDiagram-v2 が GitHub でネイティブレンダリングされるため、ツール依存なし・ログイン不要で閲覧可能。

## Decision

XState machine 定義（`engine/src/ship-machine.ts`）を Mermaid `stateDiagram-v2` で可視化し、本 ADR に埋め込む。

### Ship ライフサイクル状態遷移図

```mermaid
stateDiagram-v2
    [*] --> planning

    state "Work Phases" as work {
        planning --> planning_gate : GATE_ENTER
        planning_gate --> implementing : GATE_APPROVED
        planning_gate --> planning : GATE_REJECTED
        planning_gate --> planning : ESCORT_DIED

        implementing --> implementing_gate : GATE_ENTER
        implementing_gate --> acceptance_test : GATE_APPROVED
        implementing_gate --> implementing : GATE_REJECTED
        implementing_gate --> implementing : ESCORT_DIED

        acceptance_test --> acceptance_test_gate : GATE_ENTER [qaRequired]
        acceptance_test --> merging : GATE_ENTER [!qaRequired]
        acceptance_test_gate --> merging : GATE_APPROVED
        acceptance_test_gate --> acceptance_test : GATE_REJECTED
        acceptance_test_gate --> acceptance_test : ESCORT_DIED

        merging --> done : COMPLETE
    }

    planning --> done : NOTHING_TO_DO
    implementing --> done : NOTHING_TO_DO
    acceptance_test --> done : NOTHING_TO_DO
    merging --> done : NOTHING_TO_DO

    planning --> stopped : STOP
    planning_gate --> stopped : STOP
    implementing --> stopped : STOP
    implementing_gate --> stopped : STOP
    acceptance_test --> stopped : STOP
    acceptance_test_gate --> stopped : STOP
    merging --> stopped : STOP

    stopped --> planning : RESUME [wasPlanning]
    stopped --> planning_gate : RESUME [wasPlanningGate]
    stopped --> implementing : RESUME [wasImplementing]
    stopped --> implementing_gate : RESUME [wasImplementingGate]
    stopped --> acceptance_test : RESUME [wasAcceptanceTest]
    stopped --> acceptance_test_gate : RESUME [wasAcceptanceTestGate]
    stopped --> merging : RESUME [wasMerging]
    stopped --> implementing : RESUME [default]

    done --> [*]
```

### Gate フロー詳細図

各 gate phase で Escort プロセスが起動し、レビューを実施する。

```mermaid
stateDiagram-v2
    state "Gate Phase (共通パターン)" as gate {
        [*] --> gate_entered : Ship が gate phase に遷移
        gate_entered --> escort_running : Engine が Escort 起動
        escort_running --> verdict_submitted : Escort がレビュー実施

        state verdict_fork <<choice>>
        verdict_submitted --> verdict_fork

        verdict_fork --> approved : APPROVE
        verdict_fork --> rejected : REJECT
        verdict_fork --> escort_crashed : Escort プロセス異常終了

        approved --> next_phase : GATE_APPROVED
        rejected --> prev_phase : GATE_REJECTED
        escort_crashed --> prev_phase : ESCORT_DIED
    }

    state "Gate Types" as types {
        state "planning-gate" as pg
        state "implementing-gate" as ig
        state "acceptance-test-gate" as ag

        pg : gateType = plan-review
        pg : Escort skill = /planning-gate
        pg : APPROVED → implementing
        pg : REJECTED → planning

        ig : gateType = code-review
        ig : Escort skill = /implementing-gate
        ig : APPROVED → acceptance-test
        ig : REJECTED → implementing

        ag : gateType = playwright
        ag : Escort skill = /acceptance-test-gate
        ag : APPROVED → merging
        ag : REJECTED → acceptance-test
        ag : Skip when qaRequired=false
    }
```

### 異常系フロー

```mermaid
stateDiagram-v2
    state "Process Death (derived error)" as death {
        [*] --> running : Ship プロセス稼働中
        running --> dead : Engine が 30s ポーリングで検知
        dead --> error_display : phase ≠ done && processDead

        state "Recovery Options" as recovery {
            error_display --> resume : RESUME（Bridge/User が判断）
            error_display --> skip : NOTHING_TO_DO（スキップ）
        }

        resume --> running : retryCount++, processDead=false
    }

    state "STOP / RESUME Cycle" as stop_resume {
        [*] --> any_phase : Ship 稼働中
        any_phase --> stopped : STOP
        stopped --> original_phase : RESUME

        stopped : phaseBeforeStopped を保持
        stopped : Guard ベースで復帰先を決定
        original_phase : retryCount++
        original_phase : processDead = false
    }

    state "Gate Rejection Retry" as rejection {
        [*] --> work_phase : 作業 phase
        work_phase --> gate_phase : GATE_ENTER
        gate_phase --> work_phase : GATE_REJECTED（フィードバック付き）
        work_phase --> gate_phase : 修正後に再度 GATE_ENTER

        gate_phase : gateCheck.status = pending → rejected
        work_phase : gateCheck クリア、フィードバックを反映して修正
    }
```

### 状態一覧

| Phase | 種別 | Entry Action | 遷移先 |
|-------|------|-------------|--------|
| `planning` | 作業 | — | planning-gate, stopped, done |
| `planning-gate` | Gate | gateCheck 生成 (plan-review) | implementing, planning, stopped |
| `implementing` | 作業 | — | implementing-gate, stopped, done |
| `implementing-gate` | Gate | gateCheck 生成 (code-review) | acceptance-test, implementing, stopped |
| `acceptance-test` | 作業 | — | acceptance-test-gate, merging, stopped, done |
| `acceptance-test-gate` | Gate | gateCheck 生成 (playwright) | merging, acceptance-test, stopped |
| `merging` | 作業 | — | done, stopped |
| `done` | 終了 | — | (final) |
| `stopped` | 停止 | phaseBeforeStopped 保存 | RESUME で元 phase に復帰 |

### グローバルイベント（全状態で受信可能）

| Event | 効果 |
|-------|------|
| `PROCESS_OUTPUT` | lastOutputAt 更新、processDead クリア |
| `PROCESS_DIED` | processDead = true |
| `COMPACT_START` | isCompacting = true |
| `COMPACT_END` | isCompacting = false |
| `SET_SESSION_ID` | sessionId 更新 |
| `SET_PR_URL` | prUrl 更新 |
| `SET_QA_REQUIRED` | qaRequired トグル |
| `SET_PR_REVIEW_STATUS` | prReviewStatus 更新 |

### 表示状態の導出ルール

```
phase = done                    → "done" (成功)
phase ≠ done && !processDead    → phase そのまま表示 (正常稼働中)
phase ≠ done && processDead     → "error" (異常終了、要対応)
```

## Consequences

**Positive**:
- 状態遷移の全体像を GitHub 上で視覚的にレビューできる
- ツール依存なし（Mermaid は GitHub ネイティブレンダリング）
- ADR として設計判断の記録を兼ねる
- 新規メンバーのオンボーディングに活用できる

**Negative**:
- XState machine 定義と Mermaid 図は手動で同期する必要がある
- Machine 定義変更時に ADR の図も更新が必要（ただし変更頻度は低い）
