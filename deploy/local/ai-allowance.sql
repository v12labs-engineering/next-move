-- Use the testing convention of the largest integer for an effectively unlimited AI allowance.
update public.plans
set monthly_ai_requests = 2147483647
where monthly_ai_requests <> 2147483647;
