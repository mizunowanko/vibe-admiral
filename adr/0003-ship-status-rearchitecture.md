# ADR-0003: Ship ステータス管理のリアーキテクチャ — DB 化・Phase 設計・SSoT 分離

- **Status**: Accepted
- **Date**: 2026-03-21
- **Issue**: [#378](https://github.com/mizunowanko-org/vibe-admiral/issues/378)
- **Tags**: engine, ship, status, database, phase, gate, escort

## Context

Ship のステータス管理に構造的な問題が頻発していた。根本原因は「状態の真実の源（SSoT）が分散している」ことにある。

### 発生していた問題

1. **プロセス生存チェックが存在しない** — Engine は `exit` イベントでしか死亡を検知しない。マシンスリープ等で `exit` が発火しないと、ステータスが active のまま放置される
2. **error 判定がファジー** — exit code 0 でも error になる（gate 待ちタイムアウト等）。Gate が Engine 側で approved なのに Ship が知らずに終了するケース
3. **resume が error 限定** — プロセスが dead なのに `merging` 等のままの Ship は resume 不可
4. **GitHub label と内部状態の二重管理** — 不整合の検出・修復が startup 時のみ
5. **Gate 状態の二重管理** — Engine 内部状態とファイル伝言板（gate-request.json / gate-response.json）が独立に存在
6. **Bridge がボトルネック** — Escort が Bridge の sub-agent であり、全 Ship の gate 処理が Bridge のシリアルな応答に依存

### 旧アーキテクチャの SSoT 分散

| 状態 | 保存場所 | 問題 |
|------|---------|------|
| Ship ステータス | ships.json + GitHub label + Engine メモリ | 3箇所が独立に変化 |
| Gate 状態 | Engine メモリ + ファイル伝言板 | 2箇所が独立に変化 |
| プロセス生死 | OS のプロセステーブル（未チェック） | 誰も見ていない |

## Decision

### 設計原則: 2つの独立した SSoT

状態を2つの独立した概念に分離し、それぞれに明確な SSoT を持たせる。

1. **Phase（フェーズ）** — 「今こうあるべき」という概念的状態 → **SQLite DB** が SSoT
2. **プロセス生死（Process Liveness）** — マシン上の現実 → **OS のプロセス状態** が SSoT

`error` は Phase ではなく、`phase ≠ done && process dead` から**導出される**表示状態。

### Phase モデル: Gate を Phase の一部として組み込む

Gate 待ちも Phase として定義し、状態遷移を単純な前進のみにする。reject = 同じ gate phase に留まる（後退なし）。

```
planning → planning-gate → implementing → implementing-gate
→ acceptance-test → acceptance-test-gate → merging → done
```

### Fleet 単位の SQLite DB (better-sqlite3)

- 配置: `<repo-root>/.vibe-admiral/fleet.db`
- WAL モード有効（Engine + Ship の複数プロセスから同時アクセス）
- Ship worktree からは環境変数 `VIBE_ADMIRAL_MAIN_REPO` でメインリポジトリの DB にアクセス

### Phase 遷移のトランザクション設計

```sql
BEGIN;
  1. phases.phase が期待値と一致するか確認（事前条件）
  2. phase_transitions に INSERT（遷移ログ）
  3. phases を UPDATE（最新状態）
COMMIT;
```

- 副作用（GitHub label 変更、worktree 削除、Bridge 通知等）はトランザクション外で実行
- 副作用の失敗はフェーズ遷移をブロックしない
- 冪等性: 直近 N 秒以内に同一遷移レコードがあれば no-op

### ファイル伝言板の廃止 → DB messages テーブル

- gate-request.json / gate-response.json / acceptance-test-request.json を廃止
- DB の `messages` テーブルに統合
- Ship は Bash ツールで `sqlite3` コマンドを使い DB をポーリング
- `read_at` フラグで既読管理

### GitHub label の簡素化

- per-phase label（`status/planning`, `status/implementing` 等）を**廃止**
- `status/sortied` のみ（sortie 時に付与）
- label 同期失敗がフェーズ遷移をブロックしない

### Escort を Ship の sub-agent に移管

- **Before**: Bridge が Gate Check Request を受信 → Escort 起動 → gate-result 送信（全ステップ Bridge 経由）
- **After**: Ship が Gate Phase に入ったら自分で Escort（Task tool）を起動 → レビュー → 結果を DB に書き込み → Ship が DB をポーリングして検知
- Bridge は Gate に関与しない

### プロセス生死チェック

- Engine が 30 秒ごとに `process.kill(pid, 0)` で生存確認
- dead 検知 → Bridge に通知
- Bridge が状況を調査して resume 判断（自動 resume はしない）

### 検討したが採用しなかった案

| 案 | 不採用理由 |
|----|----------|
| GitHub label を SSoT とする（従来方式） | API レート制限、ネットワーク依存、プロセス状態を表現できない |
| error を Phase として残す | 「プロセスが死んでいる」は Phase ではなく物理的事実。導出で十分 |
| 自動 resume | rate limit 時に無限リトライのリスク。Bridge の判断が必要 |
| ファイル伝言板の改良 | アトミシティが保証されない。DB の方が構造的に優れる |
| Escort を Engine が直接起動 | Escort は Claude Code の Task tool でしか起動できない。Ship の sub-agent が自然 |

## Consequences

### Positive

- **SSoT の明確化**: Phase は DB、プロセス生死は OS。二重管理がなくなる
- **トランザクション保証**: Phase 遷移が atomic。中間状態で不整合が起きない
- **Bridge の負荷軽減**: Gate 処理から完全に解放。並列 sortie のスループット向上
- **遷移ログの蓄積**: phase_transitions テーブルでデバッグ・監査が容易
- **resume 制約の解消**: error ステータスに依存しない resume が可能
- **冪等性**: 遷移の再実行が安全

### Negative

- **DB 依存の追加**: better-sqlite3 のネイティブモジュールが必要（CI/Docker 環境での考慮）
- **Ship が sqlite3 CLI に依存**: macOS にはデフォルトで入っているが、他環境では要インストール
- **移行コスト**: 6ステップに分割したが、大規模な破壊的変更。CI は一時的に無効化
- **Bridge の system prompt / skill が旧フォーマットのまま残るリスク**: 実際に gate-result のフォーマット不一致で問題が発生した

### 実装ステップ

| Step | Issue | 内容 |
|------|-------|------|
| 1/6 | #380 | SQLite DB 導入 + ships.json 移行 |
| 2/6 | #381 | Phase モデル変更 + Gate Phase 化 + 伝言板 DB 化 + label 簡素化 |
| 3/6 | #382 | Escort を Ship sub-agent に移管 |
| 4/6 | #397 | GitHub label 一括更新 |
| 5/6 | #392 | 方針整合性チェック + コード浄化 |
| 6/6 | #385 | テスト再設計 + CI 復旧 |
