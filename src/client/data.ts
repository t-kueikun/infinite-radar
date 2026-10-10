/** API との型とデータ整形、単位計算。DOM には触れない。 */

export type Session = { id: string; name: string; users: number; worldType: number };

export type Flight = {
  id: string;
  callsign: string;
  username: string;
  lat: number;
  lon: number;
  alt: number;
  gs: number;
  track: number;
  vs: number;
  aircraft: string;
  livery: string;
  va: string;
  lastReport: number;
  /** 受信時点で lastReport から何秒経っていたか（デッドレコニングの起点） */
  ageAtReceipt: number;
  receivedAt: number;
};

export type AirportPin = { icao: string; iata: string; name: string; lat: number; lon: number; cls: number };
export type Airport = { icao: string; iata: string | null; name: string; city: string | null; country: string | null };
export type PlanPoint = [name: string, lat: number, lon: number];
export type TrackPoint = [lat: number, lon: number, alt: number, time: number];
export type FlightDetail = { plan: PlanPoint[]; origin: Airport | null; destination: Airport | null; track: TrackPoint[] };
export type Photo = { id: string; thumb: string; page: string; photographer: string; airport: string | null; category: string };
export type PhotoResult = { total: number; photos: Photo[] };

type CompactRow = [string, string, string, number, number, number, number, number, number, number, string, number];
type CompactFlights = { t: number; types: Array<[string, string]>; f: CompactRow[] };

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      message = ((await response.json()) as { error?: string }).error || message;
    } catch {
      /* 本文が JSON でなければステータスだけ出す */
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export function fetchSessions(): Promise<Session[]> {
  return getJson('/api/sessions');
}

export async function fetchFlights(sessionId: string, signal?: AbortSignal): Promise<Flight[]> {
  const data = await getJson<CompactFlights>(`/api/flights?sessionId=${encodeURIComponent(sessionId)}`, signal);
  const receivedAt = performance.now();
  const serverSec = data.t / 1000;

  return data.f.map((r) => {
    const [aircraft, livery] = data.types[r[9]] ?? ['', ''];
    return {
      id: r[0],
      callsign: r[1],
      username: r[2],
      lat: r[3],
      lon: r[4],
      alt: r[5],
      gs: r[6],
      track: r[7],
      vs: r[8],
      aircraft,
      livery,
      va: r[10],
      lastReport: r[11],
      ageAtReceipt: Math.max(0, serverSec - r[11]),
      receivedAt
    };
  });
}

export async function fetchAirportPins(): Promise<AirportPin[]> {
  const data = await getJson<{ a: Array<[string, string, string, number, number, number]> }>('/api/airports');
  // 小さい空港から描き、大きい空港のピンを上に重ねる
  return data.a.map(([icao, iata, name, lat, lon, cls]) => ({ icao, iata, name, lat, lon, cls })).sort((a, b) => a.cls - b.cls);
}

// ---------------------------------------------------------------------------
// ATC
// ---------------------------------------------------------------------------

export type AtcFacility = { airport: string; type: number; username: string; lat: number; lon: number; since: number };
/** 1 つの空港（またはセンター管制官 1 人）にまとめた ATC。types は表示順に並べた周波数種別。 */
export type AtcStation = { key: string; icao: string; lat: number; lon: number; types: number[]; controllers: string[]; since: number };
export type WorldState = { stations: AtcStation[]; centers: AtcStation[]; traffic: Map<string, [number, number]> };

export const ATC_TYPES: Record<number, { short: string; name: string }> = {
  0: { short: 'G', name: 'Ground' },
  1: { short: 'T', name: 'Tower' },
  2: { short: 'U', name: 'Unicom' },
  3: { short: 'C', name: 'Clearance' },
  4: { short: 'A', name: 'Approach' },
  5: { short: 'D', name: 'Departure' },
  6: { short: 'CTR', name: 'Center' },
  7: { short: 'I', name: 'ATIS' }
};
// 実際の管制の流れ（ATIS → デリバリー → グラウンド → タワー → 出発 → 進入）の順に並べる
const ATC_ORDER = [7, 3, 0, 1, 5, 4, 6, 2];

export async function fetchWorld(sessionId: string, signal?: AbortSignal): Promise<WorldState> {
  const data = await getJson<{ atc: Array<[string, number, string, number, number, number]>; traffic: Record<string, [number, number]> }>(
    `/api/world?sessionId=${encodeURIComponent(sessionId)}`,
    signal
  );
  const groups = new Map<string, AtcStation>();
  for (const [airport, type, username, lat, lon, since] of data.atc) {
    const key = airport || `CTR:${username}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, icao: airport, lat, lon, types: [], controllers: [], since }));
    if (!g.types.includes(type)) g.types.push(type);
    if (username && !g.controllers.includes(username)) g.controllers.push(username);
    if (since && (!g.since || since < g.since)) g.since = since;
  }
  const rank = (t: number) => (ATC_ORDER.includes(t) ? ATC_ORDER.indexOf(t) : 99);
  const all = [...groups.values()];
  for (const g of all) g.types.sort((a, b) => rank(a) - rank(b));
  const byIcao = (a: AtcStation, b: AtcStation) => a.icao.localeCompare(b.icao);
  return {
    stations: all.filter((g) => g.icao).sort(byIcao),
    centers: all.filter((g) => !g.icao),
    traffic: new Map(Object.entries(data.traffic))
  };
}

export function fetchAirportFlights(sessionId: string, icao: string, signal?: AbortSignal): Promise<{ inbound: string[]; outbound: string[] }> {
  return getJson(`/api/airport-flights?sessionId=${encodeURIComponent(sessionId)}&icao=${encodeURIComponent(icao)}`, signal);
}

export type LocatedFlight = { sessionId: string; server: string; flightId: string; callsign: string };

/** IFC ユーザー名から、いま飛んでいるサーバーと便を探す。 */
export async function fetchLocate(username: string): Promise<LocatedFlight | null> {
  const data = await getJson<{ flight: LocatedFlight | null }>(`/api/locate?username=${encodeURIComponent(username)}`);
  return data.flight;
}

export function fetchFlightDetail(sessionId: string, flightId: string, signal?: AbortSignal): Promise<FlightDetail> {
  return getJson(`/api/flights/${encodeURIComponent(flightId)}?sessionId=${encodeURIComponent(sessionId)}`, signal);
}

const photoCache = new Map<string, Promise<PhotoResult>>();

export function fetchPhotos(aircraft: string, livery: string): Promise<PhotoResult> {
  if (!aircraft || !livery) return Promise.resolve({ total: 0, photos: [] });
  const key = `${aircraft}|${livery}`;
  let pending = photoCache.get(key);
  if (!pending) {
    pending = getJson<PhotoResult>(`/api/photos?aircraft=${encodeURIComponent(aircraft)}&livery=${encodeURIComponent(livery)}`)
      .catch(() => ({ total: 0, photos: [] }));
    photoCache.set(key, pending);
  }
  return pending;
}

// ---------------------------------------------------------------------------
// 位置計算
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;
const MAX_EXTRAPOLATE_SEC = 45;

export function isOnGround(f: Flight): boolean {
  return f.gs < 50;
}

/** 最後の報告位置から速度と針路で現在位置を推定する。 */
export function extrapolate(f: Flight, now: number): [number, number] {
  if (f.gs < 3) return [f.lat, f.lon];
  const dt = Math.min(MAX_EXTRAPOLATE_SEC, f.ageAtReceipt + (now - f.receivedAt) / 1000);
  const nm = (f.gs * dt) / 3600;
  const lat = f.lat + (nm * Math.cos(f.track * DEG)) / 60;
  const cosLat = Math.max(0.05, Math.cos(f.lat * DEG));
  let lon = f.lon + (nm * Math.sin(f.track * DEG)) / (60 * cosLat);
  if (lon > 180) lon -= 360;
  if (lon < -180) lon += 360;
  return [lat, lon];
}

export function distanceNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** 経度の連続性を保つ（日付変更線をまたいでも線が地球を一周しないように）。 */
export function unwrapLongitudes<T extends [number, number]>(points: T[], referenceLon?: number): T[] {
  const out: T[] = [];
  let prev = referenceLon;
  for (const p of points) {
    let lon = p[1];
    if (prev !== undefined) {
      while (lon - prev > 180) lon -= 360;
      while (lon - prev < -180) lon += 360;
    }
    out.push([p[0], lon] as T);
    prev = lon;
  }
  return out;
}

export type Progress = {
  total: number;
  remaining: number;
  /** 現在位置から先の飛行計画（現在位置を先頭に含む） */
  ahead: Array<[number, number]>;
};

/** 飛行計画に沿った総距離・残距離を求める。 */
export function planProgress(plan: PlanPoint[], lat: number, lon: number): Progress | null {
  if (plan.length < 2) return null;

  let nearest = 0;
  let best = Infinity;
  for (let i = 0; i < plan.length; i++) {
    const d = distanceNm(lat, lon, plan[i][1], plan[i][2]);
    if (d < best) {
      best = d;
      nearest = i;
    }
  }
  // 最寄り点をすでに通過しているなら次の点から数える
  let next = nearest;
  if (nearest < plan.length - 1) {
    const legLen = distanceNm(plan[nearest][1], plan[nearest][2], plan[nearest + 1][1], plan[nearest + 1][2]);
    const toNext = distanceNm(lat, lon, plan[nearest + 1][1], plan[nearest + 1][2]);
    if (toNext < legLen) next = nearest + 1;
  }

  let total = 0;
  for (let i = 1; i < plan.length; i++) total += distanceNm(plan[i - 1][1], plan[i - 1][2], plan[i][1], plan[i][2]);

  let remaining = distanceNm(lat, lon, plan[next][1], plan[next][2]);
  for (let i = next + 1; i < plan.length; i++) remaining += distanceNm(plan[i - 1][1], plan[i - 1][2], plan[i][1], plan[i][2]);

  const ahead: Array<[number, number]> = [[lat, lon], ...plan.slice(next).map((p) => [p[1], p[2]] as [number, number])];
  return { total, remaining, ahead };
}

// ---------------------------------------------------------------------------
// 表示用フォーマット
// ---------------------------------------------------------------------------

const intFmt = new Intl.NumberFormat('en-US');

export const fmt = {
  int: (n: number) => intFmt.format(Math.round(n)),
  alt: (ft: number) => intFmt.format(Math.round(ft / 10) * 10),
  vs: (fpm: number) => {
    const v = Math.round(fpm / 10) * 10;
    return `${v > 0 ? '+' : ''}${intFmt.format(v)}`;
  },
  heading: (deg: number) => String(Math.round(((deg % 360) + 360) % 360)).padStart(3, '0'),
  duration: (minutes: number) => {
    const m = Math.max(0, Math.round(minutes));
    return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
  },
  utc: (date: Date) => `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`,
  ago: (sec: number) => (sec < 60 ? `${Math.max(0, Math.round(sec))}s ago` : `${Math.round(sec / 60)}m ago`)
};

export function phaseOf(f: Flight): string {
  if (isOnGround(f)) return f.gs > 5 ? 'Taxiing' : 'On ground';
  if (f.vs > 300) return 'Climbing';
  if (f.vs < -300) return 'Descending';
  return 'Cruising';
}
