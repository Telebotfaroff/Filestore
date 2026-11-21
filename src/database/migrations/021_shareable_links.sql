CREATE TABLE IF NOT EXISTS share_links (
  id BIGSERIAL PRIMARY KEY,
  link_code TEXT NOT NULL UNIQUE,
  link_type TEXT NOT NULL CHECK (link_type IN ('single', 'batch')),
  title TEXT NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS share_links_created_idx ON share_links(created_at DESC);

CREATE TABLE IF NOT EXISTS share_link_items (
  link_id BIGINT NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
  file_id BIGINT NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 1 AND position <= 20),
  PRIMARY KEY (link_id, file_id),
  UNIQUE (link_id, position)
);

CREATE INDEX IF NOT EXISTS share_link_items_order_idx ON share_link_items(link_id, position);
