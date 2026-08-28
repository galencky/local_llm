-- Scope observed model availability to the Google quota it was observed against.
--
-- A refusal is a fact about ONE allowance, not about the model. With a global
-- table, one clinician exhausting gemini-3.7-flash greyed it out for everybody
-- on the instance — and the row survived a restart to keep doing so. Now that a
-- clinician can bring their own key, that is no longer merely wrong, it is
-- wrong in a way that costs other people their working models.
--
-- Existing rows were all observed against this deployment's own GEMINI_API_KEY,
-- which is exactly what the default names, so the backfill is the default.
ALTER TABLE "ModelCooldown" ADD COLUMN "quota" TEXT NOT NULL DEFAULT 'instance';

ALTER TABLE "ModelCooldown" DROP CONSTRAINT "ModelCooldown_pkey";
ALTER TABLE "ModelCooldown" ADD CONSTRAINT "ModelCooldown_pkey" PRIMARY KEY ("quota", "model");
