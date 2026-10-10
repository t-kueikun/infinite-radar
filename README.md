# IFSpotters Radar

Infinite Flight Live API を使った軽量なライブフライトトラッカー。デザインは [design.md](design.md)（Flightradar24 の design.md 解析に準拠）。

## セットアップ

```bash
# .env.local
INFINITE_FLIGHT_API_KEY=xxxx
# 任意: 写真の照合先（既定 https://ifspotters.com）
# IFSPOTTERS_BASE_URL=https://ifspotters.com

npm install
npm run dev      # http://localhost:3000
npm run build    # public/app.js と dist/server.js を生成
```

## 構成

| ファイル | 役割 |
|---|---|
| `src/server.ts` | Express。API キーを秘匿したプロキシ、短命キャッシュ、フライト一覧の圧縮、IFSpotters 照合 |
| `src/client/main.ts` | 地図（Leaflet）、ポーリング、選択・追従、検索 |
| `src/client/aircraft-layer.ts` | 全機体を 1 枚の canvas に描画するレイヤー（当たり判定込み） |
| `src/client/panel.ts` | フライト詳細パネル（写真・ルート・統計・高度プロファイル） |
| `src/client/data.ts` | API 型、デッドレコニング、距離計算、フォーマット |

## API

- `GET /api/sessions` — サーバー一覧
- `GET /api/flights?sessionId=` — 全機体（列を絞った配列形式。`types` に機種/リバリー名を重複排除）
- `GET /api/flights/:id?sessionId=` — 飛行計画・出発/到着空港・航跡
- `GET /api/photos?aircraft=&livery=` — IFSpotters の承認済み写真（機種名 + リバリー名の完全一致）

## 軽量化のポイント

- フライト一覧: Expert 約 4,500 機で生 JSON 2.3MB → gzip 約 240KB（列の削減・UUID の短縮・名前の重複排除）
- クライアント JS: 1.3MB（MapLibre + React）→ 173KB / gzip 52KB（Leaflet + 素の TypeScript）
- DOM マーカーを使わず canvas 1 枚に描画。ポーリング間は速度と針路で位置を補間
- タブ非表示中はポーリング停止。上流 API への同時リクエストはサーバー側で 1 本にまとめる
