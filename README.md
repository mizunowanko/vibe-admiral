# vibe-admiral

**Claude Code を使った並列開発を統括するデスクトップアプリ。**

複数リポジトリにまたがる issue ベースの並列実装を自動化し、人間は受け入れテストのみ介入する「開発指揮システム」。

## 哲学

### AI 最適化開発モデル

vibe-admiral は「**95%の読者は AI である**」という前提に基づいて設計されている。

従来の開発ドキュメント（要件定義書、仕様書、設計書）は人間が読むことを想定していた。AI 時代の開発では、情報を GitHub に集約し、AI がノイズなく正確にコンテキストを抽出できることを優先する。

| 開発要素 | 従来の形式 | AI 時代の形式 |
|----------|-----------|-------------|
| Problem | 要件定義書 | **Issue** |
| Spec | 仕様書 / Wiki | **Test** |
| Design | 設計書 / 図面 | **Code** |
| Decision | 口頭 / チャット | **ADR** |
| Report | 進捗・完了報告 | **Pull Request** |

### 事後フィードバックモデル

従来の開発では人間が事前に計画を承認し、実装中も逐次レビューする。vibe-admiral はこのモデルを逆転させる。

- AI が自律的に調査・計画・実装・テストを実行する
- 人間が介入するのは**受け入れテスト**のみ
- フィードバックは事後に行い、AI が修正して再提出する

この「事後フィードバックモデル」により、人間のボトルネックを最小化しつつ品質を担保する。

## 主要機能

### プロジェクト管理

1. **プロジェクト（Fleet）の登録** — GitHub リポジトリを Fleet として登録し、issue ベースの並列開発を開始する。Fleet ごとに最大同時実装数やカスタム設定を管理

### Issue ライフサイクル

2. **Issue トリアージ** — open issue の優先度判定・要件の明確化・依存関係の整理を AI が自動で行う（Dock）
3. **Issue の並列実装管理** — 複数の issue を同時に出撃させ、進捗監視・異常検知・再開を統括する（Flagship）
4. **フェーズベースの自動実装** — 個別 issue を plan → coding → qa → merging のステートマシンで段階的に実装し、PR 作成・マージまで自動で完了する（Ship）
5. **各フェーズの自動品質レビュー** — plan / coding / qa の完了時に AI レビュアーが自動審査し、基準を満たさなければ差し戻す（Escort）
6. **コードベース調査の委譲** — バグ調査やアーキテクチャ探索を専用の調査セッションに委譲し、結果を受け取る（Dispatch）

## 用語

vibe-admiral は海軍の指揮系統になぞらえた用語体系を持つ。

| 用語 | 対応概念 | 説明 |
|------|---------|------|
| **Admiral** | アプリ全体 | 開発指揮を統括するデスクトップアプリ |
| **Fleet** | 艦隊 = プロジェクト | 管理対象のリポジトリ群 |
| **Commander** | 指揮官 = Fleet 統括 | Fleet を統括する AI セッションの総称（Flagship と Dock） |
| **Flagship** | 旗艦 = Ship 管理 | 出撃中の Ship の進捗監視・異常検知・再開を担当する Commander |
| **Dock** | ドック = Issue 管理 | Issue のトリアージ・作成・整理を担当する Commander |
| **Ship** | 艦 = 個別実装セッション | 1 つの issue を担当する Claude Code プロセス |
| **Sortie** | 出撃 = Ship 起動 | Ship を起動して issue の実装を開始すること |
| **Escort** | 護衛 = 自動審査 | Gate レビュー（plan / code / qa）を行う自動審査セッション |
| **Dispatch** | 派遣 = 調査 | Commander が起動するコードベース調査用セッション |
| **Unit** | 部隊 = セッション主体 | 全セッション種別の総称（Ship, Flagship, Dock, Escort） |

## アーキテクチャ

```
React Frontend (port 1420)
  ↕ WebSocket
Node.js Engine Sidecar (port 9721)
  ↕ subprocess
Claude Code CLI (claude -p --output-format stream-json)
```

- **Frontend**: React 19 + Vite 6 + Tailwind CSS v4 + Zustand 5 + shadcn/ui
- **Engine**: Node.js + `ws` -- Claude CLI のプロセス管理、GitHub 連携、worktree 操作を担当
- **Data**: GitHub Issues が真実の源。ローカル DB は持たない
- **確定的制御**: issue ラベル / worktree / ポート管理はスクリプト。LLM は知性が必要な作業のみ担当

## Getting Started

### 前提条件

- Node.js 20+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) がインストール済み
- [GitHub CLI (`gh`)](https://cli.github.com/) がインストール・認証済み
- Git

### セットアップ

```bash
git clone https://github.com/mizunowanko-org/vibe-admiral.git
cd vibe-admiral
npm install
cd engine && npm install && cd ..
```

### 起動

```bash
# Frontend (port 1420)
npm run dev

# Engine (port 9721) -- 別ターミナルで
npx tsx engine/src/index.ts
```

### ビルド

```bash
npm run build
```

## 開発ガイド

開発規約、ディレクトリ構成、コマンド一覧、ラベル体系などの詳細は [CLAUDE.md](CLAUDE.md) を参照。
