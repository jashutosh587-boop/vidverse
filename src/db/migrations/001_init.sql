-- Vidverse schema, version 1.
-- Money is always an integer number of minor units (paise); there are no floating-point amounts anywhere.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------- accounts

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  email_verified_at timestamptz,
  password_hash text NOT NULL,
  handle text NOT NULL CHECK (handle ~ '^[a-z0-9][a-z0-9_.-]{2,29}$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 50),
  bio text NOT NULL DEFAULT '' CHECK (char_length(bio) <= 1000),
  avatar_hue smallint NOT NULL DEFAULT 0 CHECK (avatar_hue BETWEEN 0 AND 35),
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'moderator', 'admin')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  suspended_reason text,
  adult_confirmed_at timestamptz NOT NULL,
  terms_version text NOT NULL,
  terms_accepted_at timestamptz NOT NULL,
  creator_terms_version text,
  creator_terms_accepted_at timestamptz,
  totp_secret_enc text,
  totp_enabled_at timestamptz,
  totp_last_step bigint NOT NULL DEFAULT 0,
  recovery_codes jsonb NOT NULL DEFAULT '[]',
  failed_logins int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  autoplay boolean NOT NULL DEFAULT true,
  daily_limit_minutes int CHECK (daily_limit_minutes IS NULL OR daily_limit_minutes BETWEEN 10 AND 1440),
  support_links jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  deleted_at timestamptz
);
CREATE UNIQUE INDEX users_email_lower ON users (lower(email));
CREATE UNIQUE INDEX users_handle_lower ON users (lower(handle));
CREATE INDEX users_name_trgm ON users USING gin (lower(display_name) gin_trgm_ops);

CREATE TABLE sessions (
  id text PRIMARY KEY,                       -- sha256 of the cookie value; the cookie value itself is never stored
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  stage text NOT NULL DEFAULT 'active' CHECK (stage IN ('active', 'mfa')),
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  user_agent text,
  ip_prefix text
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE email_tokens (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verify', 'reset')),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_tokens_user ON email_tokens (user_id, purpose);

-- ---------------------------------------------------------------- videos

CREATE TABLE videos (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{11}$'),
  owner_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 5000),
  tags text[] NOT NULL DEFAULT '{}',
  category text NOT NULL DEFAULT 'other',
  status text NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'processing', 'ready', 'failed', 'removed')),
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'unlisted', 'private')),
  duration_ms int,
  width int,
  height int,
  renditions jsonb NOT NULL DEFAULT '[]',
  poster_candidates jsonb NOT NULL DEFAULT '[]',
  thumb_kind text NOT NULL DEFAULT 'frame' CHECK (thumb_kind IN ('frame', 'custom')),
  thumb_name text,
  size_bytes bigint NOT NULL DEFAULT 0,
  comments_enabled boolean NOT NULL DEFAULT true,
  has_paid_promotion boolean NOT NULL DEFAULT false,
  ad_status text NOT NULL DEFAULT 'eligible' CHECK (ad_status IN ('eligible', 'limited', 'none')),
  removed_reason text,
  fail_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  views bigint NOT NULL DEFAULT 0,           -- qualified views only
  watch_ms bigint NOT NULL DEFAULT 0,
  retention_sum double precision NOT NULL DEFAULT 0,   -- sum over viewers of (watched / duration), each capped at 1
  retention_n int NOT NULL DEFAULT 0,
  likes int NOT NULL DEFAULT 0,
  dislikes int NOT NULL DEFAULT 0,
  comment_count int NOT NULL DEFAULT 0,
  search_text text NOT NULL DEFAULT ''
);
CREATE INDEX videos_owner ON videos (owner_id, created_at DESC);
CREATE INDEX videos_feed ON videos (published_at DESC) WHERE status = 'ready' AND visibility = 'public';
CREATE INDEX videos_search_fts ON videos USING gin (to_tsvector('simple', search_text));
CREATE INDEX videos_title_trgm ON videos USING gin (lower(title) gin_trgm_ops);

CREATE FUNCTION videos_set_search_text() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_text := lower(NEW.title || ' ' || array_to_string(NEW.tags, ' ') || ' ' || left(NEW.description, 500));
  RETURN NEW;
END $$;
CREATE TRIGGER videos_search_text_trg BEFORE INSERT OR UPDATE OF title, tags, description ON videos
  FOR EACH ROW EXECUTE FUNCTION videos_set_search_text();

-- One row per viewer per video per day. viewer_hash is a keyed hash of IP and browser that changes every day,
-- so it can count unique viewers but cannot follow a person from one day to the next.
CREATE TABLE video_view_days (
  video_id text NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
  day date NOT NULL,
  viewer_hash text NOT NULL,
  watch_ms int NOT NULL DEFAULT 0,
  qualified boolean NOT NULL DEFAULT false,
  counted boolean NOT NULL DEFAULT false,
  last_beat_at timestamptz NOT NULL,
  first_beat_at timestamptz NOT NULL DEFAULT now(),  -- watch time credited can never exceed what real time since this allows
  PRIMARY KEY (video_id, day, viewer_hash)
);
CREATE INDEX video_view_days_day ON video_view_days (day);

CREATE TABLE video_votes (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  video_id text NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
  value smallint NOT NULL CHECK (value IN (-1, 1)),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, video_id)
);
CREATE INDEX video_votes_video ON video_votes (video_id);

CREATE TABLE subscriptions (
  subscriber_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  notify boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subscriber_id, channel_id),
  CHECK (subscriber_id <> channel_id)
);
CREATE INDEX subscriptions_channel ON subscriptions (channel_id);

CREATE TABLE watch_history (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  video_id text NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
  position_ms int NOT NULL DEFAULT 0,
  watched_ms bigint NOT NULL DEFAULT 0,
  completed boolean NOT NULL DEFAULT false,
  last_watched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, video_id)
);
CREATE INDEX watch_history_recent ON watch_history (user_id, last_watched_at DESC);

-- How long each member watched on each day (for the personal time-watched view and the optional daily reminder).
CREATE TABLE user_watch_days (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  day date NOT NULL,
  watch_ms bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE watch_later (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  video_id text NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, video_id)
);

CREATE TABLE comments (
  id bigserial PRIMARY KEY,
  video_id text NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  parent_id bigint REFERENCES comments (id) ON DELETE CASCADE,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz
);
CREATE INDEX comments_video ON comments (video_id, created_at DESC, id DESC) WHERE parent_id IS NULL;
CREATE INDEX comments_parent ON comments (parent_id, created_at);
CREATE INDEX comments_user ON comments (user_id);

-- ---------------------------------------------------------------- background jobs

CREATE TABLE jobs (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3,
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  dedupe_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX jobs_ready ON jobs (run_after) WHERE status = 'queued';

-- ---------------------------------------------------------------- moderation, notifications, audit

CREATE TABLE reports (
  id bigserial PRIMARY KEY,
  reporter_id uuid REFERENCES users (id) ON DELETE SET NULL,
  target_type text NOT NULL CHECK (target_type IN ('video', 'comment', 'user')),
  target_id text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('spam', 'harassment', 'hate', 'sexual', 'child_safety', 'violence', 'copyright', 'misleading', 'illegal', 'other')),
  details text NOT NULL DEFAULT '' CHECK (char_length(details) <= 1000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  handled_by uuid REFERENCES users (id) ON DELETE SET NULL,
  handled_at timestamptz,
  resolution_note text
);
CREATE INDEX reports_queue ON reports (status, created_at);
CREATE INDEX reports_target ON reports (target_type, target_id) WHERE status = 'open';
CREATE UNIQUE INDEX reports_one_open_per_reporter ON reports (reporter_id, target_type, target_id) WHERE status = 'open';

CREATE TABLE notifications (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('new_video', 'comment', 'reply', 'video_ready', 'video_failed', 'tip', 'payout', 'policy', 'milestone')),
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
CREATE INDEX notifications_user ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread ON notifications (user_id) WHERE read_at IS NULL;

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  actor_id uuid REFERENCES users (id) ON DELETE SET NULL,
  action text NOT NULL,
  target_type text,
  target_id text,
  meta jsonb NOT NULL DEFAULT '{}',
  ip_prefix text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_recent ON audit_log (created_at DESC);
CREATE INDEX audit_log_actor ON audit_log (actor_id, created_at DESC);

CREATE TABLE contact_messages (
  id bigserial PRIMARY KEY,
  user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  email text NOT NULL,
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 150),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- money

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payer_id uuid REFERENCES users (id) ON DELETE SET NULL,
  channel_id uuid NOT NULL REFERENCES users (id),
  video_id text REFERENCES videos (id) ON DELETE SET NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL,
  fee_minor bigint NOT NULL CHECK (fee_minor >= 0),
  net_minor bigint NOT NULL CHECK (net_minor >= 0),
  provider text NOT NULL CHECK (provider IN ('razorpay', 'test')),
  provider_ref text UNIQUE,
  provider_payment_id text,
  checkout_url text,
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paid', 'failed', 'expired', 'refunded')),
  message text CHECK (message IS NULL OR char_length(message) <= 140),
  anonymous boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  CHECK (fee_minor + net_minor = amount_minor)
);
CREATE INDEX payments_channel ON payments (channel_id, created_at DESC);
CREATE INDEX payments_payer ON payments (payer_id, created_at DESC);

-- Append-only: balances are always the sum of entries, never a number someone can overwrite.
CREATE TABLE ledger_entries (
  id bigserial PRIMARY KEY,
  account text NOT NULL,                       -- 'user:<uuid>' or 'platform'
  user_id uuid REFERENCES users (id),
  kind text NOT NULL CHECK (kind IN ('tip_net', 'tip_fee', 'revenue_share', 'payout_request', 'payout_reversal', 'adjustment', 'refund')),
  amount_minor bigint NOT NULL CHECK (amount_minor <> 0),
  currency text NOT NULL,
  available_at timestamptz NOT NULL,
  ref_type text NOT NULL,
  ref_id text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account, kind, ref_type, ref_id)     -- the same payment or payout can never be booked twice
);
CREATE INDEX ledger_user ON ledger_entries (user_id, available_at);

CREATE FUNCTION ledger_is_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only';
END $$;
CREATE TRIGGER ledger_no_change BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION ledger_is_append_only();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON ledger_entries FOR EACH STATEMENT EXECUTE FUNCTION ledger_is_append_only();

CREATE TABLE payout_profiles (
  user_id uuid PRIMARY KEY REFERENCES users (id),
  method text NOT NULL CHECK (method IN ('upi', 'bank')),
  details_enc text NOT NULL,
  display_hint text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'paid', 'rejected', 'cancelled')),
  method text NOT NULL,
  details_enc text NOT NULL,
  display_hint text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users (id),
  decided_at timestamptz,
  paid_reference text,
  paid_at timestamptz,
  note text
);
CREATE INDEX payouts_user ON payouts (user_id, requested_at DESC);
CREATE INDEX payouts_queue ON payouts (status, requested_at);
-- At most one open request per person, enforced by the database itself so no race in the application can break it.
CREATE UNIQUE INDEX payouts_one_open ON payouts (user_id) WHERE status IN ('requested', 'approved');

CREATE TABLE revenue_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 100),
  source text NOT NULL CHECK (source IN ('membership', 'sponsorship', 'manual', 'adsense')),
  gross_minor bigint NOT NULL CHECK (gross_minor > 0),
  creator_share_bps int NOT NULL CHECK (creator_share_bps BETWEEN 0 AND 10000),
  currency text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  google_permission_attested boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted')),
  pool_minor bigint,
  allocated_minor bigint,
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  posted_at timestamptz,
  CHECK (period_end >= period_start)
);

CREATE TABLE revenue_allocations (
  batch_id uuid NOT NULL REFERENCES revenue_batches (id),
  user_id uuid NOT NULL REFERENCES users (id),
  watch_ms bigint NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  PRIMARY KEY (batch_id, user_id)
);

CREATE TABLE webhook_events (
  provider text NOT NULL,
  event_id text NOT NULL,
  type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);
