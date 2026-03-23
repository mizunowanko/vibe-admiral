# ADR-0012: Unit 用語の導入 — セッション主体の総称を XState Actor と分離

- **Status**: Accepted
- **Date**: 2026-03-23
- **Issue**: [#558](https://github.com/mizunowanko-org/vibe-admiral/issues/558)
- **Tags**: terminology, naming, unit, actor, xstate

## Context

Ship/Flagship/Dock/Escort をまとめて「Actor」と呼んでいたが、XState v5 導入（ADR-0008）により XState の「Actor」概念と衝突する:

- **XState Actor**: 状態機械のインスタンス。Ship 1台 = Actor 1つ。`ShipActorManager` が管理
- **従来の Actor**: Claude Code セッションの主体（Ship/Flagship/Dock/Escort の総称）

同じ「Actor」が2つの異なる概念を指すため、ドキュメント・Issue・コード上で混乱を招く。

なお、ソースコードには「Actor」を総称として使う箇所は存在しない（Issue・ドキュメント・system prompt 上の口語的呼称のみ）。

## Decision

Claude Code セッション主体の総称を **Unit**（部隊）に変更する。

### 用語の定義

| 用語 | 意味 |
|------|------|
| **Unit** | Claude Code セッション主体の総称（Ship, Flagship, Dock, Escort）。Engine が管理する全セッション種別の上位概念 |
| **Actor** | XState の状態機械インスタンス。Ship 1隻 = Actor 1つ。`ShipActorManager` が管理 |

### 変更対象

- CLAUDE.md の用語テーブル
- system prompt（`flagship-system-prompt.ts`, `dock-system-prompt.ts`）
- skills 内のドキュメント
- ADR 内の記述
- Issue 本文・コメント内の「Actor」→「Unit」

### 検討したが採用しなかった案

| 案 | 不採用理由 |
|----|----------|
| Agent | Claude の「AI Agent」と衝突。混同リスクが高い |
| Entity | 抽象的すぎて海軍メタファーに合わない |
| Session | すでに Claude Code のセッション概念と重複 |
| Crew | 人間を連想させ、AI エージェントの呼称として不自然 |

## Consequences

- **Positive**: XState Actor と Claude Code セッション主体が明確に区別され、ドキュメント・コードの可読性が向上
- **Positive**: 海軍メタファーとの親和性が高い（艦隊の「部隊」）
- **Negative**: 既存のドキュメント・Issue・skill ファイルの用語を一斉変更する必要がある
- **Neutral**: ソースコード上の変更は最小限（口語的呼称のみだったため、型名やクラス名の変更は不要）
