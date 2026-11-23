-- Non-secret settings (phone number ID, admin numbers, business name, verify token).
-- Supabase secrets with the same name take priority.
create table if not exists settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
alter table settings enable row level security;
insert into settings (key, value) values ('WHATSAPP_VERIFY_TOKEN', 'dawn-bot-' || substr(md5(random()::text), 1, 10))
on conflict (key) do nothing;
