export type ProviderState = 'enabled' | 'disabled' | 'unavailable';
/** Public GoTrue settings, not the Management/Admin API. Never attach a user JWT. */
export async function googleProviderState(origin: string, publishableKey: string, request: typeof fetch = fetch, timeoutMs = 4000): Promise<ProviderState> {
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const task = (async (): Promise<ProviderState> => {
      const response = await request(new URL('/auth/v1/settings', origin).href, {
        method: 'GET', headers: { apikey: publishableKey }, credentials: 'omit', cache: 'no-store', signal: controller.signal,
      });
      if (!response.ok) return 'unavailable';
      const value = await response.json();
      return value?.external?.google === true ? 'enabled' : value?.external?.google === false ? 'disabled' : 'unavailable';
    })();
    const deadline = new Promise<ProviderState>(resolve => { timer = setTimeout(() => { controller.abort(); resolve('unavailable'); }, timeoutMs); });
    return await Promise.race([task, deadline]);
  } catch { return 'unavailable'; }
  finally { if (timer) clearTimeout(timer); }
}
