---
name: escort-gate-protocol
description: Escort gate の共通プロトコル。gate-intent / gate-verdict API テンプレートと構造化フィードバック仕様
user-invocable: false
---

# /escort-gate-protocol — Gate Intent & Verdict API Protocol

Escort gate スキル（planning-gate, implementing-gate, acceptance-test-gate）が共通で使用する
gate-intent / gate-verdict API テンプレートと構造化フィードバック仕様。

## 前提

- Gate API は親 Ship（`PARENT_SHIP_ID`）に対して実行する。`SHIP_ID`（Escort 自身）ではない。
- `gh issue comment` / `gh pr comment` の出力がコメント URL になる。この URL を verdict API に渡す。

## Gate Intent（verdict 前のフォールバック）

verdict 送信前に intent を記録する。Escort が verdict 送信前にクラッシュした場合のフォールバック:

```bash
curl -sf http://localhost:${ENGINE_PORT}/api/ship/${PARENT_SHIP_ID}/gate-intent \
  -H 'Content-Type: application/json' \
  -d '{"verdict": "<approve or reject>"}'
```

## Gate Verdict

### 承認

```bash
curl -sf http://localhost:${ENGINE_PORT}/api/ship/${PARENT_SHIP_ID}/gate-verdict \
  -H 'Content-Type: application/json' \
  -d "{\"verdict\": \"approve\", \"commentUrl\": \"${COMMENT_URL}\"}"
```

### 拒否（構造化フィードバック付き — ADR-0018）

```bash
curl -sf http://localhost:${ENGINE_PORT}/api/ship/${PARENT_SHIP_ID}/gate-verdict \
  -H 'Content-Type: application/json' \
  -d "{
    \"verdict\": \"reject\",
    \"commentUrl\": \"${COMMENT_URL}\",
    \"feedback\": {
      \"summary\": \"<1-2文の要約>\",
      \"items\": [
        {
          \"category\": \"<plan|code|test|style|security|performance>\",
          \"severity\": \"<blocker|warning|suggestion>\",
          \"message\": \"<具体的な指摘内容>\",
          \"file\": \"<対象ファイルパス（code-review 時のみ、任意）>\",
          \"line\": \"<対象行番号（code-review 時のみ、任意）>\"
        }
      ]
    }
  }"
```

## Severity 定義

| severity | 意味 |
|----------|------|
| `blocker` | 修正必須 |
| `warning` | 推奨 |
| `suggestion` | 任意 |

> **IMPORTANT**: `commentUrl` は必須。未指定の場合は 400 エラーとなる。
