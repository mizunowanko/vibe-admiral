# vibe-admiral

> **このファイルはリポジトリ固有の開発規約です。**
> Admiral（Bridge/Ship）への運用指示は Engine が `--append-system-prompt` やスキル経由で別途注入します。
> 詳細は後述の「Admiral 連携アーキテクチャ」セクションを参照してください。

Claude Code を使った並列開発を統括するデスクトップアプリ。
複数リポにまたがる issue ベースの並列実装を自動化し、AI agent が品質を担保する「開発指揮システム」。

> プロジェクトの哲学・ビジョン・解決する課題の詳細は [README.md](README.md) を参照。

## AI 最適化開発モデル

95% の読者は AI である。開発情報は GitHub に集約し、AI がノイズなく正確にコンテキストを抽出できる形式を最優先する。Issue = Problem、Test = Spec、Code = Design、ADR = Decision、PR = Report。詳細は [ADR-0001](adr/0001-ai-optimized-dev-model.md) を参照。

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
skills/implement/     /implement スキル（feature+cleanup+merge 統合）
skills/adr/           /adr スキル（ADR 作成・更新・検索）
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

## このプロジェクトが解決する問題

> 人間向けの課題説明は [README.md](README.md) を参照。以下は AI がコンテキストとして使用するための要約。

1. **dev-shared の `/feature` と `/cleanup` が分離** → 手動で繋ぐのが面倒 → `/implement` で統合
2. **Claude Code の plan mode 承認後にコンテキスト消失** → 後続ステップを忘れる → `workflow-state.json` で状態永続化
3. **並列で複数 issue を捌く UI がない** → Ship Grid で並列セッションを一望
4. **LLM に任せるとブレる制御が確定的でない** → issue ラベル・worktree・ポート管理はスクリプトに移譲
5. **CLI の stream-json 出力をそのまま全表示するとメモリを大量消費** → Engine 側でフィルタリング・要約し、フロントエンドにはステータス変化と重要メッセージのみ転送する設計が必要

## 開発哲学: 事後フィードバックモデル

> AI が大体の問題は発見してくれるから、基本的に人間は同期的に確認しない。
> 人間は後で漏れたものにだけ気づいたら issue で伝える。

### 原則

- **QA agent が品質を担保する**。人間承認は Gate に含めない
- **人間はフローのボトルネックにならない**。並列 sortie のスループットを最大化する
- **完璧を同期的に求めるより、問題を非同期で回収する方が全体効率が高い**
- **人間が発見した問題は新規 issue として起票し、次の sortie で修正する**

### 背景

従来の開発フローでは、コードレビューや受け入れテストで人間の同期的な承認を必須としていた。
しかし並列 sortie を運用する環境では、人間の承認待ちが全体のスループットを著しく低下させる。

vibe-admiral では Bridge sub-agent による自動 Gate（計画レビュー・コードレビュー・E2E テスト）で品質を担保し、
人間は非同期的に結果を確認する。問題を発見した場合は新規 issue として起票し、次の sortie で修正する。

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

## ラベル体系

### ステータスラベル（`status/` prefix）— Engine 自動管理、排他的
| ラベル | 意味 |
|--------|------|
| `status/todo` | Sortie 可能 |
| `status/planning` | 計画中（調査 + 計画） |
| `status/implementing` | 実装中（コーディング + テスト） |
| `status/acceptance-test` | 受け入れテスト中（PR レビュー + QA） |
| `status/merging` | マージ中 |
| `status/blocked` | 依存関係で着手不可（Bridge が付与可） |

### カテゴリラベル（`type/` prefix）— 人間または Bridge が付与
| 優先順位 | ラベル | コミット prefix |
|----------|--------|----------------|
| 1 | `type/skill` | `skill:` |
| 2 | `type/bug` | `fix:` |
| 3 | `type/infra` | `infra:` |
| 4 | `type/test` | `test:` |
| 5 | `type/refactor` | `refactor:` |
| 6 | `type/feature` | `feat:` |

## Admiral 連携アーキテクチャ

vibe-admiral は Fleet 配下の各リポに対して Claude Code セッション（Bridge / Ship）を起動する。
各リポの CLAUDE.md は **リポ固有の開発規約** として尊重され、Admiral の運用指示は別経路で注入される。

### 注入経路

| 対象 | 経路 | 内容 |
|------|------|------|
| Bridge | `--append-system-prompt`（`bridge-system-prompt.ts` で生成） | Admiral-Request プロトコル、Sortie フロー、ラベル運用、PR レビュー手順 |
| Ship | `/implement` スキル（`.claude/skills/implement/SKILL.md`） | ワークフロー手順（調査→実装→テスト→PR→マージ） |
| 共通 | `VIBE_ADMIRAL=true` 環境変数 | Admiral 管理下であることの検出フラグ |

### Fleet 設定による追加ルール

Fleet ごとに以下のパスを設定可能（`engine/src/types.ts` の `Fleet` 型）:

- **`sharedRulePaths`**: Bridge・Ship 双方に注入される Fleet 全体の共通ルール
- **`bridgeRulePaths`**: Bridge にのみ注入されるルール
- **`shipRulePaths`**: Ship にのみ注入されるルール

### リポ固有 CLAUDE.md と Admiral 指示の分離原則

- **CLAUDE.md**: リポの技術スタック、ディレクトリ構成、コマンド、コーディング規約、ラベル体系など開発規約のみを記載する。Claude Code が worktree の `cwd` から自動で読み込む
- **Admiral 運用指示**: Engine が `--append-system-prompt` やスキルファイルとして注入する。CLAUDE.md には書かない
- **複数リポ対応**: 各リポは独自の CLAUDE.md を持ち、Admiral はそれを変更しない。運用指示は常に別経路で注入される
