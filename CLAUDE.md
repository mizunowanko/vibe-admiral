# vibe-admiral

> **このファイルはリポジトリ固有の開発規約です。**

Claude Code を使った並列開発を統括するデスクトップアプリ。
複数リポにまたがる issue ベースの並列実装を自動化し、AI agent が品質を担保する「開発指揮システム」。

> プロジェクトの哲学・ビジョン・解決する課題の詳細は [README.md](README.md) を参照。

## 用語

Admiral(アプリ) → Fleet(艦隊=プロジェクト) → Bridge(艦橋=中央管理チャット) → Ship(艦=個別実装セッション) → Sortie(出撃=Ship起動)

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
skills/                Skills（Claude Code が on-demand で注入）
  implement/           /implement オーケストレータ + 5 sub-skills
  adr/                 /adr スキル（ADR 作成・更新・検索）
  admiral-protocol/    admiral-request プロトコル仕様
  gate-plan-review/    plan-review Gate Dispatch
  gate-code-review/    code-review Gate Dispatch
  sortie/              Sortie 計画・優先順位
  issue-manage/        Issue 作成・整理
  investigate/         調査 Dispatch テンプレート
  read-issue/          Issue 全コンテキスト取得
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
- [ADR-0002: 品質保証戦略](adr/0002-qa-strategy.md)
- [ADR-0003: Ship ステータス管理のリアーキテクチャ](adr/0003-ship-status-rearchitecture.md)

## ラベル体系

### ステータスラベル（`status/` prefix）— 排他的
| ラベル | 意味 |
|--------|------|
| `status/todo` | Sortie 可能 |
| `status/planning` | 計画中（調査 + 計画） |
| `status/implementing` | 実装中（コーディング + テスト） |
| `status/acceptance-test` | 受け入れテスト中（PR レビュー + QA） |
| `status/merging` | マージ中 |
| `status/blocked` | 依存関係で着手不可 |

### カテゴリラベル（`type/` prefix）— 人間または Bridge が付与
| 優先順位 | ラベル | コミット prefix |
|----------|--------|----------------|
| 1 | `type/skill` | `skill:` |
| 2 | `type/bug` | `fix:` |
| 3 | `type/infra` | `infra:` |
| 4 | `type/test` | `test:` |
| 5 | `type/refactor` | `refactor:` |
| 6 | `type/feature` | `feat:` |

