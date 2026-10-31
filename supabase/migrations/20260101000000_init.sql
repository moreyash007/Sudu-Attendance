-- SUDU Attendance: tables, security rules and the private photo bucket.
-- Run once in Supabase > SQL Editor (or `supabase db push`). Safe to run again.
--
-- Security model: people can only READ their own rows. Every write that matters (check-in, check-out, visits,
-- adding/removing employees, approvals, settings) goes through the `api` Edge Function, which re-checks
-- location, device, time and role on the server. Admin access also requires the authenticator-app login (aal2).

create extension if not exists pgcrypto;

-- ---------- tables ----------

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text not null,
  name        text not null,
  emp_id      text not null default '',
  role        text not null check (role in ('admin', 'employee')),
  active      boolean not null default true,
  device_id   text,
  enrol_photo text,
  created_at  timestamptz not null default now()
);
create unique index if not exists profiles_username_key on public.profiles (lower(username));

create table if not exists public.attendance (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null references public.profiles(id) on delete cascade,
  date      date not null,
  late      boolean not null default false,
  test      boolean not null default false,
  in_time   timestamptz not null default now(),
  in_lat double precision, in_lng double precision, in_acc real, in_dist integer, in_photo text,
  out_time  timestamptz,
  out_lat double precision, out_lng double precision, out_acc real, out_dist integer, out_photo text,
  unique (user_id, date)
);
create index if not exists attendance_date_idx on public.attendance (date);

create table if not exists public.visits (
  id       uuid primary key default gen_random_uuid(),
  user_id  uuid not null references public.profiles(id) on delete cascade,
  date     date not null,
  type     text not null check (type in ('out_duty', 'customer_visit', 'custom_visit')),
  customer text not null default '',
  reason   text not null check (char_length(reason) between 1 and 500),
  time     timestamptz not null default now(),
  lat double precision, lng double precision, acc real, photo text,
  status   text not null default 'pending' check (status in ('pending', 'approved', 'rejected'))
);
create index if not exists visits_date_idx on public.visits (date);

create table if not exists public.leaves (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  type       text not null check (type in ('full', 'half_first', 'half_second')),
  from_date  date not null,
  to_date    date not null,
  reason     text not null check (char_length(reason) between 1 and 500),
  status     text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  check (to_date >= from_date),
  check (type = 'full' or from_date = to_date) -- half-day leave is for a single date
);

create table if not exists public.settings (
  key   text primary key,
  value jsonb not null
);

insert into public.settings (key, value) values
  ('office', '{"lat": 18.646972, "lng": 73.784528, "radius": 10, "maxAccuracy": 15, "startTime": "09:30", "graceMin": 15}')
on conflict (key) do nothing;

-- ---------- helpers ----------

-- True only for an active admin whose session passed the authenticator-app step (aal2).
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
     and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin' and p.active);
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- ---------- row level security ----------

alter table public.profiles   enable row level security;
alter table public.attendance enable row level security;
alter table public.visits     enable row level security;
alter table public.leaves     enable row level security;
alter table public.settings   enable row level security;

revoke all on public.profiles, public.attendance, public.visits, public.leaves, public.settings from anon;

drop policy if exists profiles_read   on public.profiles;
drop policy if exists attendance_read on public.attendance;
drop policy if exists visits_read     on public.visits;
drop policy if exists leaves_read     on public.leaves;
drop policy if exists leaves_insert   on public.leaves;
drop policy if exists settings_read   on public.settings;

create policy profiles_read   on public.profiles   for select to authenticated using (id = auth.uid() or public.is_admin());
create policy attendance_read on public.attendance for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy visits_read     on public.visits     for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy leaves_read     on public.leaves     for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy settings_read   on public.settings   for select to authenticated using (true);

-- Employees may file their own leave request; approving/rejecting goes through the Edge Function.
create policy leaves_insert on public.leaves for insert to authenticated
  with check (
    user_id = auth.uid()
    and status = 'pending'
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'employee' and p.active)
  );

-- Signed-in users can only read/insert through the policies above; nobody can update or delete from the browser.
revoke update, delete, truncate on public.profiles, public.attendance, public.visits, public.leaves, public.settings from authenticated;
revoke insert on public.profiles, public.attendance, public.visits, public.settings from authenticated;

-- ---------- private photo bucket ----------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 2097152, array['image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = 2097152, allowed_mime_types = array['image/jpeg'];

drop policy if exists photos_employee_upload on storage.objects;
drop policy if exists photos_admin_read      on storage.objects;

-- An employee can upload only into their own selfies/<their id>/ folder, and can never read photos back.
create policy photos_employee_upload on storage.objects for insert to authenticated
  with check (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] = 'selfies'
    and (storage.foldername(name))[2] = auth.uid()::text
  );

-- Only an admin (with the authenticator step) can view photos.
create policy photos_admin_read on storage.objects for select to authenticated
  using (bucket_id = 'photos' and public.is_admin());
