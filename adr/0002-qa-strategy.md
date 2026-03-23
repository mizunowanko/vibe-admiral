# ADR-0002: 品質保証戦略 — CI / Acceptance Test / 事後フィードバック

- **Status**: Superseded by [ADR-0013](0013-test-strategy-design.md)
- **Date**: 2026-03-17
- **Issue**: [#248](https://github.com/mizunowanko-org/vibe-admiral/issues/248)

## Context

vibe-admiral の品質保証は、並列 sortie のスループットを最大化しつつ、デグレと機能不備を検知する必要がある。

従来は toy project を使った E2E テスト（`qa-gate-e2e.ts`）を Gate に組み込んでいたが、以下の問題で費用対効果が悪かった：

- Claude Code のトークン消費が激しい（1回の E2E で数万トークン）
- main ブランチの Engine しか検証できない（PR ブランチの変更は反映されない）
- 実行時間が長い（15分以上）
- 外部依存（toy project リポ、GitHub API）による不安定さ

人間によるコードレビューも、並列 sortie 環境ではボトルネックとなり、スループットを著しく低下させる。

## Decision

品質保証を以下の3層に整理する。人間の同期的レビューはフローに含めない。

### 1. CI（GitHub Actions）— デグレ検知

- **目的**: 既存機能の破壊を防ぐ
- **実行タイミング**: 全 PR に自動実行
- **内容**: ユニットテスト（vitest）+ 型チェック（tsc）+ ビルド確認（vite build）
- **特徴**: 高速、確定的、トークン消費ゼロ

### 2. Acceptance Test — 追加機能の動作確認

- **目的**: その PR が追加した機能が実際に動いているか検証する
- **実行タイミング**: reviewing→acceptance-test Gate 通過時
- **内容**: Bridge sub-agent が PR diff を読み、「何を確認すべきか」を判断して適切な方法で検証する
- **方法**: issue の性質に応じて sub-agent が選択（curl で API 確認、Playwright で UI 確認、コード解析のみ、等）
- **特徴**: LLM が検証項目を動的に決定するため、issue の種類に依存しない柔軟性がある

### 3. 事後フィードバック — 人間による非同期品質回収

- **目的**: AI が見逃した問題の回収
- **実行タイミング**: 人間が気づいたとき（非同期）
- **内容**: 問題を発見したら新規 issue として起票し、次の sortie で修正する
- **特徴**: 人間はフローのボトルネックにならない

### 廃止: Toy Project E2E

- qa-gate-e2e.ts、reset-toy-project.ts、real-e2e.test.ts を削除
- GateType から real-e2e を除去
- 理由: トークン消費が激しく、main ブランチしか検証できないため費用対効果が悪い

### 廃止: 人間によるコードレビュー

- Gate に human review を含めない
- GateType の human は廃止方向（#246 で対応）
- 理由: 並列 sortie のスループットを最大化するため。問題は事後フィードバックで回収する

## Consequences

- CI が全 PR のデグレ検知を担保するため、安全にマージできる基盤ができる
- Acceptance test は Bridge sub-agent の判断力に依存する。判断精度が低い場合は事後フィードバックで補完する
- 人間はフローから解放され、問題発見に集中できる
- toy project E2E の廃止により、Gate 通過時間が大幅に短縮される（15分 → 数十秒）
- DEFAULT_GATE_TYPES を以下に変更：
  - reviewing→acceptance-test: code-review（Bridge sub-agent による PR レビュー）
  - acceptance-test→merging: auto-approve（#246 で対応予定）
