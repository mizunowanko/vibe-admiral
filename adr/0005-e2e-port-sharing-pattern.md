# ADR-0005: E2E Config の webServer と globalSetup 間のポート共有パターン

- **Status**: Accepted
- **Date**: 2026-03-23
- **Issue**: [#547](https://github.com/mizunowanko-org/vibe-admiral/issues/547)
- **Tags**: testing, e2e, playwright, port-management

## Context

Playwright の E2E テストでは、テスト対象のサーバー（Vite dev server, Engine）を起動する方法として以下の 2 つがある:

1. **`webServer` config** — `playwright.config.ts` の `webServer` フィールドでプロセス起動を宣言
2. **`globalSetup`** — セットアップ関数内でプロセスを手動 spawn

### 問題: config → globalSetup の評価順序

Playwright は以下の順序で処理を実行する:

```
1. playwright.config.ts を評価（同期的にポート値を読み取り）
2. globalSetup() を実行
3. webServer で指定されたプロセスを起動
4. テスト実行
```

`webServer.env` にポートを渡すには **config 評価時点で値が確定している必要がある**。
しかし `globalSetup` は config 評価後に実行されるため、globalSetup で動的に取得したポートを `webServer.env` に渡すことができない。

### 実際の問題

Ship #516 (Playwright E2E テスト基盤の構築) で、UI テストの Mock Engine がハードコードされたポート 9721 を使用しており、本番 Admiral が起動中だとポートが競合して `EADDRINUSE` が発生した。

E2E テストも同様に、ハードコードされた Engine ポート 9821 / Vite ポート 1520 を使用しており、複数の E2E テスト実行が並行した場合や、他のプロセスがこれらのポートを使用中の場合にポート競合のリスクがあった。

## Decision

**globalSetup 内でプロセスを直接 spawn し、OS に動的ポートを割り当てさせるパターンを標準とする。** Playwright config の `webServer` は使用しない。

### パターン詳細

```typescript
// test-utils/port-helpers.ts — 共通ユーティリティ

// 1. OS にポートを割り当てさせる（port 0 → auto-assign）
export async function getAvailablePort(envVar?: string): Promise<number> {
  // 環境変数が指定されていればそれを優先（CI で固定ポート使用を可能に）
  if (envVar && process.env[envVar]) {
    return parseInt(process.env[envVar]!, 10);
  }
  // OS に空きポートを選ばせる
  const server = net.createServer();
  server.listen(0, () => { /* addr.port を取得 */ });
}

// 2. ポートが受付可能になるまでポーリング
export function waitForPort(port: number, timeoutMs?: number): Promise<void>;
```

```typescript
// globalSetup.ts
export default async function globalSetup() {
  const enginePort = await getAvailablePort("E2E_ENGINE_PORT");
  const vitePort = await getAvailablePort("E2E_VITE_PORT");

  // プロセスを spawn して waitForPort で待機
  const engineProcess = spawn(..., { env: { ENGINE_PORT: String(enginePort) } });
  await waitForPort(enginePort);

  const viteProcess = spawn("npx", ["vite", "--port", String(vitePort)], ...);
  await waitForPort(vitePort);

  // globalThis に保存（teardown 用）
  (globalThis as Record<string, unknown>).__context = { engineProcess, viteProcess };

  // process.env 経由でテストファイルにポートを伝搬
  process.env.E2E_ENGINE_PORT = String(enginePort);
  process.env.E2E_VITE_PORT = String(vitePort);
}
```

```typescript
// playwright.config.ts — webServer は使わない
export default defineConfig({
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  // use.baseURL は fixtures で動的に設定
});

// fixtures.ts — baseURL を動的に注入
export const test = base.extend<{ vitePort: number }>({
  vitePort: async ({}, use) => {
    await use(parseInt(process.env.E2E_VITE_PORT ?? "1420", 10));
  },
  baseURL: async ({ vitePort }, use) => {
    await use(`http://localhost:${vitePort}`);
  },
});
```

### 環境変数によるオーバーライド

`getAvailablePort("E2E_ENGINE_PORT")` のように環境変数名を渡すと、環境変数が設定されていればその値を使用する。これにより:
- **ローカル開発**: 環境変数未設定 → OS が動的に割り当て → ポート競合なし
- **CI / 特定環境**: `E2E_ENGINE_PORT=9821` 等で固定ポートを指定可能

### 代替案と却下理由

| 代替案 | 却下理由 |
|--------|----------|
| `webServer` config + ハードコードポート | ポート競合の可能性。ローカルで本番アプリと同時実行不可 |
| `webServer` config + `.env` ファイル | config 評価前に `.env` をセットする追加スクリプトが必要。複雑化 |
| `webServer` config + `process.env` のみ | globalSetup の動的ポートを config に渡せない（評価順序問題） |
| テスト実行前に空きポートを確認するスクリプト | TOCTOU 競合（確認後〜使用前に他プロセスがポートを奪う可能性） |

## Consequences

### Positive

- **ポート競合の完全解消**: OS が未使用ポートを動的に割り当てるため、本番アプリやその他のプロセスとの競合が発生しない
- **並行テスト実行対応**: 複数の Playwright 実行が同時に走っても各々が異なるポートを取得
- **パターンの統一**: UI テストと E2E テストが同じ `test-utils/port-helpers.ts` を共有し、一貫したポート管理戦略を使用
- **CI 互換性**: 環境変数オーバーライドにより、CI で固定ポートが必要な場合にも対応可能

### Negative

- **Playwright `webServer` 機能の不使用**: Playwright の組み込み機能（プロセスライフサイクル管理、URL ベースの readiness check）を利用できない。代わりに globalSetup/globalTeardown でプロセス管理を自前実装する必要がある
- **globalThis 経由のプロセス受け渡し**: globalSetup → globalTeardown 間でプロセス参照を `globalThis` に保存する必要がある（Playwright の仕様制約）
