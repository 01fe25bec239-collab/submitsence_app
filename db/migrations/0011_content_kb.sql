-- 0011_content_kb.sql
-- Public content / knowledge base (req f24). NOT tenant-owned (global marketing/help content).
-- COPYRIGHT SAFETY (NFR6): this table has NO column that carries NATSPEC clause text and is
-- intentionally NOT linked to clauses/extracted_fragments. A DB CHECK blocks publishing content
-- that is flagged as containing NATSPEC text unless it has been explicitly copyright-cleared.

begin;

create table knowledge_base_articles (
  id                     uuid primary key default gen_random_uuid(),
  slug                   citext not null unique,
  title                  text not null,
  body                   text,
  excerpt                text,
  seo_title              text,
  seo_description        text,
  seo_keywords           text[] not null default '{}',
  publication_state      publication_state not null default 'draft',
  source_policy          text,                          -- provenance/licensing note for the content
  author_id              uuid references users(id),
  reviewer_id            uuid references users(id),
  reviewed_at            timestamptz,
  published_at           timestamptz,
  contains_natspec_text  boolean not null default false,   -- req f24 copyright safety flag
  natspec_copyright_cleared boolean not null default false,
  archived_at            timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  -- NFR6: cannot publish content flagged as containing NATSPEC text unless it is copyright-cleared.
  constraint chk_publish_copyright_safe check (
    publication_state <> 'published'
    or contains_natspec_text = false
    or natspec_copyright_cleared = true
  ),
  -- a published article must have a human reviewer recorded
  constraint chk_publish_reviewed check (
    publication_state <> 'published' or reviewer_id is not null
  )
);
create index idx_kb_published on knowledge_base_articles (publication_state, published_at);
create index idx_kb_title_trgm on knowledge_base_articles using gin (title gin_trgm_ops);

-- Public site sees only published articles; authoring/review is performed by an elevated role
-- (migration owner / content service) which bypasses RLS. See docs/rls.md.
alter table knowledge_base_articles enable row level security;
create policy kb_read_published on knowledge_base_articles
  for select using (publication_state = 'published');

commit;
