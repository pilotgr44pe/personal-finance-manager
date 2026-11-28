create table if not exists public.savings_assets (
  user_id uuid not null references auth.users (id) on delete cascade,
  id text not null,
  name text not null check (char_length(name) between 1 and 70),
  kind text not null check (kind in ('savings', 'investment')),
  category text not null check (char_length(category) between 1 and 80),
  institution text not null default '' check (char_length(institution) <= 70),
  amount numeric(12, 2) not null check (amount >= 0),
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists savings_assets_user_name_idx
  on public.savings_assets (user_id, name);

revoke all on public.savings_assets from anon;
grant select, insert, update, delete on public.savings_assets to authenticated;

alter table public.savings_assets enable row level security;

drop policy if exists "Users manage their own savings assets" on public.savings_assets;
create policy "Users manage their own savings assets"
  on public.savings_assets for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
