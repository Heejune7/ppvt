-- CUP-PPVT: '검사 종료' 버튼(임의 중지) 지원을 위한 컬럼 추가
-- supabase_migrate_v0.2.sql을 이미 실행한 프로젝트에서 이어서 실행하세요.

alter table public.results add column manually_stopped boolean not null default false;
