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

## 解決する問題

1. **実装ワークフローの分断** -- feature 実装とコード整理が別スキルに分離し、手動で繋ぐ必要があった。`/implement` スキルで調査からマージまでを一気通貫で自動化する
2. **コンテキストの消失** -- Claude Code の plan mode 承認後に後続ステップを忘れる問題を、`workflow-state.json` による状態永続化で解決する
3. **並列開発の可視性** -- 複数 issue を同時に捌く際の全体俯瞰が困難だったことを、Ship Grid による並列セッション管理で解決する
4. **非確定的な制御** -- LLM に任せるとブレやすい issue ラベル管理、worktree 操作、ポート割り当てを確定的なスクリプトに移譲する
5. **メモリ消費の最適化** -- CLI の stream-json 出力をそのまま表示するとメモリを大量消費するため、Engine 側でフィルタリング・要約してフロントエンドに転送する

## 用語

vibe-admiral は海軍の指揮系統になぞらえた用語体系を持つ。

| 用語 | 対応概念 | 説明 |
|------|---------|------|
| **Admiral** | アプリ全体 | 開発指揮を統括するデスクトップアプリ |
| **Fleet** | プロジェクト | 管理対象のリポジトリ群 |
| **Bridge** | 中央管理チャット | Fleet 全体の状況把握と指示を行う AI セッション |
| **Ship** | 個別実装セッション | 1 つの issue を担当する Claude Code プロセス |
| **Sortie** | Ship の出撃 | Ship を起動して issue の実装を開始すること |

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
