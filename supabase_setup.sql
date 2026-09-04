-- CUP-PPVT 결과 저장용 테이블 및 접근 정책 (v0.2, 150문항 기준)
-- 신규 Supabase 프로젝트에서 처음 설정할 때 이 파일 전체를 SQL Editor에서 실행하세요.
-- 이미 v0.1 버전 테이블을 만든 적이 있다면 이 파일 대신 supabase_migrate_v0.2.sql 을 실행하세요.

create table public.results (
  id uuid primary key default gen_random_uuid(),
  subject_id text not null,
  birth_year_month text,
  gender text,
  examiner text,
  responses jsonb not null,
  raw_score int,
  basal_seq int,
  ceiling_seq int,
  noun_correct int,
  noun_total int,
  verb_correct int,
  verb_total int,
  adjective_correct int,
  adjective_total int,
  manually_stopped boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid not null default auth.uid()
);

alter table public.results enable row level security;

-- 로그인한 사용자만 결과를 저장할 수 있음
create policy "authenticated can insert results"
  on public.results for insert
  to authenticated
  with check (auth.uid() = created_by);

-- 로그인한 사용자만 결과를 조회할 수 있음 (비로그인 상태에서는 완전히 비공개)
create policy "authenticated can read results"
  on public.results for select
  to authenticated
  using (true);
