-- 消息撤回：保留占位行，不返回原文；与 deleted_at（双向删除，彻底消失）语义不同。
ALTER TABLE messages ADD COLUMN recalled_at TEXT;
ALTER TABLE messages ADD COLUMN recalled_by INTEGER;

-- 好友备注按「我的视角」存储：只影响自己对对方的显示名，互不可见。
CREATE TABLE IF NOT EXISTS contact_aliases (
  owner_id INTEGER NOT NULL,
  contact_id INTEGER NOT NULL,
  alias TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_id, contact_id),
  CHECK (owner_id != contact_id),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (contact_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_contact_aliases_contact
  ON contact_aliases(contact_id, owner_id);
