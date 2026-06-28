-- Packing Tool — Supabase schema (Phase 4)
-- Run this in the Supabase dashboard → SQL Editor → New query → Run.
-- Gives real per-user isolation via Row-Level Security (RLS).

-- ── Tables ───────────────────────────────────────────────────────────────────

-- Invite list / roles (email-based; admins manage it).
create table if not exists public.members (
  email      text primary key,
  is_admin   boolean not null default false,
  is_allowed boolean not null default true,
  created_at timestamptz not null default now()
);

-- Seed the owner (always admin + allowed; can't be locked out).
insert into public.members (email, is_admin, is_allowed)
values ('jonas.takolander@gmail.com', true, true)
on conflict (email) do update set is_admin = true, is_allowed = true;

-- Global default template that seeds new members (singleton row).
create table if not exists public.app_config (
  id         text primary key default 'singleton',
  template   jsonb,
  updated_at timestamptz not null default now()
);
insert into public.app_config (id, template) values ('singleton', null)
on conflict (id) do nothing;

-- Per-user state (the whole app state blob: { profileDefault, trips }).
create table if not exists public.user_data (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text,
  data       jsonb,
  updated_at timestamptz not null default now()
);

-- ── Membership helpers (SECURITY DEFINER → bypass RLS, avoid recursion) ───────

create or replace function public.is_member() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.members m
    where lower(m.email) = lower(auth.jwt() ->> 'email') and m.is_allowed
  );
$$;

create or replace function public.is_admin() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.members m
    where lower(m.email) = lower(auth.jwt() ->> 'email') and m.is_admin
  );
$$;

-- ── Row-Level Security ────────────────────────────────────────────────────────

alter table public.members   enable row level security;
alter table public.app_config enable row level security;
alter table public.user_data enable row level security;

-- members: any authenticated user may read (so the app can check access); only admins write.
drop policy if exists members_read on public.members;
create policy members_read on public.members for select to authenticated using (true);
drop policy if exists members_admin_write on public.members;
create policy members_admin_write on public.members for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- app_config: allowed members read; admins write.
drop policy if exists cfg_read on public.app_config;
create policy cfg_read on public.app_config for select to authenticated using (public.is_member());
drop policy if exists cfg_admin_write on public.app_config;
create policy cfg_admin_write on public.app_config for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- user_data: an allowed member may read/write ONLY their own row.
drop policy if exists ud_self on public.user_data;
create policy ud_self on public.user_data for all to authenticated
  using (auth.uid() = user_id and public.is_member())
  with check (auth.uid() = user_id and public.is_member());
