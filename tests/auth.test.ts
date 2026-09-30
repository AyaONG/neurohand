import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AuthController, cloudConfig } from '../src/cloud';
const create = vi.hoisted(() => vi.fn(() => ({ auth: {} })));
vi.mock('@supabase/supabase-js', () => ({ createClient: create }));
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const result = (id: string | null) => ({ data: { session: id ? { user: { id } } : null }, error: null });
function mock() {
  let listener: (event: string, session: unknown) => void = () => {};
  const auth = { onAuthStateChange: vi.fn(cb => { listener = cb; return { data: { subscription: { unsubscribe: vi.fn() } } }; }),
    getSession: vi.fn(async () => result(null)), exchangeCodeForSession: vi.fn(async () => result(A)),
    signInWithOAuth: vi.fn(async () => ({ error: null })), signOut: vi.fn(async () => ({ error: null })) };
  const identity = vi.fn(), view = vi.fn();
  return { auth, identity, view, controller: new AuthController({ auth } as unknown as SupabaseClient, identity, view),
    emit: (event: string, id: string | null) => listener(event, id ? { user: { id } } : null) };
}
describe('optional SDK configuration', () => {
  it('stays guest with absent/partial/secret configuration and never creates a client', () => {
    create.mockClear();
    for (const env of [{}, { VITE_SUPABASE_URL: 'https://example.supabase.co' },
      { VITE_SUPABASE_URL: 'https://example.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_do_not_accept' },
      { VITE_SUPABASE_URL: 'http://example.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example' }]) {
      expect(cloudConfig(env).client).toBeNull();
    }
    expect(create).not.toHaveBeenCalled();
  });
  it('uses one PKCE mechanism and leaves token/verifier storage to SDK', () => {
    cloudConfig({ VITE_SUPABASE_URL: 'https://example.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example' });
    expect(create).toHaveBeenLastCalledWith('https://example.supabase.co', 'sb_publishable_example', {
      auth: { flowType: 'pkce', detectSessionInUrl: false, persistSession: true, autoRefreshToken: true },
    });
  });
});
it('exchanges a callback exactly once, removes code before the request and supports reload without replay', async () => {
  const m = mock(), replace = vi.fn();
  const first = m.controller.start('https://app.example/?code=one-use&debug=1', replace);
  expect(m.controller.start('https://app.example/?code=one-use', replace)).toBe(first);
  expect(replace).toHaveBeenCalledWith('https://app.example/?debug=1');
  await first; expect(m.auth.exchangeCodeForSession).toHaveBeenCalledTimes(1);
  expect(m.auth.getSession).not.toHaveBeenCalled(); expect(m.identity).toHaveBeenLastCalledWith(A);
  const reload = mock(); await reload.controller.start(replace.mock.calls[0][0], vi.fn());
  expect(reload.auth.exchangeCodeForSession).not.toHaveBeenCalled(); expect(reload.auth.getSession).toHaveBeenCalledOnce();
});
it('does not let a late getSession response replace a newer account or sign-out', async () => {
  const m = mock(); let resolve!: (value: ReturnType<typeof result>) => void;
  m.auth.getSession.mockImplementation(() => new Promise(r => { resolve = r; }));
  const boot = m.controller.start('https://app.example/', vi.fn());
  m.emit('SIGNED_IN', B); resolve(result(A)); await boot;
  expect(m.identity).toHaveBeenLastCalledWith(B);
  m.emit('SIGNED_OUT', null); expect(m.identity).toHaveBeenLastCalledWith(null);
});
it('handles denied/failed OAuth without rendering provider error text or saving tokens', async () => {
  const m = mock(), replace = vi.fn();
  await m.controller.start('https://app.example/?error=access_denied&error_description=private', replace);
  expect(m.auth.exchangeCodeForSession).not.toHaveBeenCalled(); expect(replace).toHaveBeenCalledWith('https://app.example/');
  expect(m.view.mock.lastCall![0].text).not.toContain('private');
  m.auth.signInWithOAuth.mockRejectedValueOnce(Error('private server error'));
  const pause = vi.fn(); await m.controller.signIn('https://app.example', pause);
  expect(pause).toHaveBeenCalledOnce(); expect(m.view.mock.lastCall![0].busy).toBe(false);
  expect(m.auth.signInWithOAuth).toHaveBeenCalledWith({ provider: 'google', options: { redirectTo: 'https://app.example/' } });
});
it('hides the old identity immediately on logout; failed logout stays hidden until retry succeeds', async () => {
  const m = mock(); await m.controller.start('https://app.example/', vi.fn()); m.emit('SIGNED_IN', A);
  m.auth.signOut.mockRejectedValueOnce(Error('offline')); await m.controller.signOut();
  expect(m.identity).toHaveBeenLastCalledWith(null); expect(m.view.mock.lastCall![0].canSignOut).toBe(true);
  m.emit('TOKEN_REFRESHED', A); expect(m.identity).toHaveBeenLastCalledWith(null);
  await m.controller.signOut(); expect(m.auth.signOut).toHaveBeenLastCalledWith({ scope: 'local' });
  expect(m.view.mock.lastCall![0].canSignOut).toBe(false);
});
it('ignores late bootstrap completion after disposal', async () => {
  const m = mock(); let resolve!: (value: ReturnType<typeof result>) => void;
  m.auth.getSession.mockImplementation(() => new Promise(r => { resolve = r; }));
  const boot = m.controller.start('https://app.example/', vi.fn()); m.controller.dispose(); resolve(result(A)); await boot;
  expect(m.identity).not.toHaveBeenCalled();
});
it('ignores a stale token refresh from the former account', async () => {
  const m = mock(); await m.controller.start('https://app.example/', vi.fn());
  m.emit('SIGNED_IN', A); m.emit('SIGNED_IN', B); m.emit('TOKEN_REFRESHED', A);
  expect(m.identity).toHaveBeenLastCalledWith(B);
});

it('exposes a safe debug category for provider failure without exposing credentials', async () => {
  const m = mock(); await m.controller.start('https://app.example/', vi.fn());
  m.auth.signInWithOAuth.mockRejectedValueOnce({ code: 'provider_disabled', message: 'private-token' });
  await m.controller.signIn('http://127.0.0.1:5173', vi.fn());
  expect(m.view.mock.lastCall![0].diagnostic).toBe('provider');
  expect(JSON.stringify(m.view.mock.lastCall![0])).not.toContain('private-token');
  expect(m.auth.signInWithOAuth.mock.lastCall![0].options.redirectTo).toBe('http://127.0.0.1:5173/');
});
