---
name: adr
description: ADR（Architecture Decision Records）の作成・更新・検索。"/adr create <title>", "/adr list", "/adr search <query>" などで起動。
user-invocable: true
argument-hint: [create|list|search] [args]
---

# /adr — ADR 管理スキル

Architecture Decision Records を作成・更新・一覧・検索するスキル。
ADR は `adr/` ディレクトリに `NNNN-kebab-case-title.md` の形式で配置する。

## 引数

- `create <title>` — 新しい ADR を作成する
- `update <number>` — 既存 ADR のステータスや内容を更新する
- `list` — 全 ADR の一覧を表示する
- `search <query>` — タイトル・タグ・内容で ADR を検索する
- 引数なし — `list` として動作する

## リポ情報の取得

```bash
REMOTE_URL=$(git remote get-url origin)
REPO=$(echo "$REMOTE_URL" | sed -E 's#.+github\.com[:/](.+)\.git#\1#' | sed -E 's#.+github\.com[:/](.+)$#\1#')
REPO_ROOT=$(git rev-parse --show-toplevel)
ADR_DIR="${REPO_ROOT}/adr"
```

## モード別手順

### `list` モード

全 ADR を一覧表示する:

```bash
echo "=== Architecture Decision Records ==="
for f in "${ADR_DIR}"/[0-9]*.md; do
  [ -f "$f" ] || continue
  NUM=$(basename "$f" | sed 's/-.*//')
  TITLE=$(head -1 "$f" | sed 's/^# ADR-[0-9]*: //')
  STATUS=$(grep -m1 '^\- \*\*Status\*\*:' "$f" | sed 's/.*: //')
  echo "  ADR-${NUM}: ${TITLE} [${STATUS}]"
done
```

### `create` モード

1. 次の番号を自動採番する:
   ```bash
   LAST_NUM=$(ls "${ADR_DIR}"/[0-9]*.md 2>/dev/null | sort -r | head -1 | xargs basename 2>/dev/null | sed 's/-.*//' | sed 's/^0*//')
   NEXT_NUM=$(printf "%04d" $(( ${LAST_NUM:-0} + 1 )))
   ```

2. タイトルを kebab-case に変換する:
   ```bash
   TITLE="<引数で渡されたタイトル>"
   KEBAB=$(echo "$TITLE" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g' | sed -E 's/^-|-$//g')
   ADR_FILE="${ADR_DIR}/${NEXT_NUM}-${KEBAB}.md"
   ```

3. テンプレートから ADR ファイルを作成する:
   ```bash
   TODAY=$(date +%Y-%m-%d)
   cat > "$ADR_FILE" << EOF
   # ADR-${NEXT_NUM}: ${TITLE}

   - **Status**: Proposed
   - **Date**: ${TODAY}
   - **Issue**: [#N](url)
   - **Tags**:

   ## Context

   <Background and problem statement>

   ## Decision

   <The decision made and rationale>

   ## Consequences

   <Impact and implications>
   EOF
   ```

4. ユーザーに作成されたファイルパスを報告する

5. **関連する Issue がある場合**: Issue 番号とリンクを `Issue` フィールドに記入する

6. **既存 ADR との整合性チェック**: 新しい ADR の内容が既存 ADR と矛盾しないか確認する:
   ```bash
   # 既存 ADR のタイトルと Decision セクションを簡易スキャン
   for f in "${ADR_DIR}"/[0-9]*.md; do
     [ -f "$f" ] || continue
     echo "--- $(basename "$f") ---"
     head -1 "$f"
     sed -n '/^## Decision/,/^## /p' "$f" | head -20
   done
   ```
   矛盾がある場合はユーザーに警告し、既存 ADR を Superseded にすべきか相談する。

7. ADR の Context / Decision / Consequences セクションをユーザーの説明に基づいて記入する

8. コミットする:
   ```bash
   git add "$ADR_FILE"
   git commit -m "adr: Add ADR-${NEXT_NUM} ${TITLE}

   Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
   ```

### `update` モード

1. 対象の ADR ファイルを特定する:
   ```bash
   ADR_NUM=$(printf "%04d" <引数の番号>)
   ADR_FILE=$(ls "${ADR_DIR}/${ADR_NUM}"-*.md 2>/dev/null | head -1)
   ```

2. 現在の内容を Read ツールで読む

3. ユーザーの指示に基づいて更新する（ステータス変更、内容修正など）

4. **ステータスが Superseded に変わる場合**: 後継の ADR 番号とリンクを記入する

5. コミットする:
   ```bash
   git add "$ADR_FILE"
   git commit -m "adr: Update ADR-${ADR_NUM} status/content

   Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
   ```

### `search` モード

タイトル・タグ・内容で ADR を検索する:

```bash
QUERY="<検索クエリ>"
echo "=== Searching ADRs for: ${QUERY} ==="
grep -ril "$QUERY" "${ADR_DIR}"/[0-9]*.md 2>/dev/null | while read f; do
  NUM=$(basename "$f" | sed 's/-.*//')
  TITLE=$(head -1 "$f" | sed 's/^# ADR-[0-9]*: //')
  STATUS=$(grep -m1 '^\- \*\*Status\*\*:' "$f" | sed 's/.*: //')
  echo "  ADR-${NUM}: ${TITLE} [${STATUS}]"
  # マッチした行のコンテキストを表示
  grep -n -i "$QUERY" "$f" | head -3 | sed 's/^/    /'
done
```

マッチした ADR がある場合、その内容を Read ツールで詳細表示する。

## ADR 参照ガイドライン

以下のタイミングで既存 ADR を自動的に参照すること:

1. **実装前の調査時**: `adr/` 内の ADR を確認し、実装方針に影響する過去の決定がないかチェックする
2. **設計判断が必要な時**: 類似の判断が過去にないか `search` で確認する
3. **コードレビュー時**: 変更が既存 ADR の Decision に矛盾しないか検証する
4. **新規 ADR 作成時**: 既存 ADR との整合性を確認し、矛盾があれば Supersede フローを検討する

## 注意事項

- ADR のファイル名は変更しない（番号は永続的な識別子）
- Deprecated/Superseded な ADR はファイルを削除せず、ステータスを更新する
- ADR は `adr/` ディレクトリ直下に配置する（サブディレクトリは使わない）
- テンプレートは `adr/TEMPLATE.md` を参照
