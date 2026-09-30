-- Run in SQL Editor AFTER migration. Choose two EXISTING ordinary Auth users.
-- Replace only the UUID placeholders below. Transaction rolls back all test data.
-- SET LOCAL ROLE switches assertions to ordinary authenticated/anon roles;
-- assertions are NOT executed as the SQL Editor's privileged role.
begin;
select set_config('neurohand.test_user_a', 'REPLACE_WITH_USER_A_UUID', true);
select set_config('neurohand.test_user_b', 'REPLACE_WITH_USER_B_UUID', true);
do $$ begin
  if current_setting('neurohand.test_user_a')::uuid = current_setting('neurohand.test_user_b')::uuid then raise exception 'Choose two distinct users'; end if;
end $$;
select set_config('neurohand.test_id', gen_random_uuid()::text, true);
select set_config('neurohand.test_payload', jsonb_build_object(
  'schemaVersion', 3, 'id', current_setting('neurohand.test_id'),
  'startedAt', '2026-09-30T00:00:00Z', 'endedAt', '2026-09-30T00:01:00Z',
  'status', 'stopped', 'mode', 'guided', 'protocolId', 'guided-v1',
  'recognitionVersion', 'landmarks-v1-norm008', 'hand', 'left', 'currentExercise', 'pinch', 'paused', true,
  'settings', '{"pinchTarget":5,"gripTarget":5,"holdTargetCount":3,"holdTargetMs":2000,"targetRadiusRatio":0.12}'::jsonb,
  'exercises', '{"pinch":{"reps":0,"target":5,"started":false,"activeMs":0,"promptEpisodes":{},"bestHoldMs":null},"grip":{"reps":0,"target":5,"started":false,"activeMs":0,"promptEpisodes":{},"bestHoldMs":null},"hold":{"reps":0,"target":3,"started":false,"activeMs":0,"promptEpisodes":{},"bestHoldMs":0}}'::jsonb,
  'attempts', '{"historyComplete":true,"records":[],"active":null}'::jsonb
)::text, true);

set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('neurohand.test_user_a'), true);
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('neurohand.test_user_a'), 'role', 'authenticated')::text, true);
insert into public.training_sessions (user_id,id,schema_version,started_at,ended_at,status,payload)
values (auth.uid(),current_setting('neurohand.test_id'),3,'2026-09-30T00:00:00Z','2026-09-30T00:01:00Z','stopped',current_setting('neurohand.test_payload')::jsonb);
do $$ begin
  if (select count(*) from public.training_sessions where id=current_setting('neurohand.test_id')) <> 1 then raise exception 'A cannot read own record'; end if;
  begin
    insert into public.training_sessions(user_id,id,schema_version,started_at,ended_at,status,payload)
    values(current_setting('neurohand.test_user_b')::uuid,current_setting('neurohand.test_id'),3,'2026-09-30T00:00:00Z','2026-09-30T00:01:00Z','stopped',current_setting('neurohand.test_payload')::jsonb);
    raise exception 'A inserted as B';
  exception when insufficient_privilege then null; end;
  begin
    update public.training_sessions set status='stopped' where user_id=auth.uid();
    raise exception 'UPDATE allowed';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.training_sessions where user_id=auth.uid();
    raise exception 'DELETE allowed';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.training_sessions(user_id,id,schema_version,started_at,ended_at,status,payload)
    values(auth.uid(),current_setting('neurohand.test_id'),3,'2026-09-30T00:00:00Z','2026-09-30T00:01:00Z','stopped',current_setting('neurohand.test_payload')::jsonb);
    raise exception 'Duplicate allowed';
  exception when unique_violation then null; end;
end $$;

-- Invalid payloads must fail even for their owner.
do $$ declare bad jsonb; base jsonb := current_setting('neurohand.test_payload')::jsonb;
begin
  base := jsonb_set(base, '{id}', to_jsonb(current_setting('neurohand.test_id') || '-invalid'));
  foreach bad in array array[
    base - 'attempts', jsonb_set(base, '{schemaVersion}', '2'),
    jsonb_set(base, '{status}', '"in_progress"'),
    jsonb_set(base, '{attempts,active}', '{"attemptId":"unfinished"}'),
    jsonb_set(base, '{settings,landmarks}', '[]')
  ] loop
    begin
      insert into public.training_sessions(user_id,id,schema_version,started_at,ended_at,status,payload)
      values(auth.uid(),bad->>'id',3,'2026-09-30T00:00:00Z','2026-09-30T00:01:00Z','stopped',bad);
      raise exception 'Invalid payload accepted';
    exception when check_violation then null; end;
  end loop;
end $$;

select set_config('request.jwt.claim.sub', current_setting('neurohand.test_user_b'), true);
select set_config('request.jwt.claims', jsonb_build_object('sub', current_setting('neurohand.test_user_b'), 'role', 'authenticated')::text, true);
do $$ begin
  if exists(select 1 from public.training_sessions where id=current_setting('neurohand.test_id')) then raise exception 'B read A record'; end if;
end $$;
insert into public.training_sessions(user_id,id,schema_version,started_at,ended_at,status,payload)
values(auth.uid(),current_setting('neurohand.test_id'),3,'2026-09-30T00:00:00Z','2026-09-30T00:01:00Z','stopped',current_setting('neurohand.test_payload')::jsonb);
do $$ begin
  if (select count(*) from public.training_sessions where id=current_setting('neurohand.test_id')) <> 1 then raise exception 'Owner-scoped ID failed'; end if;
end $$;

reset role;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{}', true);
do $$ begin
  begin
    perform 1 from public.training_sessions limit 1;
    raise exception 'Anon SELECT allowed';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.training_sessions(user_id,id,schema_version,started_at,ended_at,status,payload)
    values(current_setting('neurohand.test_user_a')::uuid,current_setting('neurohand.test_id'),3,'2026-09-30T00:00:00Z','2026-09-30T00:01:00Z','stopped',current_setting('neurohand.test_payload')::jsonb);
    raise exception 'Anon INSERT allowed';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
