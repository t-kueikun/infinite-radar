import type * as MapLibre from 'maplibre-gl';

/**
 * フライト統計用の地球儀（MapLibre の globe 投影）。
 *
 * ライブの地図は軽さ優先で Leaflet のままにし、MapLibre（gzip 約 280KB）は統計を開いたときに
 * 初めて読み込む。タイルはライブの地図と同じ Esri Dark Gray を使う。
 */

type ML = typeof MapLibre;

declare global {
  interface Window {
    maplibregl?: ML;
  }
}

// バージョン付きのファイル名にして、長くキャッシュさせる（package.json の vendor スクリプトでコピー）
const SCRIPT = '/vendor/maplibre-gl-5.24.0.js';
const STYLESHEET = '/vendor/maplibre-gl-5.24.0.css';
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas';
const ROUTE_COLOR = '#f8c023';

export type GlobeRoute = { coords: Array<[number, number]>; t: number };
export type GlobeAirport = { lon: number; lat: number; t: number; html: string };
export type Padding = { top: number; bottom: number; left: number; right: number };

let loading: Promise<ML> | null = null;

function loadMapLibre(): Promise<ML> {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  loading ??= new Promise<ML>((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = STYLESHEET;
    document.head.appendChild(link);
    const script = document.createElement('script');
    script.src = SCRIPT;
    script.async = true;
    script.onload = () => (window.maplibregl ? resolve(window.maplibregl) : reject(new Error('MapLibre did not load')));
    script.onerror = () => {
      loading = null;
      reject(new Error('Could not load the globe'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

const empty = (): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: [] });

export class Globe {
  private readonly hlMarkers: MapLibre.Marker[] = [];
  private readonly popup: MapLibre.Popup;

  private constructor(private ml: ML, readonly map: MapLibre.Map) {
    this.popup = new ml.Popup({ closeButton: false, closeOnClick: false, offset: 10, className: 'globe-pop' });
    map.on('mousemove', 'airports', (e) => {
      const f = e.features?.[0];
      if (!f || f.geometry.type !== 'Point') return;
      map.getCanvas().style.cursor = 'pointer';
      this.popup
        .setLngLat(f.geometry.coordinates as [number, number])
        .setHTML(String(f.properties?.html ?? ''))
        .addTo(map);
    });
    map.on('mouseleave', 'airports', () => {
      map.getCanvas().style.cursor = '';
      this.popup.remove();
    });
  }

  static async create(container: HTMLElement): Promise<Globe> {
    const ml = await loadMapLibre();
    const tiles = (name: string) => ({
      type: 'raster' as const,
      tiles: [`${ESRI}/${name}/MapServer/tile/{z}/{y}/{x}`],
      tileSize: 256,
      maxzoom: 16
    });
    const map = new ml.Map({
      container,
      center: [0, 30],
      zoom: 1.4,
      minZoom: 0.5,
      maxZoom: 12,
      attributionControl: { compact: true },
      renderWorldCopies: false,
      style: {
        version: 8,
        projection: { type: 'globe' },
        // 地球の縁を薄く光らせ、拡大すると消す
        sky: { 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.9, 4, 0.6, 6, 0] },
        sources: {
          base: { ...tiles('World_Dark_Gray_Base'), attribution: 'Tiles © Esri — Esri, HERE, Garmin, © OpenStreetMap contributors' },
          ref: tiles('World_Dark_Gray_Reference'),
          routes: { type: 'geojson', data: empty() },
          airports: { type: 'geojson', data: empty() },
          hl: { type: 'geojson', data: empty() }
        },
        layers: [
          { id: 'base', type: 'raster', source: 'base' },
          { id: 'ref', type: 'raster', source: 'ref', paint: { 'raster-opacity': 0.6 } },
          {
            id: 'routes',
            type: 'line',
            source: 'routes',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
              'line-color': ROUTE_COLOR,
              'line-width': ['+', 1, ['*', 2.5, ['get', 't']]],
              'line-opacity': ['+', 0.3, ['*', 0.6, ['get', 't']]]
            }
          },
          {
            id: 'hl-casing',
            type: 'line',
            source: 'hl',
            layout: { 'line-cap': 'round' },
            paint: { 'line-color': '#303030', 'line-width': 7, 'line-opacity': 0.6 }
          },
          { id: 'hl', type: 'line', source: 'hl', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#ff3e5f', 'line-width': 3.5 } },
          {
            id: 'airports',
            type: 'circle',
            source: 'airports',
            paint: {
              'circle-radius': ['+', 2.5, ['*', 5, ['get', 't']]],
              'circle-color': '#ffffff',
              'circle-stroke-color': '#1b1a1a',
              'circle-stroke-width': 1.5,
              'circle-pitch-alignment': 'map'
            }
          }
        ]
      }
    });
    if (!window.matchMedia('(pointer: coarse)').matches) {
      map.addControl(new ml.NavigationControl({ showCompass: false }), 'bottom-right');
    }
    map.touchZoomRotate.disableRotation();
    map.dragRotate.disable();
    await new Promise<void>((resolve) => (map.loaded() ? resolve() : map.once('load', () => resolve())));
    return new Globe(ml, map);
  }

  private source(id: string): MapLibre.GeoJSONSource | undefined {
    return this.map.getSource(id) as MapLibre.GeoJSONSource | undefined;
  }

  setData(routes: GlobeRoute[], airports: GlobeAirport[]): void {
    this.source('routes')?.setData({
      type: 'FeatureCollection',
      // 回数の少ない路線から描き、多い路線を上に重ねる
      features: [...routes]
        .sort((a, b) => a.t - b.t)
        .map((r) => ({ type: 'Feature', properties: { t: r.t }, geometry: { type: 'LineString', coordinates: r.coords } }))
    });
    this.source('airports')?.setData({
      type: 'FeatureCollection',
      features: [...airports]
        .sort((a, b) => a.t - b.t)
        .map((a) => ({ type: 'Feature', properties: { t: a.t, html: a.html }, geometry: { type: 'Point', coordinates: [a.lon, a.lat] } }))
    });
  }

  /** 選んだ路線（または空港）を赤い線とラベルで示す。null で消す。 */
  highlight(coords: Array<[number, number]> | null, labels: Array<{ lon: number; lat: number; text: string }> = []): void {
    this.source('hl')?.setData(
      coords && coords.length > 1
        ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }] }
        : empty()
    );
    for (const m of this.hlMarkers.splice(0)) m.remove();
    for (const l of labels) {
      const el = document.createElement('div');
      el.className = 'airport-pin';
      el.textContent = l.text;
      this.hlMarkers.push(new this.ml.Marker({ element: el, anchor: 'bottom', offset: [0, -8] }).setLngLat([l.lon, l.lat]).addTo(this.map));
    }
  }

  /**
   * 範囲が見えるように動かす。世界中に散らばっているときは、よく使う空港（focus）を
   * 正面にして地球全体を見せる。
   */
  fit(bounds: [[number, number], [number, number]], padding: Padding, focus: [number, number] | null, maxZoom: number): void {
    const camera = this.map.cameraForBounds(bounds, { padding, maxZoom });
    const wide = !camera || (camera.zoom ?? 0) < 2;
    // 地球全体を見せるときは、空いている範囲いっぱい（短い辺の 85%）の大きさにする。
    // ズーム z での地球の直径はおよそ 600px × 2^(z - 1.2)
    const { clientWidth: w, clientHeight: h } = this.map.getContainer();
    const room = Math.min(w - padding.left - padding.right, h - padding.top - padding.bottom);
    const whole = 1.2 + Math.log2(Math.max(180, room * 0.85) / 600);
    this.map.flyTo({
      center: wide && focus ? focus : (camera?.center ?? focus ?? [0, 30]),
      zoom: wide ? whole : Math.min(maxZoom, camera!.zoom!),
      padding,
      duration: 1200,
      essential: true
    });
  }

  resize(): void {
    this.map.resize();
  }
}
