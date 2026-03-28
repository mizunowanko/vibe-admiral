---
name: admiral-issue
description: vibe-admiral リポに Issue を作成する。任意の Fleet/Unit から使用可能
user-invocable: true
argument-hint: ["<title or description>"]
---

# /admiral-issue — Create Issue on vibe-admiral Repo

任意の Fleet/Unit から `mizunowanko/vibe-admiral` リポに Issue を作成する。
Ship が実装中に Admiral 自体のバグや改善点を発見した場合など、発見→記録のフローをスムーズにする。

## Trigger

- ユーザーまたは Unit が `/admiral-issue <説明>` を実行したとき
- Ship が vibe-admiral に対するバグ・改善を報告したいとき

## Flow

### 1. 引数の解釈

引数 `<title or description>` を解釈し、以下を生成する:

- **タイトル**: 簡潔な 1 行（日本語 OK）
- **本文**: 背景・現象・期待動作を含む Issue body
- **type ラベル**: 以下の分類基準で 1 つ選択

### 2. Type 分類基準

| 基準 | ラベル |
|------|--------|
| 既存の動作が壊れている | `type/bug` |
| AI 制御設定の変更（CLAUDE.md, skills/, rules/） | `type/skill` |
| CI/CD、ビルド設定、依存管理 | `type/infra` |
| テストの追加・修正 | `type/test` |
| 動作変更のないコード改善 | `type/refactor` |
| 新機能の追加 | `type/feature` |

### 3. コンテキストの自動収集

Admiral 環境（`VIBE_ADMIRAL=true`）で実行されている場合、以下の情報を本文に自動で含める:

```bash
# 利用可能な環境変数を収集
CONTEXT=""
if [ "${VIBE_ADMIRAL}" = "true" ]; then
  [ -n "${VIBE_ADMIRAL_SHIP_ID}" ] && CONTEXT="${CONTEXT}\n- Ship ID: ${VIBE_ADMIRAL_SHIP_ID}"
  [ -n "${VIBE_ADMIRAL_MAIN_REPO}" ] && CONTEXT="${CONTEXT}\n- Fleet Repo: ${VIBE_ADMIRAL_MAIN_REPO}"
  [ -n "${VIBE_ADMIRAL_FLEET_ID}" ] && CONTEXT="${CONTEXT}\n- Fleet ID: ${VIBE_ADMIRAL_FLEET_ID}"
fi
```

Admiral 環境外の場合は、現在のリポ情報を取得:
```bash
CURRENT_REPO=$(git remote get-url origin 2>/dev/null | sed -E 's#.+github\.com[:/](.+)\.git#\1#' | sed -E 's#.+github\.com[:/](.+)$#\1#')
```

### 4. Issue 作成

```bash
ISSUE_URL=$(gh issue create \
  --repo mizunowanko/vibe-admiral \
  --title "<generated title>" \
  --label "<type/*>" \
  --body "$(cat <<'EOF'
<generated body>

## Context
- Reported from: <Unit type and current repo/fleet info>
<collected context>

---
🤖 Created via `/admiral-issue` skill
EOF
)")
echo "$ISSUE_URL"
```

### 5. 結果の報告

作成された Issue の URL を返す。

## 注意事項

- 対象リポは **`mizunowanko/vibe-admiral` 固定**。他のリポには作成しない
- `status/*` ラベルは付与しない（Engine が管理する）
- `gh` CLI の認証が通っていれば、どのリポの worktree からでも実行可能
- Ship の `disallowedTools` に `Bash` は含まれていないため、全 Unit から利用可能
