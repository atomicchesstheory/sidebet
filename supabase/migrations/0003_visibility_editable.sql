-- ============================================================================
-- Side Bet 0003 — public/private stays editable after entries.
-- Same guard as 0001, minus `visibility` in the locked-terms list. Everyone
-- who already joined keeps access through their entry either way.
-- Safe to re-run.
-- ============================================================================

create or replace function sidebet_private.guard_contest() returns trigger
language plpgsql security definer set search_path = public as $$
declare internal boolean := coalesce(current_setting('sidebet.internal', true), '') = 'on';
begin
  if tg_op = 'UPDATE' then
    if old.terms_locked_at is not null and (
      new.kind, new.stake, new.payout_rule, new.lock_at, new.pick_visibility, new.tiebreakers,
      new.terms_text, new.roster_size, new.draft_format, new.max_entrants
    ) is distinct from (
      old.kind, old.stake, old.payout_rule, old.lock_at, old.pick_visibility, old.tiebreakers,
      old.terms_text, old.roster_size, old.draft_format, old.max_entrants
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

create table if not exists sidebet_private.migrations (name text primary key, applied_at timestamptz not null default now());
insert into sidebet_private.migrations (name) values ('0003_visibility_editable') on conflict do nothing;
