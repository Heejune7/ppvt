-- CUP-PPVT 결과 저장용 테이블 및 접근 정책
-- Supabase 대시보드 > SQL Editor 에서 이 파일 내용을 그대로 실행하세요.

create table public.results (
  id uuid primary key default gen_random_uuid(),
  subject_id text not null,
  birth_year_month text,
  gender text,
  examiner text,
  responses jsonb not null,
  total_score int not null,
  noun_score int not null,
  verb_score int not null,
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
