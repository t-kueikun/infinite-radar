import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './styles.css';
import { AircraftLayer } from './aircraft-layer';
import { devSignIn, loadViewer, settingsUrl, signInUrl, signOut, type Viewer } from './auth';
import {
  ATC_TYPES,
  fetchAirportFlights,
  fetchAirportPins,
  fetchFlightDetail,
  fetchFlights,
  fetchLocate,
  fetchPilot,
  fetchSessions,
  fetchWorld,
  fmt,
  isOnGround,
  planProgress,
  unwrapLongitudes,
  type AirportPin,
  type AtcStation,
  type Flight,
  type FlightDetail,
  type LocatedFlight,
  type Session,
  type WorldState
} from './data';
import { activeCount, createMatcher, DEFAULT_FILTERS, FilterForm, loadFilters, saveFilters, type AirportFlights } from './filters';
import { FlightPanel } from './panel';

const POLL_MS = 10_000;
const DETAIL_REFRESH_MS = 60_000;
const TICK_MS = 1_000;
const WORLD_MS = 30_000;
const STORAGE_SERVER = 'ir:server';
const STORAGE_FILTERS = 'ir:filters';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const els = {
  servers: $('servers'),
  search: $<HTMLInputElement>('search'),
  results: $<HTMLUListElement>('search-results'),
  count: $('count'),
  clock: $('clock'),
  panel: $('panel'),
  toast: $('toast'),
  tooltip: $('tooltip'),
  filterBtn: $<HTMLButtonElement>('filter-btn'),
  filterCount: $('filter-count'),
  filterPop: $('filter-pop'),
  atcBtn: $<HTMLButtonElement>('atc-btn'),
  atcCount: $('atc-count'),
  atcPop: $('atc-pop'),
  me: $('me'),
  filterLocked: $('filter-locked'),
  filterReset: $('filter-reset')
};

// ---------------------------------------------------------------------------
// 状態
// ---------------------------------------------------------------------------

const state = {
  sessions: [] as Session[],
  sessionId: '',
  flights: [] as Flight[],
  byId: new Map<string, Flight>(),
  selectedId: null as string | null,
  following: false,
  detail: null as FlightDetail | null,
  detailAt: 0,
  pollTimer: 0,
  pollAbort: null as AbortController | null,
  filters: loadFilters(STORAGE_FILTERS),
  /** 絞り込みを通った機体（地図に出す分） */
  shown: 0,
  airportFlights: null as AirportFlights | null,
  world: null as WorldState | null,
  /** IFSpotters（Clerk）のログイン。authReady になるまでは何も出さない */
  viewer: null as Viewer | null,
  authReady: false,
  myFlight: null as LocatedFlight | null,
  worldAt: 0,
  pendingFlightFromUrl: new URL(location.href).searchParams.get('flight')
};

// ---------------------------------------------------------------------------
// 地図
// ---------------------------------------------------------------------------

const map = L.map('map', {
  center: [30, 0],
  zoom: 3,
  minZoom: 2,
  maxZoom: 16,
  worldCopyJump: true,
  zoomControl: false,
  attributionControl: true,
  preferCanvas: true,
  fadeAnimation: false
});
map.attributionControl.setPrefix(false);
if (!window.matchMedia('(pointer: coarse)').matches) L.control.zoom({ position: 'bottomright' }).addTo(map);
// Esri Dark Gray Canvas（キー不要、z16 まで同じ地図なので途中で切り替わらない）。
// ズーム中にタイルを読み直さないよう updateWhenZooming を切り、周囲のタイルを多めに保持する
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas';
const tileOptions: L.TileLayerOptions = {
  maxZoom: 16,
  maxNativeZoom: 16,
  updateWhenIdle: true,
  updateWhenZooming: false,
  keepBuffer: 4
};
L.tileLayer(`${ESRI}/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`, {
  ...tileOptions,
  attribution: 'Tiles © <a href="https://www.esri.com/">Esri</a> — Esri, HERE, Garmin, © OpenStreetMap contributors'
}).addTo(map);
L.tileLayer(`${ESRI}/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, tileOptions).addTo(map);

const aircraft = new AircraftLayer().addTo(map);

const routeLayer = L.layerGroup().addTo(map);
const flownCasing = L.polyline([], { color: '#303030', weight: 6, opacity: 0.55, interactive: false });
const flownLine = L.polyline([], { color: '#ff3e5f', weight: 3, opacity: 1, interactive: false });
const aheadLine = L.polyline([], { color: '#d0d0d0', weight: 2, opacity: 0.75, dashArray: '6 6', interactive: false });
let airportMarkers: L.Marker[] = [];
let airportShift = NaN;
flownCasing.addTo(routeLayer);
flownLine.addTo(routeLayer);
aheadLine.addTo(routeLayer);

const panel = new FlightPanel(els.panel, {
  onClose: () => select(null),
  onToggleFollow: () => setFollowing(!state.following)
});

// ---------------------------------------------------------------------------
// セッションとポーリング
// ---------------------------------------------------------------------------

function renderServers(): void {
  els.servers.innerHTML = state.sessions
    .map((s) => `<button class="chip" data-id="${s.id}" aria-pressed="${s.id === state.sessionId}">${s.name}<span class="n">${fmt.int(s.users)}</span></button>`)
    .join('');
}

els.servers.addEventListener('click', (event) => {
  const btn = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-id]');
  if (btn && btn.dataset.id !== state.sessionId) switchSession(btn.dataset.id!);
});

function switchSession(id: string): void {
  state.sessionId = id;
  const name = state.sessions.find((s) => s.id === id)?.name ?? '';
  try {
    localStorage.setItem(STORAGE_SERVER, name);
  } catch {
    /* ストレージが使えなくても動作に支障はない */
  }
  select(null);
  state.flights = [];
  state.byId.clear();
  aircraft.setFlights([]);
  aircraft.setAtc([]);
  state.world = null;
  state.worldAt = 0;
  state.airportFlights = null;
  renderAtc();
  els.count.textContent = '—';
  renderServers();
  syncUrl();
  void poll();
}

async function poll(): Promise<void> {
  window.clearTimeout(state.pollTimer);
  if (!state.sessionId) return;
  if (document.hidden) return; // 非表示中は止め、visibilitychange で再開する

  state.pollAbort?.abort();
  const controller = new AbortController();
  state.pollAbort = controller;
  const sessionId = state.sessionId;

  try {
    const flights = await fetchFlights(sessionId, controller.signal);
    if (sessionId !== state.sessionId) return;
    state.flights = flights;
    state.byId = new Map(flights.map((f) => [f.id, f]));
    applyFilters();
    hideToast();
    if (Date.now() - state.worldAt > WORLD_MS) void loadWorld(sessionId);
    afterFlightsUpdate();
  } catch (error) {
    if ((error as Error).name !== 'AbortError') showToast(`Live data unavailable: ${(error as Error).message}`);
  } finally {
    if (sessionId === state.sessionId) state.pollTimer = window.setTimeout(poll, POLL_MS);
  }
}

function afterFlightsUpdate(): void {
  if (state.pendingFlightFromUrl) {
    const f = state.byId.get(state.pendingFlightFromUrl);
    state.pendingFlightFromUrl = null;
    if (f) select(f.id, { fly: true });
    else syncUrl();
  }

  if (state.selectedId) {
    const f = state.byId.get(state.selectedId);
    if (!f) {
      showToast('The selected flight has disconnected');
      select(null);
      return;
    }
    // 航跡に最新の報告位置を足す
    if (state.detail) {
      const last = state.detail.track[state.detail.track.length - 1];
      if (!last || last[3] < f.lastReport) state.detail.track.push([f.lat, f.lon, f.alt, f.lastReport]);
    }
    if (Date.now() - state.detailAt > DETAIL_REFRESH_MS) void loadDetail(f.id);
  }
  if (els.search.value.trim()) renderSearch();
  if (state.myFlight) renderMe();
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void poll();
});

// ---------------------------------------------------------------------------
// 選択・追従
// ---------------------------------------------------------------------------

let detailAbort: AbortController | null = null;

function select(id: string | null, options: { fly?: boolean } = {}): void {
  if (id === state.selectedId && id) {
    if (options.fly) flyToSelected();
    return;
  }
  state.selectedId = id;
  state.detail = null;
  aircraft.selectedId = id;
  detailAbort?.abort();
  clearRoute();

  applyFilters();
  if (!id) {
    setFollowing(false);
    panel.close();
    syncUrl();
    return;
  }

  const f = state.byId.get(id);
  if (!f) return;
  panel.open(f);
  setFollowing(false);
  if (options.fly) flyToSelected();
  syncUrl();
  void loadDetail(id);
  void loadPilot(id);
}

let pilotAbort: AbortController | null = null;

async function loadPilot(id: string): Promise<void> {
  pilotAbort?.abort();
  const controller = new AbortController();
  pilotAbort = controller;
  try {
    panel.setPilot(id, await fetchPilot(state.sessionId, id, controller.signal));
  } catch (error) {
    if ((error as Error).name !== 'AbortError') panel.setPilot(id, null);
  }
}

async function loadDetail(id: string): Promise<void> {
  detailAbort?.abort();
  const controller = new AbortController();
  detailAbort = controller;
  state.detailAt = Date.now();
  try {
    const detail = await fetchFlightDetail(state.sessionId, id, controller.signal);
    if (state.selectedId !== id) return;
    const f = state.byId.get(id);
    state.detail = detail;
    if (f) panel.setDetail(detail, f, currentPos(f));
    drawRoute(true);
  } catch (error) {
    if ((error as Error).name !== 'AbortError') state.detailAt = 0;
  }
}

function currentPos(f: Flight): [number, number] {
  return aircraft.positions.get(f.id) ?? [f.lat, f.lon];
}

/** パネルに隠れない位置（地図の見えている部分の中央）に機体が来るよう中心をずらす。 */
function centerFor(pos: [number, number], zoom: number): L.LatLng {
  const rect = els.panel.hidden ? null : els.panel.getBoundingClientRect();
  const mapRect = map.getContainer().getBoundingClientRect();
  let dx = 0;
  let dy = 0;
  if (rect && rect.width) {
    if (rect.width >= mapRect.width - 1) dy = (mapRect.bottom - rect.top) / 2; // モバイルのボトムシート
    else dx = -(rect.right - mapRect.left) / 2; // デスクトップの左パネル
  }
  const point = map.project(pos, zoom).add([dx, dy]);
  return map.unproject(point, zoom);
}

function flyToSelected(): void {
  const f = state.selectedId ? state.byId.get(state.selectedId) : null;
  if (!f) return;
  const zoom = Math.max(map.getZoom(), 7);
  map.flyTo(centerFor(currentPos(f), zoom), zoom, { duration: 0.8 });
}

function setFollowing(on: boolean): void {
  state.following = on && !!state.selectedId;
  panel.setFollowing(state.following);
  if (state.following) flyToSelected();
}

map.on('dragstart', () => {
  if (state.following) setFollowing(false);
});

function clearRoute(): void {
  flownLine.setLatLngs([]);
  flownCasing.setLatLngs([]);
  aheadLine.setLatLngs([]);
  for (const m of airportMarkers) m.remove();
  airportMarkers = [];
  airportShift = NaN;
}

/** 選択中フライトの航跡と残りの計画を描く。経度は機体の描画位置の近くに揃える。 */
function drawRoute(withAirports = false): void {
  const f = state.selectedId ? state.byId.get(state.selectedId) : null;
  const detail = state.detail;
  if (!f || !detail) return;

  const pos = currentPos(f);
  // 機体は地図中心に最も近い世界コピーに描かれるので、線もそこへ寄せる
  const centerLon = map.getCenter().lng;
  let refLon = pos[1];
  while (refLon - centerLon > 180) refLon -= 360;
  while (refLon - centerLon < -180) refLon += 360;

  const flownRaw = [...detail.track.map((p) => [p[0], p[1]] as [number, number]), pos];
  const flown = unwrapLongitudes(flownRaw.reverse(), refLon).reverse();
  flownLine.setLatLngs(flown);
  flownCasing.setLatLngs(flown);

  const progress = planProgress(detail.plan, pos[0], pos[1]);
  const ahead = progress ? unwrapLongitudes(progress.ahead, refLon) : [];
  aheadLine.setLatLngs(ahead);

  const shift = Math.round((refLon - pos[1]) / 360);
  if (withAirports || shift !== airportShift) {
    airportShift = shift;
    for (const m of airportMarkers) m.remove();
    airportMarkers = [];
    const plan = detail.plan;
    const ends: Array<[typeof detail.origin, [number, number] | undefined]> = [
      [detail.origin, plan.length ? [plan[0][1], plan[0][2]] : undefined],
      [detail.destination, plan.length > 1 ? [plan[plan.length - 1][1], plan[plan.length - 1][2]] : undefined]
    ];
    for (const [airport, at] of ends) {
      if (!airport || !at) continue;
      const [ll] = unwrapLongitudes([at], refLon);
      const marker = L.marker(ll, {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({ className: 'airport-pin', html: airport.iata || airport.icao, iconSize: undefined })
      }).addTo(routeLayer);
      airportMarkers.push(marker);
    }
  }
}

// ---------------------------------------------------------------------------
// 地図の操作（クリック・ホバー）
// ---------------------------------------------------------------------------

map.on('click', (event: L.LeafletMouseEvent) => {
  const { x, y } = event.containerPoint;
  const hit = aircraft.hitTest(x, y);
  if (hit) {
    hideTooltip();
    select(hit.id);
    return;
  }
  const airport = aircraft.hitTestAirport(x, y);
  if (airport) {
    showAirportTooltip(airport, event.containerPoint);
    return;
  }
  hideTooltip();
  select(null);
});

/** 空港の周囲（約 3nm）で地上にいる機体と、到着が近い機体の数を数える。 */
function airportTraffic(a: AirportPin): { ground: number; nearby: number } {
  let ground = 0;
  let nearby = 0;
  const cosLat = Math.cos((a.lat * Math.PI) / 180);
  for (const f of state.flights) {
    const dLat = (f.lat - a.lat) * 60;
    const dLon = (f.lon - a.lon) * 60 * cosLat;
    const d2 = dLat * dLat + dLon * dLon;
    if (d2 < 9 && f.gs < 50) ground++;
    else if (d2 < 900 && f.gs >= 50) nearby++;
  }
  return { ground, nearby };
}

function showAirportTooltip(a: AirportPin, at: L.Point): void {
  const traffic = airportTraffic(a);
  const codes = [a.icao, a.iata].filter(Boolean).join(' / ');
  const planned = state.world?.traffic.get(a.icao);
  const counts = planned
    ? `${traffic.ground} on ground · ${planned[0]} arrivals · ${planned[1]} departures`
    : `${traffic.ground} on ground · ${traffic.nearby} within 30 nm`;
  const station = state.world?.stations.find((s) => s.icao === a.icao);
  const atc = station
    ? `<span class="atc-line">${station.types.map((t) => ATC_TYPES[t]?.name ?? 'Unknown').join(' · ')}${
        station.controllers.length ? ` — ${escapeHtml(station.controllers.join(', '))}` : ''
      }</span>`
    : '';
  els.tooltip.innerHTML = `<b>${escapeHtml(a.name)}</b>${escapeHtml(codes)} · ${counts}${atc}`;
  els.tooltip.style.left = `${at.x + 14}px`;
  els.tooltip.style.top = `${at.y + 14}px`;
  els.tooltip.hidden = false;
}

function hideTooltip(): void {
  els.tooltip.hidden = true;
}

const canHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
let hoverFrame = 0;
let lastMouse: L.Point | null = null;

if (canHover) {
  map.on('mousemove', (event: L.LeafletMouseEvent) => {
    lastMouse = event.containerPoint;
    if (hoverFrame) return;
    hoverFrame = requestAnimationFrame(() => {
      hoverFrame = 0;
      if (!lastMouse) return;
      const hit = aircraft.hitTest(lastMouse.x, lastMouse.y);
      const airport = hit ? null : aircraft.hitTestAirport(lastMouse.x, lastMouse.y);
      map.getContainer().style.cursor = hit || airport ? 'pointer' : '';
      if (airport) {
        showAirportTooltip(airport, lastMouse);
        return;
      }
      if (!hit) {
        hideTooltip();
        return;
      }
      els.tooltip.innerHTML = `<b>${escapeHtml(hit.callsign || '—')}</b>${escapeHtml(hit.aircraft || '')} · ${fmt.alt(hit.alt)} ft · ${fmt.int(hit.gs)} kt`;
      els.tooltip.style.left = `${lastMouse.x + 14}px`;
      els.tooltip.style.top = `${lastMouse.y + 14}px`;
      els.tooltip.hidden = false;
    });
  });
  map.on('mouseout movestart', () => {
    lastMouse = null;
    els.tooltip.hidden = true;
  });
}

map.on('moveend', () => drawRoute(false));

// 1 秒ごとにデッドレコニングで位置を進め、パネルと追従を更新する
window.setInterval(() => {
  if (document.hidden) return;
  aircraft.redraw();
  updateClock();

  const f = state.selectedId ? state.byId.get(state.selectedId) : null;
  if (!f) return;
  requestAnimationFrame(() => {
    const pos = currentPos(f);
    panel.update(f, true, pos);
    drawRoute(false);
    if (state.following) map.panTo(centerFor(pos, map.getZoom()), { animate: true, duration: 0.9, easeLinearity: 1 });
  });
}, TICK_MS);

// ---------------------------------------------------------------------------
// フィルター
// ---------------------------------------------------------------------------

const filterForm = new FilterForm(els.filterPop, (filters) => {
  const airportChanged = filters.airport !== state.filters.airport;
  state.filters = filters;
  saveFilters(STORAGE_FILTERS, filters);
  if (airportChanged) {
    state.airportFlights = null;
    void loadAirportFlights();
  }
  applyFilters();
});
filterForm.write(state.filters);

/** 絞り込みを地図に反映する。選択中の機体は条件に合わなくても出しておく。 */
function applyFilters(): void {
  // フィルターはログインした人だけ。未ログインなら保存済みの条件も効かせない
  const f = state.viewer ? state.filters : DEFAULT_FILTERS;
  const active = activeCount(f);
  const match = createMatcher(f, state.airportFlights);
  const visible = active ? state.flights.filter((flight) => flight.id === state.selectedId || match(flight)) : state.flights;
  state.shown = active ? visible.filter((flight) => flight.id !== state.selectedId || match(flight)).length : visible.length;
  aircraft.setFlights(visible);
  aircraft.setAirportMode(f.airports);

  if (state.sessionId && state.flights.length) {
    els.count.textContent = active ? `${fmt.int(state.shown)} / ${fmt.int(state.flights.length)}` : `${fmt.int(state.flights.length)} flights`;
  }
  els.filterCount.textContent = String(active);
  els.filterCount.hidden = !active;
  els.filterBtn.classList.toggle('on', active > 0);
  filterForm.setResult(state.shown, state.flights.length, active > 0);
}

let airportAbort: AbortController | null = null;

async function loadAirportFlights(): Promise<void> {
  const icao = state.filters.airport;
  airportAbort?.abort();
  if (!/^[A-Z0-9]{3,4}$/.test(icao) || !state.sessionId) return;
  const controller = new AbortController();
  airportAbort = controller;
  try {
    const r = await fetchAirportFlights(state.sessionId, icao, controller.signal);
    if (icao !== state.filters.airport) return;
    state.airportFlights = { icao, inbound: new Set(r.inbound), outbound: new Set(r.outbound) };
    applyFilters();
  } catch {
    /* 次の更新で再試行 */
  }
}

// ---------------------------------------------------------------------------
// ATC（/world を 30 秒ごとに取得）
// ---------------------------------------------------------------------------

let worldAbort: AbortController | null = null;

async function loadWorld(sessionId: string): Promise<void> {
  state.worldAt = Date.now();
  worldAbort?.abort();
  const controller = new AbortController();
  worldAbort = controller;
  try {
    const world = await fetchWorld(sessionId, controller.signal);
    if (sessionId !== state.sessionId) return;
    state.world = world;
    aircraft.setAtc(world.stations);
    renderAtc();
    if (state.filters.airport) void loadAirportFlights();
  } catch (error) {
    if ((error as Error).name !== 'AbortError') state.worldAt = 0;
  }
}

function since(epochSec: number): string {
  return epochSec ? fmt.duration((Date.now() / 1000 - epochSec) / 60) : '';
}

function atcRow(s: AtcStation, title: string, sub: string): string {
  const freqs = s.types.map((t) => `<i title="${ATC_TYPES[t]?.name ?? 'Unknown'}">${ATC_TYPES[t]?.short ?? '?'}</i>`).join('');
  const meta = [escapeHtml(s.controllers.join(', ')), since(s.since)].filter(Boolean).join(' · ');
  return `<li data-key="${escapeHtml(s.key)}">
    <button type="button" class="atc-main">
      <span class="atc-title"><b>${escapeHtml(title)}</b><span class="atc-name">${escapeHtml(sub)}</span></span>
      <span class="freqs">${freqs}</span>
      <span class="atc-meta">${meta}</span>
    </button>
    ${s.icao ? `<button type="button" class="link-btn atc-filter" data-icao="${escapeHtml(s.icao)}">Flights</button>` : ''}
  </li>`;
}

function renderAtc(): void {
  const world = state.world;
  const stations = world?.stations ?? [];
  const centers = world?.centers ?? [];
  els.atcCount.textContent = String(stations.length + centers.length);
  els.atcBtn.classList.toggle('on', stations.length + centers.length > 0);
  if (els.atcPop.hidden) return;

  const server = state.sessions.find((s) => s.id === state.sessionId)?.name ?? '';
  const rows = stations.map((s) => {
    const a = aircraft.airport(s.icao);
    const t = world?.traffic.get(s.icao);
    return atcRow(s, s.icao, [a?.name !== s.icao ? a?.name : '', t ? `↓${t[0]} ↑${t[1]}` : ''].filter(Boolean).join(' · '));
  });
  const centerRows = centers.map((s) => atcRow(s, 'Center', ''));
  els.atcPop.innerHTML = `<header class="pop-head"><h3>Active ATC</h3><span class="muted">${escapeHtml(server)}</span></header>
    ${
      !world
        ? '<p class="pop-empty">Loading…</p>'
        : rows.length || centerRows.length
          ? `<ul class="atc-list">${rows.join('')}${centerRows.join('')}</ul>`
          : '<p class="pop-empty">No ATC is active on this server right now.</p>'
    }
    <footer class="pop-foot">G Ground · T Tower · I ATIS · C Clearance · A Approach · D Departure</footer>`;
}

els.atcPop.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const filterBtn = target.closest<HTMLButtonElement>('.atc-filter');
  if (filterBtn) {
    if (!state.viewer) {
      openPopover('filter');
      return;
    }
    state.filters = { ...state.filters, airport: filterBtn.dataset.icao!, direction: 'both' };
    filterForm.write(state.filters);
    saveFilters(STORAGE_FILTERS, state.filters);
    state.airportFlights = null;
    void loadAirportFlights();
    applyFilters();
    openPopover('filter');
    return;
  }
  const row = target.closest<HTMLElement>('li[data-key]');
  if (!row) return;
  const station = [...(state.world?.stations ?? []), ...(state.world?.centers ?? [])].find((s) => s.key === row.dataset.key);
  if (!station) return;
  closePopovers();
  const airport = station.icao ? aircraft.airport(station.icao) : null;
  const target_ = airport ? L.latLng(airport.lat, airport.lon) : L.latLng(station.lat, station.lon);
  map.flyTo(target_, Math.max(map.getZoom(), station.icao ? 10 : 6), { duration: 0.8 });
  if (airport) map.once('moveend', () => showAirportTooltip(airport, map.latLngToContainerPoint(target_)));
});

// ---------------------------------------------------------------------------
// ポップオーバー（フィルター / ATC）
// ---------------------------------------------------------------------------

type PopName = 'filter' | 'atc';
const pops: Record<PopName, { btn: HTMLButtonElement; pop: HTMLElement }> = {
  filter: { btn: els.filterBtn, pop: els.filterPop },
  atc: { btn: els.atcBtn, pop: els.atcPop }
};

function openPopover(name: PopName): void {
  for (const [key, { btn, pop }] of Object.entries(pops)) {
    const open = key === name;
    pop.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  }
  hideTooltip();
  if (name === 'filter') filterForm.updateSuggestions(state.flights);
  if (name === 'atc') renderAtc();
}

function closePopovers(): void {
  for (const { btn, pop } of Object.values(pops)) {
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  }
}

for (const [name, { btn, pop }] of Object.entries(pops) as Array<[PopName, (typeof pops)[PopName]]>) {
  btn.addEventListener('click', () => (pop.hidden ? openPopover(name) : closePopovers()));
}

// 時間表示（何分前から管制しているか）を更新する
window.setInterval(() => {
  if (!document.hidden && !els.atcPop.hidden) renderAtc();
}, 30_000);

// ---------------------------------------------------------------------------
// ログイン（IFSpotters と共通）と自分の機体
// ---------------------------------------------------------------------------

const LOCATE_MS = 30_000;
let meMenuOpen = false;

function handleViewer(viewer: Viewer | null): void {
  state.viewer = viewer;
  state.authReady = true;
  state.myFlight = null;
  meMenuOpen = false;
  renderMe();
  renderFilterLock();
  applyFilters();
  void locateMe();
}

function renderFilterLock(): void {
  const locked = !state.viewer;
  els.filterLocked.hidden = !locked;
  els.filterPop.querySelector('form')!.hidden = locked;
  els.filterReset.hidden = locked;
  $('filter-result').hidden = locked;
  els.filterBtn.classList.toggle('locked', locked);
}

async function locateMe(): Promise<void> {
  const name = state.viewer?.ifcUsername;
  if (!name || document.hidden) return;
  try {
    const found = await fetchLocate(name);
    if (name !== state.viewer?.ifcUsername) return;
    state.myFlight = found;
  } catch {
    /* 次回に再試行 */
  }
  renderMe();
}

window.setInterval(() => void locateMe(), LOCATE_MS);

function initial(name: string): string {
  return escapeHtml((name.trim()[0] || '?').toUpperCase());
}

function renderMe(): void {
  if (!state.authReady) return;
  const v = state.viewer;
  if (!v) {
    els.me.innerHTML = '<a class="chip signin js-signin" href="#">Sign in</a>';
    return;
  }

  const mine = state.myFlight;
  let flight = '';
  if (!v.ifcUsername) {
    flight = `<a class="my-flight idle" href="${settingsUrl()}" target="_blank" rel="noopener">Set your IFC username</a>`;
  } else if (mine) {
    const live = mine.sessionId === state.sessionId ? state.byId.get(mine.flightId) : null;
    const where = live ? (isOnGround(live) ? 'On ground' : `${fmt.alt(live.alt)} ft`) : mine.server;
    const selected = state.selectedId === mine.flightId;
    flight = `<button type="button" class="my-flight" id="my-flight" aria-pressed="${selected}" title="Go to my flight">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 2l1.8 6.6 7.2 3v2l-7.2-1.5-.7 4.8 2.2 1.9V20l-3.3-1.1L8.7 20v-1.2l2.2-1.9-.7-4.8L3 13.6v-2l7.2-3z" fill="currentColor"/></svg>
      <b>${escapeHtml(mine.callsign || 'My flight')}</b><span class="where">${escapeHtml(where)}</span>
    </button>`;
  } else {
    flight = '<span class="my-flight idle">Not flying</span>';
  }

  const avatar = v.imageUrl ? `<img src="${escapeHtml(v.imageUrl)}" alt="" width="32" height="32" />` : initial(v.displayName);
  els.me.innerHTML = `${flight}
    <button type="button" class="avatar" id="me-btn" aria-expanded="${meMenuOpen}" aria-label="Account">${avatar}</button>
    <div class="me-menu" ${meMenuOpen ? '' : 'hidden'}>
      <div class="who"><b>${escapeHtml(v.displayName)}</b>${v.ifcUsername ? `<span>IFC @${escapeHtml(v.ifcUsername)}</span>` : ''}</div>
      <a href="${settingsUrl()}" target="_blank" rel="noopener">IFSpotters settings</a>
      <button type="button" data-action="signout">Sign out</button>
    </div>`;
}

/** 自分の便へ移動して追従する。別のサーバーなら切り替えてから選ぶ。 */
function goToMyFlight(): void {
  const mine = state.myFlight;
  if (!mine) return;
  closePopovers();
  if (mine.sessionId !== state.sessionId) {
    state.pendingFlightFromUrl = mine.flightId;
    switchSession(mine.sessionId);
    return;
  }
  select(mine.flightId, { fly: true });
  setFollowing(true);
  renderMe();
}

els.me.addEventListener('click', async (event) => {
  const target = event.target as HTMLElement;
  if (target.closest('#my-flight')) {
    goToMyFlight();
  } else if (target.closest('#me-btn')) {
    meMenuOpen = !meMenuOpen;
    renderMe();
  } else if (target.closest('[data-action="signout"]')) {
    await signOut();
    handleViewer(null);
  }
});

document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const signin = target.closest<HTMLAnchorElement>('.js-signin');
  if (signin) {
    event.preventDefault();
    // ログイン後に今見ている地図（サーバー・選択中の便）へ戻れるよう、押した時点の URL を渡す
    const url = signInUrl();
    if (url === '#dev-sign-in') {
      if (devSignIn()) location.reload();
    } else {
      location.href = url;
    }
    return;
  }
  // 再描画でクリックした要素が DOM から外れていることがあるので、経路で判定する
  if (meMenuOpen && !event.composedPath().includes(els.me)) {
    meMenuOpen = false;
    renderMe();
  }
});

// ---------------------------------------------------------------------------
// 検索
// ---------------------------------------------------------------------------

let searchItems: Flight[] = [];
let activeIndex = -1;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function renderSearch(): void {
  const q = els.search.value.trim().toLowerCase();
  if (!q) {
    els.results.hidden = true;
    searchItems = [];
    return;
  }

  const scored: Array<[number, Flight]> = [];
  for (const f of state.flights) {
    const cs = f.callsign.toLowerCase();
    const user = f.username.toLowerCase();
    let score = -1;
    if (cs.startsWith(q) || user.startsWith(q)) score = 0;
    else if (cs.includes(q) || user.includes(q)) score = 1;
    else if (f.va.toLowerCase().includes(q)) score = 2;
    else if (f.aircraft.toLowerCase().includes(q) || f.livery.toLowerCase().includes(q)) score = 3;
    if (score >= 0) scored.push([score, f]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].callsign.localeCompare(b[1].callsign));
  searchItems = scored.slice(0, 30).map(([, f]) => f);
  activeIndex = Math.min(activeIndex, searchItems.length - 1);

  els.results.innerHTML = searchItems.length
    ? searchItems
        .map(
          (f, i) => `<li role="option" data-id="${f.id}" aria-selected="${i === activeIndex}">
            <span class="cs">${escapeHtml(f.callsign || '—')}</span>
            <span class="alt">${fmt.alt(f.alt)} ft</span>
            <span class="meta">${escapeHtml([f.username, f.aircraft, f.livery].filter(Boolean).join(' · '))}</span>
          </li>`
        )
        .join('')
    : '<li class="empty">No matching flights</li>';
  els.results.hidden = false;
}

let searchTimer = 0;
els.search.addEventListener('input', () => {
  activeIndex = -1;
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(renderSearch, 100);
});

els.search.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!searchItems.length) return;
    activeIndex = (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + searchItems.length) % searchItems.length;
    renderSearch();
    els.results.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  } else if (event.key === 'Enter') {
    const f = searchItems[Math.max(0, activeIndex)];
    if (f) chooseResult(f.id);
  } else if (event.key === 'Escape') {
    els.search.value = '';
    renderSearch();
    els.search.blur();
  }
});

els.results.addEventListener('mousedown', (event) => {
  const li = (event.target as HTMLElement).closest<HTMLElement>('li[data-id]');
  if (!li) return;
  event.preventDefault();
  chooseResult(li.dataset.id!);
});

els.search.addEventListener('focus', () => {
  if (els.search.value.trim()) renderSearch();
});
els.search.addEventListener('blur', () => {
  els.results.hidden = true;
});

function chooseResult(id: string): void {
  els.results.hidden = true;
  els.search.blur();
  select(id, { fly: true });
}

document.addEventListener('keydown', (event) => {
  const typing = document.activeElement instanceof HTMLInputElement;
  if (event.key === '/' && !typing) {
    event.preventDefault();
    els.search.focus();
  } else if (event.key === 'Escape' && (!els.filterPop.hidden || !els.atcPop.hidden)) {
    closePopovers();
  } else if (event.key === 'Escape' && !typing && state.selectedId) {
    select(null);
  }
});

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------

function syncUrl(): void {
  const url = new URL(location.href);
  const name = state.sessions.find((s) => s.id === state.sessionId)?.name;
  if (name) url.searchParams.set('server', name.toLowerCase());
  if (state.selectedId) url.searchParams.set('flight', state.selectedId);
  else if (!state.pendingFlightFromUrl) url.searchParams.delete('flight');
  history.replaceState(null, '', url);
}

let lastClock = '';
function updateClock(): void {
  const text = `${fmt.utc(new Date())} UTC`;
  if (text !== lastClock) els.clock.textContent = lastClock = text;
}

function showToast(message: string): void {
  els.toast.textContent = message;
  els.toast.hidden = false;
}

function hideToast(): void {
  els.toast.hidden = true;
}

async function init(): Promise<void> {
  updateClock();
  try {
    state.sessions = await fetchSessions();
  } catch (error) {
    showToast(`Could not load servers: ${(error as Error).message}`);
    window.setTimeout(init, 10_000);
    return;
  }

  let stored = '';
  try {
    stored = localStorage.getItem(STORAGE_SERVER) || '';
  } catch {
    /* noop */
  }
  const wanted = (new URL(location.href).searchParams.get('server') || stored).toLowerCase();
  const initial =
    state.sessions.find((s) => s.name.toLowerCase() === wanted) ??
    state.sessions.find((s) => /expert/i.test(s.name)) ??
    state.sessions[0];
  if (!initial) {
    showToast('No active servers');
    return;
  }

  state.sessionId = initial.id;
  fetchAirportPins()
    .then((airports) => aircraft.setAirports(airports))
    .catch(() => {
      /* 空港ピンが無くても機体の表示には影響しない */
    });
  renderServers();
  syncUrl();
  void poll();

  // ログイン確認は地図が出てから（clerk-js の読み込みで初回表示を遅らせない）
  renderFilterLock();
  window.setTimeout(() => {
    loadViewer(handleViewer).then(handleViewer, () => handleViewer(null));
  }, 300);

  // セッションの人数表示は数分おきに更新すれば十分
  window.setInterval(async () => {
    if (document.hidden) return;
    try {
      state.sessions = await fetchSessions();
      renderServers();
    } catch {
      /* 次回に再試行 */
    }
  }, 5 * 60_000);
}

void init();
