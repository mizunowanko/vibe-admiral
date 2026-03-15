# vibe-admiral

Claude Code を使った並列開発を統括するデスクトップアプリ。
複数リポにまたがる issue ベースの並列実装を自動化し、人間は受け入れテストのみ介入する「開発指揮システム」。

## 用語

Admiral(アプリ) → Fleet(艦隊=プロジェクト) → Bridge(艦橋=中央管理チャット) → Ship(艦=個別実装セッション) → Sortie(出撃=Ship起動)

## アーキテクチャ

```
React Frontend (port 1420)
  ↕ WebSocket
Node.js Engine Sidecar (port 9720)
  ↕ subprocess
Claude Code CLI (claude -p --output-format stream-json)
```

- **Frontend**: React 19 + Vite 6 + Tailwind CSS v4 + Zustand 5 + shadcn/ui
- **Desktop**: Tauri v2 (`tauri-plugin-shell`)
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
    port-manager.ts   ポート割り当て
    acceptance-watcher.ts  ファイル伝言板監視
    types.ts          Engine 共通型
src-tauri/            Tauri shell
skills/implement/     /implement スキル（feature+cleanup+merge 統合）
```

## コマンド

| Purpose | Command |
|---------|---------|
| Frontend dev | `npm run dev` |
| Engine dev | `npx tsx engine/src/index.ts` |
| Tauri dev | `npm run tauri dev` |
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

- コミット: `feat:` / `fix:` / `refactor:` / `test:` / `chore:` / `docs:` / `style:`
- `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`
- ブランチ: `feature/<issue-num>-<short-name>`
- `git add -A` 禁止（ファイル名指定）
- PR に `Closes #<issue-num>`
- パスエイリアス: `@/*` → `./src/*`
- Engine の import は `.js` 拡張子（ESM）
