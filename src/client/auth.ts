/**
 * IFSpotters と同じ Clerk のログインを使う。
 *
 * radar.ifspotters.com は ifspotters.com のサブドメインなので、Clerk の本番インスタンス
 * （clerk.ifspotters.com）のセッションをそのまま共有できる。ログイン画面も IFSpotters の
 * /sign-in を使い、終わったら redirect_url でこのページへ戻す（Clerk は既定で
 * *.ifspotters.com への戻り先を許可している）。
 *
 * clerk-js は地図の表示を遅らせないよう、最初の描画が終わってから読み込む。
 */

const PUBLISHABLE_KEY = 'pk_live_Y2xlcmsuaWZzcG90dGVycy5jb20k';
const CLERK_SCRIPT = 'https://clerk.ifspotters.com/npm/@clerk/clerk-js@6/dist/clerk.browser.js';
const IFSPOTTERS = 'https://ifspotters.com';
/** ローカル開発でログイン状態を試すためのキー（localhost のときだけ見る） */
const DEV_USER_KEY = 'ir:devUser';

export type Viewer = {
  displayName: string;
  /** Infinite Flight Community のユーザー名。ライブのフライトの username と一致する */
  ifcUsername: string;
  imageUrl: string;
};

type ClerkUser = {
  username: string | null;
  firstName: string | null;
  imageUrl: string;
  primaryEmailAddress: { emailAddress: string } | null;
  publicMetadata: { displayName?: string; ifcUsername?: string };
};

type ClerkInstance = {
  load(options?: Record<string, unknown>): Promise<void>;
  user: ClerkUser | null | undefined;
  signOut(): Promise<void>;
  addListener(listener: (resources: { user?: ClerkUser | null }) => void): () => void;
};

declare global {
  interface Window {
    Clerk?: ClerkInstance;
  }
}

/** ログインが使えるのは本番ドメインだけ（Clerk の本番キーは他のオリジンを受け付けない）。 */
function onIfspottersDomain(): boolean {
  return location.hostname === 'ifspotters.com' || location.hostname.endsWith('.ifspotters.com');
}

function isLocalhost(): boolean {
  return location.hostname === 'localhost' || location.hostname === '127.0.0.1';
}

function toViewer(user: ClerkUser | null | undefined): Viewer | null {
  if (!user) return null;
  const meta = user.publicMetadata ?? {};
  // IFSpotters の resolveDisplayName と同じ優先順位
  const displayName =
    meta.displayName || user.username || user.firstName || user.primaryEmailAddress?.emailAddress.split('@')[0] || 'spotter';
  return { displayName, ifcUsername: meta.ifcUsername ?? '', imageUrl: user.imageUrl };
}

function loadScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = CLERK_SCRIPT;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.dataset.clerkPublishableKey = PUBLISHABLE_KEY;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Could not load Clerk'));
    document.head.appendChild(script);
  });
}

/**
 * ログイン状態を調べる。変化（別タブでのログアウトなど）は onChange で知らせる。
 * Clerk が読めないときは未ログイン扱いにする。
 */
export async function loadViewer(onChange: (viewer: Viewer | null) => void): Promise<Viewer | null> {
  if (isLocalhost()) {
    try {
      const dev = localStorage.getItem(DEV_USER_KEY);
      if (dev) return { displayName: dev, ifcUsername: dev, imageUrl: '' };
    } catch {
      /* noop */
    }
    return null;
  }
  if (!onIfspottersDomain()) return null;

  try {
    await loadScript();
    const clerk = window.Clerk;
    if (!clerk) return null;
    await clerk.load();
    const keyOf = (user: ClerkUser | null | undefined) => (user ? `in:${user.publicMetadata?.ifcUsername ?? ''}` : 'out');
    let last = keyOf(clerk.user);
    clerk.addListener(({ user }) => {
      if (keyOf(user) === last) return;
      last = keyOf(user);
      onChange(toViewer(user));
    });
    return toViewer(clerk.user);
  } catch {
    return null;
  }
}

export function signInUrl(): string {
  if (isLocalhost()) return '#dev-sign-in';
  return `${IFSPOTTERS}/sign-in?redirect_url=${encodeURIComponent(location.href)}`;
}

export function settingsUrl(): string {
  return `${IFSPOTTERS}/settings`;
}

export async function signOut(): Promise<void> {
  if (isLocalhost()) {
    try {
      localStorage.removeItem(DEV_USER_KEY);
    } catch {
      /* noop */
    }
    return;
  }
  await window.Clerk?.signOut();
}

/** localhost でだけ使う、ログインしたことにする仕組み（IFC ユーザー名を入れる）。 */
export function devSignIn(): boolean {
  const name = window.prompt('Dev sign-in: IFC username');
  if (!name) return false;
  try {
    localStorage.setItem(DEV_USER_KEY, name.trim());
  } catch {
    return false;
  }
  return true;
}
