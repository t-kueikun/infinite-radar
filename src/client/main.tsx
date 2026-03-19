import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

declare const L: any;

type JsonObject = Record<string, unknown>;

type Session = {
  id: string;
  name: string;
};

type Airport = {
  icao: string;
  name: string;
  latitude: number;
  longitude: number;
  airportClass: number;
  frequenciesCount: number;
};

type Flight = {
  id: string;
  callsign: string;
  username: string;
  aircraft: string;
  origin: string;
  destination: string;
  altitudeFt: number;
  speedKts: number;
  headingDeg: number;
  verticalSpeedFpm: number;
  latitude: number;
  longitude: number;
};

type FlightPlanItem = {
  name: string;
  children: FlightPlanItem[] | null;
  location?: {
    latitude?: number;
    longitude?: number;
  } | null;
};

type FlightPlanData = {
  flightPlanId: string;
  lastUpdate: string;
  flightPlanItems: FlightPlanItem[];
};

type AtcStation = {
  airportName: string;
};

type AirportLayoutFeature = {
  kind: 'runway' | 'taxiway' | 'apron' | 'helipad' | 'taxilane' | string;
  closed: boolean;
  coordinates: Array<[number, number]>;
};

type MarkerState = {
  markers: any[];
  flight: Flight;
  mode: 'dot' | 'plane';
  positionsKey: string;
  renderKey: string;
};

const POLL_INTERVAL_MS = 8000;
const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;
const ROUTE_REFRESH_MS = 30000;
const PLANE_ICON_ZOOM = 2.8;
const FORCE_DOT_ZOOM = 4.2;
const LABEL_MIN_ZOOM = 5.2;
const DUPLICATE_ALL_ZOOM = 5.8;
const AIRPORT_ALL_ZOOM = 7.5;
const AIRPORT_LABEL_ZOOM = 8.5;
const ATC_POLL_INTERVAL_MS = 15000;
const AIRPORT_LAYOUT_ZOOM = 11;
const WORLD_VIEW = { lat: 20, lng: 170, zoom: 2 };
const airportIconCache: Record<string, any> = {};

function getFirstValue<T>(source: JsonObject, keys: string[], fallback: T): T {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null) {
      return value as T;
    }
  }
  return fallback;
}

function normalizeFlight(raw: JsonObject): Flight | null {
  const id = String(getFirstValue(raw, ['flightId', 'id', 'FlightID', 'Id', 'flightID'], ''));
  const latitude = Number(getFirstValue(raw, ['latitude', 'Latitude', 'lat', 'Lat'], Number.NaN));
  const longitude = Number(getFirstValue(raw, ['longitude', 'Longitude', 'lon', 'Lng', 'Long'], Number.NaN));

  if (!id || Number.isNaN(latitude) || Number.isNaN(longitude)) {
    return null;
  }

  return {
    id,
    callsign: String(getFirstValue(raw, ['callsign', 'Callsign', 'flightNumber'], 'N/A')),
    username: String(getFirstValue(raw, ['username', 'Username', 'pilotName'], 'N/A')),
    aircraft: String(getFirstValue(raw, ['aircraftName', 'AircraftName', 'aircraftId'], 'Unknown')),
    origin: String(getFirstValue(raw, ['originIcao', 'OriginIcao', 'originAirportIcao'], '----')),
    destination: String(getFirstValue(raw, ['destinationIcao', 'DestinationIcao', 'destinationAirportIcao'], '----')),
    altitudeFt: Number(getFirstValue(raw, ['altitude', 'Altitude'], 0)),
    speedKts: Number(getFirstValue(raw, ['speed', 'Speed', 'groundSpeed'], 0)),
    headingDeg: Number(getFirstValue(raw, ['track', 'Track', 'heading', 'Heading'], 0)),
    verticalSpeedFpm: Number(getFirstValue(raw, ['verticalSpeed', 'VerticalSpeed'], 0)),
    latitude,
    longitude
  };
}

function normalizeAirport(raw: JsonObject): Airport | null {
  const icao = String(getFirstValue(raw, ['icao', 'Icao'], ''));
  const latitude = Number(getFirstValue(raw, ['latitude', 'Latitude'], Number.NaN));
  const longitude = Number(getFirstValue(raw, ['longitude', 'Longitude'], Number.NaN));

  if (!icao || Number.isNaN(latitude) || Number.isNaN(longitude)) {
    return null;
  }

  return {
    icao,
    name: String(getFirstValue(raw, ['name', 'Name'], icao)),
    latitude,
    longitude,
    airportClass: Number(getFirstValue(raw, ['class', 'Class'], 0)),
    frequenciesCount: Number(getFirstValue(raw, ['frequenciesCount', 'FrequenciesCount'], 0))
  };
}

function normalizeAtcStation(raw: JsonObject): AtcStation | null {
  const airportName = String(getFirstValue(raw, ['airportName', 'airportIcao', 'AirportName'], '')).toUpperCase();
  if (!/^[A-Z]{4}$/.test(airportName)) {
    return null;
  }
  return { airportName };
}

function normalizeAirportLayoutFeature(raw: JsonObject): AirportLayoutFeature | null {
  const kind = String(getFirstValue(raw, ['kind'], ''));
  const coordinatesRaw = getFirstValue(raw, ['coordinates'], [] as unknown);
  if (!kind || !Array.isArray(coordinatesRaw)) {
    return null;
  }

  const coordinates = coordinatesRaw
    .filter((entry): entry is [number, number] => Array.isArray(entry) && entry.length >= 2)
    .map(([lat, lon]) => [Number(lat), Number(lon)] as [number, number])
    .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));

  if (coordinates.length < 2) {
    return null;
  }

  return {
    kind,
    closed: Boolean(getFirstValue(raw, ['closed'], false)),
    coordinates
  };
}

function normalizeFlightPlanItem(raw: JsonObject): FlightPlanItem {
  const childrenRaw = raw.children;
  const children = Array.isArray(childrenRaw)
    ? childrenRaw
        .filter((item): item is JsonObject => typeof item === 'object' && item !== null)
        .map(normalizeFlightPlanItem)
    : null;

  const locationRaw = raw.location;
  let location: FlightPlanItem['location'] = null;
  if (locationRaw && typeof locationRaw === 'object') {
    const loc = locationRaw as JsonObject;
    const latitude = Number(getFirstValue(loc, ['latitude', 'Latitude'], Number.NaN));
    const longitude = Number(getFirstValue(loc, ['longitude', 'Longitude'], Number.NaN));
    if (!Number.isNaN(latitude) && !Number.isNaN(longitude)) {
      location = { latitude, longitude };
    }
  }

  return {
    name: String(getFirstValue(raw, ['name', 'Name', 'identifier', 'Identifier'], '')),
    children,
    location
  };
}

function normalizeFlightPlan(raw: JsonObject): FlightPlanData | null {
  const flightPlanId = String(getFirstValue(raw, ['flightPlanId', 'FlightPlanId'], ''));
  const itemsRaw = getFirstValue(raw, ['flightPlanItems', 'FlightPlanItems'], [] as unknown);
  const items = Array.isArray(itemsRaw)
    ? itemsRaw
        .filter((item): item is JsonObject => typeof item === 'object' && item !== null)
        .map(normalizeFlightPlanItem)
    : [];

  if (!flightPlanId && items.length === 0) {
    return null;
  }

  return {
    flightPlanId,
    lastUpdate: String(getFirstValue(raw, ['lastUpdate', 'LastUpdate'], '')),
    flightPlanItems: items
  };
}

function collectPlanNames(items: FlightPlanItem[], out: string[] = []): string[] {
  for (const item of items) {
    const name = item.name.trim();
    if (name) {
      out.push(name);
    }
    if (item.children?.length) {
      collectPlanNames(item.children, out);
    }
  }
  return out;
}

function isValidLatLon(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180 &&
    !(Math.abs(latitude) < 0.0001 && Math.abs(longitude) < 0.0001)
  );
}

function normalizePlanName(name: string): string {
  return name.trim().toUpperCase();
}

function collectFlightPlanCoordinates(
  items: FlightPlanItem[],
  airportLookup: Map<string, Airport>,
  out: Array<[number, number]> = []
): Array<[number, number]> {
  for (const item of items) {
    let point: [number, number] | null = null;

    if (
      item.location &&
      typeof item.location.latitude === 'number' &&
      typeof item.location.longitude === 'number' &&
      isValidLatLon(item.location.latitude, item.location.longitude)
    ) {
      point = [item.location.latitude, item.location.longitude];
    } else {
      const token = normalizePlanName(item.name);
      if (/^[A-Z]{4}$/.test(token)) {
        const airport = airportLookup.get(token);
        if (airport) {
          point = [airport.latitude, airport.longitude];
        }
      }
    }

    if (point) {
      out.push(point);
    }

    if (item.children?.length) {
      collectFlightPlanCoordinates(item.children, airportLookup, out);
    }
  }

  return out;
}

function dedupeConsecutiveCoordinates(points: Array<[number, number]>, minDistanceNm = 0.2): Array<[number, number]> {
  if (points.length <= 1) {
    return points;
  }

  const deduped: Array<[number, number]> = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    const [prevLat, prevLon] = deduped[deduped.length - 1];
    const [lat, lon] = points[i];
    if (distanceNm(prevLat, prevLon, lat, lon) >= minDistanceNm) {
      deduped.push([lat, lon]);
    }
  }
  return deduped;
}

function findNearestCoordinateIndex(
  coords: Array<[number, number]>,
  latitude: number,
  longitude: number
): { index: number; distanceNm: number } {
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let i = 0; i < coords.length; i += 1) {
    const [lat, lon] = coords[i];
    const dist = distanceNm(latitude, longitude, lat, lon);
    if (dist < bestDistance) {
      bestDistance = dist;
      bestIndex = i;
    }
  }

  return { index: bestIndex, distanceNm: bestDistance };
}

function normalizeLongitudeNear(lon: number, referenceLon: number): number {
  let value = lon;
  while (value - referenceLon > 180) {
    value -= 360;
  }
  while (value - referenceLon < -180) {
    value += 360;
  }
  return value;
}

function unwrapAntimeridian(coords: Array<[number, number]>): Array<[number, number]> {
  if (coords.length <= 1) {
    return coords;
  }

  const unwrapped: Array<[number, number]> = [coords[0]];
  let previousLon = coords[0][1];

  for (let i = 1; i < coords.length; i += 1) {
    const [lat, rawLon] = coords[i];
    const lon = normalizeLongitudeNear(rawLon, previousLon);
    unwrapped.push([lat, lon]);
    previousLon = lon;
  }

  return unwrapped;
}

function rebaseTrackNearLongitude(coords: Array<[number, number]>, referenceLon: number): Array<[number, number]> {
  if (coords.length <= 1) {
    return coords.length
      ? [[coords[0][0], normalizeLongitudeNear(coords[0][1], referenceLon)]]
      : [];
  }

  const rebased: Array<[number, number]> = [[coords[0][0], normalizeLongitudeNear(coords[0][1], referenceLon)]];
  let previousLon = rebased[0][1];

  for (let i = 1; i < coords.length; i += 1) {
    const [lat, rawLon] = coords[i];
    const lon = normalizeLongitudeNear(rawLon, previousLon);
    rebased.push([lat, lon]);
    previousLon = lon;
  }

  return rebased;
}

function shiftTrackLongitude(coords: Array<[number, number]>, deltaLon: number): Array<[number, number]> {
  if (!deltaLon) {
    return coords;
  }
  return coords.map(([lat, lon]) => [lat, lon + deltaLon]);
}

function splitRouteForDisplay(
  coords: Array<[number, number]>,
  current: [number, number]
): { passed: Array<[number, number]>; planned: Array<[number, number]> } {
  if (coords.length < 2 || !isValidLatLon(current[0], current[1])) {
    return { passed: coords, planned: [] };
  }

  const currentLon = normalizeLongitudeNear(current[1], coords[0][1]);
  const nearest = findNearestCoordinateIndex(coords, current[0], currentLon);
  if (nearest.index < 0) {
    return { passed: coords, planned: [] };
  }

  let passed = coords.slice(0, nearest.index + 1);
  let planned = coords.slice(nearest.index);

  // When close enough, split exactly at the live aircraft position.
  if (nearest.distanceNm <= 120) {
    const [nearestLat, nearestLon] = coords[nearest.index];
    const joinDistanceNm = distanceNm(current[0], currentLon, nearestLat, nearestLon);
    if (joinDistanceNm > 1.2) {
      const normalizedCurrent: [number, number] = [current[0], currentLon];
      passed = [...passed, normalizedCurrent];
      planned = [normalizedCurrent, ...planned];
    }
  }

  return {
    passed: dedupeConsecutiveCoordinates(passed),
    planned: dedupeConsecutiveCoordinates(planned)
  };
}

function findLastPlanCoordinate(items: FlightPlanItem[]): { latitude: number; longitude: number } | null {
  const flat: Array<{ latitude: number; longitude: number }> = [];

  function walk(nodes: FlightPlanItem[]): void {
    for (const node of nodes) {
      if (
        node.location &&
        typeof node.location.latitude === 'number' &&
        typeof node.location.longitude === 'number' &&
        Number.isFinite(node.location.latitude) &&
        Number.isFinite(node.location.longitude) &&
        Math.abs(node.location.latitude) <= 90 &&
        Math.abs(node.location.longitude) <= 180 &&
        !(Math.abs(node.location.latitude) < 0.0001 && Math.abs(node.location.longitude) < 0.0001)
      ) {
        flat.push({ latitude: node.location.latitude, longitude: node.location.longitude });
      }
      if (node.children?.length) {
        walk(node.children);
      }
    }
  }

  walk(items);
  return flat.length ? flat[flat.length - 1] : null;
}

function distanceNm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const rKm = 6371;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  const km = rKm * c;
  return km * 0.5399568;
}

function formatEtaMinutes(totalMinutes: number): string {
  const mins = Math.max(0, Math.round(totalMinutes));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h <= 0) {
    return `${m}m`;
  }
  return `${h}h ${m}m`;
}

function shouldRenderAirport(airport: Airport, zoom: number): boolean {
  if (zoom >= AIRPORT_ALL_ZOOM) {
    return true;
  }

  if (zoom >= 6) {
    return airport.airportClass >= 1 || airport.frequenciesCount >= 3;
  }

  if (zoom >= 4.5) {
    return airport.airportClass >= 2 || airport.frequenciesCount >= 6;
  }

  return airport.airportClass >= 3 || airport.frequenciesCount >= 10;
}

function getAirportTier(airport: Airport): 'major' | 'regional' | 'local' {
  if (airport.airportClass >= 3 || airport.frequenciesCount >= 10) {
    return 'major';
  }
  if (airport.airportClass >= 2 || airport.frequenciesCount >= 6) {
    return 'regional';
  }
  return 'local';
}

function shouldShowAirportLabel(airport: Airport, zoom: number): boolean {
  return zoom >= AIRPORT_LABEL_ZOOM && (airport.airportClass >= 2 || airport.frequenciesCount >= 6);
}

function createAirportPinIcon(tier: 'major' | 'regional' | 'local', atcOn: boolean): any {
  const cacheKey = `${tier}-${atcOn ? 'on' : 'off'}` as keyof typeof airportIconCache;
  if (airportIconCache[cacheKey]) {
    return airportIconCache[cacheKey];
  }

  const icon = L.divIcon({
    className: '',
    html: `<svg class="airport-pin ${tier} ${atcOn ? 'atc-on' : 'atc-off'}" viewBox="0 0 24 24" aria-hidden="true">
      <path class="body" d="M12 22c4.2-5 7-8.2 7-11.6a7 7 0 1 0-14 0c0 3.4 2.8 6.6 7 11.6z"></path>
      <circle class="core" cx="12" cy="10" r="5.1"></circle>
      <path class="plane" d="M16 10.9v-1l-3.3-2V5.7a.7.7 0 0 0-1.4 0v2.2L8 9.9v1l3.3-1v2.2l-.8.6v.9l1.5-.4 1.5.4v-.9l-.8-.6V9.9l3.3 1z"></path>
    </svg>`,
    iconSize: [18, 24],
    iconAnchor: [9, 24]
  });

  airportIconCache[cacheKey] = icon;
  return icon;
}

function airportButtonLabel(zoom: number): string {
  if (zoom >= AIRPORT_ALL_ZOOM) {
    return 'Airports ON (All)';
  }
  if (zoom >= 6) {
    return 'Airports ON (Regional+)';
  }
  if (zoom >= 4.5) {
    return 'Airports ON (Major+)';
  }
  return 'Airports ON (Hub only)';
}

function findCoordinatesDeep(input: unknown, result: number[][] = []): number[][] {
  if (Array.isArray(input)) {
    for (const item of input) {
      findCoordinatesDeep(item, result);
    }
    return result;
  }

  if (!input || typeof input !== 'object') {
    return result;
  }

  const source = input as JsonObject;
  const lat = getFirstValue(source, ['latitude', 'Latitude', 'lat', 'Lat'], null as number | null);
  const lon = getFirstValue(source, ['longitude', 'Longitude', 'lon', 'Lng', 'Long'], null as number | null);

  if (typeof lat === 'number' && typeof lon === 'number') {
    result.push([lat, lon]);
  }

  for (const value of Object.values(source)) {
    if (value && typeof value === 'object') {
      findCoordinatesDeep(value, result);
    }
  }

  return result;
}

function formatUtcClock(date: Date): string {
  return `${date.toISOString().slice(11, 16)} UTC`;
}

function createPlaneIcon(headingDeg: number, selected: boolean): any {
  const safeHeading = Number.isFinite(headingDeg) ? headingDeg : 0;
  const rotationDeg = Math.round((safeHeading + 360) % 360);
  const classes = selected ? 'aircraft-glyph selected' : 'aircraft-glyph';
  return L.divIcon({
    className: '',
    html: `<div class="${classes}" style="transform: rotate(${rotationDeg}deg)">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5L21 16z"></path>
      </svg>
    </div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10]
  });
}

function bindFlightTooltip(marker: any, callsign: string, showLabels: boolean): void {
  marker.unbindTooltip?.();
  marker.bindTooltip(callsign, {
    direction: 'top',
    opacity: 0.92,
    offset: [0, -7],
    permanent: showLabels,
    className: showLabels ? 'flight-label' : ''
  });
}

function getWrappedMarkerPositions(
  latitude: number,
  longitude: number,
  bounds: any,
  centerLon: number,
  duplicate: boolean
): Array<[number, number]> {
  const baseLon = normalizeLongitudeNear(longitude, centerLon);
  if (!duplicate) {
    return [[latitude, baseLon]];
  }

  const candidates: Array<[number, number]> = [
    [latitude, baseLon - 360],
    [latitude, baseLon],
    [latitude, baseLon + 360]
  ];

  const visible = candidates.filter(([lat, lon]) => bounds.contains([lat, lon]));
  if (visible.length) {
    return visible;
  }
  return [[latitude, baseLon]];
}

function markerRenderKey(
  flight: Flight,
  mode: 'dot' | 'plane',
  isSelected: boolean,
  showLabels: boolean
): string {
  const lat = Number.isFinite(flight.latitude) ? flight.latitude.toFixed(5) : 'NaN';
  const lon = Number.isFinite(flight.longitude) ? flight.longitude.toFixed(5) : 'NaN';
  const heading = Number.isFinite(flight.headingDeg) ? Math.round(flight.headingDeg) : 0;
  return [
    mode,
    isSelected ? '1' : '0',
    showLabels ? '1' : '0',
    heading,
    lat,
    lon,
    flight.callsign
  ].join(':');
}

function App(): React.JSX.Element {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any | null>(null);
  const rendererRef = useRef<any | null>(null);
  const markersRef = useRef<Map<string, MarkerState>>(new Map());
  const routeLayerRef = useRef<any | null>(null);
  const airportsLayerRef = useRef<any | null>(null);
  const airportLayoutLayerRef = useRef<any | null>(null);
  const flightPlanCacheRef = useRef<Map<string, FlightPlanData | null>>(new Map());
  const routeCacheRef = useRef<Map<string, Array<[number, number]>>>(new Map());
  const selectedRouteKeyRef = useRef('');
  const isFetchingRef = useRef(false);
  const pausedRef = useRef(false);
  const lastInteractionRef = useRef(Date.now());
  const lastRouteLoadRef = useRef(0);

  const [sessions, setSessions] = useState<Session[]>([]);
  const [airports, setAirports] = useState<Airport[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState('');
  const [flights, setFlights] = useState<Flight[]>([]);
  const [selectedFlightId, setSelectedFlightId] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [followSelected, setFollowSelected] = useState(false);
  const [status, setStatus] = useState('Loading sessions...');
  const [warningStatus, setWarningStatus] = useState(false);
  const [utc, setUtc] = useState(formatUtcClock(new Date()));
  const [zoomLevel, setZoomLevel] = useState(3);
  const [viewRevision, setViewRevision] = useState(0);
  const [showLabels, setShowLabels] = useState(false);
  const [iconMode, setIconMode] = useState<'smart' | 'plane'>('plane');
  const [showAirports, setShowAirports] = useState(true);
  const [flightPlan, setFlightPlan] = useState<FlightPlanData | null>(null);
  const [flightPlanLoading, setFlightPlanLoading] = useState(false);
  const [routeCoords, setRouteCoords] = useState<Array<[number, number]>>([]);
  const [selectedFlightSnapshot, setSelectedFlightSnapshot] = useState<Flight | null>(null);
  const [atcAirports, setAtcAirports] = useState<string[]>([]);

  const selectedFlightLive = useMemo(
    () => flights.find((flight) => flight.id === selectedFlightId) ?? null,
    [flights, selectedFlightId]
  );

  const selectedFlight = useMemo(() => {
    if (selectedFlightLive) {
      return selectedFlightLive;
    }
    if (selectedFlightId && selectedFlightSnapshot && selectedFlightSnapshot.id === selectedFlightId) {
      return selectedFlightSnapshot;
    }
    return null;
  }, [selectedFlightId, selectedFlightLive, selectedFlightSnapshot]);

  const searchCandidates = useMemo(() => {
    const token = searchText.trim().toLowerCase();
    if (!token) {
      return [] as Flight[];
    }

    return flights
      .filter((flight) => {
        return (
          flight.callsign.toLowerCase().includes(token) ||
          flight.username.toLowerCase().includes(token) ||
          flight.origin.toLowerCase().includes(token) ||
          flight.destination.toLowerCase().includes(token)
        );
      })
      .slice(0, 12);
  }, [flights, searchText]);

  const airportLookup = useMemo(() => {
    const map = new Map<string, Airport>();
    for (const airport of airports) {
      map.set(airport.icao.toUpperCase(), airport);
    }
    return map;
  }, [airports]);

  const atcAirportSet = useMemo(() => new Set(atcAirports), [atcAirports]);

  const planNames = useMemo(() => {
    if (!flightPlan) {
      return [];
    }
    const unique = Array.from(new Set(collectPlanNames(flightPlan.flightPlanItems)));
    return unique;
  }, [flightPlan]);

  const plannedRouteCoords = useMemo((): Array<[number, number]> => {
    if (!selectedFlight || !flightPlan) {
      return [];
    }

    const rawCoords = collectFlightPlanCoordinates(flightPlan.flightPlanItems, airportLookup);
    const coords = unwrapAntimeridian(dedupeConsecutiveCoordinates(rawCoords));

    if (!coords.length) {
      return [];
    }

    const destinationToken = normalizePlanName(selectedFlight.destination);
    const destinationAirport =
      destinationToken && destinationToken !== '----' ? airportLookup.get(destinationToken) : undefined;

    if (destinationAirport) {
      const [lastLat, lastLon] = coords[coords.length - 1];
      const destinationLon = normalizeLongitudeNear(destinationAirport.longitude, lastLon);
      const toDestinationNm = distanceNm(lastLat, lastLon, destinationAirport.latitude, destinationLon);
      if (toDestinationNm > 2) {
        coords.push([destinationAirport.latitude, destinationLon]);
      }
    }

    return unwrapAntimeridian(dedupeConsecutiveCoordinates(coords));
  }, [airportLookup, flightPlan, selectedFlight]);

  useEffect(() => {
    const key = selectedFlightId && currentSessionId ? `${currentSessionId}:${selectedFlightId}` : '';
    selectedRouteKeyRef.current = key;
    if (!key) {
      setRouteCoords([]);
      return;
    }
    setRouteCoords(routeCacheRef.current.get(key) ?? []);
  }, [currentSessionId, selectedFlightId]);

  useEffect(() => {
    if (!selectedFlightId) {
      setSelectedFlightSnapshot(null);
      return;
    }
    if (selectedFlightLive && selectedFlightLive.id === selectedFlightId) {
      setSelectedFlightSnapshot(selectedFlightLive);
    }
  }, [selectedFlightId, selectedFlightLive]);

  const etaText = useMemo(() => {
    if (!selectedFlight) {
      return null;
    }

    let destinationCoord = flightPlan ? findLastPlanCoordinate(flightPlan.flightPlanItems) : null;
    if (!destinationCoord && selectedFlight.destination && selectedFlight.destination !== '----') {
      const airport = airportLookup.get(selectedFlight.destination.toUpperCase());
      if (airport) {
        destinationCoord = { latitude: airport.latitude, longitude: airport.longitude };
      }
    }

    if (!destinationCoord) {
      return null;
    }

    const gs = selectedFlight.speedKts;
    if (!Number.isFinite(gs) || gs < 80) {
      return 'Calculating...';
    }

    const remainingNm = distanceNm(
      selectedFlight.latitude,
      selectedFlight.longitude,
      destinationCoord.latitude,
      destinationCoord.longitude
    );
    if (!Number.isFinite(remainingNm) || remainingNm < 5) {
      return 'Arriving soon';
    }

    const minutes = (remainingNm / gs) * 60;
    const etaDate = new Date(Date.now() + minutes * 60_000);
    return `${etaDate.toISOString().slice(11, 16)} UTC (${formatEtaMinutes(minutes)})`;
  }, [airportLookup, flightPlan, selectedFlight]);

  const resetInactivity = useCallback(() => {
    lastInteractionRef.current = Date.now();
    if (pausedRef.current) {
      pausedRef.current = false;
      setStatus('Polling resumed.');
      setWarningStatus(false);
    }
  }, []);

  const setStatusText = useCallback((message: string, warning = false) => {
    setStatus(message);
    setWarningStatus(warning);
  }, []);

  const selectFlightFromSearch = useCallback((flight: Flight) => {
    setSelectedFlightId(flight.id);
    setSearchText(flight.callsign);
    setSearchFocused(false);
    lastRouteLoadRef.current = 0;
    if (mapRef.current) {
      mapRef.current.panTo([flight.latitude, flight.longitude], { animate: true });
    }
    resetInactivity();
  }, [resetInactivity]);

  const clearRouteLayer = useCallback(() => {
    if (mapRef.current && routeLayerRef.current) {
      mapRef.current.removeLayer(routeLayerRef.current);
      routeLayerRef.current = null;
    }
  }, []);

  const drawCombinedRouteLayer = useCallback((
    passed: Array<[number, number]>,
    planned: Array<[number, number]>
  ) => {
    const map = mapRef.current;
    if (!map) {
      clearRouteLayer();
      return;
    }

    if (passed.length < 2 && planned.length < 2) {
      clearRouteLayer();
      return;
    }

    clearRouteLayer();
    const group = L.layerGroup();
    const centerLon = map.getCenter().lng;
    const wrapOffsets = [-360, 0, 360];

    const addWrappedPolyline = (coords: Array<[number, number]>, style: JsonObject): void => {
      if (coords.length < 2) {
        return;
      }
      const rebased = rebaseTrackNearLongitude(coords, centerLon);
      for (const offset of wrapOffsets) {
        const shifted = shiftTrackLongitude(rebased, offset);
        L.polyline(shifted, {
          ...style,
          noClip: true
        }).addTo(group);
      }
    };

    if (passed.length >= 2) {
      addWrappedPolyline(passed, {
        color: '#ffb000',
        weight: 2.5,
        opacity: 0.95,
        lineJoin: 'round'
      });
    }

    if (planned.length >= 2) {
      addWrappedPolyline(planned, {
        color: '#ffffff',
        weight: 2.2,
        opacity: 0.92,
        lineJoin: 'round',
        dashArray: '8 8'
      });
    }

    group.addTo(map);
    routeLayerRef.current = group;
  }, [clearRouteLayer]);

  const loadRoute = useCallback(async () => {
    if (!selectedFlightId || !currentSessionId || !mapRef.current) {
      setRouteCoords([]);
      return;
    }
    const requestKey = `${currentSessionId}:${selectedFlightId}`;

    const now = Date.now();
    if (now - lastRouteLoadRef.current < ROUTE_REFRESH_MS) {
      return;
    }

    lastRouteLoadRef.current = now;

    try {
      const response = await fetch(
        `/api/flights/${encodeURIComponent(selectedFlightId)}/route?sessionId=${encodeURIComponent(currentSessionId)}`
      );

      if (!response.ok) {
        if (selectedRouteKeyRef.current === requestKey) {
          setRouteCoords([]);
        }
        return;
      }

      const data = (await response.json()) as unknown;
      const coords = unwrapAntimeridian(
        dedupeConsecutiveCoordinates(
          findCoordinatesDeep(data).filter(([lat, lon]) => isValidLatLon(lat, lon))
        )
      );

      if (selectedRouteKeyRef.current !== requestKey) {
        return;
      }

      routeCacheRef.current.set(requestKey, coords);
      setRouteCoords(coords);
    } catch (_error) {
      if (selectedRouteKeyRef.current === requestKey) {
        setRouteCoords([]);
      }
    }
  }, [currentSessionId, selectedFlightId]);

  const fetchFlights = useCallback(async () => {
    if (!currentSessionId || isFetchingRef.current || pausedRef.current) {
      return;
    }

    isFetchingRef.current = true;

    try {
      const response = await fetch(`/api/flights?sessionId=${encodeURIComponent(currentSessionId)}`);

      if (!response.ok) {
        const body = (await response.json()) as JsonObject;
        throw new Error(String(body.error || `HTTP ${response.status}`));
      }

      const data = (await response.json()) as JsonObject;
      const rawFlights = Array.isArray(data.result) ? data.result : Array.isArray(data) ? data : [];
      const nextFlights = rawFlights
        .filter((entry): entry is JsonObject => typeof entry === 'object' && entry !== null)
        .map(normalizeFlight)
        .filter((flight): flight is Flight => Boolean(flight));

      setFlights(nextFlights);

      const timestamp = new Date().toLocaleTimeString('ja-JP', { hour12: false });
      setStatusText(`Updated ${timestamp} / ${nextFlights.length.toLocaleString()} flights`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('401')) {
        setStatusText(
          '認証エラー: "Authorization: Bearer <apikey>" を確認してください。',
          true
        );
      } else {
        setStatusText(`更新エラー: ${message}`, true);
      }
    } finally {
      isFetchingRef.current = false;
    }
  }, [currentSessionId, setStatusText]);

  useEffect(() => {
    setUtc(formatUtcClock(new Date()));
    const timer = window.setInterval(() => {
      setUtc(formatUtcClock(new Date()));
    }, 1000);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) {
      return;
    }

    const map = L.map(mapContainerRef.current, {
      worldCopyJump: true,
      zoomControl: false,
      minZoom: 2,
      preferCanvas: true
    }).setView([WORLD_VIEW.lat, WORLD_VIEW.lng], WORLD_VIEW.zoom);

    mapRef.current = map;
    rendererRef.current = L.canvas({ padding: 0.5 });
    map.createPane('airportLayoutPane');
    map.getPane('airportLayoutPane').style.zIndex = '330';
    map.createPane('airportPane');
    map.getPane('airportPane').style.zIndex = '350';
    airportLayoutLayerRef.current = L.layerGroup();
    airportsLayerRef.current = L.layerGroup();
    setZoomLevel(map.getZoom());

    L.control.zoom({ position: 'topright' }).addTo(map);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19
    }).addTo(map);

    const onZoomEnd = () => {
      setZoomLevel(map.getZoom());
      setViewRevision((prev) => prev + 1);
    };
    const onMoveEnd = () => {
      setViewRevision((prev) => prev + 1);
    };
    map.on('zoomend', onZoomEnd);
    map.on('moveend', onMoveEnd);

    return () => {
      map.off('zoomend', onZoomEnd);
      map.off('moveend', onMoveEnd);
    };
  }, []);

  useEffect(() => {
    const onInteraction = () => resetInactivity();

    const events: Array<keyof WindowEventMap> = ['click', 'keydown', 'touchstart'];
    for (const eventName of events) {
      window.addEventListener(eventName, onInteraction, { passive: true });
    }

    const inactivityTimer = window.setInterval(() => {
      if (pausedRef.current) {
        return;
      }

      if (Date.now() - lastInteractionRef.current >= INACTIVITY_TIMEOUT_MS) {
        pausedRef.current = true;
        setStatusText('15分間操作がなかったため更新を停止しました。操作で再開します。', true);
      }
    }, 10000);

    return () => {
      for (const eventName of events) {
        window.removeEventListener(eventName, onInteraction);
      }
      window.clearInterval(inactivityTimer);
    };
  }, [resetInactivity, setStatusText]);

  useEffect(() => {
    let cancelled = false;

    async function loadSessions(): Promise<void> {
      try {
        const response = await fetch('/api/sessions');
        if (!response.ok) {
          throw new Error(`Failed to load sessions: ${response.status}`);
        }

        const data = (await response.json()) as JsonObject;
        const list = (Array.isArray(data.result) ? data.result : Array.isArray(data) ? data : [])
          .filter((entry): entry is JsonObject => typeof entry === 'object' && entry !== null)
          .map((session) => ({
            id: String(getFirstValue(session, ['id', 'Id'], '')),
            name: String(getFirstValue(session, ['name', 'Name'], 'Unknown Session'))
          }))
          .filter((session) => session.id);

        if (!list.length) {
          throw new Error('No sessions found');
        }

        if (cancelled) {
          return;
        }

        setSessions(list);
        const preferred = list.find((session) => session.name.toLowerCase().includes('expert'));
        setCurrentSessionId(preferred ? preferred.id : list[0].id);
        setStatusText('セッション取得完了。フライト情報を更新中...');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setStatusText(`初期化エラー: ${message}`, true);
      }
    }

    void loadSessions();

    return () => {
      cancelled = true;
    };
  }, [setStatusText]);

  useEffect(() => {
    let cancelled = false;

    async function loadAirports(): Promise<void> {
      try {
        const response = await fetch('/api/airports');
        if (!response.ok) {
          throw new Error(`Failed to load airports: ${response.status}`);
        }

        const data = (await response.json()) as JsonObject;
        const list = (Array.isArray(data.result) ? data.result : Array.isArray(data) ? data : [])
          .filter((entry): entry is JsonObject => typeof entry === 'object' && entry !== null)
          .map(normalizeAirport)
          .filter((airport): airport is Airport => Boolean(airport));

        if (cancelled) {
          return;
        }

        setAirports(list);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setStatusText(`空港データ取得失敗: ${message}`, true);
      }
    }

    void loadAirports();

    return () => {
      cancelled = true;
    };
  }, [setStatusText]);

  useEffect(() => {
    if (!currentSessionId) {
      setAtcAirports([]);
      return;
    }

    let cancelled = false;

    async function loadAtc(): Promise<void> {
      try {
        const response = await fetch(`/api/atc?sessionId=${encodeURIComponent(currentSessionId)}`);
        if (!response.ok) {
          throw new Error(`Failed to load ATC: ${response.status}`);
        }

        const data = (await response.json()) as JsonObject;
        const list = (Array.isArray(data.result) ? data.result : Array.isArray(data) ? data : [])
          .filter((entry): entry is JsonObject => typeof entry === 'object' && entry !== null)
          .map(normalizeAtcStation)
          .filter((station): station is AtcStation => Boolean(station));
        const airportsWithAtc = Array.from(new Set(list.map((station) => station.airportName)));

        if (cancelled) {
          return;
        }

        setAtcAirports(airportsWithAtc);
      } catch (_error) {
        if (!cancelled) {
          setAtcAirports([]);
        }
      }
    }

    void loadAtc();
    const timer = window.setInterval(() => {
      void loadAtc();
    }, ATC_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [currentSessionId]);

  useEffect(() => {
    if (!currentSessionId) {
      return;
    }

    void fetchFlights();

    const timer = window.setInterval(() => {
      void fetchFlights();
    }, POLL_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [currentSessionId, fetchFlights]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    const markers = markersRef.current;
    const activeIds = new Set<string>();
    const baseMode: 'dot' | 'plane' = iconMode === 'plane' || zoomLevel >= PLANE_ICON_ZOOM ? 'plane' : 'dot';
    const mode: 'dot' | 'plane' = iconMode === 'plane'
      ? 'plane'
      : (zoomLevel < FORCE_DOT_ZOOM ? 'dot' : baseMode);
    const effectiveShowLabels = showLabels && zoomLevel >= LABEL_MIN_ZOOM;
    const duplicateAll = zoomLevel >= DUPLICATE_ALL_ZOOM;
    const bounds = map.getBounds().pad(0.05);
    const centerLon = map.getCenter().lng;

    const createMarker = (
      flight: Flight,
      latitude: number,
      longitude: number,
      isSelected: boolean
    ): any => {
      const marker =
        mode === 'plane'
          ? L.marker([latitude, longitude], {
              icon: createPlaneIcon(flight.headingDeg, isSelected),
              keyboard: false,
              zIndexOffset: isSelected ? 1000 : 0
            }).addTo(map)
          : L.circleMarker([latitude, longitude], {
              renderer: rendererRef.current,
              radius: isSelected ? 5.5 : 3.2,
              color: '#201a00',
              weight: 1,
              fillColor: isSelected ? '#ffffff' : '#ffd200',
              fillOpacity: 0.95
            }).addTo(map);

      marker.on('click', () => {
        setSelectedFlightId(flight.id);
        lastRouteLoadRef.current = 0;
        resetInactivity();
      });

      bindFlightTooltip(marker, flight.callsign, effectiveShowLabels);
      return marker;
    };

    for (const flight of flights) {
      activeIds.add(flight.id);
      const isSelected = selectedFlightId === flight.id;
      let existing = markers.get(flight.id);
      const positions = getWrappedMarkerPositions(
        flight.latitude,
        flight.longitude,
        bounds,
        centerLon,
        duplicateAll || isSelected
      );
      const positionsKey = positions.map(([lat, lon]) => `${lat.toFixed(5)}:${lon.toFixed(5)}`).join('|');
      const renderKey = markerRenderKey(flight, mode, isSelected, effectiveShowLabels);

      if (existing && existing.mode !== mode) {
        for (const marker of existing.markers) {
          map.removeLayer(marker);
        }
        markers.delete(flight.id);
        existing = undefined;
      }

      if (!existing) {
        const nextMarkers = positions.map(([lat, lon]) => createMarker(flight, lat, lon, isSelected));
        markers.set(flight.id, { markers: nextMarkers, flight, mode, positionsKey, renderKey });
      } else {
        existing.flight = flight;
        if (existing.positionsKey !== positionsKey || existing.markers.length !== positions.length) {
          for (const marker of existing.markers) {
            map.removeLayer(marker);
          }
          const nextMarkers = positions.map(([lat, lon]) => createMarker(flight, lat, lon, isSelected));
          existing.markers = nextMarkers;
          existing.positionsKey = positionsKey;
          existing.renderKey = renderKey;
        } else {
          if (existing.renderKey === renderKey) {
            continue;
          }
          existing.renderKey = renderKey;
          for (let i = 0; i < existing.markers.length; i += 1) {
            const marker = existing.markers[i];
            const [lat, lon] = positions[i];
            marker.setLatLng([lat, lon]);
            if (mode === 'plane') {
              marker.setIcon(createPlaneIcon(flight.headingDeg, isSelected));
              marker.setZIndexOffset(isSelected ? 1000 : 0);
            } else {
              marker.setStyle({
                radius: isSelected ? 5.5 : 3.2,
                color: '#201a00',
                fillColor: isSelected ? '#ffffff' : '#ffd200'
              });
            }
            bindFlightTooltip(marker, flight.callsign, effectiveShowLabels);
          }
        }
      }
    }

    for (const [id, markerState] of markers.entries()) {
      if (!activeIds.has(id)) {
        if (id === selectedFlightId) {
          continue;
        }
        for (const marker of markerState.markers) {
          map.removeLayer(marker);
        }
        markers.delete(id);
      }
    }
  }, [flights, iconMode, resetInactivity, selectedFlightId, showLabels, zoomLevel, viewRevision]);

  useEffect(() => {
    if (!followSelected || !selectedFlight || !mapRef.current) {
      return;
    }

    mapRef.current.panTo([selectedFlight.latitude, selectedFlight.longitude], { animate: true });
  }, [followSelected, selectedFlight]);

  const selectedFlightPositionKey = selectedFlight
    ? `${selectedFlight.latitude.toFixed(4)},${selectedFlight.longitude.toFixed(4)}`
    : '';

  useEffect(() => {
    if (!selectedFlightId) {
      setRouteCoords([]);
      return;
    }
    void loadRoute();
  }, [loadRoute, selectedFlightId, flights.length]);

  useEffect(() => {
    if (!selectedFlightId) {
      clearRouteLayer();
      return;
    }

    const current: [number, number] = selectedFlight
      ? [selectedFlight.latitude, selectedFlight.longitude]
      : [Number.NaN, Number.NaN];
    const planned = plannedRouteCoords.length >= 2 ? splitRouteForDisplay(plannedRouteCoords, current).planned : [];
    const passed = routeCoords.length >= 2 ? routeCoords : [];

    if (passed.length < 2 && planned.length < 2) {
      clearRouteLayer();
      return;
    }

    drawCombinedRouteLayer(passed, planned);
  }, [
    clearRouteLayer,
    drawCombinedRouteLayer,
    plannedRouteCoords,
    routeCoords,
    selectedFlightId,
    selectedFlight,
    selectedFlightPositionKey
  ]);

  useEffect(() => {
    if (!selectedFlightId || !currentSessionId) {
      setFlightPlan(null);
      setFlightPlanLoading(false);
      return;
    }

    const cacheKey = `${currentSessionId}:${selectedFlightId}`;
    if (flightPlanCacheRef.current.has(cacheKey)) {
      setFlightPlan(flightPlanCacheRef.current.get(cacheKey) ?? null);
      setFlightPlanLoading(false);
      return;
    }

    let cancelled = false;
    setFlightPlanLoading(true);

    async function loadFlightPlan(): Promise<void> {
      try {
        const response = await fetch(
          `/api/flights/${encodeURIComponent(selectedFlightId)}/flightplan?sessionId=${encodeURIComponent(currentSessionId)}`
        );
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = (await response.json()) as JsonObject;
        const resultRaw = (data.result && typeof data.result === 'object')
          ? (data.result as JsonObject)
          : data;
        const parsed = normalizeFlightPlan(resultRaw as JsonObject);

        if (cancelled) {
          return;
        }

        flightPlanCacheRef.current.set(cacheKey, parsed);
        setFlightPlan(parsed);
      } catch (_error) {
        if (cancelled) {
          return;
        }
        flightPlanCacheRef.current.set(cacheKey, null);
        setFlightPlan(null);
      } finally {
        if (!cancelled) {
          setFlightPlanLoading(false);
        }
      }
    }

    void loadFlightPlan();

    return () => {
      cancelled = true;
    };
  }, [currentSessionId, selectedFlightId]);

  useEffect(() => {
    const map = mapRef.current;
    const renderer = rendererRef.current;
    const layer = airportsLayerRef.current;
    if (!map || !renderer || !layer) {
      return;
    }

    if (!showAirports) {
      if (map.hasLayer(layer)) {
        map.removeLayer(layer);
      }
      return;
    }

    layer.clearLayers();
    const bounds = map.getBounds().pad(0.3);
    const zoom = map.getZoom();
    for (const airport of airports) {
      const inBounds =
        bounds.contains([airport.latitude, airport.longitude]) ||
        bounds.contains([airport.latitude, airport.longitude + 360]) ||
        bounds.contains([airport.latitude, airport.longitude - 360]);

      if (!inBounds || !shouldRenderAirport(airport, zoom)) {
        continue;
      }

      const tier = getAirportTier(airport);
      const atcOn = atcAirportSet.has(airport.icao.toUpperCase());
      const marker = L.marker([airport.latitude, airport.longitude], {
        pane: 'airportPane',
        icon: createAirportPinIcon(tier, atcOn),
        keyboard: false,
        interactive: false
      }).addTo(layer);

      if (shouldShowAirportLabel(airport, zoom)) {
        marker.bindTooltip(`${airport.icao} - ${airport.name}`, {
          permanent: true,
          direction: 'right',
          offset: [10, -2],
          opacity: 0.96,
          className: `airport-label ${atcOn ? 'atc-on' : 'atc-off'}`
        });
      }
    }

    if (!map.hasLayer(layer)) {
      layer.addTo(map);
    }
  }, [airports, atcAirportSet, showAirports, viewRevision]);

  useEffect(() => {
    const map = mapRef.current;
    const layoutLayer = airportLayoutLayerRef.current;
    if (!map || !layoutLayer) {
      return;
    }

    if (!showAirports) {
      if (map.hasLayer(layoutLayer)) {
        map.removeLayer(layoutLayer);
      }
      layoutLayer.clearLayers();
      return;
    }

    const zoom = map.getZoom();
    if (zoom < AIRPORT_LAYOUT_ZOOM) {
      if (map.hasLayer(layoutLayer)) {
        map.removeLayer(layoutLayer);
      }
      layoutLayer.clearLayers();
      return;
    }

    const bounds = map.getBounds().pad(0.08);
    const west = bounds.getWest();
    const east = bounds.getEast();
    if (!Number.isFinite(west) || !Number.isFinite(east) || west >= east) {
      layoutLayer.clearLayers();
      return;
    }

    let cancelled = false;
    const bbox = [
      bounds.getSouth().toFixed(4),
      west.toFixed(4),
      bounds.getNorth().toFixed(4),
      east.toFixed(4)
    ].join(',');

    async function loadAirportLayout(): Promise<void> {
      try {
        const response = await fetch(`/api/airport-layout?bbox=${encodeURIComponent(bbox)}`);
        if (!response.ok) {
          throw new Error(`Failed to load airport layout: ${response.status}`);
        }

        const data = (await response.json()) as JsonObject;
        const features = (Array.isArray(data.features) ? data.features : [])
          .filter((entry): entry is JsonObject => typeof entry === 'object' && entry !== null)
          .map(normalizeAirportLayoutFeature)
          .filter((feature): feature is AirportLayoutFeature => Boolean(feature));

        if (cancelled) {
          return;
        }

        layoutLayer.clearLayers();

        for (const feature of features) {
          const coords = feature.coordinates;
          if (feature.kind === 'apron' && feature.closed) {
            L.polygon(coords, {
              pane: 'airportLayoutPane',
              stroke: false,
              fill: true,
              fillColor: '#55585f',
              fillOpacity: 0.28,
              interactive: false
            }).addTo(layoutLayer);
            continue;
          }

          const styleByKind: Record<string, { color: string; weight: number; opacity: number }> = {
            runway: { color: '#676a72', weight: 5.2, opacity: 0.9 },
            taxiway: { color: '#50545b', weight: 2.4, opacity: 0.82 },
            taxilane: { color: '#4b4e55', weight: 1.8, opacity: 0.74 },
            helipad: { color: '#737780', weight: 2.2, opacity: 0.82 }
          };
          const style = styleByKind[feature.kind] || { color: '#4b4e55', weight: 1.8, opacity: 0.7 };

          L.polyline(coords, {
            pane: 'airportLayoutPane',
            color: style.color,
            weight: style.weight,
            opacity: style.opacity,
            lineCap: 'round',
            lineJoin: 'round',
            interactive: false
          }).addTo(layoutLayer);
        }

        if (!map.hasLayer(layoutLayer)) {
          layoutLayer.addTo(map);
        }
      } catch (_error) {
        if (!cancelled) {
          layoutLayer.clearLayers();
        }
      }
    }

    void loadAirportLayout();

    return () => {
      cancelled = true;
    };
  }, [showAirports, viewRevision, zoomLevel]);

  const isSearchOpen = searchFocused && searchText.trim().length > 0;
  const listFlights = flights.slice(0, 70);

  return (
    <>
      <div id="map" ref={mapContainerRef} />
      <div className="map-overlay" />

      <header className="hud-top">
        <div className="brand-chip">
          <img src="/logo-infiniteradar26.svg" alt="InfiniteRadar26" className="brand-logo" />
        </div>

        <div className={`search-wrap ${isSearchOpen ? 'open' : ''}`}>
          <input
            value={searchText}
            onChange={(event) => {
              setSearchText(event.target.value);
              resetInactivity();
            }}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && searchCandidates.length > 0) {
                event.preventDefault();
                selectFlightFromSearch(searchCandidates[0]);
              }
              if (event.key === 'Escape') {
                setSearchFocused(false);
              }
            }}
            type="text"
            placeholder="Find flights, airports and more"
          />
          {isSearchOpen ? (
            <div className="search-suggest" role="listbox" aria-label="Flight search suggestions">
              {searchCandidates.length ? (
                searchCandidates.map((flight) => (
                  <button
                    key={flight.id}
                    type="button"
                    className="search-suggest-item"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectFlightFromSearch(flight)}
                  >
                    <strong>{flight.callsign}</strong>
                    <span>
                      {flight.username} · {flight.origin} → {flight.destination}
                    </span>
                  </button>
                ))
              ) : (
                <div className="search-suggest-empty">No matching flights</div>
              )}
            </div>
          ) : null}
        </div>

        <div className="top-actions">
          <div className="utc-chip">{utc}</div>
          <label className="session-wrap">
            <span>Session</span>
            <select
              value={currentSessionId}
              onChange={(event) => {
                setCurrentSessionId(event.target.value);
                setSelectedFlightId(null);
                clearRouteLayer();
                resetInactivity();
              }}
            >
              {sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      <aside className="left-rail">
        <button className="live-card" type="button">
          <span>Most tracked flights</span>
          <b>LIVE</b>
        </button>
        <button className="live-card" type="button">
          <span>Airport disruptions</span>
          <b>LIVE</b>
        </button>
        <button className="live-card" type="button">
          <span>Bookmarks</span>
          <b>HOT</b>
        </button>
      </aside>

      <aside className="right-rail">
        <div className="rail-head">
          <h1>Live Traffic</h1>
          <span id="flightCount">{flights.length.toLocaleString()}</span>
        </div>

        <p className={`polling ${warningStatus ? 'warning' : ''}`}>{status}</p>

        <div className="info-box selected-flight">
          {!selectedFlight ? (
            <p>機体をクリックすると詳細を表示します。</p>
          ) : (
            <>
              <h2>{selectedFlight.callsign}</h2>
              <dl>
                <dt>User</dt>
                <dd>{selectedFlight.username}</dd>
                <dt>Route</dt>
                <dd>
                  {selectedFlight.origin} → {selectedFlight.destination}
                </dd>
                <dt>Altitude</dt>
                <dd>{selectedFlight.altitudeFt.toLocaleString()} ft</dd>
                <dt>Speed</dt>
                <dd>{selectedFlight.speedKts.toLocaleString()} kts</dd>
                <dt>Heading</dt>
                <dd>{Math.round(selectedFlight.headingDeg)}°</dd>
                <dt>Aircraft</dt>
                <dd>{selectedFlight.aircraft}</dd>
                <dt>ETA (est)</dt>
                <dd>{etaText ?? 'N/A'}</dd>
              </dl>

              <div className="plan-box">
                <div className="plan-head">
                  <span>Flight Plan</span>
                  {flightPlanLoading ? <small>Loading...</small> : null}
                </div>
                {planNames.length ? (
                  <p className="plan-route">
                    {planNames.slice(0, 18).join(' -> ')}
                    {planNames.length > 18 ? ' ...' : ''}
                  </p>
                ) : (
                  <p className="plan-route muted">No flight plan data</p>
                )}
              </div>
            </>
          )}
        </div>

        <div className="info-box list-wrap">
          <h2>Airborne Now</h2>
          <ul className="flight-list">
            {!listFlights.length ? (
              <li className="empty">No flights in current filter</li>
            ) : (
              listFlights.map((flight) => (
                <li
                  key={flight.id}
                  className={flight.id === selectedFlightId ? 'active' : ''}
                  onClick={() => {
                    setSelectedFlightId(flight.id);
                    lastRouteLoadRef.current = 0;
                    if (mapRef.current) {
                      mapRef.current.panTo([flight.latitude, flight.longitude], { animate: true });
                    }
                    resetInactivity();
                  }}
                >
                  <div>
                    <strong>{flight.callsign}</strong>
                    <div className="meta">
                      {flight.origin} → {flight.destination}
                    </div>
                  </div>
                  <div>{Math.round(flight.altitudeFt / 1000)}k ft</div>
                </li>
              ))
            )}
          </ul>
        </div>

        <div className="info-box promo-box">
          <h2>API Notes</h2>
          <p>
            "The Sessions endpoint currently has a timeout of 15 minutes if no API calls are made."
            <br />
            認証: "Authorization: Bearer {'<apikey>'}"
            <br />
            空港一覧: "GET /public/v2/airports" (Get 3D Airports)
            <br />
            フライトプラン: "GET /public/v2/sessions/{'{sessionId}'}/flights/{'{flightId}'}/flightplan"
          </p>
        </div>
      </aside>

      <nav className="bottom-dock">
        <button
          className={followSelected ? 'active' : ''}
          onClick={() => {
            setFollowSelected((prev) => !prev);
            resetInactivity();
          }}
          type="button"
        >
          Follow {followSelected ? 'ON' : 'OFF'}
        </button>

        <button
          className={showLabels ? 'active' : ''}
          onClick={() => {
            setShowLabels((prev) => !prev);
            resetInactivity();
          }}
          type="button"
        >
          Labels {showLabels ? 'ON' : 'OFF'}
        </button>

        <button
          className={iconMode === 'plane' ? 'active' : ''}
          onClick={() => {
            setIconMode((prev) => (prev === 'plane' ? 'smart' : 'plane'));
            resetInactivity();
          }}
          type="button"
        >
          {iconMode === 'plane' ? 'Planes ON' : 'Smart planes'}
        </button>

        <button
          className={showAirports ? 'active' : ''}
          onClick={() => {
            setShowAirports((prev) => !prev);
            resetInactivity();
          }}
          type="button"
        >
          {showAirports ? airportButtonLabel(zoomLevel) : 'Airports OFF'}
        </button>

        <button
          onClick={() => {
            if (mapRef.current) {
              mapRef.current.setView([WORLD_VIEW.lat, WORLD_VIEW.lng], WORLD_VIEW.zoom, { animate: true });
            }
            resetInactivity();
          }}
          type="button"
        >
          World View
        </button>

        <button type="button" disabled>
          Weather
        </button>
        <button type="button" disabled>
          Filters
        </button>
        <button type="button" disabled>
          Playback
        </button>
      </nav>
    </>
  );
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Missing #root element');
}

createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
