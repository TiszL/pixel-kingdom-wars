ALTER TABLE global_chat_messages ADD COLUMN mentions jsonb NOT NULL DEFAULT '[]'::jsonb;
