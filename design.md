# Infinite Radar — design.md

出典: https://www.sokosumi.com/tools/design-md/analysis/flightradar24 （Flightradar24 の design.md 解析）。
トークンは `public/styles.css` の `:root` にそのまま定義している。**パレット外の色・独自の影・ハードコードした余白は使わない。**

## Colors

| Token | Hex | 用途 |
|---|---|---|
| surface | `#f8f8f8` | アプリ背景 |
| surface-bright | `#ffffff` | パネル・カード・入力 |
| surface-container | `#fafafa` | チップ |
| surface-container-low | `#f5f5f5` | 統計タイル |
| surface-container-high | `#e5e5e5` | hover / progress track |
| on-surface | `#303030` | 本文 |
| on-surface-variant | `#a4a1a1` | 補助テキスト・ラベル |
| outline | `#a3a3a3` | 地上の機体 |
| outline-variant | `#d0d0d0` | 罫線 |
| primary | `#64bef1` | 操作要素・地図ハイライト・飛行済み航跡 |
| primary-container | `#e0f2f9` | 選択チップ背景、tertiary ボタン hover |
| on-primary-container | `#1a4d5f` | （ダーク UI ではバッジ背景） |
| inverse-primary | `#327db6` | ボタン hover |
| secondary | `#f8c023` | **プレミアム/アップグレード CTA 専用**（一般 UI では使わない） |
| tertiary | `#ff3e5f` | エラー・重大アラート専用 |
| error | `#d73737` | エラー |
| inverse-surface | `#222121` | ツールチップ |

### 地図まわりの適用（FR24 を参考に調整）

FR24 本体の見た目に寄せ、UI も地図も暗いトーンにしている。色そのものは上のパレットから取る。

- UI（上部バー・パネル・検索・ズームボタン）: inverse-surface `#222121` を基調にしたダーク。本文 `#f8f8f8`、補助 `#a4a1a1`
- 地図: Esri World Dark Gray Base + Reference（キー不要、z16 まで同じ地図）。ズーム中はタイルを更新しない（`updateWhenZooming: false`）
- 空港ピン: 規模 3 段階（周波数の数・ボーディングブリッジ有無から算出）。大 = primary `#64bef1`、中 = primary-fixed-dim `#a8d4e8`、小 = outline `#a3a3a3`。ズームに応じて表示とコード表記を増やす
- ATC が開いている空港: 追加色 atc `#4cd07d`（パレットに緑が無いため、「オンライン」を示す用途に限って追加）。ズームに関係なく緑のピンを出し、空港コードと周波数の頭文字（I ATIS · C Clearance · G Ground · T Tower · D Departure · A Approach）を緑枠のラベルで添える。ラベルは機体に隠れないよう最前面
- 機体: secondary `#f8c023` に `#303030` の縁取り。地上は secondary-fixed-dim `#f5d87d`、**選択中は tertiary `#ff3e5f`**
- 飛行済み航跡: tertiary の実線（暗い縁取り付き）。残りの計画: outline-variant `#d0d0d0` の破線
- 選択中のサーバーチップ・空港コード・進捗バー: secondary（機体色と揃える）
- 元の design.md の「secondary はプレミアム CTA 専用」「tertiary はエラー専用」は、FR24 本体の地図表現に合わせるため、地図と機体の表現に限って緩めている

## Typography — Open Sans のみ

| Style | Size / LH | Weight | Tracking |
|---|---|---|---|
| title-lg | 20 / 28 | 600 | 0 |
| body-md | 16 / 24 | 400 | 0.01em |
| label-md | 14 / 20 | 600 | 0.01em |
| label-sm | 12 / 16 | 500 | 0.02em |

操作ラベルは 600、受動的なテキストは 400。数値は `font-variant-numeric: tabular-nums`。

## Spacing / Radius / Elevation

- Spacing（8px ベース）: xs 4 · sm 12 · md 24 · lg 40 · xl 64
- Radius: sm 4 · DEFAULT 8（入力） · md 12（リスト項目） · lg 16（カード・パネル） · full（ボタン・バッジ・チップ）
- Elevation: sm `0 1px 2px rgba(0,0,0,.06)` · md `0 3px 8px rgba(0,0,0,.15)`（カード） · lg `0 8px 24px rgba(0,0,0,.12)`（ドロップダウン・ポップオーバー）
- トランジションは 150–200ms ease-in-out。フォーカスは 2px アウトラインではなく primary 10% の 3px グロー。

## Layout

- 地図が主役（デスクトップで幅の 60–70% 以上）。フライト詳細は左のフローティングパネル（360px）、モバイルでは下からのボトムシート。
- 上部バー 56px: ロゴ / サーバー切替チップ / 検索 / 機数・UTC 時計。
- 地図の右上に「Filters」「ATC」のピル型ボタン。押すと下に 340px のポップオーバー（モバイルは横幅いっぱい）。
  - Filters: 飛行中/地上、高度範囲、機種、リバリー、VA/VO、空港（飛行計画の出発・到着）、空港ピンの表示（全部 / ATC のみ / なし）。条件はブラウザに保存し、機数バッジは「表示数 / 全体」になる。選択中の機体は条件外でも消さない
  - ATC: 管制中の空港とセンターの一覧（周波数・管制官・経過時間・到着/出発数）。行を押すとその空港へ移動、「Flights」でその空港の発着便だけに絞り込む

## Performance rules

- フライト一覧はサーバーで列を絞った配列形式に変換し gzip で返す（Expert 4,500 機で 2.3MB → gzip 約 240KB）。
- 機体と空港ピンは 1 枚の canvas にスプライトで描画（DOM マーカーは使わない）。canvas は地図ペイン内に置き、ズームアニメーション中はタイルと同じ CSS 変形で追従させる。ポーリング間はデッドレコニングで滑らかに補間。
- タブが非表示の間はポーリングを止める。
- ATC と空港ごとの発着数（/atc・/world）は 30 秒ごと。/world の便 ID 一覧（約 400KB）はサーバー内だけで持ち、空港フィルターのときにその空港の分だけ返す。
- 写真は IFSpotters の公開 API を機種名 + リバリー名の完全一致で照合し、見つからなければ “No images”。
