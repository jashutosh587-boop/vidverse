-- Version 2: a catalog of openly licensed videos that play from the archive that holds them.
--
-- A "linked" video has no files on this server apart from its thumbnail. The browser plays media_url directly from
-- the archive (NASA, the Internet Archive), and the watch page credits the source and shows the licence from
-- `origin`. Uploaded videos are unchanged: source = 'upload', media_url and origin stay empty.

ALTER TABLE videos ADD COLUMN source text NOT NULL DEFAULT 'upload' CHECK (source IN ('upload', 'linked'));
ALTER TABLE videos ADD COLUMN media_url text CHECK (media_url IS NULL OR (media_url ~ '^https://[^\s]+$' AND char_length(media_url) <= 2000));
-- { provider, key, collection, page_url, credit, license, license_url, year }. Validated in code before insert.
ALTER TABLE videos ADD COLUMN origin jsonb CHECK (origin IS NULL OR jsonb_typeof(origin) = 'object');
ALTER TABLE videos ADD CONSTRAINT videos_linked_complete CHECK (
  (source = 'upload' AND media_url IS NULL AND origin IS NULL)
  OR (source = 'linked' AND media_url IS NOT NULL AND origin ? 'provider' AND origin ? 'key' AND origin ? 'license')
);
-- The same archive item is never imported twice.
CREATE UNIQUE INDEX videos_origin_key ON videos ((origin ->> 'provider'), (origin ->> 'key')) WHERE origin IS NOT NULL;

-- Archive items that were looked at and not imported (wrong format, licence unclear, possible third-party material),
-- or that staff removed. They are never fetched again, so a daily import stays cheap and a removal stays removed.
CREATE TABLE catalog_skips (
  provider text NOT NULL,
  key text NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, key)
);

-- Channels that hold the catalog. They belong to the site, have no password anyone can use, never sign in,
-- and never earn (tips and revenue share require creator terms, which these accounts never accept).
ALTER TABLE users ADD COLUMN is_system boolean NOT NULL DEFAULT false;
