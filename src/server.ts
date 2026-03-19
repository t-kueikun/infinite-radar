import path from 'path';
import express, { type Request, type Response } from 'express';
import dotenv from 'dotenv';

dotenv.config({ path: ['.env.local', '.env'] });

const app = express();
const PORT = Number(process.env.PORT || 3000);
const INFINITE_API_BASE = 'https://api.infiniteflight.com/public/v2';
const OVERPASS_API_URL = 'https://overpass-api.de/api/interpreter';
const API_KEY = process.env.INFINITE_FLIGHT_API_KEY;
const PUBLIC_DIR = path.join(__dirname, '../public');
const AIRPORTS_CACHE_TTL_MS = 10 * 60 * 1000;
const AIRPORT_LAYOUT_CACHE_TTL_MS = 5 * 60 * 1000;

type ApiError = Error & {
  status?: number;
  payload?: unknown;
};

let airportsCache: { expiresAt: number; payload: unknown } | null = null;
const airportLayoutCache = new Map<string, { expiresAt: number; payload: unknown }>();

if (!API_KEY) {
  console.error('Missing INFINITE_FLIGHT_API_KEY in .env');
  process.exit(1);
}

app.use(express.static(PUBLIC_DIR));

async function requestInfiniteFlight(endpoint: string): Promise<unknown> {
  const response = await fetch(`${INFINITE_API_BASE}${endpoint}`, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      Accept: 'application/json'
    }
  });

  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json')
    ? await response.json()
    : { error: await response.text() };

  if (!response.ok) {
    const error: ApiError = new Error('Infinite Flight API request failed');
    error.status = response.status;
    error.payload = body;
    throw error;
  }

  return body;
}

async function requestOverpass(query: string): Promise<unknown> {
  const response = await fetch(OVERPASS_API_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
    },
    body: new URLSearchParams({ data: query }).toString()
  });

  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json')
    ? await response.json()
    : { error: await response.text() };

  if (!response.ok) {
    const error: ApiError = new Error('Overpass request failed');
    error.status = response.status;
    error.payload = body;
    throw error;
  }

  return body;
}

function roundCoord(value: number, precision = 3): number {
  const power = 10 ** precision;
  return Math.round(value * power) / power;
}

function buildAirportLayoutKey(south: number, west: number, north: number, east: number): string {
  return [south, west, north, east].map((value) => roundCoord(value, 2)).join(':');
}

function normalizeBbox(input: string): [number, number, number, number] | null {
  const parts = input.split(',').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
    return null;
  }

  const [south, west, north, east] = parts;
  if (south < -90 || north > 90 || west < -180 || east > 180 || south >= north || west >= east) {
    return null;
  }

  return [south, west, north, east];
}

function simplifyOverpassAeroways(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') {
    return { features: [] };
  }

  const source = payload as { elements?: Array<Record<string, unknown>> };
  const elements = Array.isArray(source.elements) ? source.elements : [];
  const nodeMap = new Map<number, [number, number]>();

  for (const element of elements) {
    if (
      element.type === 'node' &&
      typeof element.id === 'number' &&
      typeof element.lat === 'number' &&
      typeof element.lon === 'number'
    ) {
      nodeMap.set(element.id, [element.lat, element.lon]);
    }
  }

  const features = elements.flatMap((element) => {
    if (element.type !== 'way') {
      return [];
    }

    const tags = (element.tags && typeof element.tags === 'object') ? element.tags as Record<string, unknown> : {};
    const kind = typeof tags.aeroway === 'string' ? tags.aeroway : '';
    if (!kind) {
      return [];
    }

    const refs = Array.isArray(element.nodes) ? element.nodes : [];
    const coordinates = refs
      .map((ref) => (typeof ref === 'number' ? nodeMap.get(ref) : null))
      .filter((coord): coord is [number, number] => Array.isArray(coord));

    if (coordinates.length < 2) {
      return [];
    }

    const first = coordinates[0];
    const last = coordinates[coordinates.length - 1];
    const closed = first[0] === last[0] && first[1] === last[1];

    return [{
      kind,
      closed,
      coordinates
    }];
  });

  return { features };
}

function withErrorHandling(handler: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await handler(req, res);
    } catch (error) {
      const apiError = error as ApiError;
      const status = apiError.status || 500;
      const payload = apiError.payload || { error: apiError.message };
      res.status(status).json({
        ok: false,
        status,
        endpoint: req.originalUrl,
        ...((typeof payload === 'object' && payload !== null) ? payload : { error: String(payload) })
      });
    }
  };
}

app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.get('/api/sessions', withErrorHandling(async (_req, res) => {
  const data = await requestInfiniteFlight('/sessions');
  res.json(data);
}));

app.get('/api/airports', withErrorHandling(async (_req, res) => {
  if (airportsCache && Date.now() < airportsCache.expiresAt) {
    res.json(airportsCache.payload);
    return;
  }

  const data = await requestInfiniteFlight('/airports');
  airportsCache = {
    payload: data,
    expiresAt: Date.now() + AIRPORTS_CACHE_TTL_MS
  };

  res.json(data);
}));

app.get('/api/airport-layout', withErrorHandling(async (req, res) => {
  const bboxRaw = String(req.query.bbox || '');
  const bbox = normalizeBbox(bboxRaw);

  if (!bbox) {
    res.status(400).json({
      ok: false,
      error: 'Invalid required query parameter: bbox'
    });
    return;
  }

  const [south, west, north, east] = bbox;
  const cacheKey = buildAirportLayoutKey(south, west, north, east);
  const cached = airportLayoutCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    res.json(cached.payload);
    return;
  }

  const overpassQuery = `
    [out:json][timeout:20];
    (
      way["aeroway"~"runway|taxiway|apron|helipad|taxilane"](${south},${west},${north},${east});
    );
    (._;>;);
    out body;
  `;

  const raw = await requestOverpass(overpassQuery);
  const simplified = simplifyOverpassAeroways(raw);

  airportLayoutCache.set(cacheKey, {
    payload: simplified,
    expiresAt: Date.now() + AIRPORT_LAYOUT_CACHE_TTL_MS
  });

  res.json(simplified);
}));

app.get('/api/flights', withErrorHandling(async (req, res) => {
  const sessionId = String(req.query.sessionId || '');

  if (!sessionId) {
    res.status(400).json({
      ok: false,
      error: 'Missing required query parameter: sessionId'
    });
    return;
  }

  const data = await requestInfiniteFlight(`/sessions/${encodeURIComponent(sessionId)}/flights`);
  res.json(data);
}));

app.get('/api/atc', withErrorHandling(async (req, res) => {
  const sessionId = String(req.query.sessionId || '');

  if (!sessionId) {
    res.status(400).json({
      ok: false,
      error: 'Missing required query parameter: sessionId'
    });
    return;
  }

  const data = await requestInfiniteFlight(`/sessions/${encodeURIComponent(sessionId)}/atc`);
  res.json(data);
}));

app.get('/api/flights/:flightId/route', withErrorHandling(async (req, res) => {
  const sessionId = String(req.query.sessionId || '');
  const flightId = String(req.params.flightId || '');

  if (!sessionId) {
    res.status(400).json({
      ok: false,
      error: 'Missing required query parameter: sessionId'
    });
    return;
  }

  const data = await requestInfiniteFlight(
    `/sessions/${encodeURIComponent(sessionId)}/flights/${encodeURIComponent(flightId)}/route`
  );

  res.json(data);
}));

app.get('/api/flights/:flightId/flightplan', withErrorHandling(async (req, res) => {
  const sessionId = String(req.query.sessionId || '');
  const flightId = String(req.params.flightId || '');

  if (!sessionId) {
    res.status(400).json({
      ok: false,
      error: 'Missing required query parameter: sessionId'
    });
    return;
  }

  const data = await requestInfiniteFlight(
    `/sessions/${encodeURIComponent(sessionId)}/flights/${encodeURIComponent(flightId)}/flightplan`
  );

  res.json(data);
}));

app.listen(PORT, () => {
  console.log(`Infinite Radar running at http://localhost:${PORT}`);
});
