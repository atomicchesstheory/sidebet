-- ============================================================================
-- Side Bet 0002 — friends, player-run (manual) contests, manual scores,
-- achievements, 10-chip free claims.
-- Safe to re-run. Run after 0001 in the Supabase SQL editor (or db:migrate).
--
-- Player-run contests ("manual"): any signed-in user can create one. The
-- creator manages it the way an admin manages a normal contest: enters
-- rosters, types in scores, and pays out. Nothing is auto-tracked.
-- ============================================================================

-- ------------------------------------------------------------- free chips --
alter table public.app_settings alter column claim_amount set default 10;
update public.app_settings set claim_amount = 10 where id = 1 and claim_amount = 50;

-- ------------------------------------------------------- ledger: rewards --
alter table public.ledger drop constraint if exists ledger_kind_check;
alter table public.ledger add constraint ledger_kind_check
  check (kind in ('starting_grant','free_claim','stake','payout','refund','achievement'));

-- --------------------------------------------------------- manual contests --
alter table public.contests add column if not exists manual boolean not null default false;
create index if not exists contests_created_by_idx on public.contests (created_by);

-- Admins manage everything; a player manages the manual contests they created.
create or replace function public.can_manage_contest(p_contest uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (
    public.is_admin()
    or exists (select 1 from public.contests c where c.id = p_contest and c.manual and c.created_by = auth.uid())
  )
$$;

-- Same check for server-only functions that receive the acting user explicitly.
create or replace function sidebet_private.can_manage_as(p_contest uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = p_user and is_admin)
      or exists (select 1 from public.contests where id = p_contest and manual and created_by = p_user)
$$;

-- Creators can always see their own contests (including while in setup).
create or replace function public.can_view_contest(p_contest uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and exists (
    select 1 from public.contests c
    where c.id = p_contest and (
      (c.visibility = 'public' and c.status <> 'setup')
      or c.created_by = auth.uid()
      or public.is_admin()
      or exists (select 1 from public.contest_access a where a.contest_id = c.id and a.user_id = auth.uid())
      or exists (select 1 from public.entries e where e.contest_id = c.id and e.user_id = auth.uid())
    )
  )
$$;

-- Players may only create manual, offline contests for themselves, and can't
-- flip a contest's manual flag or owner afterwards.
create or replace function sidebet_private.guard_contest_owner() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('sidebet.internal', true), '') = 'on' then return new; end if;
  if auth.uid() is null or public.is_admin() then return new; end if;
  if tg_op = 'INSERT' then
    if not new.manual or new.created_by is distinct from auth.uid() then raise exception 'forbidden'; end if;
    if new.kind = 'draft' and new.draft_mode is distinct from 'offline' then raise exception 'forbidden'; end if;
  elsif new.manual is distinct from old.manual or new.created_by is distinct from old.created_by then
    raise exception 'forbidden';
  end if;
  return new;
end $$;
drop trigger if exists guard_contest_owner on public.contests;
create trigger guard_contest_owner before insert or update on public.contests
  for each row execute function sidebet_private.guard_contest_owner();

drop policy if exists contests_read on public.contests;
create policy contests_read on public.contests for select to authenticated
  using (public.is_admin() or created_by = auth.uid() or public.can_view_contest(id));
drop policy if exists contests_admin_insert on public.contests;
drop policy if exists contests_insert on public.contests;
create policy contests_insert on public.contests for insert to authenticated
  with check (public.is_admin() or (manual and created_by = auth.uid()));
drop policy if exists contests_admin_update on public.contests;
drop policy if exists contests_update on public.contests;
create policy contests_update on public.contests for update to authenticated
  using (public.can_manage_contest(id)) with check (public.can_manage_contest(id));

-- Organizers can see who has access to their contest.
drop policy if exists contest_access_read on public.contest_access;
create policy contest_access_read on public.contest_access for select to authenticated
  using (user_id = auth.uid() or public.can_manage_contest(contest_id));

-- Outcomes, pool and invites: whoever manages the contest.
do $$
declare t text;
begin
  foreach t in array array['contest_outcomes','pool_items','invites'] loop
    execute format('drop policy if exists %I on public.%I', t || '_admin', t);
    execute format('drop policy if exists %I on public.%I', t || '_manage', t);
    execute format('create policy %I on public.%I for all to authenticated using (public.can_manage_contest(contest_id)) with check (public.can_manage_contest(contest_id))', t || '_manage', t);
  end loop;
end $$;

create or replace function public.admin_set_status(p_contest uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare c public.contests;
begin
  if not public.can_manage_contest(p_contest) then raise exception 'forbidden'; end if;
  select * into c from public.contests where id = p_contest for update;
  if not found then raise exception 'contest_not_found'; end if;
  if p_status = 'open' then
    if c.kind = 'bet' and (select count(*) from public.contest_outcomes where contest_id = p_contest) < 2 then
      raise exception 'needs_two_outcomes';
    end if;
    if c.kind = 'draft' and not c.manual and not exists (select 1 from public.scoring_rulesets where contest_id = p_contest and status = 'approved') then
      raise exception 'needs_approved_rules';
    end if;
  end if;
  update public.contests set status = p_status where id = p_contest;
  perform sidebet_private.bump(p_contest);
end $$;

create or replace function public.import_draft(p_contest uuid, p_picks jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare c public.contests; v_n int := 0; r record; v_entries int;
begin
  if not public.can_manage_contest(p_contest) then raise exception 'forbidden'; end if;
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

create or replace function sidebet_private.settle_contest(
  p_contest uuid, p_admin uuid, p_outcome uuid, p_lines jsonb, p_summary jsonb, p_hash text
) returns text
language plpgsql security definer set search_path = public as $$
declare c public.contests; v_pot int; v_paid int; v_entries int; r record;
begin
  if not sidebet_private.can_manage_as(p_contest, p_admin) then raise exception 'forbidden'; end if;
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
  if not sidebet_private.can_manage_as(p_contest, p_admin) then raise exception 'forbidden'; end if;
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

create or replace function sidebet_private.guard_adjustment() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not sidebet_private.can_manage_as(new.contest_id, new.approved_by) then
    raise exception 'admin_only';
  end if;
  if exists (select 1 from public.contests where id = new.contest_id and status in ('settled','canceled')) then
    raise exception 'contest_closed';
  end if;
  return new;
end $$;
drop policy if exists adjustments_admin on public.adjustments;
create policy adjustments_admin on public.adjustments for insert to authenticated
  with check (public.can_manage_contest(contest_id) and approved_by = auth.uid());

-- ---------------------------------------------------------- manual scores --
-- One running total per rostered player/team, typed in by whoever runs it.
create table if not exists public.manual_scores (
  pool_item_id uuid primary key references public.pool_items(id) on delete cascade,
  contest_id uuid not null references public.contests(id) on delete cascade,
  points numeric(12,2) not null default 0 check (points between -100000 and 100000),
  note text not null default '' check (char_length(note) <= 200),
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);
create index if not exists manual_scores_contest_idx on public.manual_scores (contest_id);
alter table public.manual_scores enable row level security;
drop policy if exists manual_scores_read on public.manual_scores;
create policy manual_scores_read on public.manual_scores for select to authenticated using (public.can_view_contest(contest_id));
drop policy if exists manual_scores_manage on public.manual_scores;
create policy manual_scores_manage on public.manual_scores for all to authenticated
  using (public.can_manage_contest(contest_id)) with check (public.can_manage_contest(contest_id));

create or replace function sidebet_private.guard_manual_score() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_cid uuid := coalesce(new.contest_id, old.contest_id);
begin
  if exists (select 1 from public.contests where id = v_cid and status in ('settled','canceled')) then
    raise exception 'contest_closed';
  end if;
  if tg_op <> 'DELETE' and not exists (select 1 from public.pool_items where id = new.pool_item_id and contest_id = new.contest_id) then
    raise exception 'pick_not_available';
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists guard_manual_score on public.manual_scores;
create trigger guard_manual_score before insert or update or delete on public.manual_scores
  for each row execute function sidebet_private.guard_manual_score();

-- ----------------------------------------------------------------- friends --
create table if not exists public.friendships (
  requester uuid not null references public.profiles(id) on delete cascade,
  addressee uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  primary key (requester, addressee),
  check (requester <> addressee)
);
create unique index if not exists friendships_pair_idx on public.friendships (least(requester, addressee), greatest(requester, addressee));
create index if not exists friendships_addressee_idx on public.friendships (addressee);
alter table public.friendships enable row level security;
drop policy if exists friendships_own on public.friendships;
create policy friendships_own on public.friendships for select to authenticated
  using (requester = auth.uid() or addressee = auth.uid());

create or replace function public.are_friends(p_a uuid, p_b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.friendships
                  where status = 'accepted'
                    and ((requester = p_a and addressee = p_b) or (requester = p_b and addressee = p_a)))
$$;

-- Returns 'requested', 'accepted' (they had already asked you) or 'already'.
create or replace function public.send_friend_request(p_username text) returns text
language plpgsql security definer set search_path = public as $$
declare v_me uuid := auth.uid(); v_them uuid; f public.friendships;
begin
  if v_me is null then raise exception 'not_signed_in'; end if;
  select id into v_them from public.profiles where username = lower(trim(p_username));
  if v_them is null then raise exception 'user_not_found'; end if;
  if v_them = v_me then raise exception 'cant_friend_self'; end if;
  select * into f from public.friendships
   where (requester = v_me and addressee = v_them) or (requester = v_them and addressee = v_me) for update;
  if found then
    if f.status = 'pending' and f.requester = v_them then
      update public.friendships set status = 'accepted', responded_at = now() where requester = v_them and addressee = v_me;
      return 'accepted';
    end if;
    return 'already';
  end if;
  insert into public.friendships (requester, addressee) values (v_me, v_them);
  return 'requested';
end $$;

create or replace function public.respond_friend_request(p_requester uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  if p_accept then
    update public.friendships set status = 'accepted', responded_at = now()
     where requester = p_requester and addressee = auth.uid() and status = 'pending';
  else
    delete from public.friendships where requester = p_requester and addressee = auth.uid() and status = 'pending';
  end if;
end $$;

create or replace function public.remove_friend(p_other uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  delete from public.friendships
   where (requester = auth.uid() and addressee = p_other) or (requester = p_other and addressee = auth.uid());
end $$;

-- Give friends access to a contest you run (they still choose whether to join).
create or replace function public.add_friends_to_contest(p_contest uuid, p_users uuid[]) returns int
language plpgsql security definer set search_path = public as $$
declare v_n int := 0; u uuid;
begin
  if not public.can_manage_contest(p_contest) then raise exception 'forbidden'; end if;
  if exists (select 1 from public.contests where id = p_contest and status in ('settled','canceled')) then
    raise exception 'contest_closed';
  end if;
  foreach u in array coalesce(p_users, '{}') loop
    if not public.are_friends(auth.uid(), u) and not public.is_admin() then raise exception 'not_friends'; end if;
    insert into public.contest_access (contest_id, user_id, via) values (p_contest, u, 'friend') on conflict do nothing;
    if found then v_n := v_n + 1; end if;
  end loop;
  perform sidebet_private.bump(p_contest);
  return v_n;
end $$;

-- ------------------------------------------------------------ achievements --
-- Definitions and eligibility live in the app; the database records each
-- claim once and pays it through the ledger.
create table if not exists public.achievement_claims (
  user_id uuid not null references public.profiles(id) on delete cascade,
  achievement_id text not null check (char_length(achievement_id) between 1 and 60),
  reward int not null check (reward > 0 and reward <= 1000),
  claimed_at timestamptz not null default now(),
  primary key (user_id, achievement_id)
);
alter table public.achievement_claims enable row level security;
drop policy if exists achievement_claims_own on public.achievement_claims;
create policy achievement_claims_own on public.achievement_claims for select to authenticated using (user_id = auth.uid());

create or replace function sidebet_private.claim_achievement(p_user uuid, p_id text, p_reward int, p_title text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  insert into public.achievement_claims (user_id, achievement_id, reward) values (p_user, p_id, p_reward)
  on conflict do nothing;
  if not found then return false; end if;
  perform sidebet_private.post_ledger(p_user, 'achievement', p_reward, 'ach:' || p_user || ':' || p_id, null, null, p_title);
  return true;
end $$;

-- ------------------------------------------------------------------ grants --
revoke execute on all functions in schema sidebet_private from public;
do $$ begin
  execute 'revoke execute on all functions in schema sidebet_private from anon, authenticated';
  execute 'revoke execute on function public.can_manage_contest(uuid), public.are_friends(uuid, uuid),
           public.send_friend_request(text), public.respond_friend_request(uuid, boolean), public.remove_friend(uuid),
           public.add_friends_to_contest(uuid, uuid[]) from anon, public';
  execute 'grant execute on function public.can_manage_contest(uuid), public.are_friends(uuid, uuid),
           public.send_friend_request(text), public.respond_friend_request(uuid, boolean), public.remove_friend(uuid),
           public.add_friends_to_contest(uuid, uuid[]) to authenticated';
exception when undefined_object then null; end $$;

-- ---------------------------------------------------------- bookkeeping --
-- Record what's applied so `npm run db:migrate` never re-runs 0001 (which
-- would restore admin-only policies) on a project set up via the SQL editor.
create table if not exists sidebet_private.migrations (name text primary key, applied_at timestamptz not null default now());
insert into sidebet_private.migrations (name) values ('0001_side_bet'), ('0002_friends_manual_achievements') on conflict do nothing;
