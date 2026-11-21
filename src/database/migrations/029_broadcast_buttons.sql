-- Optional inline URL buttons for creator broadcast campaigns.
ALTER TABLE creator_broadcasts
  ADD COLUMN IF NOT EXISTS buttons JSONB NOT NULL DEFAULT '[]'::jsonb;
