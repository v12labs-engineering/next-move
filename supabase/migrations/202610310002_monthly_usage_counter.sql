-- The monthly quota RPC superseded the original ten-attempt daily limit, but
-- the old storage constraint remained. A visual loop exposed that at call 11.
-- Keep all recorded usage; reserve_ai_attempt still enforces each account's
-- rolling monthly plan limit under its existing advisory lock.
alter table public.account_ai_usage drop constraint account_ai_usage_attempts_check;
alter table public.account_ai_usage add constraint account_ai_usage_attempts_check check (attempts >= 1);
