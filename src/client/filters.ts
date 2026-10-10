import { fmt, isOnGround, type Flight } from './data';
import type { AirportMode } from './aircraft-layer';

/** 地図に出す機体と空港ピンの絞り込み条件。 */

export const ALT_MAX = 45_000;

export type Filters = {
  status: 'all' | 'air' | 'ground';
  altMin: number;
  /** ALT_MAX のときは上限なし */
  altMax: number;
  aircraft: string;
  airline: string;
  va: string;
  airport: string;
  direction: 'both' | 'in' | 'out';
  airports: AirportMode;
};

export const DEFAULT_FILTERS: Filters = {
  status: 'all',
  altMin: 0,
  altMax: ALT_MAX,
  aircraft: '',
  airline: '',
  va: '',
  airport: '',
  direction: 'both',
  airports: 'all'
};

/** 空港フィルター用。サーバーの /world から取った、その空港を出発地・目的地にしている便 */
export type AirportFlights = { icao: string; inbound: Set<string>; outbound: Set<string> };

/** 機体の絞り込みに効いている条件の数（空港ピンの表示切替は数えない）。 */
export function activeCount(f: Filters): number {
  return (
    Number(f.status !== 'all') +
    Number(f.altMin > 0 || f.altMax < ALT_MAX) +
    Number(!!f.aircraft) +
    Number(!!f.airline) +
    Number(!!f.va) +
    Number(!!f.airport)
  );
}

export function createMatcher(f: Filters, airportFlights: AirportFlights | null): (flight: Flight) => boolean {
  const aircraft = f.aircraft.toLowerCase();
  const airline = f.airline.toLowerCase();
  const va = f.va.toLowerCase();
  const routeIds =
    f.airport && airportFlights?.icao === f.airport
      ? f.direction === 'in'
        ? airportFlights.inbound
        : f.direction === 'out'
          ? airportFlights.outbound
          : new Set([...airportFlights.inbound, ...airportFlights.outbound])
      : null;

  return (flight) => {
    if (f.status === 'air' && isOnGround(flight)) return false;
    if (f.status === 'ground' && !isOnGround(flight)) return false;
    if (flight.alt < f.altMin) return false;
    if (f.altMax < ALT_MAX && flight.alt > f.altMax) return false;
    if (aircraft && !flight.aircraft.toLowerCase().includes(aircraft)) return false;
    if (airline && !flight.livery.toLowerCase().includes(airline)) return false;
    if (va && !flight.va.toLowerCase().includes(va)) return false;
    // 空港の便一覧がまだ届いていない間は全便を出す（一瞬すべて消えるのを避ける）
    if (f.airport && routeIds && !routeIds.has(flight.id)) return false;
    return true;
  };
}

export function loadFilters(key: string): Filters {
  try {
    const stored = JSON.parse(localStorage.getItem(key) || 'null') as Partial<Filters> | null;
    return { ...DEFAULT_FILTERS, ...(stored ?? {}) };
  } catch {
    return { ...DEFAULT_FILTERS };
  }
}

export function saveFilters(key: string, f: Filters): void {
  try {
    localStorage.setItem(key, JSON.stringify(f));
  } catch {
    /* 保存できなくても絞り込み自体は効く */
  }
}

// ---------------------------------------------------------------------------
// フォーム
// ---------------------------------------------------------------------------

function altText(ft: number): string {
  return ft >= ALT_MAX ? `${fmt.int(ALT_MAX)}+` : fmt.int(ft);
}

export class FilterForm {
  private form: HTMLFormElement;
  private altOut: HTMLOutputElement;
  private result: HTMLElement;
  private range: HTMLElement;

  constructor(
    root: HTMLElement,
    private onChange: (filters: Filters) => void
  ) {
    this.form = root.querySelector('form')!;
    this.altOut = root.querySelector('#alt-out')!;
    this.result = root.querySelector('#filter-result')!;
    this.range = root.querySelector('.range2')!;

    let timer = 0;
    this.form.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement;
      this.keepAltOrder(target.name);
      this.showAlt();
      // 文字入力は打ち終わりを待ってから反映する
      window.clearTimeout(timer);
      const delay = target.type === 'search' ? 200 : 0;
      timer = window.setTimeout(() => this.onChange(this.read()), delay);
    });
    this.form.addEventListener('submit', (event) => event.preventDefault());
    root.querySelector('#filter-reset')!.addEventListener('click', () => {
      this.write(DEFAULT_FILTERS);
      this.onChange(this.read());
    });
  }

  read(): Filters {
    const data = new FormData(this.form);
    const text = (name: string) => String(data.get(name) ?? '').trim();
    return {
      status: (text('status') || 'all') as Filters['status'],
      altMin: Number(text('altMin')) || 0,
      altMax: Number(text('altMax')) || ALT_MAX,
      aircraft: text('aircraft'),
      airline: text('airline'),
      va: text('va'),
      airport: text('airport').toUpperCase(),
      direction: (text('direction') || 'both') as Filters['direction'],
      airports: (text('airports') || 'all') as AirportMode
    };
  }

  write(f: Filters): void {
    const el = this.form.elements;
    const set = (name: string, value: string) => {
      const field = el.namedItem(name);
      if (field instanceof RadioNodeList) field.value = value;
      else if (field instanceof HTMLInputElement) field.value = value;
    };
    set('status', f.status);
    set('altMin', String(f.altMin));
    set('altMax', String(f.altMax));
    set('aircraft', f.aircraft);
    set('airline', f.airline);
    set('va', f.va);
    set('airport', f.airport);
    set('direction', f.direction);
    set('airports', f.airports);
    this.showAlt();
  }

  /** 入力候補を今飛んでいる機体から作る（多い順）。 */
  updateSuggestions(flights: Flight[]): void {
    const fill = (id: string, pick: (f: Flight) => string) => {
      const counts = new Map<string, number>();
      for (const f of flights) {
        const v = pick(f);
        if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      const options = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 200);
      const list = document.getElementById(id)!;
      list.replaceChildren(
        ...options.map(([value]) => {
          const option = document.createElement('option');
          option.value = value;
          return option;
        })
      );
    };
    fill('dl-aircraft', (f) => f.aircraft);
    fill('dl-airline', (f) => f.livery);
    fill('dl-va', (f) => f.va);
  }

  setResult(shown: number, total: number, active: boolean): void {
    this.result.innerHTML = active ? `<b>${fmt.int(shown)}</b> of ${fmt.int(total)} flights match` : `${fmt.int(total)} flights`;
  }

  /** 下限のつまみが上限を越えないようにする。 */
  private keepAltOrder(changed: string): void {
    const el = this.form.elements;
    const min = el.namedItem('altMin') as HTMLInputElement;
    const max = el.namedItem('altMax') as HTMLInputElement;
    if (Number(min.value) <= Number(max.value)) return;
    if (changed === 'altMin') max.value = min.value;
    else min.value = max.value;
  }

  private showAlt(): void {
    const el = this.form.elements;
    const min = Number((el.namedItem('altMin') as HTMLInputElement).value);
    const max = Number((el.namedItem('altMax') as HTMLInputElement).value);
    this.altOut.textContent = min === 0 && max >= ALT_MAX ? 'Any' : `${altText(min)} – ${altText(max)} ft`;
    this.range.style.setProperty('--lo', `${(min / ALT_MAX) * 100}%`);
    this.range.style.setProperty('--hi', `${(max / ALT_MAX) * 100}%`);
  }
}
