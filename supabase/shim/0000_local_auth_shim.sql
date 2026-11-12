-- ============================================================================
-- LOCAL / DEMO / TEST ONLY.  Never run this on a real Supabase project.
--
-- Emulates the parts of Supabase that the Side Bet migrations rely on, so the
-- exact same SQL (tables, RLS policies, functions) runs inside PGlite for the
-- demo mode and the integration tests:
--   * roles anon / authenticated / service_role
--   * auth.users + auth.uid() reading request.jwt.claims (same as Supabase)
--   * Supabase's default grants on the public schema (RLS is the real guard)
--   * auth.local_credentials: username/password store for demo sign-in
-- ============================================================================

do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists auth.local_credentials (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  password_hash text not null
);
revoke all on auth.local_credentials from anon, authenticated;

create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ), ''
  )::uuid
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;

-- Supabase grants everything in public to these roles by default; mirror it so
-- the tests prove RLS (not missing grants) is what protects the data.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
