# ADR-0018: Escort Gate Feedback の構造化

- **Status**: Accepted
- **Date**: 2026-03-30
- **Issue**: [#764](https://github.com/mizunowanko/vibe-admiral/issues/764)
- **Tags**: escort, gate, feedback, quality

## Context

Escort の Gate レビューで reject された場合のフィードバックが構造化されていない:

1. **現状**: reject フィードバックは `phase_transitions.metadata` の自由形式 JSON に格納。Ship は `phase-transition-log` API で取得するが、フィードバックの形式が統一されていない
2. **`escortFailCount`**: XState context でカウントのみ管理。reject の**理由**は保持されない
3. **繰り返しリジェクト**: 同じ gate で同じ問題が繰り返し指摘される（#270）。Ship が前回の reject 理由を構造的に把握できないため

過去 22 件の Escort/Gate バグのうち約 10 件がフィードバック不足や繰り返しリジェクトに関連。代表例: #270（同じ指摘繰り返し）、#581（起動失敗で永久停止）。

現在の Gate verdict フロー:
1. Escort がレビュー実施
2. Escort が `POST /api/ship/:id/gate-verdict` で verdict（approve/reject + feedback テキスト）を送信
3. Engine が XState イベント（GATE_APPROVED / GATE_REJECTED）を発火
4. reject 時: Ship の phase が作業 phase に戻り、Ship が polling で検知 → `phase-transition-log` API でフィードバック取得

## Decision

### 方針: 構造化 Verdict スキーマ + フィードバック自動注入

#### 1. 構造化 Verdict スキーマ

Gate verdict API のフィードバックを構造化する:

```typescript
interface GateVerdict {
  decision: "approve" | "reject";
  feedback: {
    summary: string;                    // 1-2 文の要約
    items: GateFeedbackItem[];          // 個別の指摘事項
    previouslyRejected?: string[];      // 前回 reject で指摘済みの項目 ID
  };
}

interface GateFeedbackItem {
  id: string;                           // 一意識別子（重複検知用）
  category: "plan" | "code" | "test" | "style" | "security" | "performance";
  severity: "blocker" | "warning" | "suggestion";
  message: string;
  file?: string;                        // 対象ファイル（code-review 時）
  line?: number;                        // 対象行番号
}
```

#### 2. フィードバック蓄積と自動注入

reject 時のフィードバックを Ship の次回プロンプトに自動注入:

```typescript
// ship-manager.ts
function buildGateFeedbackContext(shipId: string): string {
  const history = db.getRecentGateVerdicts(shipId, { limit: 3 });
  if (history.length === 0) return "";

  return history.map(v =>
    `## Previous Gate Feedback (${v.gateType}, ${v.createdAt})\n` +
    v.feedback.items.map(item =>
      `- [${item.severity}] ${item.category}: ${item.message}`
    ).join("\n")
  ).join("\n\n");
}
```

Ship が gate phase から作業 phase に戻った際、`phase-transition-log` API のレスポンスに構造化フィードバックを含める。Ship のスキル（`/implement-code` 等）が自動的にこのフィードバックを読み取って修正に反映する。

#### 3. 連続 Reject エスカレーション

同一カテゴリの blocker が 2 回連続で reject された場合、Flagship にエスカレーション:

```typescript
// escort-manager.ts
function checkEscalation(shipId: string, verdict: GateVerdict): boolean {
  if (verdict.decision !== "reject") return false;

  const blockers = verdict.feedback.items.filter(i => i.severity === "blocker");
  const previous = db.getLastGateVerdict(shipId);
  if (!previous || previous.decision !== "reject") return false;

  const repeatedBlockers = blockers.filter(b =>
    previous.feedback.items.some(p => p.category === b.category && p.severity === "blocker")
  );

  return repeatedBlockers.length > 0;
}
```

### 検討した代替案

- **GitHub PR Review として記録**: 構造化は可能だが、gate phase は PR 作成前（plan-gate）にも存在。GitHub API 依存も増える
- **フィードバックを XState context に保持**: context が肥大化し、スナップショットサイズが増大。DB 側で管理する方が適切
- **フィードバックなし（カウントのみ）の現状維持**: 繰り返しリジェクトの根本原因を解決しない

## Consequences

### Positive

- Ship が前回の reject 理由を構造的に把握でき、同じ問題の繰り返しが減少
- Flagship への自動エスカレーションにより、手動介入のタイミングが明確化
- Gate レビューの品質メトリクス（カテゴリ別 reject 率等）の収集が可能に
- Escort スキルのレビュー観点が標準化され、レビュー品質のばらつきが減少

### Negative

- Escort スキル（`/planning-gate`, `/implementing-gate`, `/acceptance-test-gate`）の出力形式変更が必要
- 構造化スキーマの維持コスト（新しいカテゴリ追加時に更新）
- フィードバック自動注入による Ship のコンテキスト消費量増加

### Migration Strategy

1. Gate verdict API に新スキーマを追加（旧形式も受け付ける後方互換）
2. Escort スキルを更新して構造化フィードバックを出力
3. Ship スキルを更新してフィードバック自動読み取りを実装
4. エスカレーションロジックを追加
