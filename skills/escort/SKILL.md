# /escort — On-Demand Gate Reviewer (Session Resume)

Escort skill for on-demand gate review. Launched once per gate phase, performs the
review, submits a verdict, and exits. Session resume (`--resume sessionId`) preserves
context across gates so that planning review insights carry over to code review and
acceptance testing.

## Environment Variables

- `VIBE_ADMIRAL_SHIP_ID` — This Escort Ship's own ID
- `VIBE_ADMIRAL_PARENT_SHIP_ID` — The parent Ship being reviewed
- `VIBE_ADMIRAL_MAIN_REPO` — The fleet's main repository (owner/repo)
- `VIBE_ADMIRAL_ENGINE_PORT` — Engine API port (default: 9721)

## Arguments

- Issue number (e.g., `42`)

## Execution Model

This skill is invoked **once per gate**. After submitting the verdict, **exit normally**.
The Engine will resume this session (with `--resume`) for the next gate, preserving
all context from prior reviews.

```
Gate 1 (plan-gate):
  Escort launched fresh → plan review → verdict → exit
  sessionId saved by Engine

Gate 2 (coding-gate):
  Escort resumed (--resume sessionId) → code review → verdict → exit
  sessionId updated

Gate 3 (qa-gate):
  Escort resumed (--resume sessionId) → QA → verdict → exit
```

## Common Setup

```bash
PARENT_SHIP_ID="${VIBE_ADMIRAL_PARENT_SHIP_ID}"
REPO="${VIBE_ADMIRAL_MAIN_REPO:-$(git remote get-url origin | sed -E 's#.+github\.com[:/](.+)\.git#\1#' | sed -E 's#.+github\.com[:/](.+)$#\1#')}"
SHIP_ID="$VIBE_ADMIRAL_SHIP_ID"
ENGINE_PORT="${VIBE_ADMIRAL_ENGINE_PORT:-9721}"
```

## Gate Detection

```bash
RESULT=$(curl -sf "http://localhost:${ENGINE_PORT}/api/ship/${PARENT_SHIP_ID}/phase")
PHASE=$(echo "$RESULT" | grep -o '"phase":"[^"]*"' | cut -d'"' -f4)
```

Based on `$PHASE`, execute the corresponding gate skill (`/planning-gate`, `/implementing-gate`, `/acceptance-test-gate`). If not a gate phase — log an error and exit.

## Common Gate Protocol

All gate skills share this verdict submission flow. **Individual gate skills reference this section.**

### 1. Gate intent（verdict 前のフォールバック）

```bash
curl -sf http://localhost:${ENGINE_PORT}/api/ship/${SHIP_ID}/gate-intent \
  -H 'Content-Type: application/json' \
  -d '{"verdict": "<approve or reject>"}'
```

### 2. Gate verdict（GitHub コメントより先に実行）

承認:
```bash
curl -sf http://localhost:${ENGINE_PORT}/api/ship/${SHIP_ID}/gate-verdict \
  -H 'Content-Type: application/json' \
  -d '{"verdict": "approve"}'
```

拒否（構造化フィードバック付き — ADR-0018）:
```bash
curl -sf http://localhost:${ENGINE_PORT}/api/ship/${SHIP_ID}/gate-verdict \
  -H 'Content-Type: application/json' \
  -d '{
    "verdict": "reject",
    "feedback": {
      "summary": "<1-2文の要約>",
      "items": [
        {
          "category": "<plan|code|test|style|security|performance>",
          "severity": "<blocker|warning|suggestion>",
          "message": "<具体的な指摘内容>",
          "file": "<対象ファイルパス（任意・code-review 用）>",
          "line": "<対象行番号（任意・code-review 用）>"
        }
      ]
    }
  }'
```

> `blocker` は修正必須、`warning` は推奨、`suggestion` は任意。

### 3. GitHub に記録（verdict 送信後）

- Plan review → `gh issue comment`
- Code review / QA → `gh pr comment`

> Ship と Escort は同じ GitHub アカウントのため `gh pr review --approve` は使えない。コメントを使用する。

## Key Advantages (Session Resume Model)

- **Context preservation**: Plan review insights carry over to code review via `--resume`
- **No polling overhead**: No 30-second polling loop consuming tokens between gates
- **Clean lifecycle**: One process per gate review, no persistent daemon to manage
- **Automatic retry**: If Escort fails, Engine reverts the gate and can re-launch immediately
