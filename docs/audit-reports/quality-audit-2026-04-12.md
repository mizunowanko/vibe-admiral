# Quality Audit Report — 2026-04-12

**Issue**: [#938](https://github.com/mizunowanko/vibe-admiral/issues/938) — /audit-quality 実行
**Scope**: 直近 closed `type/bug` 50 件 + #937 で起票された open bug 7 件（#944–#950）= 計 57 件
**Method**: `/audit-quality` スキルに従い、バグ傾向分析 → 4 並列 Dispatch による構造精査 → ADR + issue 起票

## 1. バグ傾向（カテゴリ別件数）

| カテゴリ | 件数 | 代表 Issue |
|---------|------|-----------|
| UI 状態管理 (Ship chat / panel) | 14+ | #944, #923, #902, #893, #860, #855, #817, #809, #788, #737, #729, #724, #704, #703, #699, #683 |
| Escort ライフサイクル / Gate verdict | 9+ | #947, #896, #853, #861, #835, #830, #812, #696, #695, #751, #781 |
| Context Isolation / Session Resume | 9 | #814, #787, #867, #865, #881, #736, #895, #855, #859 |
| Engine 安定性 / エラー伝播 | 7+ | #949, #946, #948, #690, #754, #726, #715, #716, #712 |
| Skill / Template（低クラスタ） | 3 | #931, #924, #752 |

### 再発パターン仮説

- **UI 状態管理**: ADR-0019 の 4 Phase 実装後も同系統バグが継続発生 → store 構造自体の分離不足が根本
- **Escort lifecycle**: phase 更新ロジックが 7 箇所に散在し、XState/DB/long-poll/gate-intent/Flagship 通知の 5 チャンネル手動整合が崩れる
- **Context isolation**: Fleet/cwd/session が複数モジュールで独自管理、境界チェックが経路ごとに非対称
- **Engine 安定性**: `JSON.parse` 22 箇所・`console.*` 137 箇所など抽象層が不在で、1 箇所の不備が Engine 全停止に波及

## 2. Dispatch 構造精査サマリ

4 並列 Dispatch を起動し、各カテゴリで 6〜10 件の構造的問題を特定した。

| カテゴリ | Dispatch | Problems | High | ADR Needed |
|---------|----------|----------|------|-----------|
| UI 状態管理 | `audit-quality-ui-state` | 9 | 4 | 4 |
| Escort lifecycle | `audit-quality-escort-lifecycle` | 10 (F1–F10) | 4 | 3 |
| Context isolation | `audit-quality-context-isolation` | 6 | 3 | 3 |
| Engine 安定性 | `audit-quality-engine-stability` | 8 (S-1〜S-8) | 3 | 3 |

## 3. 起票した ADR (Proposed)

| ADR | タイトル | 実装 Issue | スコープ |
|-----|---------|-----------|---------|
| [ADR-0021](../../adr/0021-phase-transaction-service.md) | PhaseTransactionService による単一原子トランザクション | [#952](https://github.com/mizunowanko/vibe-admiral/issues/952) | Escort lifecycle / Gate / XState-DB sync |
| [ADR-0022](../../adr/0022-engine-parse-safety-error-abstractions.md) | Parse-safe / Logger / エラー伝播 抽象 | [#953](https://github.com/mizunowanko/vibe-admiral/issues/953) | Engine 安定性 |
| [ADR-0023](../../adr/0023-ship-escort-log-channel-separation.md) | Ship/Escort ログチャネル分離 + Session 登録一本化 + 通知 payload 自律化 | [#954](https://github.com/mizunowanko/vibe-admiral/issues/954) | Frontend UI 状態管理（ADR-0019 Phase 5） |
| [ADR-0024](../../adr/0024-context-isolation-registry.md) | Fleet / cwd / SystemPrompt の Context Isolation Registry | [#955](https://github.com/mizunowanko/vibe-admiral/issues/955) | Context 境界管理 |

## 4. 起票した Issue 一覧

### ADR 紐付き（構造的設計変更）

| Issue | タイトル | 優先度 | 工数 | ADR |
|-------|---------|--------|------|-----|
| [#952](https://github.com/mizunowanko/vibe-admiral/issues/952) | PhaseTransactionService 導入 | High | L | ADR-0021 |
| [#953](https://github.com/mizunowanko/vibe-admiral/issues/953) | parse-safe / Logger / 行指向 stderr 抽象 | High | L | ADR-0022 |
| [#954](https://github.com/mizunowanko/vibe-admiral/issues/954) | Ship/Escort ログチャネル分離他 | High | L | ADR-0023 |
| [#955](https://github.com/mizunowanko/vibe-admiral/issues/955) | Context Isolation Registry | High | L | ADR-0024 |

### 局所リファクタ（ADR 不要）

| Issue | タイトル | 優先度 | 工数 |
|-------|---------|--------|------|
| [#956](https://github.com/mizunowanko/vibe-admiral/issues/956) | Escort Outcome 型統合 + Gate Taxonomy 単一ソース化 | Medium | M |
| [#957](https://github.com/mizunowanko/vibe-admiral/issues/957) | mergeShipHistory / focus 復元 / fingerprint 自動化 | Medium | S |
| [#958](https://github.com/mizunowanko/vibe-admiral/issues/958) | db.ts 5 repo 分割 + ProcessManager stream parser 分離 | Medium | L |

## 5. 過去の ADR との関係

| 新規 ADR | 関連する既存 ADR | 関係 |
|---------|----------------|------|
| ADR-0021 | ADR-0017 (XState snapshot) | 発展（「DB が SoT」を実行レベルまで貫徹） |
| ADR-0021 | ADR-0008 (XState Ship/Escort lifecycle) | 補完（Escort 起動 trigger を XState entry に統合） |
| ADR-0022 | ADR-0015 (typesafe messaging) | 補完（supervisor IPC 側への延長） |
| ADR-0022 | ADR-0016 (Supervisor) | 補完（crash-logger を Logger 抽象に統合） |
| ADR-0023 | ADR-0019 (frontend store normalization) | 発展（Phase 5 として継続） |
| ADR-0023 | ADR-0006 (SessionChat 表示ルール) | 基盤補強（データチャネル分離） |
| ADR-0023 | ADR-0015 | 回復（二重経路で破られた不変条件の回復） |
| ADR-0024 | ADR-0007 (Engine REST API 統一) | 補完（実行時の文脈検証を統一） |
| ADR-0024 | ADR-0012 (Unit terminology) | 補完（属性チェックの型強制） |

## 6. 推奨アクション順序

1. **#953 (ADR-0022) Phase 1 + 2** — 小さな変更で複数バグ（#949, #946, #712, #754）を根元から止める。早期着手推奨
2. **#952 (ADR-0021)** — #947 の bugfix と合流させる。Escort lifecycle の構造的バグ集合の同時撲滅
3. **#955 (ADR-0024)** — #952 と連携（gate-intents の DB 化は共通）。repos UNIQUE migration と合わせて実施
4. **#954 (ADR-0023)** — Frontend の大型改修。#944 / #855 / #683 の同時解消
5. #957 — ADR-0023 の周辺で同時に着手可能な小粒改善
6. #956 — #952 完了後の仕上げリファクタ
7. #958 — ADR-0022 の parse 置換と相乗効果。中長期で着手

## 7. 監査メモ

- 既存 ADR (0015, 0017, 0018, 0019, 0020) は本監査で提案する新 ADR と整合的で、矛盾や撤回は不要
- `type/refactor` 起票 7 件はいずれも既存 `type/bug` 複数件を同時解消する構造改修であり、個別 bugfix で既に close したものの「再発防止」の位置付けも含む
- Ship がコード実装を伴わない audit タスクとして完結しており、PR は ADR 4 本 + 本レポート + CLAUDE.md 更新のみ
