# ADR-0013: テスト戦略の全体設計 — 4層テストピラミッド

- **Status**: Accepted
- **Date**: 2026-03-23
- **Issue**: [#516](https://github.com/mizunowanko-org/vibe-admiral/issues/516), [#518](https://github.com/mizunowanko-org/vibe-admiral/issues/518)
- **Tags**: testing, ci, e2e, playwright, vitest
- **Supersedes**: [ADR-0002](0002-qa-strategy.md)

## Context

ADR-0002 では品質保証を CI / Acceptance Test / 事後フィードバックの3層に整理したが、その後のアーキテクチャ変更（Engine REST API 化、XState 導入、Bridge 分離等）により、テスト戦略の再設計が必要になった:

- Engine のテストはユニットテスト中心で、コア結合動作（sortie フロー、phase 遷移 → gate → Escort 起動、WS ルーティング等）の検証が不足
- Playwright E2E テストの基盤が未整備
- vibe-admiral 特有の問題: Admiral 起動 + toy project sortie で Claude Code トークンを大量消費するため、通常の E2E テスト戦略がそのまま適用できない

## Decision

テストを以下の4層に再設計する。

### Layer 1: ユニットテスト（vitest）

- **目的**: 個別モジュールのロジック検証
- **実行**: CI で全 PR に自動実行
- **対象**: stream-parser、db、api-server、state-sync、status-manager、escort-manager、worktree、issue-tracker
- **方針**: pure function 中心。外部依存はモック

### Layer 2: 結合テスト（vitest）

- **目的**: モジュール間の連携動作を検証
- **実行**: CI で全 PR に自動実行
- **対象**:
  - Sortie フロー（API → sortie guard → DB → worktree → プロセス起動）
  - Phase 遷移 → Gate → Escort 起動フロー
  - WS メッセージルーティング
  - Process exit → StateSync → cleanup
  - Commander セッション resume
- **方針**: CLI subprocess はモック、GitHub API は test double、DB は real SQLite、WS は localhost で real server

### Layer 3: Playwright E2E テスト

- **目的**: UI と Engine の統合動作を検証
- **実行**: ユーザー判断での手動実行（`npm run test:e2e`）。CI や acceptance-test gate では自動実行しない
- **方針**: 1回の Admiral 起動 + toy project sortie で多観点を網羅するシナリオ設計。トークン効率を重視
- **Fleet 設定**: E2E テストを acceptance-test gate で実行するかは Fleet ごとに設定可能（一般的な Fleet では毎回実行可）

### Layer 4: AI Acceptance Test（Escort）

- **目的**: PR が追加した機能の動作確認
- **実行**: implementing-gate 通過後、acceptance-test-gate で Escort が実施
- **方針**: Escort が PR diff を読み、検証項目を動的に決定。`qaRequired: false` の場合はスキップ

### ADR-0002 からの変更点

| 観点 | ADR-0002 | 本 ADR |
|------|---------|--------|
| テスト層 | 3層（CI / Acceptance / 事後） | 4層（Unit / Integration / E2E / AI Acceptance） |
| 結合テスト | 言及なし | Layer 2 として明示的に定義 |
| E2E テスト | toy project E2E を廃止 | Playwright 基盤で再設計（手動実行） |
| Acceptance Test | Bridge sub-agent が実施 | Escort が独立プロセスとして実施 |

### 検討したが採用しなかった案

| 案 | 不採用理由 |
|----|----------|
| E2E を CI で毎回自動実行 | トークン消費が膨大。vibe-admiral の Claude Code 依存特有の制約 |
| 結合テストなし（Unit + E2E のみ） | Engine 内部のモジュール連携バグが E2E まで見つからず、デバッグコストが高い |
| 外部 CI サービスで E2E | Claude Code CLI のセットアップが複雑。ローカル実行の方が現実的 |

## Consequences

- **Positive**: 4層の明確な役割分担により、各層が最適な粒度で検証を担当
- **Positive**: 結合テストの追加で、Engine コアのリファクタリング時のデグレ検知が大幅に改善
- **Positive**: E2E テストの手動実行方針により、不要なトークン消費を防止
- **Negative**: 結合テストの作成・維持に工数が必要（ただし、バグ修正コストの削減で回収可能）
- **Negative**: E2E テストが手動実行のため、実行忘れによる品質低下のリスクがある
