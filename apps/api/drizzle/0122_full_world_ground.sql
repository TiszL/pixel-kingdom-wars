-- Owner 2026-09-10: current terrain paints the whole surrounding world. Keep
-- frozen v1 and NULL historical contexts intact; no stored row is rewritten.
ALTER TABLE raids DROP CONSTRAINT raids_visual_context_valid;
--> statement-breakpoint
ALTER TABLE raids ADD CONSTRAINT raids_visual_context_valid CHECK (
  visual_context IS NULL OR (
    jsonb_typeof(visual_context) = 'object'
    AND visual_context->'version' = '1'::jsonb
    AND visual_context->'artVersion' IN ('1'::jsonb, '2'::jsonb)
    AND visual_context->>'realmId' IN (
      'frostveil', 'elderwood', 'sunscar', 'crownlands', 'seeker-reach',
      'stormcairn', 'thornwake', 'cinderfall'
    )
  ) IS TRUE
);
