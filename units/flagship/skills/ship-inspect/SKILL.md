---
name: ship-inspect
description: Ship の状況確認スキル。chat log 必読を強制し、DB/phase だけの判断を禁止する
user-invocable: true
argument-hint: [ship-id or issue-number]
---

# /ship-inspect — Ship 状況確認（chat log 必読）

Ship の状況を正確に把握するための Flagship 専用スキル。
**DB の phase 情報や WS メッセージだけで Ship の状態を判断することを禁止する。**

> **背景**: commander-rules.md に「Ship 異常調査のログ最優先ルール」を記載済みだが、Flagship がルールに従わず DB やフロントエンドの情報だけで判断するケースが繰り返し発生した。このスキルはログ読み取りを必須ステップとして強制する。

## 引数

- Ship ID（UUID）または Issue 番号（例: `42`, `#42`）
- 省略時: 全 Ship の一覧を表示して選択を促す

## CRITICAL: このスキルの使用が必須な場面

以下の場面では **必ず** `/ship-inspect` を使用すること:

- Ship の進捗・状況をユーザーに報告するとき
- Ship の異常（processDead, phase 停滞, 無限ループ等）を調査するとき
- Ship を pause/resume/abandon する判断を行うとき
- Lookout Alert を受けて Ship の状態を確認するとき

**禁止**: `/api/ships` の phase 情報だけで Ship の状況を判断・報告すること。phase はあくまで「どのフェーズにいるか」であり、「何をしているか」ではない。

## Step 1: Ship 基本情報の取得

```bash
curl -s "http://localhost:${VIBE_ADMIRAL_ENGINE_PORT:-9721}/api/ships?fleetId=${VIBE_ADMIRAL_FLEET_ID}" | jq '.ships[] | {id, issueNumber, issueTitle, phase, processDead, worktreePath, branchName, prUrl, gateCheck}'
```

引数で Ship ID や Issue 番号が指定されている場合、該当する Ship を特定する。

### 出力から確認すること

- `phase`: 現在のフェーズ（plan, coding, qa 等）
- `processDead`: プロセスが死んでいるか
- `worktreePath`: chat log の読み取りに必要
- `gateCheck`: Gate 待ちの状態

## Step 2: Ship chat log の読み取り（必須）

**このステップは省略不可。** Dispatch を起動して Ship の chat log を読む。

```bash
curl -s -X POST http://localhost:${VIBE_ADMIRAL_ENGINE_PORT:-9721}/api/dispatch \
  -H 'Content-Type: application/json' \
  -d '{
    "fleetId": "'"${VIBE_ADMIRAL_FLEET_ID}"'",
    "parentRole": "flagship",
    "name": "ship-inspect-<issue-number>",
    "type": "investigate",
    "cwd": "<worktreePath>",
    "prompt": "You are a Dispatch agent reading Ship chat logs to understand what the Ship is currently doing.\n\nWorktree: <worktreePath>\n\nSteps (in strict order — do NOT skip any step):\n\n1. **[MUST] Ship chat log** — Read the most recent messages to understand what the Ship is working on:\n   Run: tail -n 300 .claude/ship-log.jsonl 2>/dev/null | grep '\"type\":\"assistant\"' | tail -n 30\n   Run: tail -n 50 .claude/ship-log.jsonl 2>/dev/null | grep '\"type\":\"result\"'\n\n2. **[MUST] Escort chat log** — Check if an Escort exists and read its recent messages:\n   Run: tail -n 200 .claude/escort-log.jsonl 2>/dev/null | grep '\"type\":\"assistant\"' | tail -n 20\n   If the file does not exist, note: no Escort log found.\n\n3. **[MUST] Workflow state** — Check the Ship'"'"'s workflow progress:\n   Run: cat .claude/workflow-state.json 2>/dev/null || echo NO_STATE\n\nOUTPUT FORMAT (keep concise, max 15 lines):\n- **Current activity**: What the Ship is doing right now (from chat log)\n- **Last actions**: 2-3 most recent significant actions\n- **Escort status**: Gate review status if applicable, or \"no Escort\"\n- **Workflow state**: Current step and progress\n- **Issues/Blockers**: Any errors, loops, or stuck behavior observed\n\nDo NOT create issues or make any changes. Only read and report."
  }'
```

## Step 3: Dispatch 結果の待機と確認

Dispatch の完了を待ち、結果を取得する:

```bash
curl -s "http://localhost:${VIBE_ADMIRAL_ENGINE_PORT:-9721}/api/dispatches?fleetId=${VIBE_ADMIRAL_FLEET_ID}" | jq '.dispatches[] | select(.name == "ship-inspect-<issue-number>") | {status, result}'
```

Dispatch が `completed` になるまで数秒待ってからリトライする。

## Step 4: 状況の要約

Step 1（API 情報）と Step 3（chat log 分析）を統合して、Ship の状況を要約する。

### 要約に含めるべき情報

1. **フェーズと進捗**: 現在のフェーズ + chat log から読み取った実際の作業内容
2. **Ship の活動状態**: 活発に作業中 / Gate 待ち / 停滞 / プロセス死亡
3. **直近の作業内容**: chat log から読み取った具体的な作業（「何のファイルを編集していた」「どのテストを実行していた」等）
4. **Escort/Gate の状態**: Gate レビュー中であれば、Escort の判定状況
5. **問題の有無**: エラー、ループ、停滞等の兆候

### 報告フォーマット

```
Ship #<issue-number> (<issue-title>)
- Phase: <phase> | Process: <alive/dead>
- Activity: <chat log から読み取った実際の作業内容>
- Last actions: <直近の具体的なアクション>
- Escort: <Gate 状態 or "なし">
- Issues: <問題があれば記載 / "なし">
```

## 自動 inspect（Engine 駆動 — Lookout アラート起因のみ）

Engine が **Lookout アラート発生時のみ** 自動で ship-inspect Dispatch を起動する。
- **トリガー**: Lookout アラート（異常検知）のみ。**phase 変更では自動 inspect を行わない**（phase 変更は正常動作の一部であり、毎回 chat log を読む必要はない）
- **デバウンス**: 同一 Ship は最低 3 分間隔
- **バッチ処理**: 複数 Ship の inspect が必要な場合、1 つの Dispatch で全 Ship をまとめて確認
- **結果通知**: Dispatch 完了時に Flagship の stdin に結果が届く

このため、Flagship が全 Ship を定期的にポーリングして inspect する必要はない。
手動で `/ship-inspect` を実行するのは、ユー��ーから個別に状況確認を求められた場合のみ。

## 禁止事項

- **phase 情報だけで「順調です」と報告してはいけない。** chat log を読んで実際の作業内容を確認すること。
- **Dispatch を省略して API 情報だけで判断してはいけない。** Step 2 は必須。
- **ソースコードを直接読んではいけない。** 必要であれば別途 `/investigate` で Dispatch を起動する。
- **全 Ship を定期的にポーリングして inspect してはいけない。** Engine が自動で行う。
