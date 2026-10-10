import { fetchPhotos, fmt, phaseOf, planProgress, type Flight, type FlightDetail, type Photo, type Pilot } from './data';

/** フライト詳細パネル。骨組みは選択時に 1 回だけ作り、以降は数値部分だけを書き換える。 */

const ICON = {
  close: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6 10.6 12 5 6.4z" fill="currentColor"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 11h12.2l-5.6-5.6L12 4l8 8-8 8-1.4-1.4 5.6-5.6H4z" fill="currentColor"/></svg>',
  prev: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z" fill="currentColor"/></svg>',
  next: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M8.6 16.6 10 18l6-6-6-6-1.4 1.4 4.6 4.6z" fill="currentColor"/></svg>',
  noImage: '<svg viewBox="0 0 24 24" width="40" height="40" aria-hidden="true"><path d="M21 5v12.2l-2-2V5H8.8l-2-2H19a2 2 0 0 1 2 2zM2.8 2.8 21.2 21.2l-1.4 1.4-1.6-1.6H5a2 2 0 0 1-2-2V5.8L1.4 4.2zM5 7.8V19h11.2l-3-3H6l2.6-3.4 1.6 2-5.2-6.8z" fill="currentColor"/></svg>',
  follow: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8zm-1-7h2v3.1A8 8 0 0 1 19.9 11H23v2h-3.1A8 8 0 0 1 13 19.9V23h-2v-3.1A8 8 0 0 1 4.1 13H1v-2h3.1A8 8 0 0 1 11 4.1zm1 5a6 6 0 1 0 0 12 6 6 0 0 0 0-12z" fill="currentColor"/></svg>',
  upload: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M11 16V7.8l-3.6 3.6L6 10l6-6 6 6-1.4 1.4L13 7.8V16zm-7 2h16v2H4z" fill="currentColor"/></svg>',
  link: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M14 3h7v7h-2V6.4l-9.3 9.3-1.4-1.4L17.6 5H14zM5 5h6v2H5v12h12v-6h2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" fill="currentColor"/></svg>'
};

const UPLOAD_URL = 'https://ifspotters.com/upload';
const IFC_PROFILE = 'https://community.infiniteflight.com/u/';
const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export type PanelHandlers = {
  onClose: () => void;
  onToggleFollow: () => void;
};

export class FlightPanel {
  private flightId: string | null = null;
  private detail: FlightDetail | null = null;
  private photos: Photo[] = [];
  private photoIndex = 0;

  constructor(private root: HTMLElement, private handlers: PanelHandlers) {
    root.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if (!target) return;
      const action = target.dataset.action;
      if (action === 'close') handlers.onClose();
      if (action === 'follow') handlers.onToggleFollow();
      if (action === 'prev') this.showPhoto(this.photoIndex - 1);
      if (action === 'next') this.showPhoto(this.photoIndex + 1);
    });
  }

  get openId(): string | null {
    return this.flightId;
  }

  open(f: Flight): void {
    this.flightId = f.id;
    this.detail = null;
    this.photos = [];
    this.photoIndex = 0;

    const sub = [f.username || 'Anonymous', f.va].filter(Boolean).join(' · ');
    this.root.innerHTML = `
      <div class="panel-head">
        <div class="titles">
          <h2>${esc(f.callsign || '—')}</h2>
          <div class="sub" title="${esc(sub)}">${esc(sub)}</div>
        </div>
        <button class="icon-btn" data-action="close" aria-label="Close">${ICON.close}</button>
      </div>
      <div class="panel-scroll">
        <div class="photo" data-slot="photo"><div class="skeleton" style="position:absolute;inset:0;border-radius:0"></div></div>
        <div class="type-line">
          <div class="ac">${esc(f.aircraft || 'Unknown aircraft')}</div>
          <div class="lv">${esc(f.livery || '')}</div>
        </div>
        <div class="route" data-slot="route">
          <div class="route-ends">
            <div class="end"><div class="code skeleton" style="width:72px;height:32px"></div></div>
            <div class="arrow">${ICON.arrow}</div>
            <div class="end"><div class="code skeleton" style="width:72px;height:32px;margin-left:auto"></div></div>
          </div>
        </div>
        <div class="stats" data-slot="stats"></div>
        <div class="profile" data-slot="profile" hidden></div>
        <section class="pilot" data-slot="pilot">
          <div class="pilot-head"><div class="skeleton" style="width:40px;height:40px;border-radius:50%"></div><div class="skeleton" style="flex:1;height:36px"></div></div>
        </section>
        <div class="actions">
          <button class="btn btn-primary" data-action="follow" data-slot="follow">${ICON.follow}<span>Follow</span></button>
          <a class="btn btn-tertiary" data-slot="spotters" href="https://ifspotters.com/" target="_blank" rel="noopener">${ICON.link}<span>IFSpotters</span></a>
        </div>
      </div>`;
    this.root.hidden = false;
    this.update(f, false);
    void this.loadPhotos(f);
  }

  close(): void {
    this.flightId = null;
    this.detail = null;
    this.root.hidden = true;
    this.root.innerHTML = '';
  }

  setFollowing(following: boolean): void {
    const btn = this.slot('follow');
    if (!btn) return;
    btn.className = following ? 'btn btn-tertiary' : 'btn btn-primary';
    btn.querySelector('span')!.textContent = following ? 'Following' : 'Follow';
  }

  setDetail(detail: FlightDetail, f: Flight, pos: [number, number]): void {
    this.detail = detail;
    this.renderRoute(f, pos);
    this.renderProfile(f);
  }

  /** ポーリング・デッドレコニングのたびに呼ばれる。数値だけを差し替える。 */
  update(f: Flight, live = true, pos: [number, number] = [f.lat, f.lon]): void {
    if (f.id !== this.flightId) return;
    const stats = this.slot('stats');
    if (stats) {
      const age = f.ageAtReceipt + (performance.now() - f.receivedAt) / 1000;
      stats.innerHTML = [
        ['Altitude', fmt.alt(f.alt), 'ft'],
        ['Ground speed', fmt.int(f.gs), 'kt'],
        ['Vertical speed', fmt.vs(f.vs), 'fpm'],
        ['Track', fmt.heading(f.track), '°'],
        ['Status', phaseOf(f), ''],
        ['Last report', fmt.ago(age), '']
      ]
        .map(([k, v, u]) => `<div class="stat"><div class="k">${k}</div><div class="v">${esc(v)}${u ? `<small>${u}</small>` : ''}</div></div>`)
        .join('');
    }
    if (live && this.detail) this.renderRoute(f, pos);
  }

  private slot(name: string): HTMLElement | null {
    return this.root.querySelector<HTMLElement>(`[data-slot="${name}"]`);
  }

  private renderRoute(f: Flight, pos: [number, number]): void {
    const el = this.slot('route');
    const detail = this.detail;
    if (!el || !detail) return;

    const { origin, destination, plan } = detail;
    if (!origin && !destination && plan.length < 2) {
      el.innerHTML = '<div class="route-meta" style="margin:0">No flight plan filed</div>';
      return;
    }

    const end = (a: FlightDetail['origin'], fallback: string, align: 'left' | 'right') => `
      <div class="end">
        <div class="code">${esc(a?.iata || a?.icao || fallback || '—')}</div>
        <div class="name" title="${esc(a?.name || '')}">${esc(a ? [a.icao, a.city || a.name].filter(Boolean).join(' · ') : '')}</div>
      </div>`.replace('class="end"', `class="end" style="text-align:${align}"`);

    const progress = planProgress(plan, pos[0], pos[1]);
    let meta = '';
    let pct = 0;
    if (progress && progress.total > 0) {
      const flown = Math.max(0, progress.total - progress.remaining);
      pct = Math.min(100, Math.max(0, (flown / progress.total) * 100));
      const etaMin = f.gs > 50 ? (progress.remaining / f.gs) * 60 : NaN;
      const eta = Number.isFinite(etaMin)
        ? `<span><b>${fmt.duration(etaMin)}</b> left · ETA ${fmt.utc(new Date(Date.now() + etaMin * 60000))}Z</span>`
        : '<span></span>';
      meta = `<div class="route-meta"><span><b>${fmt.int(flown)}</b> / ${fmt.int(progress.total)} nm</span>${eta}</div>`;
    }

    el.innerHTML = `
      <div class="route-ends">
        ${end(origin, plan[0]?.[0] ?? '', 'left')}
        <div class="arrow">${ICON.arrow}</div>
        ${end(destination, plan[plan.length - 1]?.[0] ?? '', 'right')}
      </div>
      <div class="progress"><i style="width:${pct.toFixed(1)}%"></i></div>
      ${meta}`;
  }

  /** パイロットのプロフィールと直近のフライト。取得できなければ欄ごと消す。 */
  setPilot(flightId: string, pilot: Pilot | null): void {
    if (flightId !== this.flightId) return;
    const el = this.slot('pilot');
    if (!el) return;
    const p = pilot?.profile;
    if (!pilot || (!p && !pilot.history.length)) {
      el.hidden = true;
      return;
    }

    const name = p?.ifc || 'Anonymous pilot';
    const head = `
      <div class="pilot-head">
        <div class="pilot-avatar" aria-hidden="true">${esc((name[0] || '?').toUpperCase())}</div>
        <div class="pilot-name">
          <b>${esc(name)}</b>${p ? `<span class="grade">Grade ${p.grade}</span>` : ''}
          ${p?.va ? `<div class="sub">${esc(p.va)}</div>` : ''}
        </div>
        ${p?.ifc ? `<a class="link-btn" href="${IFC_PROFILE}${encodeURIComponent(p.ifc)}" target="_blank" rel="noopener">IFC profile</a>` : ''}
      </div>`;

    const stats = p
      ? `<div class="pilot-stats">${[
          ['Flight time', `${fmt.int(p.flightMinutes / 60)}`, 'h'],
          ['Landings', fmt.int(p.landings), ''],
          ['XP', fmt.int(p.xp), ''],
          ['Violations', fmt.int(p.violations), '']
        ]
          .map(([k, v, u]) => `<div><div class="k">${k}</div><div class="v">${v}${u ? `<small>${u}</small>` : ''}</div></div>`)
          .join('')}</div>`
      : '';

    const history = pilot.history.length
      ? `<div class="k history-k">Recent flights</div>
        <ul class="history">${pilot.history
          .map((h) => {
            const route = h.origin && h.destination && h.origin !== h.destination ? `${h.origin} → ${h.destination}` : h.origin || h.destination || '—';
            const type = [h.aircraft, h.livery].filter(Boolean).join(' · ');
            return `<li>
              <span class="h-route">${esc(route)}</span>
              <span class="h-when">${dateFmt.format(new Date(h.start * 1000))} · ${fmt.duration(h.minutes)}</span>
              <span class="h-meta">${esc([h.callsign, type].filter(Boolean).join(' · '))}</span>
              <span class="h-server">${esc(h.server)}${h.landings ? '' : ' · no landing'}</span>
            </li>`;
          })
          .join('')}</ul>`
      : '';

    el.hidden = false;
    el.innerHTML = `<div class="section-k">Pilot</div>${head}${stats}${history}`;
  }

  /** 高度プロファイル（飛行済み航跡の高度を時間軸で）。 */
  private renderProfile(f: Flight): void {
    const el = this.slot('profile');
    const track = this.detail?.track ?? [];
    if (!el || track.length < 3) {
      if (el) el.hidden = true;
      return;
    }
    const alts = track.map((p) => p[2]);
    if (Math.max(...alts, f.alt) - Math.min(...alts, f.alt) < 500) {
      el.hidden = true;
      return;
    }
    const points = [...track.map((p) => [p[3], p[2]] as [number, number]), [Date.now() / 1000, f.alt] as [number, number]];
    const t0 = points[0][0];
    const t1 = points[points.length - 1][0];
    const maxAlt = Math.max(1000, ...points.map((p) => p[1]));
    const W = 312;
    const H = 64;
    const xy = points.map(([t, a]) => `${(((t - t0) / Math.max(1, t1 - t0)) * W).toFixed(1)},${(H - 2 - (Math.max(0, a) / maxAlt) * (H - 6)).toFixed(1)}`);
    el.hidden = false;
    el.innerHTML = `
      <div class="k">Altitude profile · max ${fmt.alt(maxAlt)} ft</div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <polygon points="0,${H} ${xy.join(' ')} ${W},${H}" fill="rgba(100,190,241,0.18)"/>
        <polyline points="${xy.join(' ')}" fill="none" stroke="#64bef1" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
      </svg>`;
  }

  private async loadPhotos(f: Flight): Promise<void> {
    const id = f.id;
    const result = await fetchPhotos(f.aircraft, f.livery);
    if (this.flightId !== id) return;
    this.photos = result.photos;

    const link = this.slot('spotters') as HTMLAnchorElement | null;
    if (link && f.aircraft) {
      link.href = `https://ifspotters.com/photos?aircraft=${encodeURIComponent(f.aircraft)}${f.livery ? `&airline=${encodeURIComponent(f.livery)}` : ''}`;
    }
    this.showPhoto(0);
  }

  private showPhoto(index: number): void {
    const el = this.slot('photo');
    if (!el) return;
    const photos = this.photos;

    if (!photos.length) {
      el.innerHTML = `<div class="empty">${ICON.noImage}<span>No images</span><small>IFSpotters に該当する写真がありません</small>
        <a class="btn btn-primary btn-sm" href="${UPLOAD_URL}" target="_blank" rel="noopener">${ICON.upload}<span>Upload a photo</span></a></div>`;
      return;
    }

    this.photoIndex = (index + photos.length) % photos.length;
    const p = photos[this.photoIndex];
    const multi = photos.length > 1;
    el.innerHTML = `
      <img src="${esc(p.thumb)}" alt="${esc(`${p.photographer} – ${p.category}`)}" decoding="async" />
      <a class="credit" href="${esc(p.page)}" target="_blank" rel="noopener">© ${esc(p.photographer)}${p.airport ? ` · ${esc(p.airport)}` : ''}</a>
      ${multi ? `<button class="nav prev" data-action="prev" aria-label="Previous photo">${ICON.prev}</button>
      <button class="nav next" data-action="next" aria-label="Next photo">${ICON.next}</button>
      <span class="counter">${this.photoIndex + 1} / ${photos.length}</span>` : ''}`;

    const img = el.querySelector('img')!;
    img.onload = () => img.classList.add('loaded');
    img.onerror = () => {
      this.photos = this.photos.filter((x) => x !== p);
      this.showPhoto(this.photoIndex);
    };
    if (img.complete && img.naturalWidth) img.classList.add('loaded');
  }
}
