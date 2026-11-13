-- ============================================================================
-- Side Bet 0004 — free chips once a week (was every 23 hours).
-- Safe to re-run. Run after 0003 in the Supabase SQL editor (or db:migrate).
-- Achievements are defined in app code; tier claims reuse achievement_claims.
-- ============================================================================

alter table public.app_settings alter column claim_cooldown_seconds set default 604800; -- 7 days
update public.app_settings set claim_cooldown_seconds = 604800 where id = 1;
