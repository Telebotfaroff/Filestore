-- Media payload support for creator broadcast campaigns.
ALTER TABLE creator_broadcasts
  ADD COLUMN IF NOT EXISTS media_type TEXT,
  ADD COLUMN IF NOT EXISTS media_file_id TEXT,
  ADD COLUMN IF NOT EXISTS caption TEXT;
