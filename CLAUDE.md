# vibe-admiral

> **このファイルはリポジトリ固有の開発規約です。**
> Admiral（Bridge/Ship）への運用指示は Engine が `--append-system-prompt` やスキル経由で別途注入します。
> 詳細は後述の「Admiral 連携アーキテクチャ」セクションを参照してください。

Claude Code を使った並列開発を統括するデスクトップアプリ。
複数リポにまたがる issue ベースの並列実装を自動化し、人間は受け入れテストのみ介入する「開発指揮システム」。

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

1. **dev-shared の `/feature` と `/cleanup` が分離** → 手動で繋ぐのが面倒 → `/implement` で統合
2. **Claude Code の plan mode 承認後にコンテキスト消失** → 後続ステップを忘れる → `workflow-state.json` で状態永続化
3. **並列で複数 issue を捌く UI がない** → Ship Grid で並列セッションを一望
4. **LLM に任せるとブレる制御が確定的でない** → issue ラベル・worktree・ポート管理はスクリプトに移譲
5. **CLI の stream-json 出力をそのまま全表示するとメモリを大量消費** → Engine 側でフィルタリング・要約し、フロントエンドにはステータス変化と重要メッセージのみ転送する設計が必要

## コーディング規約

dev-shared 共通ルールに従う。詳細は `~/Projects/Plugins/dev-shared/CLAUDE.md` を参照。

- コミット: `feat:` / `fix:` / `refactor:` / `test:` / `skill:` / `infra:`
- `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`
- ブランチ: `feature/<issue-num>-<short-name>`
- `git add -A` 禁止（ファイル名指定）
- PR に `Closes #<issue-num>`
- パスエイリアス: `@/*` → `./src/*`
- Engine の import は `.js` 拡張子（ESM）

## ラベル体系

### ステータスラベル（`status/` prefix）— Engine 自動管理、排他的
| ラベル | 意味 |
|--------|------|
| `status/todo` | Sortie 可能 |
| `status/investigating` | 調査中 |
| `status/planning` | 計画中 |
| `status/implementing` | 実装中 |
| `status/testing` | テスト中 |
| `status/reviewing` | レビュー中 |
| `status/acceptance-test` | 人間の承認待ち |
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
