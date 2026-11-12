-- ============================================================================
-- Side Bet — core schema, ledger, contest state machine, RLS.
-- Idempotent-ish: safe to re-run on an empty project. Run in the Supabase SQL
-- editor (or `npm run db:migrate` with DATABASE_URL).
--
-- Security model
--   * Every table has RLS. Supabase grants table privileges to anon /
--     authenticated by default, so RLS policies are the guard.
--   * Wallet / ledger / entries / picks are only written by SECURITY DEFINER
--     functions that check auth.uid().
--   * Settlement, cancellation, rule approval and scoring writes live in the
--     `sidebet_private` schema, which anon/authenticated cannot use. Only the
--     server (DATABASE_URL connection, table owner) calls them, after the app
--     has checked admin rights and recomputed payouts itself.
-- ============================================================================

create schema if not exists sidebet_private;
revoke all on schema sidebet_private from public;
do $$ begin
  execute 'revoke all on schema sidebet_private from anon, authenticated';
exception when undefined_object then null; end $$;

-- ---------------------------------------------------------------- settings --
create table if not exists public.app_settings (
  id int primary key default 1 check (id = 1),
  starting_chips int not null default 500 check (starting_chips >= 0),
  claim_amount int not null default 50 check (claim_amount > 0),
  claim_cooldown_seconds int not null default 82800 check (claim_cooldown_seconds > 0), -- 23h
  -- Demo/test only: shifts app_now(). Only the table owner can change it.
  clock_offset_seconds int not null default 0
);
insert into public.app_settings (id) values (1) on conflict (id) do nothing;
alter table public.app_settings enable row level security;
drop policy if exists app_settings_read on public.app_settings;
create policy app_settings_read on public.app_settings for select to authenticated using (true);

-- Server time used for every deadline (claims, locks). Never trust client time.
create or replace function public.app_now() returns timestamptz
language sql stable security definer set search_path = public as $$
  select now() + make_interval(secs => coalesce((select clock_offset_seconds from public.app_settings where id = 1), 0))
$$;

-- ---------------------------------------------------------------- profiles --
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_]{3,24}$'),
  display_name text not null check (char_length(display_name) between 1 and 40),
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated using (true);

create table if not exists public.wallets (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  balance int not null default 0 check (balance >= 0),
  last_claim_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.wallets enable row level security;
drop policy if exists wallets_own on public.wallets;
create policy wallets_own on public.wallets for select to authenticated using (user_id = auth.uid());

create table if not exists public.ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('starting_grant','free_claim','stake','payout','refund')),
  amount int not null check (amount <> 0),
  balance_after int not null check (balance_after >= 0),
  contest_id uuid,
  entry_id uuid,
  idempotency_key text not null unique,
  memo text,
  created_at timestamptz not null default now()
);
create index if not exists ledger_user_idx on public.ledger (user_id, id desc);
alter table public.ledger enable row level security;
drop policy if exists ledger_own on public.ledger;
create policy ledger_own on public.ledger for select to authenticated using (user_id = auth.uid());

-- The only way chips move. Locks the wallet row, is idempotent on the key and
-- refuses to go negative. Returns true when a new row was written.
create or replace function sidebet_private.post_ledger(
  p_user uuid, p_kind text, p_amount int, p_key text,
  p_contest uuid default null, p_entry uuid default null, p_memo text default null
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_bal int;
begin
  if p_amount = 0 then return false; end if;
  select balance into v_bal from public.wallets where user_id = p_user for update;
  if not found then raise exception 'wallet_missing'; end if;
  if exists (select 1 from public.ledger where idempotency_key = p_key) then
    return false;
  end if;
  if v_bal + p_amount < 0 then
    raise exception 'insufficient_chips';
  end if;
  update public.wallets set balance = v_bal + p_amount, updated_at = now() where user_id = p_user;
  insert into public.ledger (user_id, kind, amount, balance_after, contest_id, entry_id, idempotency_key, memo)
  values (p_user, p_kind, p_amount, v_bal + p_amount, p_contest, p_entry, p_key, p_memo);
  return true;
end $$;

-- New auth user -> profile + wallet + starting grant (one transaction).
create or replace function sidebet_private.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_username text; v_display text; v_start int;
begin
  v_username := lower(coalesce(nullif(new.raw_user_meta_data->>'username', ''),
                               'user_' || substr(replace(new.id::text, '-', ''), 1, 8)));
  v_display := coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''), v_username);
  insert into public.profiles (id, username, display_name) values (new.id, v_username, left(v_display, 40));
  insert into public.wallets (user_id) values (new.id);
  select starting_chips into v_start from public.app_settings where id = 1;
  if coalesce(v_start, 0) > 0 then
    perform sidebet_private.post_ledger(new.id, 'starting_grant', v_start, 'grant:' || new.id, null, null, 'Starting chips');
  end if;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function sidebet_private.handle_new_user();

-- ---------------------------------------------------------------- contests --
create table if not exists public.contests (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('bet','draft')),
  title text not null check (char_length(title) between 3 and 120),
  description text not null default '',
  category text not null default 'custom' check (category in ('chess','sports','custom')),
  visibility text not null default 'private' check (visibility in ('public','private')),
  status text not null default 'setup' check (status in
    ('setup','open','drafting','locked','active','awaiting_settlement','settled','canceled')),
  stake int not null default 20 check (stake between 0 and 100000),
  max_entrants int check (max_entrants is null or max_entrants between 2 and 64),
  lock_at timestamptz,
  pick_visibility text not null default 'after_lock' check (pick_visibility in ('after_lock','always')),
  payout_rule text not null check (payout_rule in ('equal_split_winners','winner_take_all')),
  tiebreakers text[] not null default '{total_points,best_pick}',
  terms_text text not null default '',
  terms_locked_at timestamptz,
  -- draft config
  roster_size int check (roster_size is null or roster_size between 1 and 30),
  draft_format text check (draft_format is null or draft_format in ('snake','straight')),
  draft_mode text check (draft_mode is null or draft_mode in ('live','offline')),
  draft_order uuid[],
  -- bet resolution: which event decides it, {event_key, label}
  resolution jsonb not null default '{}'::jsonb,
  live_context jsonb,
  proposed_outcome_id uuid,
  result_outcome_id uuid,
  result_status text not null default 'none' check (result_status in ('none','provisional','final','review')),
  last_check_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  created_by uuid references public.profiles(id),
  request_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  settled_at timestamptz,
  canceled_at timestamptz,
  cancel_reason text,
  constraint draft_needs_config check (kind <> 'draft' or (roster_size is not null and draft_format is not null and draft_mode is not null))
);
create index if not exists contests_status_idx on public.contests (status);

create table if not exists public.contest_outcomes (
  id uuid primary key default gen_random_uuid(),
  contest_id uuid not null references public.contests(id) on delete cascade,
  label text not null check (char_length(label) between 1 and 80),
  color text not null default 'teal',
  sort_order int not null default 0,
  -- conditions (JSON, validated by the app) that make this outcome the result
  resolve_when jsonb not null default '[]'::jsonb,
  unique (contest_id, label)
);

create table if not exists public.entries (
  id uuid primary key default gen_random_uuid(),
  contest_id uuid not null references public.contests(id) on delete cascade,
  user_id uuid not null references public.profiles(id),
  stake int not null check (stake >= 0),
  seat int not null,
  status text not null default 'active' check (status in ('active','won','lost','tied','push','refunded')),
  place int,
  payout int not null default 0,
  refund int not null default 0,
  final_points numeric(12,2),
  joined_at timestamptz not null default now(),
  unique (contest_id, user_id),
  unique (contest_id, seat)
);
create index if not exists entries_user_idx on public.entries (user_id);

create table if not exists public.bet_picks (
  entry_id uuid primary key references public.entries(id) on delete cascade,
  contest_id uuid not null references public.contests(id) on delete cascade,
  user_id uuid not null references public.profiles(id),
  outcome_id uuid not null references public.contest_outcomes(id),
  created_at timestamptz not null default now()
);

create table if not exists public.pool_items (
  id uuid primary key default gen_random_uuid(),
  contest_id uuid not null references public.contests(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  kind text not null default 'player' check (kind in ('player','team','other')),
  seed int check (seed is null or seed > 0),
  aliases text[] not null default '{}',
  meta jsonb not null default '{}'::jsonb,
  unique (contest_id, name)
);

create table if not exists public.draft_picks (
  id uuid primary key default gen_random_uuid(),
  contest_id uuid not null references public.contests(id) on delete cascade,
  entry_id uuid not null references public.entries(id) on delete cascade,
  pool_item_id uuid not null references public.pool_items(id) on delete cascade,
  pick_no int not null check (pick_no > 0),
  round int not null check (round > 0),
  source text not null check (source in ('live','import')),
  made_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (contest_id, pool_item_id),   -- nobody drafts the same pick twice
  unique (contest_id, pick_no)
);

create table if not exists public.contest_access (
  contest_id uuid not null references public.contests(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  via text not null default 'invite',
  created_at timestamptz not null default now(),
  primary key (contest_id, user_id)
);

create table if not exists public.invites (
  id uuid primary key default gen_random_uuid(),
  contest_id uuid not null references public.contests(id) on delete cascade,
  token text not null unique default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  label text not null default 'Invite link',
  created_by uuid references public.profiles(id),
  uses int not null default 0,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.contest_signals (
  contest_id uuid primary key references public.contests(id) on delete cascade,
  version bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.contest_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(title) between 3 and 120),
  body text not null check (char_length(body) between 3 and 4000),
  status text not null default 'submitted' check (status in ('submitted','reviewing','converted','declined')),
  admin_note text,
  contest_id uuid references public.contests(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ----------------------------------------------------------------- scoring --
create table if not exists public.scoring_rulesets (
  id uuid primary key default gen_random_uuid(),
  contest_id uuid not null references public.contests(id) on delete cascade,
  version int not null,
  instructions text not null,          -- the admin's original words, kept verbatim
  answers jsonb not null default '{}'::jsonb,
  rules jsonb not null,                -- structured, validated by the app
  questions jsonb not null default '[]'::jsonb,
  unsupported jsonb not null default '[]'::jsonb,
  proposed_by text not null default 'manual',
  status text not null default 'draft' check (status in ('draft','approved','superseded')),
  created_by uuid references public.profiles(id),
  approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (contest_id, version)
);
create unique index if not exists one_approved_ruleset on public.scoring_rulesets (contest_id) where status = 'approved';

create table if not exists public.result_sources (
  id uuid primary key default gen_random_uuid(),
  contest_id uuid not null references public.contests(id) on delete cascade,
  kind text not null check (kind in ('fixture','sidebet_json','pgn','espn','html','manual')),
  url text,
  label text not null default 'Results source',
  config jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  last_preview jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  contest_id uuid not null references public.contests(id) on delete cascade,
  event_key text not null,             -- stable identity: rechecks never duplicate
  label text not null default '',
  current_revision_id uuid,
  status text not null default 'provisional' check (status in ('provisional','final','review')),
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (contest_id, event_key)
);

create table if not exists public.event_revisions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  contest_id uuid not null references public.contests(id) on delete cascade,
  revision int not null,
  facts jsonb not null,
  fingerprint text not null,
  source_id uuid references public.result_sources(id) on delete set null,
  source_url text,
  evidence text,
  origin text not null check (origin in ('feed','ai','manual','fixture')),
  state text not null check (state in ('applied','pending_review','rejected','superseded')),
  review_reason text,
  approved_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (event_id, revision)
);

create table if not exists public.score_lines (
  id uuid primary key default gen_random_uuid(),
  contest_id uuid not null references public.contests(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  revision_id uuid not null references public.event_revisions(id) on delete cascade,
  pool_item_id uuid references public.pool_items(id) on delete cascade,
  rule_id text not null,
  label text not null,
  points numeric(12,2) not null,
  detail text not null default '',
  source_url text,
  created_at timestamptz not null default now(),
  unique (event_id, pool_item_id, rule_id)
);
create index if not exists score_lines_contest_idx on public.score_lines (contest_id);

create table if not exists public.adjustments (
  id uuid primary key default gen_random_uuid(),
  contest_id uuid not null references public.contests(id) on delete cascade,
  pool_item_id uuid references public.pool_items(id) on delete cascade,
  entry_id uuid references public.entries(id) on delete cascade,
  points numeric(12,2) not null,
  reason text not null check (char_length(reason) between 3 and 400),
  approved_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  check (pool_item_id is not null or entry_id is not null)
);

create table if not exists public.score_changes (
  id bigint generated always as identity primary key,
  contest_id uuid not null references public.contests(id) on delete cascade,
  event_id uuid references public.events(id) on delete cascade,
  kind text not null check (kind in ('new','update','correction','adjustment','review')),
  summary text not null,
  deltas jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.review_items (
  id uuid primary key default gen_random_uuid(),
  contest_id uuid not null references public.contests(id) on delete cascade,
  event_id uuid references public.events(id) on delete cascade,
  revision_id uuid references public.event_revisions(id) on delete cascade,
  kind text not null check (kind in ('ambiguous_name','conflict','missing_fact','unsupported_rule','correction_after_payout','unmatched','source_error','extraction')),
  title text not null,
  detail jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open','resolved','dismissed')),
  resolution text,
  resolved_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists public.settlements (
  contest_id uuid primary key references public.contests(id) on delete cascade,
  outcome_id uuid,
  lines jsonb not null,
  summary jsonb not null,
  preview_hash text not null,
  settled_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------- access functions --
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false)
$$;

create or replace function public.can_view_contest(p_contest uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and exists (
    select 1 from public.contests c
    where c.id = p_contest and (
      (c.visibility = 'public' and c.status <> 'setup')
      or public.is_admin()
      or exists (select 1 from public.contest_access a where a.contest_id = c.id and a.user_id = auth.uid())
      or exists (select 1 from public.entries e where e.contest_id = c.id and e.user_id = auth.uid())
    )
  )
$$;

-- Picks are revealed after entries lock (default) or always, per contest.
create or replace function public.picks_visible(p_contest uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.contests c
    where c.id = p_contest and (
      c.pick_visibility = 'always'
      or c.status not in ('setup','open')
      or (c.lock_at is not null and public.app_now() >= c.lock_at)
    )
  )
$$;

create or replace function sidebet_private.bump(p_contest uuid) returns void
language sql security definer set search_path = public as $$
  insert into public.contest_signals (contest_id, version, updated_at) values (p_contest, 1, now())
  on conflict (contest_id) do update set version = public.contest_signals.version + 1, updated_at = now();
$$;

-- --------------------------------------------------------------- triggers --
-- Terms are frozen once the first entry is accepted.
create or replace function sidebet_private.guard_contest() returns trigger
language plpgsql security definer set search_path = public as $$
declare internal boolean := coalesce(current_setting('sidebet.internal', true), '') = 'on';
begin
  if tg_op = 'UPDATE' then
    if old.terms_locked_at is not null and (
      new.kind, new.stake, new.payout_rule, new.lock_at, new.pick_visibility, new.tiebreakers,
      new.terms_text, new.roster_size, new.draft_format, new.max_entrants, new.visibility
    ) is distinct from (
      old.kind, old.stake, old.payout_rule, old.lock_at, old.pick_visibility, old.tiebreakers,
      old.terms_text, old.roster_size, old.draft_format, old.max_entrants, old.visibility
    ) then
      raise exception 'terms_locked';
    end if;
    if new.terms_locked_at is distinct from old.terms_locked_at and not internal then
      raise exception 'terms_locked';
    end if;
    if new.status is distinct from old.status then
      if old.status in ('settled','canceled') then raise exception 'contest_closed'; end if;
      if new.status in ('settled','canceled') and not internal then
        raise exception 'use_settlement_flow';
      end if;
      if not internal and not (
        (old.status, new.status) in (
          ('setup','open'), ('open','setup'), ('open','drafting'), ('open','locked'), ('open','active'),
          ('drafting','active'), ('locked','active'), ('locked','awaiting_settlement'),
          ('active','awaiting_settlement'), ('awaiting_settlement','active'), ('drafting','open')
        )
      ) then
        raise exception 'bad_transition';
      end if;
      if old.status = 'open' and new.status = 'setup' and old.terms_locked_at is not null then
        raise exception 'terms_locked';
      end if;
    end if;
    if (new.result_outcome_id is distinct from old.result_outcome_id
        or new.settled_at is distinct from old.settled_at) and not internal then
      raise exception 'use_settlement_flow';
    end if;
    new.updated_at := now();
  elsif tg_op = 'INSERT' then
    if not internal and (new.status <> 'setup' or new.terms_locked_at is not null or new.result_outcome_id is not null) then
      new.status := 'setup'; new.terms_locked_at := null; new.result_outcome_id := null;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists guard_contest on public.contests;
create trigger guard_contest before insert or update on public.contests
  for each row execute function sidebet_private.guard_contest();

-- Outcomes and the pool are part of the published terms.
create or replace function sidebet_private.guard_terms_child() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_locked timestamptz; v_cid uuid;
begin
  v_cid := coalesce(new.contest_id, old.contest_id);
  select terms_locked_at into v_locked from public.contests where id = v_cid;
  if v_locked is not null and coalesce(current_setting('sidebet.internal', true), '') <> 'on' then
    raise exception 'terms_locked';
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists guard_outcomes on public.contest_outcomes;
create trigger guard_outcomes before insert or update or delete on public.contest_outcomes
  for each row execute function sidebet_private.guard_terms_child();

-- Pool: picks can be added/edited (aliases help matching) but not removed once drafted.
create or replace function sidebet_private.guard_pool() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' and exists (select 1 from public.draft_picks where pool_item_id = old.id) then
    raise exception 'pick_already_drafted';
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists guard_pool on public.pool_items;
create trigger guard_pool before delete on public.pool_items
  for each row execute function sidebet_private.guard_pool();

-- Rulesets can only become 'approved' through sidebet_private.approve_ruleset.
create or replace function sidebet_private.guard_ruleset() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('sidebet.internal', true), '') <> 'on' then
    if new.status = 'approved' or (tg_op = 'UPDATE' and old.status <> 'draft') then
      raise exception 'use_rule_approval';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists guard_ruleset on public.scoring_rulesets;
create trigger guard_ruleset before insert or update on public.scoring_rulesets
  for each row execute function sidebet_private.guard_ruleset();

create or replace function sidebet_private.guard_adjustment() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.profiles where id = new.approved_by and is_admin) then
    raise exception 'admin_only';
  end if;
  if exists (select 1 from public.contests where id = new.contest_id and status in ('settled','canceled')) then
    raise exception 'contest_closed';
  end if;
  return new;
end $$;
drop trigger if exists guard_adjustment on public.adjustments;
create trigger guard_adjustment before insert or update on public.adjustments
  for each row execute function sidebet_private.guard_adjustment();

-- ------------------------------------------------------------ user RPCs --
create or replace function public.claim_chips() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_now timestamptz := public.app_now();
  v_last timestamptz; v_amount int; v_cool int; v_bal int;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  select claim_amount, claim_cooldown_seconds into v_amount, v_cool from public.app_settings where id = 1;
  -- Row lock: concurrent claims queue here and re-read last_claim_at.
  select last_claim_at into v_last from public.wallets where user_id = v_uid for update;
  if not found then raise exception 'wallet_missing'; end if;
  if v_last is not null and v_now < v_last + make_interval(secs => v_cool) then
    raise exception 'claim_not_ready';
  end if;
  -- Key is tied to the previous claim, so two claims can never share a window.
  perform sidebet_private.post_ledger(v_uid, 'free_claim', v_amount,
    'claim:' || v_uid || ':' || coalesce(extract(epoch from v_last)::bigint::text, 'first'),
    null, null, 'Free chips');
  update public.wallets set last_claim_at = v_now where user_id = v_uid returning balance into v_bal;
  return jsonb_build_object('amount', v_amount, 'balance', v_bal,
    'next_claim_at', v_now + make_interval(secs => v_cool));
end $$;

create or replace function public.update_display_name(p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  if p_name is null or char_length(trim(p_name)) not between 1 and 40 then raise exception 'bad_display_name'; end if;
  update public.profiles set display_name = trim(p_name) where id = auth.uid();
end $$;

create or replace function public.refresh_contest(p_contest uuid) returns text
language plpgsql security definer set search_path = public as $$
declare c public.contests;
begin
  select * into c from public.contests where id = p_contest;
  if not found then return null; end if;
  if c.status = 'open' and c.lock_at is not null and public.app_now() >= c.lock_at and c.kind = 'bet' then
    update public.contests set status = 'locked' where id = p_contest and status = 'open';
    perform sidebet_private.bump(p_contest);
    return 'locked';
  end if;
  return c.status;
end $$;

create or replace function public.redeem_invite(p_token text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_inv public.invites; v_status text;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  select * into v_inv from public.invites where token = p_token for update;
  if not found then raise exception 'invite_not_found'; end if;
  if v_inv.revoked_at is not null then raise exception 'invite_revoked'; end if;
  select status into v_status from public.contests where id = v_inv.contest_id;
  if v_status in ('canceled') then raise exception 'contest_closed'; end if;
  insert into public.contest_access (contest_id, user_id, via) values (v_inv.contest_id, auth.uid(), 'invite')
  on conflict do nothing;
  if found then update public.invites set uses = uses + 1 where id = v_inv.id; end if;
  return v_inv.contest_id;
end $$;

-- Accepts an entry and debits the stake in one transaction. Retrying returns
-- the same entry and never charges twice.
create or replace function public.join_contest(p_contest uuid, p_outcome uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  c public.contests;
  v_entry uuid; v_count int;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  select * into c from public.contests where id = p_contest for update;
  if not found or not public.can_view_contest(p_contest) then raise exception 'contest_not_found'; end if;
  select id into v_entry from public.entries where contest_id = p_contest and user_id = v_uid;
  if found then return v_entry; end if;
  if c.status <> 'open' then raise exception 'entries_closed'; end if;
  if c.lock_at is not null and public.app_now() >= c.lock_at then raise exception 'entries_closed'; end if;
  select count(*) into v_count from public.entries where contest_id = p_contest;
  if c.max_entrants is not null and v_count >= c.max_entrants then raise exception 'contest_full'; end if;
  if c.kind = 'bet' then
    if p_outcome is null or not exists (select 1 from public.contest_outcomes where id = p_outcome and contest_id = p_contest) then
      raise exception 'pick_a_side';
    end if;
  end if;
  insert into public.entries (contest_id, user_id, stake, seat)
  values (p_contest, v_uid, c.stake, v_count + 1) returning id into v_entry;
  if c.stake > 0 then
    perform sidebet_private.post_ledger(v_uid, 'stake', -c.stake, 'stake:' || v_entry, p_contest, v_entry, c.title);
  end if;
  if c.kind = 'bet' then
    insert into public.bet_picks (entry_id, contest_id, user_id, outcome_id) values (v_entry, p_contest, v_uid, p_outcome);
  end if;
  insert into public.contest_access (contest_id, user_id, via) values (p_contest, v_uid, 'entry') on conflict do nothing;
  if c.terms_locked_at is null then
    perform set_config('sidebet.internal', 'on', true);
    update public.contests set terms_locked_at = public.app_now() where id = p_contest;
    perform set_config('sidebet.internal', 'off', true);
  end if;
  perform sidebet_private.bump(p_contest);
  return v_entry;
end $$;

-- Whose turn is it? Returns the entry id on the clock (null when complete).
create or replace function public.draft_on_clock(p_contest uuid) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare c public.contests; n int; k int; rnd int; pos int;
begin
  select * into c from public.contests where id = p_contest;
  if c.draft_order is null then return null; end if;
  n := coalesce(array_length(c.draft_order, 1), 0);
  if n = 0 then return null; end if;
  select count(*) into k from public.draft_picks where contest_id = p_contest;
  if k >= n * c.roster_size then return null; end if;
  rnd := k / n; pos := k % n;
  if c.draft_format = 'snake' and rnd % 2 = 1 then pos := n - 1 - pos; end if;
  return c.draft_order[pos + 1];
end $$;

create or replace function public.make_draft_pick(p_contest uuid, p_pool_item uuid, p_expected_pick_no int default null)
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  c public.contests; n int; k int; v_clock uuid; v_mine uuid;
begin
  if v_uid is null then raise exception 'not_signed_in'; end if;
  select * into c from public.contests where id = p_contest for update;  -- serializes picks
  if not found or not public.can_view_contest(p_contest) then raise exception 'contest_not_found'; end if;
  if c.status <> 'drafting' then raise exception 'draft_not_live'; end if;
  n := array_length(c.draft_order, 1);
  select count(*) into k from public.draft_picks where contest_id = p_contest;
  if p_expected_pick_no is not null and p_expected_pick_no <> k + 1 then raise exception 'stale_pick'; end if;
  if k >= n * c.roster_size then raise exception 'draft_complete'; end if;
  v_clock := public.draft_on_clock(p_contest);
  select id into v_mine from public.entries where contest_id = p_contest and user_id = v_uid;
  if v_mine is distinct from v_clock and not public.is_admin() then raise exception 'not_your_turn'; end if;
  if not exists (select 1 from public.pool_items where id = p_pool_item and contest_id = p_contest) then
    raise exception 'pick_not_available';
  end if;
  if exists (select 1 from public.draft_picks where contest_id = p_contest and pool_item_id = p_pool_item) then
    raise exception 'already_drafted';
  end if;
  insert into public.draft_picks (contest_id, entry_id, pool_item_id, pick_no, round, source, made_by)
  values (p_contest, v_clock, p_pool_item, k + 1, k / n + 1, 'live', v_uid);
  if k + 1 = n * c.roster_size then
    update public.contests set status = 'active' where id = p_contest;
  end if;
  perform sidebet_private.bump(p_contest);
  return k + 1;
end $$;

-- ----------------------------------------------------------- admin RPCs --
create or replace function public.admin_set_status(p_contest uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare c public.contests;
begin
  if not public.is_admin() then raise exception 'admin_only'; end if;
  select * into c from public.contests where id = p_contest for update;
  if not found then raise exception 'contest_not_found'; end if;
  if p_status = 'open' then
    if c.kind = 'bet' and (select count(*) from public.contest_outcomes where contest_id = p_contest) < 2 then
      raise exception 'needs_two_outcomes';
    end if;
    if c.kind = 'draft' and not exists (select 1 from public.scoring_rulesets where contest_id = p_contest and status = 'approved') then
      raise exception 'needs_approved_rules';
    end if;
  end if;
  update public.contests set status = p_status where id = p_contest;
  perform sidebet_private.bump(p_contest);
end $$;

create or replace function public.start_draft(p_contest uuid, p_order uuid[] default null) returns void
language plpgsql security definer set search_path = public as $$
declare c public.contests; v_order uuid[];
begin
  if not public.is_admin() then raise exception 'admin_only'; end if;
  select * into c from public.contests where id = p_contest for update;
  if c.kind <> 'draft' then raise exception 'not_a_draft'; end if;
  if c.status <> 'open' then raise exception 'bad_transition'; end if;
  select array_agg(id order by seat) into v_order from public.entries where contest_id = p_contest;
  if coalesce(array_length(v_order, 1), 0) < 2 then raise exception 'needs_two_entrants'; end if;
  if p_order is not null then
    if array_length(p_order, 1) <> array_length(v_order, 1)
       or exists (select unnest(p_order) except select unnest(v_order))
       or exists (select unnest(v_order) except select unnest(p_order)) then
      raise exception 'bad_draft_order';
    end if;
    v_order := p_order;
  end if;
  update public.contests set draft_order = v_order, status = 'drafting' where id = p_contest;
  perform sidebet_private.bump(p_contest);
end $$;

-- Offline draft import: rosters drafted elsewhere. p_picks = [{entry_id, pool_item_id}]
-- in draft order. Replaces any previous import while no results are scored.
create or replace function public.import_draft(p_contest uuid, p_picks jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare c public.contests; v_n int := 0; r record; v_entries int;
begin
  if not public.is_admin() then raise exception 'admin_only'; end if;
  select * into c from public.contests where id = p_contest for update;
  if c.kind <> 'draft' then raise exception 'not_a_draft'; end if;
  if c.status not in ('open','drafting','active') then raise exception 'bad_transition'; end if;
  if exists (select 1 from public.events where contest_id = p_contest) then raise exception 'scoring_started'; end if;
  select count(*) into v_entries from public.entries where contest_id = p_contest;
  if v_entries < 2 then raise exception 'needs_two_entrants'; end if;
  delete from public.draft_picks where contest_id = p_contest;
  for r in select (x->>'entry_id')::uuid as entry_id, (x->>'pool_item_id')::uuid as pool_item_id, ord
           from jsonb_array_elements(p_picks) with ordinality as t(x, ord) loop
    if not exists (select 1 from public.entries where id = r.entry_id and contest_id = p_contest) then
      raise exception 'bad_entry';
    end if;
    if not exists (select 1 from public.pool_items where id = r.pool_item_id and contest_id = p_contest) then
      raise exception 'pick_not_available';
    end if;
    v_n := v_n + 1;
    insert into public.draft_picks (contest_id, entry_id, pool_item_id, pick_no, round, source, made_by)
    values (p_contest, r.entry_id, r.pool_item_id, v_n, ((v_n - 1) / v_entries) + 1, 'import', auth.uid());
  end loop;
  if exists (
    select 1 from public.draft_picks where contest_id = p_contest group by entry_id having count(*) > c.roster_size
  ) then raise exception 'roster_too_big'; end if;
  update public.contests
     set draft_order = (select array_agg(id order by seat) from public.entries where contest_id = p_contest),
         status = 'active'
   where id = p_contest;
  perform sidebet_private.bump(p_contest);
  return v_n;
end $$;

-- ------------------------------------------- server-only (sidebet_private) --
create or replace function sidebet_private.approve_ruleset(p_ruleset uuid, p_admin uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_cid uuid; v_locked timestamptz;
begin
  if not exists (select 1 from public.profiles where id = p_admin and is_admin) then raise exception 'admin_only'; end if;
  select contest_id into v_cid from public.scoring_rulesets where id = p_ruleset;
  if not found then raise exception 'ruleset_not_found'; end if;
  select terms_locked_at into v_locked from public.contests where id = v_cid for update;
  if v_locked is not null then raise exception 'terms_locked'; end if;
  perform set_config('sidebet.internal', 'on', true);
  update public.scoring_rulesets set status = 'superseded' where contest_id = v_cid and status = 'approved';
  update public.scoring_rulesets set status = 'approved', approved_by = p_admin, approved_at = now() where id = p_ruleset;
  perform set_config('sidebet.internal', 'off', true);
  perform sidebet_private.bump(v_cid);
end $$;

-- Pays a settlement the app computed and the admin confirmed. Validates
-- conservation of chips; idempotent per contest.
create or replace function sidebet_private.settle_contest(
  p_contest uuid, p_admin uuid, p_outcome uuid, p_lines jsonb, p_summary jsonb, p_hash text
) returns text
language plpgsql security definer set search_path = public as $$
declare c public.contests; v_pot int; v_paid int; v_entries int; r record;
begin
  if not exists (select 1 from public.profiles where id = p_admin and is_admin) then raise exception 'admin_only'; end if;
  select * into c from public.contests where id = p_contest for update;
  if not found then raise exception 'contest_not_found'; end if;
  if exists (select 1 from public.settlements where contest_id = p_contest) or c.status = 'settled' then
    return 'already_settled';
  end if;
  if c.status <> 'awaiting_settlement' then raise exception 'not_ready_to_settle'; end if;
  select coalesce(sum(stake), 0), count(*) into v_pot, v_entries from public.entries where contest_id = p_contest;
  select coalesce(sum((x->>'payout')::int + (x->>'refund')::int), 0) into v_paid from jsonb_array_elements(p_lines) x;
  if v_paid <> v_pot then raise exception 'payout_mismatch'; end if;
  if (select count(distinct x->>'entry_id') from jsonb_array_elements(p_lines) x) <> v_entries
     or jsonb_array_length(p_lines) <> v_entries then
    raise exception 'payout_mismatch';
  end if;
  perform set_config('sidebet.internal', 'on', true);
  for r in select (x->>'entry_id')::uuid as entry_id, x->>'status' as status, nullif(x->>'place','')::int as place,
                  (x->>'payout')::int as payout, (x->>'refund')::int as refund, nullif(x->>'points','')::numeric as points
           from jsonb_array_elements(p_lines) x loop
    if r.payout < 0 or r.refund < 0 then raise exception 'payout_mismatch'; end if;
    update public.entries set status = r.status, place = r.place, payout = r.payout, refund = r.refund, final_points = r.points
     where id = r.entry_id and contest_id = p_contest;
    if not found then raise exception 'payout_mismatch'; end if;
    if r.payout > 0 then
      perform sidebet_private.post_ledger((select user_id from public.entries where id = r.entry_id), 'payout', r.payout,
        'payout:' || r.entry_id, p_contest, r.entry_id, c.title);
    end if;
    if r.refund > 0 then
      perform sidebet_private.post_ledger((select user_id from public.entries where id = r.entry_id), 'refund', r.refund,
        'refund:' || r.entry_id, p_contest, r.entry_id, c.title);
    end if;
  end loop;
  insert into public.settlements (contest_id, outcome_id, lines, summary, preview_hash, settled_by)
  values (p_contest, p_outcome, p_lines, p_summary, p_hash, p_admin);
  update public.contests set status = 'settled', settled_at = now(), result_outcome_id = p_outcome, result_status = 'final'
   where id = p_contest;
  perform set_config('sidebet.internal', 'off', true);
  perform sidebet_private.bump(p_contest);
  return 'settled';
end $$;

create or replace function sidebet_private.cancel_contest(p_contest uuid, p_admin uuid, p_reason text) returns text
language plpgsql security definer set search_path = public as $$
declare c public.contests; r record;
begin
  if not exists (select 1 from public.profiles where id = p_admin and is_admin) then raise exception 'admin_only'; end if;
  select * into c from public.contests where id = p_contest for update;
  if not found then raise exception 'contest_not_found'; end if;
  if c.status = 'canceled' then return 'already_canceled'; end if;
  if c.status = 'settled' then raise exception 'contest_closed'; end if;
  perform set_config('sidebet.internal', 'on', true);
  for r in select * from public.entries where contest_id = p_contest loop
    if r.stake > 0 then
      perform sidebet_private.post_ledger(r.user_id, 'refund', r.stake, 'refund:' || r.id, p_contest, r.id, 'Canceled: ' || c.title);
    end if;
    update public.entries set status = 'refunded', refund = r.stake, payout = 0 where id = r.id;
  end loop;
  update public.contests set status = 'canceled', canceled_at = now(), cancel_reason = p_reason where id = p_contest;
  perform set_config('sidebet.internal', 'off', true);
  perform sidebet_private.bump(p_contest);
  return 'canceled';
end $$;

-- ------------------------------------------------------------------- RLS --
alter table public.contests enable row level security;
alter table public.contest_outcomes enable row level security;
alter table public.entries enable row level security;
alter table public.bet_picks enable row level security;
alter table public.pool_items enable row level security;
alter table public.draft_picks enable row level security;
alter table public.contest_access enable row level security;
alter table public.invites enable row level security;
alter table public.contest_signals enable row level security;
alter table public.contest_requests enable row level security;
alter table public.scoring_rulesets enable row level security;
alter table public.result_sources enable row level security;
alter table public.events enable row level security;
alter table public.event_revisions enable row level security;
alter table public.score_lines enable row level security;
alter table public.adjustments enable row level security;
alter table public.score_changes enable row level security;
alter table public.review_items enable row level security;
alter table public.settlements enable row level security;

do $$
declare t text;
begin
  -- read access follows contest visibility
  foreach t in array array['contest_outcomes','entries','pool_items','draft_picks','contest_signals',
                           'events','event_revisions','score_lines','adjustments','score_changes','settlements'] loop
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.can_view_contest(contest_id))', t || '_read', t);
  end loop;
  -- admin-managed config tables
  foreach t in array array['contest_outcomes','pool_items','invites','result_sources','review_items','scoring_rulesets'] loop
    execute format('drop policy if exists %I on public.%I', t || '_admin', t);
    execute format('create policy %I on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t || '_admin', t);
  end loop;
end $$;

drop policy if exists contests_read on public.contests;
-- is_admin() first: INSERT ... RETURNING checks this against a row the
-- can_view_contest() snapshot can't see yet.
create policy contests_read on public.contests for select to authenticated using (public.is_admin() or public.can_view_contest(id));
drop policy if exists contests_admin_insert on public.contests;
create policy contests_admin_insert on public.contests for insert to authenticated with check (public.is_admin());
drop policy if exists contests_admin_update on public.contests;
create policy contests_admin_update on public.contests for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- Hidden picks: only your own until the contest reveals them.
drop policy if exists bet_picks_read on public.bet_picks;
create policy bet_picks_read on public.bet_picks for select to authenticated using (
  user_id = auth.uid()
  or public.is_admin()
  or (public.picks_visible(contest_id) and public.can_view_contest(contest_id))
);

drop policy if exists contest_access_read on public.contest_access;
create policy contest_access_read on public.contest_access for select to authenticated using (user_id = auth.uid() or public.is_admin());

drop policy if exists rulesets_read on public.scoring_rulesets;
create policy rulesets_read on public.scoring_rulesets for select to authenticated
  using (status = 'approved' and public.can_view_contest(contest_id));

drop policy if exists adjustments_admin on public.adjustments;
create policy adjustments_admin on public.adjustments for insert to authenticated
  with check (public.is_admin() and approved_by = auth.uid());

drop policy if exists requests_own on public.contest_requests;
create policy requests_own on public.contest_requests for select to authenticated using (user_id = auth.uid() or public.is_admin());
drop policy if exists requests_insert on public.contest_requests;
create policy requests_insert on public.contest_requests for insert to authenticated
  with check (user_id = auth.uid() and status = 'submitted' and contest_id is null and admin_note is null);
drop policy if exists requests_admin on public.contest_requests;
create policy requests_admin on public.contest_requests for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- Grants: functions are callable by signed-in users only; private stays private.
revoke execute on all functions in schema sidebet_private from public;
do $$ begin
  execute 'revoke execute on all functions in schema sidebet_private from anon, authenticated';
  execute 'revoke execute on function public.claim_chips(), public.join_contest(uuid, uuid), public.make_draft_pick(uuid, uuid, int),
           public.redeem_invite(text), public.admin_set_status(uuid, text), public.start_draft(uuid, uuid[]),
           public.import_draft(uuid, jsonb), public.update_display_name(text), public.refresh_contest(uuid) from anon, public';
  execute 'grant execute on function public.claim_chips(), public.join_contest(uuid, uuid), public.make_draft_pick(uuid, uuid, int),
           public.redeem_invite(text), public.admin_set_status(uuid, text), public.start_draft(uuid, uuid[]),
           public.import_draft(uuid, jsonb), public.update_display_name(text), public.refresh_contest(uuid),
           public.is_admin(), public.can_view_contest(uuid), public.picks_visible(uuid), public.app_now(),
           public.draft_on_clock(uuid) to authenticated';
exception when undefined_object then null; end $$;

-- Realtime: clients subscribe to contest_signals (RLS-filtered, carries no picks)
-- and re-fetch through the API, which applies pick visibility.
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'contest_signals') then
      execute 'alter publication supabase_realtime add table public.contest_signals';
    end if;
  end if;
end $$;
