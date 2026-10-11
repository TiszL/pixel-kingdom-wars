-- Owner 2026-09-16: append six sequential expansions through 50×50.
-- Mirrors CAPS.expansionsMax. Preserve every existing row, coordinate and quote;
-- widening this constraint does not grant any land or change a paid receipt.
ALTER TABLE "bases"
  DROP CONSTRAINT "bases_expansions_ck",
  ADD CONSTRAINT "bases_expansions_ck" CHECK ("expansions" BETWEEN 0 AND 12);
