-- Disposable test database only. Fictitious users; no real data.
-- The on_auth_user_created trigger (migration 001) creates an account and
-- an owner profile per user; the agent is then moved into the owner's account.
INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
VALUES
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'owner@disposable.example.invalid', '{"full_name":"Disposable Owner"}', now(), now()),
  ('00000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'agent@disposable.example.invalid', '{"full_name":"Disposable Agent"}', now(), now())
ON CONFLICT (id) DO NOTHING;

WITH owner_acc AS (
  SELECT account_id FROM public.profiles WHERE user_id = '00000000-0000-4000-8000-000000000001'
)
UPDATE public.profiles
   SET account_id = (SELECT account_id FROM owner_acc), account_role = 'agent'
 WHERE user_id = '00000000-0000-4000-8000-000000000002'
   AND account_id <> (SELECT account_id FROM owner_acc);
DELETE FROM public.accounts a
 WHERE a.owner_user_id = '00000000-0000-4000-8000-000000000002'
   AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.account_id = a.id);
