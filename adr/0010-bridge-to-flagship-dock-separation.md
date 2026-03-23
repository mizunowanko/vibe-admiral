# ADR-0010: Bridge → Flagship/Dock 分離

- **Status**: Accepted
- **Date**: 2026-03-23
- **Issue**: [#389](https://github.com/mizunowanko-org/vibe-admiral/issues/389), [#410](https://github.com/mizunowanko-org/vibe-admiral/issues/410)
- **Tags**: architecture, bridge, flagship, dock, commander

## Context

単一の Bridge が以下の2つの異なるコンテキストを同一チャットで処理しており、混線が発生していた:

1. **Sortie 前の Issue 管理** — Issue の作成・整理・依頼の分解・優先度議論・計画
2. **Sortie 後の Ship 管理** — Gate phase の通知受信・Ship 監視・マージ

Ship 管理が忙しい（gate phase の通知が頻繁に来る、複数 Ship の並列監視）ため、Issue の議論が中断・埋没していた。また、Bridge が全 Ship の Gate 処理のボトルネックになっていた。

## Decision

単一の Bridge を2つの独立した Commander に分離する。

- **Dock（ドック）**: Issue マネジメント専任。造船所/修理ドックのメタファー
- **Flagship（旗艦）**: Ship 管理専任。Bridge のリネーム

```
Admiral(アプリ) → Fleet(艦隊)
  ├── Dock(ドック = Issue マネジメント)
  └── Flagship(旗艦 = Ship 管理)
```

### 権限分離

| 権限カテゴリ | Dock | Flagship |
|-------------|:----:|:--------:|
| Ship 操作（sortie/stop/resume） | - | write |
| Lookout Alert / Gate 監視 | - | write |
| Issue CRUD | write | write |
| Issue マネジメント（triage, 優先順位） | **専任** | - |
| `/investigate`（調査 Dispatch） | write | write |
| `/hotfix`（緊急修正） | - | write |

**設計原則**:
- Ship に命令を出せるのは Flagship のみ
- Issue の CRUD は両方に開放（Flagship が Ship 運用中に問題を見つけて issue 作成できる）
- Clarity assessment / triage / 優先順位決定は Dock の専任
- Write/Edit ツールは両方とも使用不可（Commander は read-only）

### 技術的な実装

- Dock / Flagship は **別プロセス**（別の Claude CLI セッション）
- system prompt を Dock 用 / Flagship 用に分離して、各コンテキストに集中
- Engine 側の `BridgeManager` を `DockManager` + `FlagshipManager` に分離
- Gate 通知・Lookout Alert は Flagship に自動ルーティング
- WebSocket イベント: `bridge:*` → `flagship:*` + `dock:*`

### 検討したが採用しなかった案

| 案 | 不採用理由 |
|----|----------|
| Bridge 内でコンテキスト切替 | 単一セッションでは system prompt が肥大化し、コンテキスト混線が解消しない |
| 3分割以上（Gate 専任等） | 現時点では2分割で十分。将来必要になれば追加分離できる |

## Consequences

- **Positive**: Issue 議論と Ship 管理が独立チャットに分離され、混線が解消
- **Positive**: 各 Commander の system prompt が小さくなり、AI の応答精度が向上
- **Positive**: Gate 処理が Bridge のシリアル応答に依存しなくなる
- **Negative**: 2つの CLI セッションを同時に起動するため、リソース消費が増加
- **Negative**: Bridge 関連の全コンポーネント・スキル・テストのリネームと分離が必要
