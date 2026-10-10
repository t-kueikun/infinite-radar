"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const path_1 = __importDefault(require("path"));
const express_1 = __importDefault(require("express"));
const compression_1 = __importDefault(require("compression"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config({ path: ['.env.local', '.env'] });
const app = (0, express_1.default)();
const PORT = Number(process.env.PORT || 3000);
const IF_API_BASE = 'https://api.infiniteflight.com/public/v2';
const IFSPOTTERS_BASE = (process.env.IFSPOTTERS_BASE_URL || 'https://ifspotters.com').replace(/\/$/, '');
const API_KEY = process.env.INFINITE_FLIGHT_API_KEY;
const PUBLIC_DIR = path_1.default.join(__dirname, '../public');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const TTL = {
    sessions: 5 * MINUTE,
    flights: 10 * SECOND,
    liveries: 6 * 60 * MINUTE,
    flightDetail: 30 * SECOND,
    airport: 24 * 60 * MINUTE,
    airports: 6 * 60 * MINUTE,
    photos: 10 * MINUTE,
    pilot: 5 * MINUTE,
    pilotFlights: 2 * MINUTE,
    world: 30 * SECOND
};
function httpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}
const cache = new Map();
const CACHE_MAX_ENTRIES = 2000;
async function cached(key, ttlMs, load) {
    const now = Date.now();
    const entry = cache.get(key);
    if (entry?.value !== undefined && now < entry.expiresAt)
        return entry.value;
    if (entry?.pending)
        return entry.pending;
    const pending = load()
        .then((value) => {
        cache.set(key, { value, expiresAt: Date.now() + ttlMs });
        return value;
    })
        .catch((error) => {
        // 上流が落ちていても直前の値があればそれを返す
        if (entry?.value !== undefined) {
            cache.set(key, { value: entry.value, expiresAt: Date.now() + 5 * SECOND });
            return entry.value;
        }
        cache.delete(key);
        throw error;
    });
    cache.set(key, { ...entry, expiresAt: entry?.expiresAt ?? 0, pending });
    if (cache.size > CACHE_MAX_ENTRIES) {
        for (const [k, v] of cache) {
            if (!v.pending && v.expiresAt < now)
                cache.delete(k);
        }
    }
    return pending;
}
async function ifApi(endpoint, payload) {
    if (!API_KEY)
        throw httpError(500, 'INFINITE_FLIGHT_API_KEY is not set');
    const response = await fetch(`${IF_API_BASE}${endpoint}`, {
        method: payload === undefined ? 'GET' : 'POST',
        headers: {
            Authorization: `Bearer ${API_KEY}`,
            Accept: 'application/json',
            ...(payload === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        body: payload === undefined ? undefined : JSON.stringify(payload)
    });
    if (!response.ok)
        throw httpError(response.status, `Infinite Flight API ${endpoint} -> HTTP ${response.status}`);
    const body = (await response.json());
    if (body.errorCode !== 0)
        throw httpError(502, `Infinite Flight API ${endpoint} -> errorCode ${body.errorCode}`);
    return body.result;
}
/** UUID(36 文字) ⇄ base64url(22 文字)。フライト一覧で最もかさむ列を縮める。 */
function packId(uuid) {
    const hex = uuid.replace(/-/g, '');
    return /^[0-9a-f]{32}$/i.test(hex) ? Buffer.from(hex, 'hex').toString('base64url') : uuid;
}
function unpackId(id) {
    if (!/^[A-Za-z0-9_-]{22}$/.test(id))
        return id;
    const hex = Buffer.from(id, 'base64url').toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function round(value, digits) {
    const p = 10 ** digits;
    return Math.round(value * p) / p;
}
async function getLiveries() {
    return cached('liveries', TTL.liveries, async () => {
        const list = await ifApi('/aircraft/liveries');
        return new Map(list.map((l) => [l.id, l]));
    });
}
async function getSessions() {
    return cached('sessions', TTL.sessions, async () => {
        const sessions = await ifApi('/sessions');
        return sessions
            .map((s) => ({ id: s.id, name: s.name, users: s.userCount, worldType: s.worldType }))
            .sort((a, b) => a.worldType - b.worldType);
    });
}
/**
 * フライト一覧をコンパクトな配列形式に変換する。
 * 生の JSON は Expert で 2MB 超になるので、必要な列だけを固定順の配列で返し、
 * 機種/リバリー名は types テーブルに重複排除して添字で参照させる。
 *
 * f[i] = [flightId, callsign, username, lat, lon, altFt, gsKt, track, vsFpm, typeIndex, va, lastReportEpochSec]
 * types[j] = [aircraftName, liveryName]
 */
/** sessionId → (圧縮した flightId → userId)。パイロット情報の取得用で、クライアントには送らない */
const flightUsers = new Map();
async function getCompactFlights(sessionId) {
    return cached(`flights:${sessionId}`, TTL.flights, async () => {
        const [flights, liveries] = await Promise.all([
            ifApi(`/sessions/${encodeURIComponent(sessionId)}/flights`),
            getLiveries().catch(() => new Map())
        ]);
        flightUsers.set(sessionId, new Map(flights.map((f) => [packId(f.flightId), f.userId])));
        const types = [];
        const typeIndex = new Map();
        const rows = flights.map((f) => {
            let idx = typeIndex.get(f.liveryId);
            if (idx === undefined) {
                const livery = liveries.get(f.liveryId);
                idx = types.length;
                types.push([livery?.aircraftName ?? '', livery?.liveryName ?? '']);
                typeIndex.set(f.liveryId, idx);
            }
            return [
                packId(f.flightId),
                f.callsign || '',
                f.username || '',
                round(f.latitude, 4),
                round(f.longitude, 4),
                Math.round(f.altitude),
                Math.round(f.speed),
                Math.round(f.speed > 1 ? f.track : f.heading),
                Math.round(f.verticalSpeed),
                idx,
                f.virtualOrganization || '',
                Math.round(Date.parse(f.lastReport) / 1000) || 0
            ];
        });
        return { t: Date.now(), types, f: rows };
    });
}
/** IFC ユーザー名で、いまどのサーバーを飛んでいるかを探す（ログイン中の「自分の機体」用）。 */
async function locateUser(username) {
    const name = username.toLowerCase();
    const sessions = await getSessions();
    const found = await Promise.all(sessions.map(async (s) => {
        const data = await getCompactFlights(s.id).catch(() => null);
        const row = data?.f.find((r) => String(r[2]).toLowerCase() === name);
        return row ? { sessionId: s.id, server: s.name, flightId: String(row[0]), callsign: String(row[1]) } : null;
    }));
    return found.find((f) => f !== null) ?? null;
}
/** 入れ子になった飛行計画を [名前, lat, lon] の平らな列にする。 */
function flattenPlan(items, out = []) {
    for (const item of items) {
        const loc = item.location;
        if (loc && (loc.latitude !== 0 || loc.longitude !== 0)) {
            out.push([item.identifier || item.name, round(loc.latitude, 4), round(loc.longitude, 4)]);
        }
        if (item.children?.length)
            flattenPlan(item.children, out);
    }
    return out;
}
function isAirportCode(code) {
    return !!code && /^[A-Z0-9]{3,4}$/.test(code);
}
async function getAirport(icao) {
    return cached(`airport:${icao}`, TTL.airport, async () => {
        const a = await ifApi(`/airport/${encodeURIComponent(icao)}`);
        return { icao: a.icao, iata: a.iata, name: a.name, city: a.city, country: a.country?.isoCode ?? null };
    }).catch(() => ({ icao, iata: null, name: '', city: null, country: null }));
}
/**
 * 空港の規模を 0〜3 で見積もる。IF の class は規模と一致しない（EDDM が 1 など）ので、
 * 周波数の数とボーディングブリッジの有無から判断する。
 */
function airportTier(a) {
    const freqs = a.frequenciesCount ?? 0;
    if (a.hasJetbridges && freqs >= 10)
        return 3;
    if (a.hasJetbridges || (a.iata && freqs >= 5))
        return 2;
    if (a.iata)
        return 1;
    return 0;
}
/** 地図のピン用の空港一覧。a[i] = [icao, iata, name, lat, lon, tier] */
async function getAirportPins() {
    return cached('airports', TTL.airports, async () => {
        const list = await ifApi('/airports');
        return {
            a: list
                .filter((a) => Number.isFinite(a.latitude) && Number.isFinite(a.longitude))
                .map((a) => [a.icao, a.iata || '', a.name, round(a.latitude, 4), round(a.longitude, 4), airportTier(a)])
        };
    });
}
async function getFlightDetail(sessionId, flightId) {
    return cached(`detail:${sessionId}:${flightId}`, TTL.flightDetail, async () => {
        const base = `/sessions/${encodeURIComponent(sessionId)}/flights/${encodeURIComponent(flightId)}`;
        const [plan, route] = await Promise.all([
            ifApi(`${base}/flightplan`).catch(() => null),
            ifApi(`${base}/route`).catch(() => [])
        ]);
        const planPoints = plan ? flattenPlan(plan.flightPlanItems || []) : [];
        const waypoints = plan?.waypoints ?? [];
        const originCode = waypoints[0];
        const destCode = waypoints[waypoints.length - 1];
        const [origin, destination] = await Promise.all([
            isAirportCode(originCode) ? getAirport(originCode) : null,
            isAirportCode(destCode) && destCode !== originCode ? getAirport(destCode) : null
        ]);
        // 飛行軌跡は [lat, lon, altFt, epochSec]。間引いて最大 600 点に抑える
        const step = Math.max(1, Math.ceil(route.length / 600));
        const track = route
            .filter((_, i) => i % step === 0 || i === route.length - 1)
            .map((p) => [round(p.latitude, 4), round(p.longitude, 4), Math.round(p.altitude), Math.round(Date.parse(p.date) / 1000)]);
        return { plan: planPoints, origin, destination, track };
    });
}
async function getWorld(sessionId) {
    return cached(`world:${sessionId}`, TTL.world, async () => {
        const base = `/sessions/${encodeURIComponent(sessionId)}`;
        const [atc, world] = await Promise.all([
            ifApi(`${base}/atc`),
            ifApi(`${base}/world`).catch(() => [])
        ]);
        // traffic[icao] = [到着予定数, 出発数]。便 ID の一覧は空港フィルター用にサーバー側だけで持つ
        const traffic = {};
        const routes = new Map();
        for (const s of world) {
            if (!s.inboundFlightsCount && !s.outboundFlightsCount)
                continue;
            traffic[s.airportIcao] = [s.inboundFlightsCount, s.outboundFlightsCount];
            routes.set(s.airportIcao, { inbound: s.inboundFlights.map(packId), outbound: s.outboundFlights.map(packId) });
        }
        return {
            // atc[i] = [airportIcao（センターは ""）, 種別, 管制官, lat, lon, 開始 epochSec]
            atc: atc.map((a) => [
                a.airportName || '',
                a.type,
                a.username || '',
                round(a.latitude, 4),
                round(a.longitude, 4),
                Math.round(Date.parse(a.startTime.replace(' ', 'T')) / 1000) || 0
            ]),
            traffic,
            routes
        };
    });
}
async function getPilot(sessionId, flightId) {
    if (!flightUsers.has(sessionId))
        await getCompactFlights(sessionId);
    const userId = flightUsers.get(sessionId)?.get(flightId);
    if (!userId)
        throw httpError(404, 'Flight not found');
    const [stats, flights, liveries] = await Promise.all([
        cached(`pilot:${userId}`, TTL.pilot, async () => (await ifApi('/users', { userIds: [userId] }))[0] ?? null),
        cached(`pilotFlights:${userId}`, TTL.pilotFlights, () => ifApi(`/users/${encodeURIComponent(userId)}/flights?page=1`).then((r) => r.data)).catch(() => []),
        getLiveries().catch(() => new Map())
    ]);
    return {
        profile: stats && {
            ifc: stats.discourseUsername || '',
            va: stats.virtualOrganization || '',
            grade: stats.grade,
            xp: stats.xp,
            flightMinutes: Math.round(stats.flightTime),
            landings: stats.landingCount,
            onlineFlights: stats.onlineFlights,
            violations: stats.violations,
            atcOperations: stats.atcOperations
        },
        // history[i] = [開始 epochSec, callsign, server, 出発, 到着, 機種, リバリー, 飛行分, 着陸数, XP, 違反数]
        history: [...flights]
            .sort((a, b) => Date.parse(b.created) - Date.parse(a.created))
            .slice(0, 10)
            .map((f) => {
            const livery = liveries.get(f.liveryId);
            return [
                Math.round(Date.parse(f.created) / 1000) || 0,
                f.callsign || '',
                f.server || '',
                f.originAirport || '',
                f.destinationAirport || '',
                livery?.aircraftName ?? '',
                livery?.liveryName ?? '',
                Math.round(f.totalTime),
                f.landingCount,
                f.xp,
                f.violations?.length ?? 0
            ];
        })
    };
}
async function getPhotos(aircraft, livery) {
    const key = `photos:${aircraft.toLowerCase()}|${livery.toLowerCase()}`;
    return cached(key, TTL.photos, async () => {
        const url = new URL('/api/photos', IFSPOTTERS_BASE);
        url.searchParams.set('aircraft', aircraft);
        url.searchParams.set('airline', livery);
        url.searchParams.set('sort', 'views');
        const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
        if (!response.ok)
            throw httpError(502, `IFSpotters -> HTTP ${response.status}`);
        const body = (await response.json());
        return {
            total: body.total,
            photos: body.photos.slice(0, 8).map((p) => ({
                id: p.id,
                thumb: `${IFSPOTTERS_BASE}/api/img/${p.thumbKey}`,
                page: `${IFSPOTTERS_BASE}/photos/${p.id}`,
                photographer: p.photographer,
                airport: p.airport,
                category: p.category
            }))
        };
    });
}
// ---------------------------------------------------------------------------
// ルーティング
// ---------------------------------------------------------------------------
function route(handler) {
    return async (req, res) => {
        try {
            res.json(await handler(req, res));
        }
        catch (error) {
            const e = error;
            res.status(e.status && e.status >= 400 ? e.status : 500).json({ error: e.message });
        }
    };
}
function requireParam(req, name) {
    const value = String(req.query[name] ?? req.params[name] ?? '').trim();
    if (!value)
        throw httpError(400, `Missing parameter: ${name}`);
    return value;
}
app.use((0, compression_1.default)());
app.use(express_1.default.static(PUBLIC_DIR, { maxAge: '5m' }));
app.get('/health', (_req, res) => {
    res.json({ ok: true });
});
app.get('/api/sessions', route(async (_req, res) => {
    res.set('Cache-Control', 'public, max-age=60');
    return getSessions();
}));
app.get('/api/airports', route(async (_req, res) => {
    res.set('Cache-Control', 'public, max-age=3600, s-maxage=21600');
    return getAirportPins();
}));
app.get('/api/flights', route(async (req, res) => {
    res.set('Cache-Control', 'public, max-age=5, s-maxage=10, stale-while-revalidate=10');
    return getCompactFlights(requireParam(req, 'sessionId'));
}));
app.get('/api/flights/:flightId', route(async (req, res) => {
    res.set('Cache-Control', 'public, max-age=15, s-maxage=30');
    return getFlightDetail(requireParam(req, 'sessionId'), unpackId(requireParam(req, 'flightId')));
}));
app.get('/api/world', route(async (req, res) => {
    res.set('Cache-Control', 'public, max-age=15, s-maxage=30');
    const { atc, traffic } = await getWorld(requireParam(req, 'sessionId'));
    return { atc, traffic };
}));
app.get('/api/airport-flights', route(async (req, res) => {
    res.set('Cache-Control', 'public, max-age=15, s-maxage=30');
    const { routes } = await getWorld(requireParam(req, 'sessionId'));
    const r = routes.get(requireParam(req, 'icao').toUpperCase());
    return { inbound: r?.inbound ?? [], outbound: r?.outbound ?? [] };
}));
app.get('/api/pilot', route(async (req, res) => {
    res.set('Cache-Control', 'public, max-age=60, s-maxage=120');
    return getPilot(requireParam(req, 'sessionId'), requireParam(req, 'flightId'));
}));
app.get('/api/locate', route(async (req, res) => {
    res.set('Cache-Control', 'private, max-age=10');
    return { flight: await locateUser(requireParam(req, 'username')) };
}));
app.get('/api/photos', route(async (req, res) => {
    const aircraft = requireParam(req, 'aircraft');
    const livery = String(req.query.livery || '').trim();
    if (!livery)
        return { total: 0, photos: [] };
    res.set('Cache-Control', 'public, max-age=300, s-maxage=600');
    return getPhotos(aircraft, livery).catch(() => ({ total: 0, photos: [] }));
}));
// 単一ページなので、知らないパスはトップへ戻す。
// ifspotters.com 本体の /en・/ja 付き URL を radar 側で開いても 404 にしない
app.use((req, res) => {
    if (req.path.startsWith('/api/') || (req.method !== 'GET' && req.method !== 'HEAD')) {
        res.status(404).json({ error: 'Not found' });
        return;
    }
    const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    res.redirect(302, `/${query}`);
});
if (!process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`IFSpotters Radar running at http://localhost:${PORT}`);
    });
}
exports.default = app;
