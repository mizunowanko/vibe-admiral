---
name: run
description: Engine と Frontend を起動する。"/run", "起動して", "動かして" などで起動。
user-invocable: true
---

# vibe-admiral 起動スキル

Engine（WebSocket サーバー）と Frontend（Vite dev server）をバックグラウンドで起動する。

## 手順

### 1. ポートマネージャーからポートを割り当てる

```bash
curl -s http://127.0.0.1:53100/status
```

- 接続不可 → デフォルトポート（Engine: 9721, Vite: 1420）を使用する
- 接続可 → 2つのポートを割り当てる:

```bash
ENGINE_PORT=$(curl -s -X POST http://127.0.0.1:53100/allocate | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).port))")
VITE_PORT=$(curl -s -X POST http://127.0.0.1:53100/allocate | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).port))")
```

### 2. Engine を起動する

`run_in_background: true` で実行:

```bash
ENGINE_PORT=<allocated> npx tsx engine/src/index.ts
```

起動ログに `Engine WebSocket server running on port <port>` が出ることを確認。

### 3. Frontend を起動する

`run_in_background: true` で実行。`VITE_ENGINE_PORT` を Engine のポートに合わせる:

```bash
VITE_PORT=<allocated> VITE_ENGINE_PORT=<engine_port> npm run dev
```

### 4. ブラウザを開く

```bash
open http://localhost:<vite_port>
```

### 5. 起動結果を報告

割り当てたポートをユーザーに伝える:
- Frontend: `http://localhost:<vite_port>`
- Engine: `ws://localhost:<engine_port>`

## トラブルシューティング

- ポートが使用中の場合:
  ```bash
  lsof -ti:<port> | xargs kill
  ```
- Engine のビルドエラー: `cd engine && npx tsc --noEmit` で型チェック
- Frontend のビルドエラー: `npx tsc --noEmit` で型チェック
