# ADR-0014: Gate ポーリングを回数ベースに変更

- **Status**: Accepted
- **Date**: 2026-03-23
- **Issue**: [#495](https://github.com/mizunowanko-org/vibe-admiral/issues/495)
- **Tags**: skill, gate, polling, timeout

## Context

Gate ポーリングの間隔を `sleep 3` → `sleep 60` に変更した際、TIMEOUT 値が据え置かれたため、ポーリング回数が意図せず減少していた:

| スキル | TIMEOUT | sleep | 実効回数 |
|--------|---------|-------|---------|
| implement-plan | 300秒 | 60秒 | 5回 |
| implement-review | 600秒 | 60秒 | 10回 |
| implement-merge | 600秒 | 60秒 | 10回 |

Escort のレビューは数分〜10分以上かかることがあり、5回では不足していた。また、時間ベースの TIMEOUT は sleep 間隔の変更に対して脆く、意図しない回数変動を引き起こす。

## Decision

全 gate ポーリングループの制御方式を時間ベースから回数ベースに変更する。

### 統一パラメータ

- **TIMEOUT**: 900秒（15分）
- **sleep 間隔**: 60秒
- **実効回数**: 15回

### ポーリングテンプレート

```bash
TIMEOUT=900; ELAPSED=0
while [ $ELAPSED -lt $TIMEOUT ]; do
  RESULT=$(curl -sf http://localhost:${VIBE_ADMIRAL_ENGINE_PORT:-9721}/api/ship/${VIBE_ADMIRAL_SHIP_ID}/phase)
  PHASE=$(echo "$RESULT" | grep -o '"phase":"[^"]*"' | cut -d'"' -f4)
  case "$PHASE" in
    <expected-next-phase>) echo "Gate approved"; break ;;
    <rejection-phase>) echo "Gate rejected"; break ;;
    <current-gate-phase>) sleep 60 ;;
    *) echo "UNEXPECTED_PHASE: $PHASE"; break ;;
  esac
  ELAPSED=$((ELAPSED + 60))
done
[ $ELAPSED -ge $TIMEOUT ] && echo "POLL_TIMEOUT"
```

### 変更対象

- `skills/implement-plan/SKILL.md`
- `skills/implement-review/SKILL.md`
- `skills/implement-merge/SKILL.md`
- `skills/implement/SKILL.md`（テンプレート）

### 検討したが採用しなかった案

| 案 | 不採用理由 |
|----|----------|
| TIMEOUT のみ増加（時間ベース維持） | sleep 間隔を再変更した際に同じ問題が再発する |
| ポーリング間隔を短縮（sleep 10 等） | 不要な API リクエストが増加。60秒で十分 |
| WebSocket 通知方式 | CLI subprocess は WS クライアントを持てない制約がある（ADR-0007 参照） |

## Consequences

- **Positive**: TIMEOUT=900 への統一により、全 gate で最低 15 回のポーリングが保証される
- **Positive**: 時間ベースから回数ベースへの概念転換により、sleep 間隔変更時の回数変動が予測可能
- **Negative**: 15分を超える Escort レビューではタイムアウトが発生する。ただし XState 導入後（ADR-0008）はタイムアウトが Actor に内蔵されるため、この制約は解消される見込み
