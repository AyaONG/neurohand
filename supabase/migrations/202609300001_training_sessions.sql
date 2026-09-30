begin;

-- Intentionally fail if the table already exists: inspect its schema, never drop user data.
create table public.training_sessions (
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Actual local schema accepts string IDs; preserve historical IDs, including non-UUID IDs.
  id text not null check (char_length(id) between 1 and 200),
  schema_version integer not null check (schema_version = 3),
  started_at timestamptz not null check (isfinite(started_at)),
  ended_at timestamptz not null check (isfinite(ended_at) and ended_at >= started_at),
  status text not null check (status in ('completed', 'stopped')),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, id),
  constraint payload_size check (octet_length(payload::text) <= 524288),
  constraint payload_shape check ((
    jsonb_typeof(payload) = 'object'
    and payload - array['schemaVersion','attempts','id','startedAt','endedAt','status','mode','protocolId',
      'recognitionVersion','hand','settings','currentExercise','paused','exercises','opposition','ring'] = '{}'::jsonb
    and payload->>'id' = id
    and payload->'schemaVersion' = to_jsonb(schema_version)
    and (payload->>'startedAt')::timestamptz = started_at
    and (payload->>'endedAt')::timestamptz = ended_at
    and payload->>'status' = status
    and payload->'paused' = 'true'::jsonb
    and payload->>'mode' in ('guided', 'opposition', 'ring')
    and payload->>'hand' in ('left', 'right', 'unspecified')
    and jsonb_typeof(payload->'settings') = 'object'
    and jsonb_typeof(payload->'exercises') = 'object'
    and jsonb_typeof(payload->'recognitionVersion') = 'string'
    and ((payload->>'mode' = 'guided' and payload->>'protocolId' = 'guided-v1' and payload->>'currentExercise' in ('pinch','grip','hold'))
      or (payload->>'mode' = 'opposition' and payload->>'protocolId' = 'opposition-v1' and payload->>'currentExercise' = 'opposition' and jsonb_typeof(payload->'opposition') = 'object')
      or (payload->>'mode' = 'ring' and payload->>'protocolId' = 'ring-v1' and payload->>'currentExercise' = 'ring' and jsonb_typeof(payload->'ring') = 'object'))
    and (payload->'attempts' = 'null'::jsonb or (
      jsonb_typeof(payload->'attempts') = 'object'
      and jsonb_typeof(payload #> '{attempts,historyComplete}') = 'boolean'
      and jsonb_typeof(payload #> '{attempts,records}') = 'array'
      and payload #> '{attempts,active}' = 'null'::jsonb
    ))
  ) is true),
  constraint no_raw_tracking check (
    not jsonb_path_exists(payload, '$.**.landmarks')
    and not jsonb_path_exists(payload, '$.**.trajectory')
    and not jsonb_path_exists(payload, '$.**.video')
    and not jsonb_path_exists(payload, '$.**.frames')
  )
);

create index training_sessions_history_idx on public.training_sessions (user_id, ended_at desc, id);
alter table public.training_sessions enable row level security;
alter table public.training_sessions force row level security;
revoke all on table public.training_sessions from public, anon, authenticated;
grant select, insert on table public.training_sessions to authenticated;
create policy training_sessions_select_own on public.training_sessions
  for select to authenticated using ((select auth.uid()) = user_id);
create policy training_sessions_insert_own on public.training_sessions
  for insert to authenticated with check ((select auth.uid()) = user_id);
-- No anon, UPDATE or DELETE grant/policy. No SECURITY DEFINER or bypass function.
commit;
