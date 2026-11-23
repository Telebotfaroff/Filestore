ALTER TABLE delivery_bots
  ADD COLUMN IF NOT EXISTS start_message TEXT,
  ADD COLUMN IF NOT EXISTS start_image_url TEXT,
  ADD COLUMN IF NOT EXISTS start_image_data BYTEA,
  ADD COLUMN IF NOT EXISTS start_image_mime TEXT,
  ADD COLUMN IF NOT EXISTS start_updated_at TIMESTAMPTZ;
