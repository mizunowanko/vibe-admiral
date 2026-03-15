---
name: run
description: Engine と Frontend を起動する。"/run", "起動して", "動かして" などで起動。
user-invocable: true
---

# vibe-admiral 起動スキル

Engine（WebSocket サーバー）と Frontend（Vite dev server）をバックグラウンドで起動する。

## 手順

### 1. 空きポートを動的に割り当てる

```bash
ENGINE_PORT=$(node -e "const s=require('net').createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})")
VITE_PORT=$(node -e "const s=require('net').createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})")
```

### 2. Engine を起動する

`run_in_background: true` で実行:

```bash
ENGINE_PORT=$ENGINE_PORT npx tsx engine/src/index.ts
```

起動ログに `Engine WebSocket server running on port $ENGINE_PORT` が出ることを確認。

### 3. Frontend を起動する

`run_in_background: true` で実行。`VITE_ENGINE_PORT` を Engine のポートに合わせる:

```bash
VITE_PORT=$VITE_PORT VITE_ENGINE_PORT=$ENGINE_PORT npm run dev
```

### 4. ブラウザを開く

```bash
open http://localhost:$VITE_PORT
```

### 5. 起動結果を報告

割り当てたポートをユーザーに伝える:
- Frontend: `http://localhost:$VITE_PORT`
- Engine: `ws://localhost:$ENGINE_PORT`

## トラブルシューティング

- ポートが使用中の場合:
  ```bash
  lsof -ti:<port> | xargs kill
  ```
- Engine のビルドエラー: `cd engine && npx tsc --noEmit` で型チェック
- Frontend のビルドエラー: `npx tsc --noEmit` で型チェック
