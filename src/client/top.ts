import { fetchTopPilots, fmt, type TopPilot, type TopPilots } from './data';

/**
 * トップパイロット。いまオンラインの人を、通算の飛行時間・着陸回数で並べる。
 *
 * サーバーは API の上限を守りながら少しずつ記録を集める（Expert で 5〜6 分）ので、
 * 開いている間は問い合わせを続け、集まった分から順位を出していく。
 */

export type TopSort = 'time' | 'landings';

type TopHandlers = {
  onSelect: (flightId: string) => void;
  /** ログイン中の人の IFC ユーザー名（小文字）。自分の行に印を付ける */
  me: () => string | null;
};

const LIST = 100;
/** 集め終わるまでの問い合わせ間隔（サーバー側で 1 回最大 5 秒かけて集める） */
const POLL_COLLECTING_MS = 1000;
/** 集め終わったあとは、新しく来た人の分だけなのでゆっくり */
const POLL_DONE_MS = 60_000;

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export class TopPilotsView {
  private sessionId: string | null = null;
  private server = '';
  private sort: TopSort = 'time';
  private data: TopPilots | null = null;
  private error = '';
  private abort: AbortController | null = null;
  private timer = 0;

  constructor(private root: HTMLElement, private handlers: TopHandlers) {
    root.addEventListener('click', (event) => this.onClick(event));
  }

  /** 開く（サーバーを切り替えたときも呼ぶ）。 */
  open(sessionId: string, server: string): void {
    if (this.sessionId !== sessionId) {
      this.data = null;
      this.error = '';
    }
    this.sessionId = sessionId;
    this.server = server;
    this.root.innerHTML = `<header class="pop-head"><h3>Top pilots</h3><span class="muted"></span></header>
      <div class="seg top-sort" role="group" aria-label="Rank by"></div>
      <div class="top-status"></div>
      <ol class="top-list"></ol>
      <footer class="pop-foot">Lifetime totals of pilots flying on this server now.</footer>`;
    this.render();
    void this.load();
  }

  close(): void {
    this.sessionId = null;
    this.abort?.abort();
    window.clearTimeout(this.timer);
  }

  private async load(): Promise<void> {
    window.clearTimeout(this.timer);
    this.abort?.abort();
    const sessionId = this.sessionId;
    if (!sessionId) return;
    const controller = new AbortController();
    this.abort = controller;
    let next = POLL_COLLECTING_MS;
    try {
      const data = await fetchTopPilots(sessionId, controller.signal);
      if (controller.signal.aborted || this.sessionId !== sessionId) return;
      this.data = data;
      this.error = '';
      if (data.known >= data.online) next = POLL_DONE_MS;
    } catch (error) {
      if (controller.signal.aborted) return;
      this.error = (error as Error).message;
      next = 10_000;
    }
    this.render();
    this.timer = window.setTimeout(() => void this.load(), next);
  }

  private render(): void {
    const head = this.root.querySelector<HTMLElement>('.pop-head .muted');
    const seg = this.root.querySelector<HTMLElement>('.top-sort');
    const status = this.root.querySelector<HTMLElement>('.top-status');
    const list = this.root.querySelector<HTMLElement>('.top-list');
    if (!head || !seg || !status || !list) return;
    head.textContent = `Online now · ${this.server}`;
    const sorts: Array<[TopSort, string]> = [
      ['time', 'Flight time'],
      ['landings', 'Landings']
    ];
    seg.innerHTML = sorts
      .map(([value, label]) => `<button type="button" data-sort="${value}" aria-pressed="${value === this.sort}">${label}</button>`)
      .join('');

    const d = this.data;
    if (!d) {
      status.innerHTML = this.error ? `<p class="pop-empty">${esc(this.error)}</p>` : '<p class="pop-empty">Checking pilots online…</p>';
      list.innerHTML = '';
      return;
    }
    const pct = d.online ? Math.min(100, Math.round((d.known / d.online) * 100)) : 100;
    status.innerHTML =
      d.known < d.online
        ? `<div class="top-progress" role="status">
            <div>Checking pilots online… <b>${fmt.int(d.known)}</b> / ${fmt.int(d.online)}</div>
            <div class="progress"><i style="width:${pct}%"></i></div>
            <small>Big servers take a few minutes. The ranking updates as it goes.</small>
          </div>`
        : '';

    const key = this.sort === 'time' ? 'minutes' : 'landings';
    const pilots = [...d.pilots].sort((a, b) => b[key] - a[key]).slice(0, LIST);
    if (!pilots.length) {
      list.innerHTML = '';
      if (!status.innerHTML) status.innerHTML = '<p class="pop-empty">No pilots online on this server.</p>';
      return;
    }
    const me = this.handlers.me();
    list.innerHTML = pilots.map((p, i) => this.row(p, i + 1, me)).join('');
  }

  private row(p: TopPilot, rank: number, me: string | null): string {
    const name = p.name || p.callsign;
    const sub = [p.name ? p.callsign : '', p.grade ? `Grade ${p.grade}` : '', p.va].filter(Boolean).join(' · ');
    const value = this.sort === 'time' ? `${fmt.int(p.minutes / 60)}<small>h</small>` : fmt.int(p.landings);
    const mine = !!me && p.name.toLowerCase() === me;
    return `<li><button type="button" class="top-row${mine ? ' me' : ''}" data-flight="${esc(p.flightId)}">
      <span class="r-no">${rank}</span>
      <span class="top-main"><b>${esc(name)}${mine ? '<i>You</i>' : ''}</b><small>${esc(sub)}</small></span>
      <span class="top-val">${value}</span>
    </button></li>`;
  }

  private onClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    const sort = target.closest<HTMLElement>('[data-sort]')?.dataset.sort as TopSort | undefined;
    if (sort) {
      if (sort === this.sort) return;
      this.sort = sort;
      this.render();
      this.root.querySelector('.top-list')?.scrollTo({ top: 0 });
      return;
    }
    const flight = target.closest<HTMLElement>('[data-flight]')?.dataset.flight;
    if (flight) this.handlers.onSelect(flight);
  }
}
