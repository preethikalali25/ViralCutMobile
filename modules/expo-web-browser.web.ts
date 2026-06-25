// Web compatibility stub for expo-web-browser
// maybeCompleteAuthSession is called at module load time in template/auth — must not throw

export function maybeCompleteAuthSession(
  _options?: { skipRedirectCheck?: boolean },
): { type: string } {
  // On web, attempt to signal completion to any waiting auth session
  if (typeof window !== 'undefined') {
    try {
      // Dispatch a storage event that expo-auth-session listens for on web
      window.dispatchEvent(new Event('expo-web-browser-redirect'));
    } catch {
      // ignore
    }
  }
  return { type: 'success' };
}

export async function openAuthSessionAsync(
  url: string,
  _redirectUrl?: string,
  _options?: Record<string, unknown>,
): Promise<{ type: string; url?: string }> {
  if (typeof window !== 'undefined') {
    window.location.href = url;
  }
  return { type: 'opened' };
}

export async function openBrowserAsync(
  url: string,
  _options?: Record<string, unknown>,
): Promise<{ type: string }> {
  if (typeof window !== 'undefined') {
    window.open(url, '_blank');
  }
  return { type: 'opened' };
}

export function dismissBrowser(): void {}
export function dismissAuthSession(): void {}
export function warmUpAsync(_browserPackage?: string): Promise<void> {
  return Promise.resolve();
}
export function coolDownAsync(_browserPackage?: string): Promise<void> {
  return Promise.resolve();
}
