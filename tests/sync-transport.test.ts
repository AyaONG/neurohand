import { expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { supabaseTransport } from '../src/sync';
import { createSession, finishSession } from '../src/session';

it('uses captured owner and stable cursor filters through the actual SDK, with INSERT only', async () => {
  const requests: { url: URL; options: RequestInit }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, options: RequestInit = {}) => {
    requests.push({ url: new URL(String(input)), options });
    return new Response(JSON.stringify(options.method === 'POST' ? {} : []), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const client = createClient('https://example.supabase.co', 'sb_publishable_test', {
    global: { fetch }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const transport = supabaseTransport(client), signal = new AbortController().signal;
  await transport.page('owner-a', { endedAt: '2026-09-30T00:00:00+00:00', id: 'id,with"quote' }, signal);
  const page = requests[0].url.searchParams;
  expect(page.get('user_id')).toBe('eq.owner-a'); expect(page.get('limit')).toBe('30');
  expect(page.get('order')).toBe('ended_at.desc,id.asc');
  expect(page.get('or')).toContain('id.gt."id,with\\"quote"');
  await transport.get('owner-a', 'session-a', signal);
  expect(requests[1].url.searchParams.get('id')).toBe('eq.session-a');
  expect(requests[1].url.searchParams.get('user_id')).toBe('eq.owner-a');
  const s = finishSession(createSession('session-a'), 'stopped', new Date().toISOString());
  await transport.insert('owner-a', s, signal);
  expect(requests[2].options.method).toBe('POST'); expect(JSON.parse(String(requests[2].options.body)).user_id).toBe('owner-a');
  expect(requests.every(r => !['PATCH','DELETE','PUT'].includes(r.options.method ?? 'GET'))).toBe(true);
});

it('times out a stalled SDK request and aborts its fetch signal', async () => {
  vi.useFakeTimers();
  try {
    let signal: AbortSignal | undefined;
    const client = createClient('https://example.supabase.co', 'sb_publishable_test', {
      global: { fetch: async (_input, options) => { signal = options?.signal ?? undefined; return await new Promise<Response>(() => {}); } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const promise = supabaseTransport(client).page('owner-a', null, new AbortController().signal);
    const assertion = expect(promise).rejects.toMatchObject({ status: 0 });
    await vi.advanceTimersByTimeAsync(15000); await assertion;
    expect(signal?.aborted).toBe(true);
  } finally { vi.useRealTimers(); }
});
