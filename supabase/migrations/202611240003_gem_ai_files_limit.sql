-- Gem.AI · teto do bucket de anexos
-- O bucket deixa de ser o gargalo: 1 GiB por objeto.
-- ATENÇÃO: o limite GLOBAL do projeto (Storage Settings) prevalece e é definido pelo
-- plano. No Free ele é 50 MiB (52428800 bytes); no Pro pode chegar a 500 GB.
-- Medido neste projeto em 2026-11-24: 52428800 bytes -> 200, 53477376 bytes -> 413.
-- Por isso docs/js/config.js usa maxFileBytes = 50 MiB enquanto o plano for Free.
-- Para aceitar 1 GB por arquivo: suba o "Global file size limit" no dashboard
-- (exige plano Pro) e troque CONFIG.maxFileBytes para 1024 * 1024 * 1024.

update storage.buckets
  set file_size_limit = 1073741824
  where id = 'gem-uploads';
