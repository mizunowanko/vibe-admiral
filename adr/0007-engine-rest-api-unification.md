# ADR-0007: 全 Unit 間通信を Engine REST API に統一

- **Status**: Accepted
- **Date**: 2026-03-23
- **Issue**: [#460](https://github.com/mizunowanko-org/vibe-admiral/issues/460), [#459](https://github.com/mizunowanko-org/vibe-admiral/issues/459)
- **Tags**: engine, api, ipc, communication

## Context

Unit（Ship/Flagship/Dock/Escort）と Engine の間の通信手段が乱立していた。

| 通信 | 方式 | 問題 |
|------|------|------|
| Flagship → Engine | stdout の admiral-request テキストパース | フォーマットミスでサイレント失敗 |
| Ship → Engine | DB 直接更新（sqlite3 コマンド） | バリデーション迂回、監査不能 |
| Ship ↔ Escort | ファイル伝言板（`.claude/acceptance-test-*`） | ファイル監視の脆さ |
| Escort → Engine | DB 直接更新 | 同上 |

これらは「CLI subprocess から Engine API を呼べない」という誤った前提で設計されていた。実際には CLI の AI は `Bash` ツールで `curl` を自由に実行できるため、Engine に REST API を追加すれば全通信を統一できる。

DB 直接操作には以下のリスクがあった:
- Ship が不正な phase 遷移を実行できる（例: `planning` → `done` にジャンプ）
- Engine が担保すべきビジネスルール（遷移可否、前提条件）をバイパス可能
- 複数プロセスが同時に DB を書き換えて競合
- Engine を経由しないため操作のトレースが困難
- Ship/Escort の skill が DB スキーマに直接依存

## Decision

Engine の WebSocket サーバー（port 9721）に HTTP ハンドラを併設し、全 Unit が REST API 経由で操作する方式に統一する。

```
Flagship ──curl──→ Engine REST API ──→ DB
Ship     ──curl──→ Engine REST API ──→ DB
Escort   ──curl──→ Engine REST API ──→ DB
```

### 主要エンドポイント

```
POST /api/ship/:shipId/phase-transition   # Ship/Escort: phase 遷移
POST /api/ship/:shipId/nothing-to-do      # Ship: 対応不要の報告
POST /api/ship/:shipId/gate-verdict       # Escort: gate 審査結果
POST /api/sortie                          # Flagship: Ship 起動
POST /api/ship/:shipId/stop               # Flagship: Ship 停止
POST /api/ship/:shipId/resume             # Flagship: Ship 再開
GET  /api/ships/status                    # 全 Unit: 状態照会
GET  /api/ship/:shipId/phase              # Ship: 自身の phase 確認
```

### 廃止されたもの

- admiral-request stdout テキストパース（正規表現による抽出）
- `/admiral-protocol` スキル（フォーマット仕様が不要に）
- ファイル伝言板（`gate-request.json`, `gate-response.json`, `acceptance-test-*.json`）
- Ship/Escort の DB 直接操作（`sqlite3` コマンド）
- `messages` テーブル

### 検討したが採用しなかった案

| 案 | 不採用理由 |
|----|----------|
| admiral-request の改良 | stdout テキストパースという IPC 方式自体が脆い |
| 専用 CLI ツール（admiral-cli） | REST API で十分。CLI を別途配布するオーバーヘッドが不要 |
| DB 直接操作の改良（バリデーション追加） | バリデーションロジックが Ship/Engine で二重管理になる |

## Consequences

- **Positive**: 全通信が Engine を経由し、バリデーション・権限制御・監査ログが一元化
- **Positive**: DB スキーマ変更が API インターフェースに隠蔽され、skill との結合度が低下
- **Positive**: HTTP のエラーレスポンスにより、失敗がサイレントにならない
- **Negative**: Unit が Engine の HTTP ポートを知る必要がある（環境変数 `VIBE_ADMIRAL_ENGINE_PORT` で解決）
- **Negative**: `curl` コマンドへの依存が追加されるが、全主要 OS にプリインストール済み
