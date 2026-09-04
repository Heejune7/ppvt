-- CUP-PPVT v0.1(20문항) → v0.2(150문항) 결과 테이블 마이그레이션
-- 이미 supabase_setup.sql(구버전)로 results 테이블을 만든 프로젝트에서 실행하세요.
-- 현재 results 테이블에 저장된 행이 없다는 것을 이미 확인했으므로 데이터 손실 없이 안전합니다.

alter table public.results rename column total_score to raw_score;
alter table public.results alter column raw_score drop not null;

alter table public.results rename column noun_score to noun_correct;
alter table public.results alter column noun_correct drop not null;
alter table public.results add column noun_total int;

alter table public.results rename column verb_score to verb_correct;
alter table public.results alter column verb_correct drop not null;
alter table public.results add column verb_total int;

alter table public.results add column adjective_correct int;
alter table public.results add column adjective_total int;

alter table public.results add column basal_seq int;
alter table public.results add column ceiling_seq int;
