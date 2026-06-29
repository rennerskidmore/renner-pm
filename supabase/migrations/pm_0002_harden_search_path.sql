-- Applied 2026-06-11 as `pm_0002_harden_search_path`.
-- Addresses the Supabase security linter's function_search_path_mutable warning.
alter function pm.touch_updated_at() set search_path = '';
alter function pm.move_task(bigint, pm.task_status, text) set search_path = 'pm';
