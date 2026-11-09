-- «الصحفي الصغير» — المخطط الأساسي لقاعدة البيانات
-- كل التواريخ مخزنة بصيغة ISO-8601 (UTC).

CREATE TABLE users (
  id                   INTEGER PRIMARY KEY,
  username             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash        TEXT NOT NULL,
  role                 TEXT NOT NULL CHECK (role IN ('student','editor','admin')),
  display_name         TEXT NOT NULL,
  is_active            INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  failed_logins        INTEGER NOT NULL DEFAULT 0,
  locked_until         TEXT,
  last_login_at        TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

-- بيانات الطالب المدرسية والموافقات. لا نخزن هاتفًا أو بريدًا أو عنوانًا.
CREATE TABLE students (
  user_id              INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  grade                INTEGER NOT NULL CHECK (grade BETWEEN 1 AND 12),
  section              TEXT,
  photo_media_id       INTEGER REFERENCES media(id) ON DELETE SET NULL,
  consent_name_public  INTEGER NOT NULL DEFAULT 0,
  consent_photo_public INTEGER NOT NULL DEFAULT 0,
  consent_note         TEXT,
  consent_recorded_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  consent_recorded_at  TEXT
);

CREATE TABLE sessions (
  token_hash    TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  ip_hash       TEXT,
  user_agent    TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE categories (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_visible  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE media (
  id          INTEGER PRIMARY KEY,
  public_id   TEXT NOT NULL UNIQUE,
  owner_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('cover','inline','profile','site','issue')),
  article_id  INTEGER REFERENCES articles(id) ON DELETE CASCADE,
  mime        TEXT NOT NULL,
  ext         TEXT NOT NULL,
  width       INTEGER,
  height      INTEGER,
  bytes       INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_media_article ON media(article_id);
CREATE INDEX idx_media_owner ON media(owner_id);

CREATE TABLE issues (
  id             INTEGER PRIMARY KEY,
  number         INTEGER NOT NULL UNIQUE,
  title          TEXT NOT NULL,
  theme          TEXT,
  intro          TEXT,
  cover_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  published_at   TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE articles (
  id              INTEGER PRIMARY KEY,
  public_id       TEXT NOT NULL UNIQUE,
  slug            TEXT NOT NULL DEFAULT '',
  author_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id     INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  issue_id        INTEGER REFERENCES issues(id) ON DELETE SET NULL,
  title           TEXT NOT NULL DEFAULT '',
  subtitle        TEXT NOT NULL DEFAULT '',
  summary         TEXT NOT NULL DEFAULT '',
  body_json       TEXT NOT NULL DEFAULT '[]',
  cover_media_id  INTEGER REFERENCES media(id) ON DELETE SET NULL,
  cover_caption   TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
                    ('draft','submitted','in_review','changes_requested','approved','published','rejected','archived')),
  featured        INTEGER NOT NULL DEFAULT 0,
  rising_pen      INTEGER NOT NULL DEFAULT 0,
  home_order      INTEGER NOT NULL DEFAULT 0,
  views           INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  submitted_at    TEXT,
  approved_at     TEXT,
  published_at    TEXT,
  unpublished_at  TEXT,
  archived_at     TEXT
);
CREATE INDEX idx_articles_author ON articles(author_id);
CREATE INDEX idx_articles_status ON articles(status, published_at);
CREATE INDEX idx_articles_category ON articles(category_id);

-- نسخة محفوظة من المقال عند كل إرسال وعند كل تعديل تحريري (لحفظ النص الأصلي للطالب)
CREATE TABLE article_revisions (
  id             INTEGER PRIMARY KEY,
  article_id     INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  revision_no    INTEGER NOT NULL,
  reason         TEXT NOT NULL CHECK (reason IN ('submit','editor_edit')),
  note           TEXT,
  title          TEXT NOT NULL,
  subtitle       TEXT NOT NULL,
  summary        TEXT NOT NULL,
  body_json      TEXT NOT NULL,
  cover_media_id INTEGER,
  cover_caption  TEXT NOT NULL DEFAULT '',
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL,
  UNIQUE (article_id, revision_no)
);

CREATE TABLE editorial_notes (
  id                 INTEGER PRIMARY KEY,
  article_id         INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  author_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body               TEXT NOT NULL,
  visible_to_student INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_notes_article ON editorial_notes(article_id);

-- سجل انتقالات حالة المقال: من قام بماذا ومتى
CREATE TABLE article_events (
  id          INTEGER PRIMARY KEY,
  article_id  INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_events_article ON article_events(article_id);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE writing_prompts (
  id          INTEGER PRIMARY KEY,
  title       TEXT NOT NULL,
  body        TEXT,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY,
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  details     TEXT,
  ip_hash     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_audit_created ON audit_log(created_at);
