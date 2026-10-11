-- D-128: freeze presentation separately from the byte-stable simulator input.
-- Historical rows deliberately stay NULL and render as Crownlands. No replay
-- envelope or archived snapshot is rewritten by this migration.
ALTER TABLE raids ADD COLUMN visual_context jsonb;
--> statement-breakpoint
ALTER TABLE raids ADD CONSTRAINT raids_visual_context_valid CHECK (
  visual_context IS NULL OR (
    jsonb_typeof(visual_context) = 'object'
    AND visual_context->'version' = '1'::jsonb
    AND visual_context->'artVersion' = '1'::jsonb
    AND visual_context->>'realmId' IN (
      'frostveil', 'elderwood', 'sunscar', 'crownlands', 'seeker-reach',
      'stormcairn', 'thornwake', 'cinderfall'
    )
  ) IS TRUE
);
