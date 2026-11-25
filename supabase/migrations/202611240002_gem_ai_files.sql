-- Gem.AI · suporte a envio de arquivos
-- 1) Metadados dos anexos em cada mensagem + texto exibido (separado do prompt real).
-- 2) Bucket privado no Supabase Storage, isolado pelo mesmo x-gem-owner do RLS do banco.

alter table public.gem_messages
  add column if not exists attachments jsonb not null default '[]'::jsonb,
  add column if not exists display_content text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('gem-uploads', 'gem-uploads', false, 10485760, null)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Caminho dos objetos: <owner_key>/<conversation_id>/<uuid>-<nome>
-- storage.foldername(name)[1] = owner_key -> cada navegador só acessa os próprios arquivos.
drop policy if exists gem_files_select on storage.objects;
drop policy if exists gem_files_insert on storage.objects;
drop policy if exists gem_files_update on storage.objects;
drop policy if exists gem_files_delete on storage.objects;

create policy gem_files_select on storage.objects
  for select to anon, authenticated
  using (
    bucket_id = 'gem-uploads'
    and (storage.foldername(name))[1] = public.gem_current_owner()
  );

create policy gem_files_insert on storage.objects
  for insert to anon, authenticated
  with check (
    bucket_id = 'gem-uploads'
    and (storage.foldername(name))[1] = public.gem_current_owner()
  );

create policy gem_files_update on storage.objects
  for update to anon, authenticated
  using (
    bucket_id = 'gem-uploads'
    and (storage.foldername(name))[1] = public.gem_current_owner()
  )
  with check (
    bucket_id = 'gem-uploads'
    and (storage.foldername(name))[1] = public.gem_current_owner()
  );

create policy gem_files_delete on storage.objects
  for delete to anon, authenticated
  using (
    bucket_id = 'gem-uploads'
    and (storage.foldername(name))[1] = public.gem_current_owner()
  );

notify pgrst, 'reload schema';
