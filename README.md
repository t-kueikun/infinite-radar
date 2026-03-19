# Infinite Radar (Infinite Flight Live API)

Infinite Flight Live API を使った、ReactベースのFR24ライクなリアルタイムフライトマップです。

## セットアップ

```bash
cp .env.example .env.local
# .env.local に INFINITE_FLIGHT_API_KEY を設定
npm install
npm run dev
```

起動後: [http://localhost:3000](http://localhost:3000)

- 本番起動: `npm run start`（`prestart` でTypeScriptをビルド）

## 実装内容

- `express` サーバーで API キーを秘匿してプロキシ
- `React + Leaflet` ベースのフライトマップ（FR24風レイアウト + 右サイドパネル）
- セッション選択 (`/sessions`)
- フライト一覧ポーリング (`/sessions/{sessionId}/flights`)
- 選択機体のルート描画 (`/sessions/{sessionId}/flights/{flightId}/route`)
- 15分無操作で更新停止し、ユーザー操作で再開
- 高負荷対策として `canvas circleMarker` 描画を採用

## API 参照（指定リンク）

- Infinite Flight Live API Overview:
  - https://infiniteflight.com/guide/developer-reference/live-api/overview
- Infinite Flight Community / API カテゴリ:
  - https://community.infiniteflight.com/c/thirdparty/api/40

今回の実装で反映した仕様（抜粋）:

- 認証ヘッダー: `Authorization: Bearer <apikey>`
  - 出典: Live API Overview
- セッションの注意点: "The Sessions endpoint currently has a timeout of 15 minutes if no API calls are made."
  - 出典: Live API docs (`/sessions`)

## 主要ファイル

- `src/server.ts`: APIプロキシ + 静的配信
- `public/index.html`: Reactマウント用の最小エントリ
- `public/styles.css`: FR24風スタイル
- `src/client/main.tsx`: React UI、セッション読込、ポーリング、地図描画、検索、アイドル停止制御
- `public/app.js`: 上記TSから生成されるクライアントJS

## 補足

FR24「完全コピー」ではなく、機能・情報設計を寄せたUIです（ロゴや固有アセットは未使用）。
# infinite-radar
