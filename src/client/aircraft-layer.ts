import L from 'leaflet';
import { ATC_TYPES, extrapolate, isOnGround, type AirportPin, type AtcStation, type Flight } from './data';

/**
 * 全機体と空港ピンを 1 枚の canvas に描く Leaflet レイヤー。
 * DOM マーカーを数千個置くと重くなるので、描画も当たり判定もここで完結させる。
 *
 * canvas は地図ペインの中に置き、ズームアニメーション中はタイルと同じ CSS 変形で
 * 拡大縮小させる（Leaflet 標準の Canvas レンダラーと同じ方式）。これで拡大縮小の
 * 間も機体がタイルに張り付いたまま動く。
 */

const PLANE_PATH = 'M12 2l1.8 6.6 7.2 3v2l-7.2-1.5-.7 4.8 2.2 1.9V20l-3.3-1.1L8.7 20v-1.2l2.2-1.9-.7-4.8L3 13.6v-2l7.2-3z';
const PIN_PATH = 'M12 1.5a7 7 0 0 0-7 7c0 5.2 7 14 7 14s7-8.8 7-14a7 7 0 0 0-7-7z';
const SPRITE_PX = 64;

// FR24 を参考に、黄色の機体に暗い縁取り。地上はやや淡く、選択中は赤
const COLORS = {
  air: '#f8c023',
  ground: '#f5d87d',
  selected: '#ff3e5f',
  halo: 'rgba(255, 62, 95, 0.28)',
  stroke: '#1b1a1a',
  pinMajor: '#64bef1',
  pinRegional: '#a8d4e8',
  pinLocal: '#a3a3a3',
  atc: '#4cd07d',
  atcPill: 'rgba(27, 26, 26, 0.92)',
  label: '#f8f8f8',
  labelHalo: 'rgba(0, 0, 0, 0.85)'
};

function makeSprite(pathData: string, fill: string, lineWidth: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SPRITE_PX;
  const ctx = canvas.getContext('2d')!;
  const path = new Path2D(pathData);
  ctx.scale(SPRITE_PX / 24, SPRITE_PX / 24);
  ctx.lineJoin = 'round';
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = COLORS.stroke;
  ctx.stroke(path);
  ctx.fillStyle = fill;
  ctx.fill(path);
  if (pathData === PIN_PATH) {
    ctx.beginPath();
    ctx.arc(12, 8.5, 2.6, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.stroke;
    ctx.fill();
  }
  return canvas;
}

function planeSize(zoom: number): number {
  if (zoom < 3) return 15;
  if (zoom < 5) return 19;
  if (zoom < 8) return 23;
  return 27;
}

/** 空港の規模（サーバーで算出した 0〜3）ごとに、ピンとラベルを出し始めるズーム。 */
function airportTier(cls: number): { pinZoom: number; labelZoom: number; size: number; sprite: 'major' | 'regional' | 'local' } {
  if (cls >= 3) return { pinZoom: 3, labelZoom: 5, size: 16, sprite: 'major' };
  if (cls === 2) return { pinZoom: 5, labelZoom: 7, size: 14, sprite: 'regional' };
  if (cls === 1) return { pinZoom: 6.5, labelZoom: 9, size: 13, sprite: 'local' };
  return { pinZoom: 7.5, labelZoom: 10, size: 12, sprite: 'local' };
}

export type AirportMode = 'all' | 'atc' | 'none';

type Hit<T> = { items: T[]; xs: Float32Array; ys: Float32Array; count: number };

function hitBuffer<T>(): Hit<T> {
  return { items: [], xs: new Float32Array(256), ys: new Float32Array(256), count: 0 };
}

function pushHit<T>(hit: Hit<T>, item: T, x: number, y: number): void {
  if (hit.count >= hit.xs.length) {
    const xs = new Float32Array(hit.xs.length * 2);
    const ys = new Float32Array(hit.ys.length * 2);
    xs.set(hit.xs);
    ys.set(hit.ys);
    hit.xs = xs;
    hit.ys = ys;
  }
  hit.items[hit.count] = item;
  hit.xs[hit.count] = x;
  hit.ys[hit.count] = y;
  hit.count++;
}

function nearest<T>(hit: Hit<T>, x: number, y: number, radius: number): T | null {
  let best: T | null = null;
  let bestD = radius * radius;
  for (let i = 0; i < hit.count; i++) {
    const dx = hit.xs[i] - x;
    const dy = hit.ys[i] - y;
    const d = dx * dx + dy * dy;
    if (d <= bestD) {
      bestD = d;
      best = hit.items[i];
    }
  }
  return best;
}

/** 置いたラベルの矩形。重なるラベルは描かない（密集地で文字が潰れて読めなくなるのを防ぐ） */
class LabelBoxes {
  private boxes: number[] = [];
  clear(): void {
    this.boxes.length = 0;
  }
  /** 空いていれば確保して true、ほかのラベルと重なるなら false。 */
  claim(x: number, y: number, w: number, h: number): boolean {
    const b = this.boxes;
    for (let i = 0; i < b.length; i += 4) {
      if (x < b[i] + b[i + 2] && x + w > b[i] && y < b[i + 1] + b[i + 3] && y + h > b[i + 1]) return false;
    }
    b.push(x, y, w, h);
    return true;
  }
}

type MapInternals = L.Map & {
  _animatingZoom?: boolean;
  _getNewPixelOrigin(center: L.LatLng, zoom: number): L.Point;
};

export class AircraftLayer extends L.Layer {
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private sprites = {
    air: makeSprite(PLANE_PATH, COLORS.air, 1.1),
    ground: makeSprite(PLANE_PATH, COLORS.ground, 1.1),
    selected: makeSprite(PLANE_PATH, COLORS.selected, 1.1),
    major: makeSprite(PIN_PATH, COLORS.pinMajor, 1.4),
    regional: makeSprite(PIN_PATH, COLORS.pinRegional, 1.4),
    local: makeSprite(PIN_PATH, COLORS.pinLocal, 1.4),
    atc: makeSprite(PIN_PATH, COLORS.atc, 1.4)
  };
  private flights: Flight[] = [];
  private airports: AirportPin[] = [];
  private airportByIcao = new Map<string, AirportPin>();
  private atc: AtcStation[] = [];
  private atcIcaos = new Set<string>();
  private airportMode: AirportMode = 'all';
  private planeHits = hitBuffer<Flight>();
  private airportHits = hitBuffer<AirportPin>();
  private frame = 0;
  private labelBoxes = new LabelBoxes();
  private dpr = 1;
  private width = 0;
  private height = 0;
  /** 最後に描いた時点の中心とズーム（ズームアニメーションの変形計算に使う） */
  private drawnCenter: L.LatLng | null = null;
  private drawnZoom = 0;

  selectedId: string | null = null;
  /** 推定位置のキャッシュ（パネル表示と描画で同じ値を使う） */
  readonly positions = new Map<string, [number, number]>();

  onAdd(map: L.Map): this {
    const pane = map.getPane('aircraft') ?? map.createPane('aircraft');
    pane.style.zIndex = '450';
    pane.style.pointerEvents = 'none';
    this.canvas = L.DomUtil.create('canvas', 'aircraft-canvas leaflet-zoom-animated', pane);
    this.ctx = this.canvas.getContext('2d')!;
    map.on('move zoom resize viewreset moveend zoomend', this.redraw, this);
    map.on('zoomanim', this.animateZoom, this);
    this.redraw();
    return this;
  }

  onRemove(map: L.Map): this {
    map.off('move zoom resize viewreset moveend zoomend', this.redraw, this);
    map.off('zoomanim', this.animateZoom, this);
    this.canvas.remove();
    // 0 に戻しておかないと、地図へ戻したときに redraw() が予約済みと見なして描かない
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    return this;
  }

  setFlights(flights: Flight[]): void {
    this.flights = flights;
    this.redraw();
  }

  setAirports(airports: AirportPin[]): void {
    this.airports = airports;
    this.airportByIcao = new Map(airports.map((a) => [a.icao, a]));
    this.redraw();
  }

  setAtc(stations: AtcStation[]): void {
    this.atc = stations;
    this.atcIcaos = new Set(stations.map((s) => s.icao));
    this.redraw();
  }

  setAirportMode(mode: AirportMode): void {
    this.airportMode = mode;
    this.redraw();
  }

  /** ICAO から空港ピンを引く（一覧に無い空港は ATC の座標から作る）。 */
  airport(icao: string): AirportPin | null {
    const pin = this.airportByIcao.get(icao);
    if (pin) return pin;
    const station = this.atc.find((s) => s.icao === icao);
    return station ? { icao, iata: '', name: icao, lat: station.lat, lon: station.lon, cls: 3 } : null;
  }

  /** 次のアニメーションフレームで 1 回だけ描き直す。 */
  redraw(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  /** 画面座標 (コンテナ基準) に最も近い機体を返す。 */
  hitTest(x: number, y: number, radius = 14): Flight | null {
    return nearest(this.planeHits, x, y, radius);
  }

  hitTestAirport(x: number, y: number, radius = 12): AirportPin | null {
    // ピンは先端が座標なので、少し上を中心として判定する
    return nearest(this.airportHits, x, y + 8, radius);
  }

  /** ズームアニメーション開始時に、canvas をタイルと同じ変形で拡大縮小させる。 */
  private animateZoom(event: L.ZoomAnimEvent): void {
    const map = this._map as MapInternals;
    if (!this.drawnCenter) return;
    const scale = map.getZoomScale(event.zoom, this.drawnZoom);
    const viewHalf = map.getSize().multiplyBy(0.5);
    const offset = viewHalf
      .multiplyBy(-scale)
      .add(map.project(this.drawnCenter, event.zoom))
      .subtract(map._getNewPixelOrigin(event.center, event.zoom));
    L.DomUtil.setTransform(this.canvas, offset, scale);
  }

  private resize(): void {
    const size = this._map.getSize();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (size.x === this.width && size.y === this.height && dpr === this.dpr) return;
    this.width = size.x;
    this.height = size.y;
    this.dpr = dpr;
    this.canvas.width = Math.round(size.x * dpr);
    this.canvas.height = Math.round(size.y * dpr);
    this.canvas.style.width = `${size.x}px`;
    this.canvas.style.height = `${size.y}px`;
  }

  private draw(): void {
    const map = this._map as MapInternals;
    if (!map) return;
    // アニメーション中に描き直すと CSS 変形とずれるので、zoomend を待つ
    if (map._animatingZoom) return;
    this.resize();

    // canvas の左上を画面の左上に合わせる（地図ペインの座標系で配置）
    L.DomUtil.setPosition(this.canvas, map.containerPointToLayerPoint([0, 0]));
    this.drawnCenter = map.getCenter();
    this.drawnZoom = map.getZoom();

    const { ctx, dpr, width, height } = this;
    const zoom = map.getZoom();
    const pad = 24;
    // 低ズームでは世界が横に複数並ぶので、ずらした複製も描く
    const worldWidth = map.getPixelWorldBounds()?.getSize().x ?? 0;
    const shifts = worldWidth > 0 ? [-worldWidth, 0, worldWidth] : [0];
    const inView = (x: number, y: number) => x >= -pad && x <= width + pad && y >= -pad && y <= height + pad;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.planeHits.count = 0;
    this.airportHits.count = 0;

    // ---- 空港ピン（機体の下） ----
    const labels: Array<[string, number, number]> = [];
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const a of this.airportMode === 'all' ? this.airports : []) {
      if (this.atcIcaos.has(a.icao)) continue; // ATC のある空港は後で緑のピンとして描く
      const tier = airportTier(a.cls);
      if (zoom < tier.pinZoom) continue;
      const p = map.latLngToContainerPoint([a.lat, a.lon]);
      for (const shift of shifts) {
        const x = p.x + shift;
        if (!inView(x, p.y)) continue;
        const s = tier.size;
        ctx.drawImage(this.sprites[tier.sprite], x - s / 2, p.y - s + 1, s, s);
        pushHit(this.airportHits, a, x, p.y - s / 2);
        if (zoom >= tier.labelZoom) labels.push([a.iata || a.icao, x, p.y]);
      }
    }
    // ---- ATC のある空港（全ズームで表示）。ラベルは機体に隠れないよう最後に描く ----
    const atcLabels: Array<[AtcStation, AirportPin, number, number]> = [];
    if (this.airportMode !== 'none') {
      const s = 18;
      for (const station of this.atc) {
        const a = this.airport(station.icao);
        if (!a) continue;
        const p = map.latLngToContainerPoint([a.lat, a.lon]);
        for (const shift of shifts) {
          const x = p.x + shift;
          if (!inView(x, p.y)) continue;
          ctx.drawImage(this.sprites.atc, x - s / 2, p.y - s + 1, s, s);
          pushHit(this.airportHits, a, x, p.y - s / 2);
          atcLabels.push([station, a, x, p.y]);
        }
      }
    }

    this.labelBoxes.clear();
    // ATC のラベルを先に場所取りし、空港コードはその隙間にだけ出す
    const atcPlaced = this.layoutAtcLabels(atcLabels);
    if (labels.length) {
      ctx.font = '600 11px "Open Sans", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 3;
      ctx.strokeStyle = COLORS.labelHalo;
      ctx.fillStyle = COLORS.label;
      // 大きい空港から場所を取る（一覧は小さい順に並んでいる）
      for (let i = labels.length - 1; i >= 0; i--) {
        const [text, x, y] = labels[i];
        const w = ctx.measureText(text).width + 4;
        if (!this.labelBoxes.claim(x - w / 2, y + 2, w, 14)) continue;
        ctx.strokeText(text, x, y + 3);
        ctx.fillText(text, x, y + 3);
      }
    }

    // ---- 機体（地上 → 空中 → 選択中の順に重ねる） ----
    const now = performance.now();
    const size = planeSize(zoom);
    const half = size / 2;
    let selected: { f: Flight; x: number; y: number } | null = null;
    this.positions.clear();

    for (const pass of [0, 1] as const) {
      const sprite = pass === 0 ? this.sprites.ground : this.sprites.air;
      for (const f of this.flights) {
        if ((pass === 0) !== isOnGround(f)) continue;

        const [lat, lon] = extrapolate(f, now);
        this.positions.set(f.id, [lat, lon]);
        const p = map.latLngToContainerPoint([lat, lon]);

        for (const shift of shifts) {
          const x = p.x + shift;
          if (!inView(x, p.y)) continue;
          if (f.id === this.selectedId) {
            selected = { f, x, y: p.y };
          } else {
            const rad = (f.track * Math.PI) / 180;
            const cos = Math.cos(rad) * dpr;
            const sin = Math.sin(rad) * dpr;
            ctx.setTransform(cos, sin, -sin, cos, x * dpr, p.y * dpr);
            ctx.drawImage(sprite, -half, -half, size, size);
          }
          pushHit(this.planeHits, f, x, p.y);
        }
      }
    }

    if (atcPlaced.length) this.drawAtcLabels(atcPlaced);

    if (selected) {
      const s = size + 8;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.beginPath();
      ctx.arc(selected.x, selected.y, s * 0.75, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.halo;
      ctx.fill();
      const rad = (selected.f.track * Math.PI) / 180;
      const cos = Math.cos(rad) * dpr;
      const sin = Math.sin(rad) * dpr;
      ctx.setTransform(cos, sin, -sin, cos, selected.x * dpr, selected.y * dpr);
      ctx.drawImage(this.sprites.selected, -s / 2, -s / 2, s, s);
    }
  }

  /** ATC ラベルの置き場所を確保し、ほかと重ならないものだけを返す（周波数が多い空港を優先）。 */
  private layoutAtcLabels(labels: Array<[AtcStation, AirportPin, number, number]>): Array<[AtcStation, AirportPin, number, number]> {
    const { ctx } = this;
    ctx.font = '700 11px "Open Sans", system-ui, sans-serif';
    const placed: Array<[AtcStation, AirportPin, number, number]> = [];
    const ordered = [...labels].sort((a, b) => b[0].types.length - a[0].types.length);
    for (const item of ordered) {
      const [station, a, x, y] = item;
      const letters = station.types.map((t) => ATC_TYPES[t]?.short ?? '?').join(' ');
      const w = ctx.measureText(a.icao).width + 6 + ctx.measureText(letters).width + 14;
      if (this.labelBoxes.claim(x - w / 2, y + 3, w, 18)) placed.push(item);
    }
    return placed;
  }

  /** 空港コードと管制中の周波数の頭文字（I G T など）を緑の枠のラベルで描く。 */
  private drawAtcLabels(labels: Array<[AtcStation, AirportPin, number, number]>): void {
    const { ctx, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '700 11px "Open Sans", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.lineWidth = 1;
    for (const [station, a, x, y] of labels) {
      const code = a.icao;
      const letters = station.types.map((t) => ATC_TYPES[t]?.short ?? '?').join(' ');
      const codeW = ctx.measureText(code).width;
      const w = codeW + 6 + ctx.measureText(letters).width + 14;
      const left = x - w / 2;
      const top = y + 3;
      ctx.beginPath();
      ctx.roundRect(left, top, w, 18, 9);
      ctx.fillStyle = COLORS.atcPill;
      ctx.fill();
      ctx.strokeStyle = COLORS.atc;
      ctx.stroke();
      ctx.fillStyle = COLORS.label;
      ctx.fillText(code, left + 7, top + 9.5);
      ctx.fillStyle = COLORS.atc;
      ctx.fillText(letters, left + 7 + codeW + 6, top + 9.5);
    }
  }
}
