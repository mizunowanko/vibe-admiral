# vibe-admiral

> **このファイルはリポジトリ固有の開発規約です。**

Claude Code を使った並列開発を統括するデスクトップアプリ。
複数リポにまたがる issue ベースの並列実装を自動化し、AI agent が品質を担保する「開発指揮システム」。

> プロジェクトの哲学・ビジョン・解決する課題の詳細は [README.md](README.md) を参照。

## 用語

Admiral(アプリ) → Fleet(艦隊=プロジェクト) → Commander(指揮官=Fleet統括: Flagship / Dock) → Ship(艦=個別実装セッション) → Sortie(出撃=Ship起動)

| 用語 | 意味 |
|------|------|
| **Unit** | Claude Code セッション主体の総称（Ship, Flagship, Dock, Escort）。Engine が管理する全セッション種別の上位概念 |
| **Actor** | XState の状態機械インスタンス。Ship 1 隻 = Actor 1 つ。`ShipActorManager` が管理する |

## アーキテクチャ

```
React Frontend (port 1420)
  ↕ WebSocket
Node.js Engine Sidecar (port 9721)
  ↕ subprocess
Claude Code CLI (claude -p --output-format stream-json)
```

- **Frontend**: React 19 + Vite 6 + Tailwind CSS v4 + Zustand 5 + shadcn/ui
- **Engine**: Node.js + `ws`
- **Data**: GitHub Issues が真実の源（ローカル DB なし）
- **確定的制御**: issue ラベル / worktree / ポート管理はスクリプト。LLM は知性が必要な作業のみ

## ディレクトリ構成

```
src/                  React frontend
  components/
    layout/           AppLayout, Sidebar, MainPanel
    bridge/           Bridge チャット UI
    ship/             Ship カード・詳細・受け入れテスト
    fleet/            Fleet 一覧・設定
    ui/               shadcn/ui 基盤コンポーネント
  stores/             Zustand (fleet, ship, ui)
  hooks/              useEngine, useBridge, useShip
  lib/                ws-client, utils
  types/              共通型定義
engine/               Node.js sidecar
  src/
    index.ts          エントリ（WS サーバー起動）
    ws-server.ts      WebSocket + メッセージルーティング
    process-manager.ts  Claude CLI spawn/kill/stream
    ship-manager.ts   Ship ライフサイクル管理
    bridge.ts         Bridge セッション管理
    github.ts         gh CLI ラッパー（確定的制御）
    worktree.ts       git worktree CRUD（確定的制御）
    issue-tracker.ts  issue 状態トラッキング
    acceptance-watcher.ts  ファイル伝言板監視
    types.ts          Engine 共通型
units/                Unit 別スキル・ルール配置（正規配置先）
  ship/skills/         Ship 用スキル
    implement/         /implement オーケストレータ + 5 sub-skills
  escort/skills/       Escort 用スキル
    planning-gate/     planning-gate Escort スキル
    implementing-gate/ implementing-gate Escort スキル
    acceptance-test-gate/ acceptance-test-gate Escort スキル
  flagship/            Flagship 用スキル・ルール
    skills/sortie/     Sortie 計画・優先順位
    skills/ship-inspect/ Ship 状況確認
    rules/             commander-rules.md
  dock/                Dock 用スキル・ルール
    skills/issue-manage/ Issue 作成・整理
    skills/investigate/  調査 Dispatch テンプレート
    skills/dock-ship-status/ Dock Ship ステータス
    rules/             commander-rules.md
  dispatch/            Dispatch 用（将来拡張）
  shared/              共有スキル・ルール
    skills/admiral-protocol/ admiral-request プロトコル仕様
    skills/read-issue/ Issue 全コンテキスト取得
    rules/             claude-dir-access.md
skills/                Skills（レガシー配置 — Engine deploy 互換のため残存）
  implement/           /implement オーケストレータ + 5 sub-skills
  adr/                 /adr スキル（ADR 作成・更新・検索）
  admiral-protocol/    admiral-request プロトコル仕様
  planning-gate/       planning-gate Escort スキル
  implementing-gate/   implementing-gate Escort スキル
  acceptance-test-gate/ acceptance-test-gate Escort スキル
  sortie/              Sortie 計画・優先順位
  issue-manage/        Issue 作成・整理
  investigate/         調査 Dispatch テンプレート
  read-issue/          Issue 全コンテキスト取得
docs/                 ドキュメント
  cli-subprocess.md   Claude Code CLI サブプロセスルール
adr/                  Architecture Decision Records
  TEMPLATE.md         ADR テンプレート
```

## コマンド

| Purpose | Command |
|---------|---------|
| Frontend dev | `npm run dev` |
| Engine dev | `npx tsx engine/src/index.ts` |
| Type check (frontend) | `npx tsc --noEmit` |
| Type check (engine) | `cd engine && npx tsc --noEmit` |
| Build | `npm run build` |

> プロジェクトの哲学・背景・解決する課題の詳細は [docs/philosophy.md](docs/philosophy.md) を参照。

## コーディング規約

dev-shared 共通ルールに従う。詳細は `~/Projects/Plugins/dev-shared/CLAUDE.md` を参照。

- コミット: `feat:` / `fix:` / `refactor:` / `test:` / `skill:` / `infra:`
- `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`
- ブランチ: `feature/<issue-num>-<short-name>`
- `git add -A` 禁止（ファイル名指定）
- PR に `Closes #<issue-num>`
- パスエイリアス: `@/*` → `./src/*`
- Engine の import は `.js` 拡張子（ESM）

## ADR（Architecture Decision Records）

設計判断は `adr/` ディレクトリに ADR として記録する。テンプレートは [adr/TEMPLATE.md](adr/TEMPLATE.md) を参照。

- 配置: `adr/NNNN-kebab-case-title.md`（連番 4 桁）
- ステータス: `Proposed` → `Accepted` → `Deprecated` / `Superseded`
- 各 ADR には Issue リンクを含める（Issue = Problem → ADR = Decision）
- Tags フィールド（optional）でスコープやトピックを記録し、自動フィルタリングに利用する
- 実装前の調査時に関連 ADR を確認し、過去の設計判断との整合性を担保すること
- `/adr` スキルで作成・更新・一覧・検索が可能

既存 ADR:
- [ADR-0001: AI 最適化開発モデル](adr/0001-ai-optimized-dev-model.md)
- [ADR-0002: 品質保証戦略](adr/0002-qa-strategy.md) *(Superseded by ADR-0013)*
- [ADR-0003: Ship ステータス管理のリアーキテクチャ](adr/0003-ship-status-rearchitecture.md)
- [ADR-0004: XState 状態機械の可視化](adr/0004-xstate-state-machine-visualization.md)
- [ADR-0005: E2E Config のポート共有パターン](adr/0005-e2e-port-sharing-pattern.md)
- [ADR-0006: SessionChat 表示ルール](adr/0006-session-chat-display-rules.md)
- [ADR-0007: 全 Unit 間通信を Engine REST API に統一](adr/0007-engine-rest-api-unification.md)
- [ADR-0008: XState v5 による Ship/Escort ライフサイクル管理](adr/0008-xstate-ship-escort-lifecycle.md)
- [ADR-0009: UI セッション中心モデル](adr/0009-session-centric-ui-model.md)
- [ADR-0010: Bridge → Flagship/Dock 分離](adr/0010-bridge-to-flagship-dock-separation.md)
- [ADR-0011: Phase-driven communication](adr/0011-phase-driven-communication.md)
- [ADR-0012: Unit 用語の導入](adr/0012-unit-terminology.md)
- [ADR-0013: テスト戦略の全体設計](adr/0013-test-strategy-design.md)
- [ADR-0014: Gate ポーリングを回数ベースに変更](adr/0014-count-based-gate-polling.md)
- [ADR-0015: 型安全なメッセージルーティング層の導入](adr/0015-typesafe-message-routing.md)
- [ADR-0016: Engine プロセス分離と Supervisor パターン](adr/0016-engine-process-isolation.md)
- [ADR-0017: XState を Single Source of Truth にした DB スナップショット設計](adr/0017-xstate-snapshot-persistence.md)
- [ADR-0018: Escort Gate Feedback の構造化](adr/0018-structured-gate-feedback.md)
- [ADR-0019: Frontend ストア正規化と楽観的更新パターン](adr/0019-frontend-store-normalization.md)
- [ADR-0020: Escort セッション蓄積のトークン追跡と最適化方針](adr/0020-escort-token-tracking.md)

## ラベル体系

### ステータスラベル（`status/` prefix）
| ラベル | 意味 |
|--------|------|
| `status/sortied` | 出撃中（Ship 稼働中） |

> ラベルなし = Sortie 候補（open issue）。`status/sortied` のみが存在する。
> `stopped` は DB phase であり、ラベルではない。Ship 停止中も `status/sortied` を保持する。
> 依存関係の追跡は `depends-on/*` ラベルで行う。

## Conflict Risk Areas

並行 Ship が同じファイルを変更すると rebase/merge 時に競合が発生する。以下は競合リスクが高い領域:

| 領域 | ファイル例 | リスク理由 |
|------|-----------|-----------|
| Engine 型定義 | `engine/src/types.ts` | ほぼ全ての Engine 変更が触る |
| Ship ライフサイクル | `engine/src/ship-manager.ts` | 新機能追加時に頻繁に変更 |
| WS メッセージ | `engine/src/ws-server.ts` | メッセージ種別追加のたびに変更 |
| 共通スキル | `skills/implement/SKILL.md` | ワークフロー改善で頻繁に更新 |
| フロントエンド Store | `src/stores/ship-store.ts` | Ship 機能追加のたびに変更 |

### 競合を減らすガイドライン

- **大規模リファクタ**: リネームと機能変更を別 PR に分割する（`/implement-plan` 参照）
- **型定義の追加**: 既存の型を変更するのではなく、新しいファイルに型を追加することを検討する
- **Engine の拡張**: 既存ファイルへの追加が避けられない場合、ファイル末尾に追加してdiff の競合を最小化する

### カテゴリラベル（`type/` prefix）— 人間または Bridge が付与
| 優先順位 | ラベル | コミット prefix |
|----------|--------|----------------|
| 1 | `type/skill` | `skill:` |
| 2 | `type/bug` | `fix:` |
| 3 | `type/infra` | `infra:` |
| 4 | `type/test` | `test:` |
| 5 | `type/refactor` | `refactor:` |
| 6 | `type/feature` | `feat:` |

