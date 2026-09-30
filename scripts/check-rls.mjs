// Live test only: creates two synthetic immutable rows, one per ordinary test user.
// Secrets are accepted from the process environment only, never logged or persisted.
import { randomUUID } from 'node:crypto';
const env = process.env;
const url = env.VITE_SUPABASE_URL, key = env.VITE_SUPABASE_PUBLISHABLE_KEY;
const aToken = env.RLS_USER_A_ACCESS_TOKEN, bToken = env.RLS_USER_B_ACCESS_TOKEN;
if (!url?.startsWith('https://') || !key?.startsWith('sb_publishable_') || !aToken || !bToken) {
  console.error('Set Project URL, publishable key and two ordinary-user access tokens locally. Do not use service_role.'); process.exit(1);
}
const assert = (ok, label) => { if (!ok) throw new Error(label); };
async function request(path, token, method = 'GET', body) {
  const response = await fetch(new URL(path, url), { method, headers: { apikey: key,
    ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', Prefer: 'return=representation' },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  let data; try { data = await response.json(); } catch { data = null; }
  return { status: response.status, ok: response.ok, data };
}
try {
  const ua = await request('/auth/v1/user', aToken), ub = await request('/auth/v1/user', bToken);
  assert(ua.ok && ub.ok && ua.data?.id && ub.data?.id && ua.data.id !== ub.data.id, 'Two distinct ordinary authenticated users are required');
  const id = `rls-check-${randomUUID()}`, at = new Date().toISOString();
  const payload = { schemaVersion: 3, id, startedAt: at, endedAt: at, status: 'stopped', paused: true,
    mode: 'guided', protocolId: 'guided-v1', recognitionVersion: 'landmarks-v1-norm008', hand: 'unspecified', currentExercise: 'pinch',
    settings: { pinchTarget: 5, gripTarget: 5, holdTargetCount: 3, holdTargetMs: 2000, targetRadiusRatio: 0.12 },
    exercises: Object.fromEntries(['pinch','grip','hold'].map(name => [name, { reps: 0, target: name === 'hold' ? 3 : 5,
      started: false, activeMs: 0, promptEpisodes: {}, bestHoldMs: name === 'hold' ? 0 : null }])),
    attempts: { historyComplete: true, records: [], active: null } };
  const row = user_id => ({ user_id, id, schema_version: 3, started_at: at, ended_at: at, status: 'stopped', payload });
  const table = '/rest/v1/training_sessions', query = `${table}?id=eq.${id}`;
  assert((await request(table, aToken, 'POST', row(ua.data.id))).ok, 'A own INSERT failed');
  const own = await request(query, aToken);
  assert(own.ok && own.data.length === 1, 'A own SELECT failed');
  const other = await request(query, bToken);
  assert(other.ok && other.data.length === 0, 'B can read A record');
  assert((await request(table, bToken, 'POST', row(ua.data.id))).data?.code === '42501', 'B can INSERT for A');
  assert((await request(table, aToken, 'POST', row(ua.data.id))).data?.code === '23505', 'Duplicate was not rejected');
  assert((await request(query, aToken, 'PATCH', { status: 'stopped' })).data?.code === '42501', 'UPDATE was not denied');
  assert((await request(query, aToken, 'DELETE')).data?.code === '42501', 'DELETE was not denied');
  assert((await request(query, null)).data?.code === '42501', 'Anon SELECT was not denied');
  assert((await request(table, null, 'POST', row(ua.data.id))).data?.code === '42501', 'Anon INSERT was not denied');
  assert((await request(table, bToken, 'POST', row(ub.data.id))).ok, 'B own INSERT with same session id failed');
  const ownB = await request(query, bToken);
  assert(ownB.ok && ownB.data.length === 1 && ownB.data[0].user_id === ub.data.id, 'B isolation failed');
  console.log('PASS: ordinary-user A/B/anon live RLS checks. Two synthetic stopped sessions remain in the test accounts.');
} catch (error) { console.error(error instanceof Error ? error.message : 'RLS check failed'); process.exitCode = 1; }
