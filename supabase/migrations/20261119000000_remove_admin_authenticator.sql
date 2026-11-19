-- Admin sign-in is now username + password only (the authenticator-app step, aal2, is no longer required).
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin' and p.active);
$$;
