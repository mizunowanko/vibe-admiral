# ADR-0022: Engine の Parse-safe / Logger / エラー伝播 抽象の導入

- **Status**: Proposed
- **Date**: 2026-04-12
- **Issue**: [#938](https://github.com/mizunowanko/vibe-admiral/issues/938)（/audit-quality 監査枠）
- **Implementation Issue**: [#953](https://github.com/mizunowanko/vibe-admiral/issues/953)
- **Tags**: audit-quality, engine-stability, error-handling, observability

## Context

/audit-quality 監査（Issue #938）で、Engine 安定性カテゴリの再発バグ 7+ 件（#949 JSON.parse unguarded, #946 stderr chunk boundary, #948 curl -sf swallows 400, #690 WS handler missing crash, #754 crash log lost, #726 disconnect per sortie, #712 rate-limit retry leak, #716 appendFileSync block）を分析した結果、個別バグではなく **「parse・logger・error handling の抽象が存在せず、137 箇所以上にコピペ実装が散在している」** という共通構造が根本原因と特定された。

### 構造的問題（監査 Finding 2-1〜4-7）

**2-1. `JSON.parse` が 22 箇所に unguarded に散在**

- `db.ts:912` `metadata: row.metadata ? JSON.parse(row.metadata) : null` — 無防備（#949 の正体）
- `db.ts:1099` `actor_snapshot` は try/catch 済（ADR-0017 対応）→ **同じ DB 層で経路ごとに挙動が違う**
- `github.ts` 6 箇所すべて unguarded。`gh` CLI が非 JSON を返したら throw
- `ship-manager.ts:214` の PR parse も unguarded。`api-server.ts:188` だけ guarded — 一貫性皆無

**2-2. Logger 抽象なし**

`console.log/warn/error` 直書き 137 件。prefix（`[engine]`, `[supervisor]`, `[proc:${shortId}]`, `[actor]`）を手書きで付与。crash-logger は別実装で write 失敗が silent（#754 再発要因）。

**2-3. エラーハンドリング統一基準なし**

空 `catch {}` / `.catch(() => {})` / `console.warn` / re-throw が mixed。どの経路が user-visible エラーになるかの契約が曖昧（#712 の原因）。

**4-1. stderr が行指向でない（#946 根本原因）**

```ts
let stderrBuffer = "";
proc.stderr?.on("data", (chunk) => {
  stderrBuffer += chunk.toString();
  const text = stderrBuffer.trim();
  if (text) {
    if (isRetryableError(text)) emit("rate-limit");
    else emit("error", new Error(text));
    stderrBuffer = "";   // ← chunk 境界に関係なくリセット
  }
});
```

`rate_limit_error` 文字列が 2 チャンクに分断されると判定 miss → 残り半分は新バッファで再評価されず捨てられる → rate-limit が fatal error に誤分類（#712 の裏口）。

**4-2. WS `handleMessage` の async 未捕捉 rejection**

`unhandledRejection` → `writeCrashLog` → `process.exit(1)`（#690）。未知 `msg.type` の default 分岐を返していれば防げる。

**4-5. `sendMessage` / `sendToolResult` の silent failure**

stdin not writable → `return null`。呼び出し側が戻り値を見ないと送信失敗を検知できず、Flagship 回答が無言で消える。

## Decision

### 1. `util/json-safe.ts` に parse-safe ヘルパーを集約

```ts
export function parseJsonSafe<T>(
  raw: string | null | undefined,
  ctx: { source: string; fallback?: T; onError?: "null" | "throw" }
): T | null
```

- DB 層（`db.ts` の 22 箇所）、`github.ts`、`ship-manager.ts` の全 `JSON.parse` を置換。
- 失敗時のデフォルト動作は **`null` + logger.warn(ctx.source)**。corruption 1 行が Engine 全停止に波及する経路（`getPhaseTransitions` など）を遮断。
- ADR-0017 の actor_snapshot parse 既存実装はこのヘルパーへ合流。

### 2. `Logger` 抽象を導入

```ts
interface Logger {
  debug/info/warn/error(msg: string, meta?: object): void;
  child(prefix: string): Logger;
}
```

- 全モジュールで `logger.child("supervisor")` のようにコンテキスト付与。`console.*` 直書きは lint で禁止。
- crash-logger は Logger の transport として統合。write 失敗時は自動で stderr fallback（#754 撲滅）。
- 構造化ログ（JSON）を dev console には pretty、production には stream-json で出す二重 transport。

### 3. stderr を line-oriented buffer に統一

`process-manager.ts` の stderr 処理を stdout と同じ `\n` split + 残り保持パターンに統一。rate-limit / error 判定は **line 単位** で行い、行が完全になるまで判定しない。

### 4. WS `handleMessage` に top-level guard

- 全 handler を `Promise.resolve(handler(msg)).catch(err => ...)` でラップ。
- 未知 `msg.type` は `{ type: "error", code: "UNKNOWN_MESSAGE_TYPE" }` を明示的に返す。
- `unhandledRejection` 経由での crash 経路を閉じる（#690 撲滅）。

### 5. `sendMessage` / `sendToolResult` を Result 型化

```ts
type SendResult = { ok: true } | { ok: false; reason: "not-writable" | "queued-full" | "serialize-error" }
```

呼び出し側は `if (!res.ok)` で検知し、Flagship では user-visible エラーとして表示。silent null return を禁止。

### 6. 一貫性統制として lint + review ルール

- `no-restricted-syntax` で `JSON.parse` と `console.log/warn/error` 直書きを禁止（既存は段階的リプレース）。
- ADR-0015（typesafe messaging）の補完として、Supervisor IPC 側の `as` キャストも discriminated union の guard 関数に移行（範囲拡張）。

### 代替案と却下理由

- **「個別 fix のみ」**: #949/#946/#712 を 1 件ずつ直しても、次に追加される `JSON.parse` / `catch` で同系バグが再発するため却下。
- **「ADR-0016 (Supervisor) の範囲内で処理」**: エラー抽象は Supervisor 固有ではなく Engine 全体の横断関心事のため、独立 ADR にする。
- **「Winston 等の既存ロガーライブラリ採用」**: 依存追加のコストと、現状の軽量な crash-logger と混在する移行工数が合わないため、最小限の自前 Logger 抽象に留める。

## Consequences

### Positive

- 1 行の corrupt で Engine 全停止する経路が構造的に消滅（#949）。
- stderr の rate-limit 誤分類（#946, #712）が根本解決。
- crash-logger write 失敗時の観測不能状態（#754）を排除。
- 未知 WS message による crash（#690）を排除。
- Flagship の返信消失（#sendMessage silent null）を検知可能に。
- 将来バグ調査の可観測性が構造的に向上。

### Negative

- 既存 137+ 箇所の置換が必要。段階的 PR で 3〜4 本に分割:
  1. Logger 抽象導入（既存 `console.*` と併存可能）
  2. parse-safe 導入 + DB 層 22 箇所置換
  3. stderr line buffer + WS top-level guard + Result 型化
- `as` キャスト削減の supervisor IPC 型化は別 ADR 候補（本 ADR 本体からは範囲外、ADR-0015 の延長として別途）。

### Migration Plan

- Phase 1: `util/logger.ts` + `util/json-safe.ts` を追加（既存 `console.*` と併存）
- Phase 2: `db.ts` / `github.ts` / `ship-manager.ts` の parse 全置換。actor_snapshot の既存 try/catch も合流
- Phase 3: `process-manager.ts` stderr を line buffer に改修。併せて `sendMessage`/`sendToolResult` を Result 型化
- Phase 4: WS `handleMessage` top-level guard。`no-restricted-syntax` lint 追加で回帰防止
