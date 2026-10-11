import { fetchHistoryPage, fmt, unwrapLongitudes, type AirportPin, type HistoryFlight, type PilotProfile } from './data';
import { Globe, type GlobeAirport, type GlobeRoute, type Padding } from './globe';

/**
 * フライト統計。Infinite Flight のフライト履歴を全ページ読み、よく使った空港・機種・
 * 航空会社・路線をブラウザで集計する（アプリ内では見られないので）。
 *
 * 履歴は 100 便ずつ届くので、届いた分から集計し直して表示を育てていく。
 * 飛んだ路線は地球儀（globe.ts）に大圏で引き、回数が多いほど太く濃くする。
 */

export type Period = 'all' | '1y' | '30d';

const PAGE_CONCURRENCY = 2;
const RENDER_MS = 400;
const LIST_SHORT = 8;
const LIST_LONG = 50;
const MAP_ROUTES = 400;
const MAP_AIRPORTS = 400;
const NM_PER_RAD = 3440.065;
const DAY = 86_400;
/** 読み込み済みの履歴をこの時間はそのまま使う（開き直しを速くする） */
const MEMO_MS = 10 * 60_000;
/** 機体を出してすぐ抜けた記録など、飛行 1 分未満で着陸も無いものは数えない */
const MIN_MINUTES = 1;
/** 航空会社として数えないリバリー名 */
const NOT_AIRLINE = /^(default|generic|none|)$/i;

type Tally = { key: string; n: number; minutes: number };
type AirportTally = Tally & { dep: number; arr: number };
type RouteTally = Tally & { a: string; b: string; nm: number };
type Bucket = { label: string; title: string; n: number; minutes: number };

export type Summary = {
  flights: number;
  skipped: number;
  undated: number;
  minutes: number;
  night: number;
  landings: number;
  xp: number;
  violations: number;
  distance: number;
  airports: AirportTally[];
  aircraft: Tally[];
  airlines: Tally[];
  routes: RouteTally[];
  servers: Tally[];
  longest: HistoryFlight | null;
  farthest: RouteTally | null;
  buckets: Bucket[];
};

type Lookup = (icao: string) => AirportPin | null;

const ICON_CLOSE =
  '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6 10.6 12 5 6.4z" fill="currentColor"/></svg>';
const IFC_PROFILE = 'https://community.infiniteflight.com/u/';
const monthFmt = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' });
const monthYearFmt = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const dayFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function hours(minutes: number): string {
  return minutes >= 600 ? `${fmt.int(minutes / 60)}h` : fmt.duration(minutes);
}

function distanceNm(a: AirportPin, b: AirportPin): number {
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * NM_PER_RAD * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 2 点間の大圏を折れ線にする（経度は連続に揃える）。 */
function greatCircle(a: AirportPin, b: AirportPin, startLon: number): Array<[number, number]> {
  const r = Math.PI / 180;
  const [φ1, λ1, φ2, λ2] = [a.lat * r, a.lon * r, b.lat * r, b.lon * r];
  const d = distanceNm(a, b) / NM_PER_RAD;
  if (d < 1e-6) return [[a.lat, startLon]];
  const steps = Math.max(2, Math.min(48, Math.ceil(d * 30)));
  const points: Array<[number, number]> = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
    const z = A * Math.sin(φ1) + B * Math.sin(φ2);
    points.push([Math.atan2(z, Math.hypot(x, y)) / r, Math.atan2(y, x) / r]);
  }
  return unwrapLongitudes(points, startLon);
}

function wrapNear(lon: number, ref: number): number {
  while (lon - ref > 180) lon -= 360;
  while (lon - ref < -180) lon += 360;
  return lon;
}

function bump<T extends Tally>(map: Map<string, T>, key: string, minutes: number, make: () => T): T {
  let t = map.get(key);
  if (!t) map.set(key, (t = make()));
  t.n++;
  t.minutes += minutes;
  return t;
}

/** 昔のサーバー名（Expert Server (ATC)、Training Server 1 など）を今の 3 つ + Solo にまとめる。 */
function serverGroup(name: string): string {
  if (/expert/i.test(name)) return 'Expert';
  if (/training/i.test(name)) return 'Training';
  if (/casual|free|beginner/i.test(name)) return 'Casual';
  if (/solo/i.test(name)) return 'Solo';
  return name ? 'Other' : 'Unknown';
}

const byCount = (a: Tally, b: Tally) => b.n - a.n || b.minutes - a.minutes || a.key.localeCompare(b.key);

function buckets(flights: HistoryFlight[], period: Period, now: number): Bucket[] {
  const out: Bucket[] = [];
  const index = new Map<string, Bucket>();
  const add = (key: string, label: string, title: string) => {
    const b = { label, title, n: 0, minutes: 0 };
    out.push(b);
    index.set(key, b);
  };
  const today = new Date(now * 1000);
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();

  let keyOf: (d: Date) => string;
  const firstYear = Math.min(y, ...flights.filter((f) => f.start).map((f) => new Date(f.start * 1000).getUTCFullYear()));
  if (period === '30d') {
    for (let i = 29; i >= 0; i--) {
      const d = new Date((now - i * DAY) * 1000);
      add(d.toISOString().slice(0, 10), i % 7 === 0 ? String(d.getUTCDate()) : '', dayFmt.format(d));
    }
    keyOf = (d) => d.toISOString().slice(0, 10);
  } else if (period === '1y' || y - firstYear < 2) {
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(y, m - i, 1));
      add(d.toISOString().slice(0, 7), monthFmt.format(d).slice(0, 1), monthYearFmt.format(d));
    }
    keyOf = (d) => d.toISOString().slice(0, 7);
  } else {
    const span = y - firstYear;
    for (let year = firstYear; year <= y; year++) add(String(year), span > 8 ? `’${String(year).slice(2)}` : String(year), String(year));
    keyOf = (d) => String(d.getUTCFullYear());
  }

  for (const f of flights) {
    if (!f.start) continue;
    const b = index.get(keyOf(new Date(f.start * 1000)));
    if (!b) continue;
    b.n++;
    b.minutes += f.minutes;
  }
  return out;
}

export function summarize(all: Iterable<HistoryFlight>, period: Period, lookup: Lookup, now = Date.now() / 1000): Summary {
  const cutoff = period === '30d' ? now - 30 * DAY : period === '1y' ? now - 365 * DAY : -Infinity;
  const flights: HistoryFlight[] = [];
  let skipped = 0;
  for (const f of all) {
    if (period !== 'all' && (!f.start || f.start < cutoff)) continue;
    if (f.minutes < MIN_MINUTES && !f.landings) skipped++;
    else flights.push(f);
  }

  const airports = new Map<string, AirportTally>();
  const aircraft = new Map<string, Tally>();
  const airlines = new Map<string, Tally>();
  const routes = new Map<string, RouteTally>();
  const servers = new Map<string, Tally>();
  const s: Summary = {
    flights: flights.length,
    skipped,
    undated: 0,
    minutes: 0,
    night: 0,
    landings: 0,
    xp: 0,
    violations: 0,
    distance: 0,
    airports: [],
    aircraft: [],
    airlines: [],
    routes: [],
    servers: [],
    longest: null,
    farthest: null,
    buckets: []
  };

  for (const f of flights) {
    s.minutes += f.minutes;
    s.night += f.night;
    s.landings += f.landings;
    s.xp += f.xp;
    s.violations += f.violations;
    if (!f.start) s.undated++;
    if (!s.longest || f.minutes > s.longest.minutes) s.longest = f;

    const server = serverGroup(f.server);
    bump(servers, server, f.minutes, () => ({ key: server, n: 0, minutes: 0 }));
    if (f.aircraft) bump(aircraft, f.aircraft, f.minutes, () => ({ key: f.aircraft, n: 0, minutes: 0 }));
    if (!NOT_AIRLINE.test(f.livery.trim())) bump(airlines, f.livery, f.minutes, () => ({ key: f.livery, n: 0, minutes: 0 }));

    const { origin: o, destination: d } = f;
    if (o) bump(airports, o, f.minutes, () => ({ key: o, n: 0, minutes: 0, dep: 0, arr: 0 })).dep++;
    if (d && d !== o) bump(airports, d, f.minutes, () => ({ key: d, n: 0, minutes: 0, dep: 0, arr: 0 })).arr++;
    else if (d) airports.get(d)!.arr++;

    if (o && d && o !== d) {
      const [a, b] = o < d ? [o, d] : [d, o];
      const pa = lookup(a);
      const pb = lookup(b);
      const nm = pa && pb ? distanceNm(pa, pb) : 0;
      s.distance += nm;
      bump(routes, `${a}|${b}`, f.minutes, () => ({ key: `${a}|${b}`, n: 0, minutes: 0, a, b, nm }));
    }
  }

  s.airports = [...airports.values()].sort(byCount);
  s.aircraft = [...aircraft.values()].sort(byCount);
  s.airlines = [...airlines.values()].sort(byCount);
  s.routes = [...routes.values()].sort(byCount);
  s.servers = [...servers.values()].sort(byCount);
  s.farthest = s.routes.reduce<RouteTally | null>((best, r) => (r.nm > (best?.nm ?? 0) ? r : best), null);
  s.buckets = buckets(flights, period, now);
  return s;
}

// ---------------------------------------------------------------------------
// 表示
// ---------------------------------------------------------------------------

type Loaded = { profile: PilotProfile | null; flights: Map<string, HistoryFlight>; totalCount: number; complete: boolean; at: number };
const memo = new Map<string, Loaded>();

export type StatsHandlers = {
  onClose: () => void;
  airport: Lookup;
};

export class StatsView {
  user: string | null = null;
  private data: Loaded | null = null;
  private pages = { done: 0, total: 0, failed: 0 };
  private error = '';
  private period: Period = 'all';
  private expanded = new Set<string>();
  private abort: AbortController | null = null;
  private renderTimer = 0;
  private summary: Summary | null = null;
  private fitted = false;
  private globe: Globe | null = null;
  private globeLoading: Promise<void> | null = null;

  constructor(private root: HTMLElement, private globeHost: HTMLElement, private handlers: StatsHandlers) {
    root.addEventListener('click', (event) => this.onClick(event));
  }

  /** 地球儀は初めて統計を開いたときに作る（MapLibre の読み込みを待つ間もパネルは先に出す）。 */
  private ensureGlobe(): void {
    if (this.globe) {
      this.globe.resize();
      return;
    }
    this.globeLoading ??= Globe.create(this.globeHost)
      .then((globe) => {
        this.globe = globe;
        if (this.summary && this.isOpen) this.drawMap(this.summary);
      })
      .catch(() => {
        this.globeLoading = null;
        this.globeHost.classList.add('failed');
      });
  }

  get isOpen(): boolean {
    return this.user !== null;
  }

  open(user: string): void {
    const name = user.trim().replace(/^@/, '');
    if (!name) return;
    if (this.user?.toLowerCase() === name.toLowerCase()) return;
    this.abort?.abort();
    this.user = name;
    this.period = 'all';
    this.expanded.clear();
    this.error = '';
    this.fitted = false;
    this.summary = null;
    this.globeHost.hidden = false;
    this.globe?.highlight(null);
    this.ensureGlobe();
    this.root.hidden = false;
    this.root.innerHTML = `<div class="panel-head st-head"></div><div class="panel-scroll st-body"></div>`;

    const cached = memo.get(name.toLowerCase());
    if (cached?.complete && Date.now() - cached.at < MEMO_MS) {
      this.data = cached;
      this.pages = { done: 1, total: 1, failed: 0 };
      this.render();
      return;
    }
    this.data = null;
    this.pages = { done: 0, total: 0, failed: 0 };
    this.render();
    void this.load(name);
  }

  close(): void {
    this.abort?.abort();
    window.clearTimeout(this.renderTimer);
    this.renderTimer = 0;
    this.user = null;
    this.data = null;
    this.summary = null;
    this.globe?.setData([], []);
    this.globe?.highlight(null);
    this.globeHost.hidden = true;
    this.root.hidden = true;
    this.root.innerHTML = '';
  }

  /** 空港の座標が後から届いたとき（距離と地図の線を引き直す）。 */
  refresh(): void {
    if (this.isOpen) this.render();
  }

  private async load(user: string): Promise<void> {
    const controller = new AbortController();
    this.abort = controller;
    const { signal } = controller;
    const fetchPage = async (page: number) => {
      try {
        return await fetchHistoryPage(user, page, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        // 混んでいるときの 429 などは、少し待ってもう一度だけ
        await new Promise((resolve) => setTimeout(resolve, 2500));
        return fetchHistoryPage(user, page, signal);
      }
    };

    try {
      const first = await fetchPage(1);
      if (signal.aborted) return;
      const data: Loaded = { profile: first.profile, flights: new Map(), totalCount: first.totalCount, complete: false, at: Date.now() };
      for (const f of first.flights) data.flights.set(f.id, f);
      this.data = data;
      this.pages = { done: 1, total: Math.max(1, first.totalPages), failed: 0 };
      this.render();

      let next = 2;
      const worker = async () => {
        while (next <= this.pages.total && !signal.aborted) {
          const page = next++;
          try {
            const result = await fetchPage(page);
            // ページの境目が新しい便でずれても、id で重複を除けば同じ便を 2 回数えない
            for (const f of result.flights) data.flights.set(f.id, f);
          } catch {
            if (signal.aborted) return;
            this.pages.failed++;
          }
          this.pages.done++;
          this.scheduleRender();
        }
      };
      await Promise.all(Array.from({ length: PAGE_CONCURRENCY }, worker));
      if (signal.aborted) return;
      data.complete = this.pages.failed === 0;
      data.at = Date.now();
      memo.set(user.toLowerCase(), data);
      window.clearTimeout(this.renderTimer);
      this.renderTimer = 0;
      this.render();
    } catch (error) {
      if (signal.aborted) return;
      this.error = (error as Error).message;
      this.render();
    }
  }

  private scheduleRender(): void {
    if (this.renderTimer) return;
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = 0;
      this.render();
    }, RENDER_MS);
  }

  private get loading(): boolean {
    return !this.error && (!this.data || this.pages.done < this.pages.total);
  }

  private render(): void {
    if (!this.user) return;
    const head = this.root.querySelector<HTMLElement>('.st-head')!;
    const body = this.root.querySelector<HTMLElement>('.st-body')!;
    head.innerHTML = this.renderHead();

    if (this.error && !this.data) {
      body.innerHTML = `<div class="st-empty"><b>Could not load flights</b>${esc(this.error)}<button type="button" class="btn btn-tertiary btn-sm" data-action="retry">Try again</button></div>`;
      return;
    }
    if (!this.data) {
      body.innerHTML = `<div class="st-loading"><div class="skeleton" style="height:64px"></div><div class="skeleton" style="height:120px"></div><div class="skeleton" style="height:180px"></div></div>`;
      return;
    }

    const s = (this.summary = summarize(this.data.flights.values(), this.period, this.handlers.airport));
    body.innerHTML = [
      this.renderProgress(),
      this.renderPeriod(),
      s.flights ? this.renderOverview(s) : `<div class="st-empty">${this.loading ? 'Loading…' : 'No flights in this period.'}</div>`,
      s.flights ? this.renderActivity(s) : '',
      s.routes.length ? this.renderRank('routes', 'Top routes', s.routes, (r) => this.routeRow(r as RouteTally)) : '',
      s.airports.length ? this.renderRank('airports', 'Top airports', s.airports, (a) => this.airportRow(a as AirportTally)) : '',
      s.aircraft.length ? this.renderRank('aircraft', 'Top aircraft', s.aircraft, (t) => ({ main: esc(t.key), sub: `${hours(t.minutes)} flown` })) : '',
      s.airlines.length ? this.renderRank('airlines', 'Top airlines / liveries', s.airlines, (t) => ({ main: esc(t.key), sub: `${hours(t.minutes)} flown` })) : '',
      s.flights ? this.renderSplit(s) : '',
      this.renderFoot(s)
    ].join('');
    this.drawMap(s);
  }

  private renderHead(): string {
    const p = this.data?.profile;
    const name = p?.ifc || this.user || '';
    const sub = [p ? `Grade ${p.grade}` : '', p?.va ?? ''].filter(Boolean).join(' · ');
    return `<div class="pilot-avatar" aria-hidden="true">${esc((name[0] || '?').toUpperCase())}</div>
      <div class="titles">
        <h2>${esc(name)}</h2>
        <div class="sub">Flight stats${sub ? ` · ${esc(sub)}` : ''} · <a href="${IFC_PROFILE}${encodeURIComponent(name)}" target="_blank" rel="noopener">IFC profile</a></div>
      </div>
      <button type="button" class="icon-btn" data-action="close" aria-label="Close stats">${ICON_CLOSE}</button>`;
  }

  private renderProgress(): string {
    if (!this.loading || !this.data) return '';
    const total = Math.min(this.data.totalCount, this.pages.total * 100);
    const done = Math.min(total, this.data.flights.size);
    const pct = total ? Math.round((done / total) * 100) : 0;
    return `<div class="st-progress" role="status">
      <div>Reading flight log… <b>${fmt.int(done)}</b> / ${fmt.int(total)} flights</div>
      <div class="progress"><i style="width:${pct}%"></i></div>
    </div>`;
  }

  private renderPeriod(): string {
    const options: Array<[Period, string]> = [
      ['all', 'All time'],
      ['1y', '12 months'],
      ['30d', '30 days']
    ];
    return `<div class="seg st-period" role="group" aria-label="Period">${options
      .map(([value, label]) => `<button type="button" data-period="${value}" aria-pressed="${value === this.period}">${label}</button>`)
      .join('')}</div>`;
  }

  private renderOverview(s: Summary): string {
    const cells: Array<[string, string, string]> = [
      ['Flights', fmt.int(s.flights), ''],
      ['Flight time', fmt.int(s.minutes / 60), 'h'],
      ['Distance', s.distance ? fmt.int(s.distance) : '—', s.distance ? 'nm' : ''],
      ['Landings', fmt.int(s.landings), ''],
      ['Airports', fmt.int(s.airports.length), ''],
      ['Aircraft types', fmt.int(s.aircraft.length), '']
    ];
    const notes: string[] = [];
    if (s.longest && s.longest.minutes >= 1) {
      const l = s.longest;
      const route = l.origin && l.destination ? `${l.origin} → ${l.destination}` : l.origin || l.destination || '';
      notes.push(`<li><span>Longest flight</span><b>${fmt.duration(l.minutes)}</b>${esc([route, l.aircraft].filter(Boolean).join(' · '))}</li>`);
    }
    if (s.farthest && s.farthest.nm) {
      notes.push(`<li><span>Longest route</span><b>${fmt.int(s.farthest.nm)} nm</b>${esc(`${s.farthest.a} ⇄ ${s.farthest.b}`)}</li>`);
    }
    if (s.flights) {
      const avg = s.minutes / s.flights;
      notes.push(`<li><span>Average flight</span><b>${fmt.duration(avg)}</b>${fmt.int(s.xp)} XP earned</li>`);
    }
    return `<div class="st-grid">${cells
      .map(([k, v, u]) => `<div><div class="k">${k}</div><div class="v">${v}${u ? `<small>${u}</small>` : ''}</div></div>`)
      .join('')}</div>${notes.length ? `<ul class="st-notes">${notes.join('')}</ul>` : ''}`;
  }

  private renderActivity(s: Summary): string {
    const max = Math.max(1, ...s.buckets.map((b) => b.n));
    if (!s.buckets.some((b) => b.n)) return '';
    return `<section class="st-sec"><h3>Activity</h3><div class="st-chart">${s.buckets
      .map(
        (b) => `<div class="col" title="${esc(`${b.title} · ${fmt.int(b.n)} flights · ${hours(b.minutes)}`)}">
          <i style="height:${b.n ? Math.max(4, (b.n / max) * 100) : 0}%"></i><span>${esc(b.label)}</span></div>`
      )
      .join('')}</div></section>`;
  }

  private airportName(icao: string): string {
    const pin = this.handlers.airport(icao);
    return pin && pin.name !== icao ? pin.name : '';
  }

  private routeRow(r: RouteTally) {
    const names = [this.airportName(r.a), this.airportName(r.b)].filter(Boolean).join(' – ');
    const meta = [r.nm ? `${fmt.int(r.nm)} nm` : '', `avg ${fmt.duration(r.minutes / r.n)}`].filter(Boolean).join(' · ');
    return { main: `${esc(r.a)} <span class="dim">⇄</span> ${esc(r.b)}`, sub: esc([names, meta].filter(Boolean).join(' · ')), data: `data-route="${esc(r.key)}"` };
  }

  private airportRow(a: AirportTally) {
    const name = this.airportName(a.key);
    return { main: esc(a.key), sub: esc([name, `${fmt.int(a.dep)} dep · ${fmt.int(a.arr)} arr`].filter(Boolean).join(' · ')), data: `data-airport="${esc(a.key)}"` };
  }

  private renderRank(id: string, title: string, items: Tally[], row: (t: Tally) => { main: string; sub: string; data?: string }): string {
    const open = this.expanded.has(id);
    const shown = items.slice(0, open ? LIST_LONG : LIST_SHORT);
    const max = items[0]?.n || 1;
    const rows = shown
      .map((t, i) => {
        const r = row(t);
        const tag = r.data ? 'button type="button"' : 'div';
        const end = r.data ? 'button' : 'div';
        return `<li><${tag} class="rank-row" ${r.data ?? ''}>
          <span class="r-no">${i + 1}</span>
          <span class="r-body"><b>${r.main}</b><small>${r.sub}</small><i class="r-bar" style="width:${Math.max(2, (t.n / max) * 100)}%"></i></span>
          <span class="r-n">${fmt.int(t.n)}</span>
        </${end}></li>`;
      })
      .join('');
    const more =
      items.length > LIST_SHORT
        ? `<button type="button" class="link-btn st-more" data-more="${id}">${open ? 'Show less' : `Show more (${fmt.int(Math.min(items.length, LIST_LONG))})`}</button>`
        : '';
    return `<section class="st-sec"><h3>${title}<span>${fmt.int(items.length)}</span></h3><ol class="rank">${rows}</ol>${more}</section>`;
  }

  private renderSplit(s: Summary): string {
    const total = s.flights || 1;
    const colors = ['var(--secondary)', 'var(--primary)', 'var(--atc)', '#c58af9', 'var(--outline)'];
    const servers = s.servers.map((t, i) => ({
      label: t.key,
      value: t.n,
      color: t.key === 'Other' || t.key === 'Unknown' ? colors[colors.length - 1] : colors[Math.min(i, colors.length - 2)]
    }));
    const day = Math.max(0, s.minutes - s.night);
    const time = [
      { label: 'Day', value: day, color: 'var(--secondary)' },
      { label: 'Night', value: s.night, color: '#5b6bd6' }
    ].filter((p) => p.value);
    const bar = (parts: Array<{ label: string; value: number; color: string }>, sum: number, unit: (v: number) => string) =>
      `<div class="st-stack">${parts.map((p) => `<i style="flex:${p.value};background:${p.color}"></i>`).join('')}</div>
      <ul class="st-legend">${parts
        .map(
          (p) =>
            `<li><i style="background:${p.color}"></i><span class="lg-k">${esc(p.label)}<b>${Math.round((p.value / sum) * 100)}%</b></span><span class="lg-v">${unit(p.value)}</span></li>`
        )
        .join('')}</ul>`;
    return `<section class="st-sec"><h3>Servers</h3>${bar(servers, total, (v) => `${fmt.int(v)} flights`)}</section>
      ${time.length ? `<section class="st-sec"><h3>Day / night</h3>${bar(time, s.minutes || 1, (v) => `${fmt.int(v / 60)}h`)}</section>` : ''}`;
  }

  private renderFoot(s: Summary | null): string {
    const lines = ['From the Infinite Flight flight log.'];
    if (s?.skipped) lines.push(`${fmt.int(s.skipped)} sessions under a minute without a landing are not counted.`);
    if (this.period !== 'all' && s) lines.push('Flights without a date are only in All time.');
    if (this.data && this.data.totalCount > this.pages.total * 100) lines.push(`Only the latest ${fmt.int(this.pages.total * 100)} flights are included.`);
    if (!this.loading && this.pages.failed) {
      lines.push(`${fmt.int(this.pages.failed * 100)} flights could not be loaded. <button type="button" class="link-btn" data-action="retry">Reload</button>`);
    }
    return `<p class="st-foot">${lines.join(' ')}</p>`;
  }

  // -------------------------------------------------------------------------
  // 地図
  // -------------------------------------------------------------------------

  private drawMap(s: Summary): void {
    const globe = this.globe;
    if (!globe) return;
    const lookup = this.handlers.airport;
    const top = s.airports.find((a) => lookup(a.key));
    if (!top) {
      globe.setData([], []);
      return;
    }
    // 一番よく使う空港を基準に経度を揃え、路線が日付変更線で切れないようにする
    const home = lookup(top.key)!;
    const ref = home.lon;

    const routes = s.routes.slice(0, MAP_ROUTES);
    const maxRoute = routes[0]?.n || 1;
    const lines: GlobeRoute[] = [];
    for (const r of routes) {
      const a = lookup(r.a);
      const b = lookup(r.b);
      if (!a || !b) continue;
      const coords = greatCircle(a, b, wrapNear(a.lon, ref)).map(([lat, lon]) => [lon, lat] as [number, number]);
      lines.push({ coords, t: Math.sqrt(r.n / maxRoute) });
    }

    const airports = s.airports.slice(0, MAP_AIRPORTS);
    const maxAirport = airports[0]?.n || 1;
    const points: GlobeAirport[] = [];
    let [w, south, e, north] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const a of airports) {
      const p = lookup(a.key);
      if (!p) continue;
      const lon = wrapNear(p.lon, ref);
      [w, e, south, north] = [Math.min(w, lon), Math.max(e, lon), Math.min(south, p.lat), Math.max(north, p.lat)];
      points.push({
        lon: p.lon,
        lat: p.lat,
        t: Math.sqrt(a.n / maxAirport),
        html: `<b>${esc(a.key)}</b> ${esc(this.airportName(a.key))}<br>${fmt.int(a.n)} flights · ${fmt.int(a.dep)} dep · ${fmt.int(a.arr)} arr`
      });
    }
    globe.setData(lines, points);

    const firstPage = this.pages.done === 1 && this.loading;
    if (!this.fitted && points.length && (!this.loading || firstPage)) {
      // 最初のページが届いた時点で一度寄せ、全部読み終えたらもう一度合わせる
      if (!this.loading) this.fitted = true;
      this.fit([[w, south], [e, north]], [home.lon, home.lat], 6);
    }
  }

  /** パネルに隠れない範囲に収める。 */
  private fit(bounds: [[number, number], [number, number]], focus: [number, number] | null, maxZoom: number): void {
    const host = this.globeHost.getBoundingClientRect();
    const rect = this.root.getBoundingClientRect();
    const sheet = rect.width >= host.width - 1;
    const pad = 32;
    const padding: Padding = {
      top: pad,
      right: pad,
      left: sheet ? pad : Math.max(pad, rect.right - host.left + pad),
      bottom: sheet ? Math.max(pad, host.bottom - rect.top + pad) : pad
    };
    this.globe?.fit(bounds, padding, focus, maxZoom);
  }

  private showRoute(key: string): void {
    const r = this.summary?.routes.find((x) => x.key === key);
    const a = r && this.handlers.airport(r.a);
    const b = r && this.handlers.airport(r.b);
    if (!r || !a || !b || !this.globe) return;
    const coords = greatCircle(a, b, a.lon).map(([lat, lon]) => [lon, lat] as [number, number]);
    this.globe.highlight(coords, [
      { lon: a.lon, lat: a.lat, text: a.icao },
      { lon: b.lon, lat: b.lat, text: b.icao }
    ]);
    const lons = coords.map((c) => c[0]);
    const lats = coords.map((c) => c[1]);
    this.fit([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], null, 8);
  }

  private showAirport(icao: string): void {
    const p = this.handlers.airport(icao);
    if (!p || !this.globe) return;
    this.globe.highlight(null, [{ lon: p.lon, lat: p.lat, text: p.icao }]);
    this.fit([[p.lon, p.lat], [p.lon, p.lat]], null, 8);
  }

  private onClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    const el = target.closest<HTMLElement>('[data-action],[data-period],[data-more],[data-route],[data-airport]');
    if (!el) return;
    if (el.dataset.action === 'close') {
      this.handlers.onClose();
    } else if (el.dataset.action === 'retry') {
      const user = this.user;
      if (!user) return;
      memo.delete(user.toLowerCase());
      this.user = null;
      this.open(user);
    } else if (el.dataset.period) {
      this.period = el.dataset.period as Period;
      this.fitted = false;
      this.globe?.highlight(null);
      this.render();
    } else if (el.dataset.more) {
      const id = el.dataset.more;
      if (this.expanded.has(id)) this.expanded.delete(id);
      else this.expanded.add(id);
      this.render();
    } else if (el.dataset.route) {
      this.showRoute(el.dataset.route);
    } else if (el.dataset.airport) {
      this.showAirport(el.dataset.airport);
    }
  }
}
