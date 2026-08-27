-- Routines now exist for both workspaces.
--
-- Every column added here is nullable or defaulted, so every row written
-- before this migration keeps meaning exactly what it meant: a note routine
-- with no saved sampling.
ALTER TABLE "PromptTemplate" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'note';
ALTER TABLE "PromptTemplate" ADD COLUMN "systemInstruction" TEXT;
ALTER TABLE "PromptTemplate" ADD COLUMN "temperature" DOUBLE PRECISION;
ALTER TABLE "PromptTemplate" ADD COLUMN "topP" DOUBLE PRECISION;
ALTER TABLE "PromptTemplate" ADD COLUMN "topK" INTEGER;
ALTER TABLE "PromptTemplate" ADD COLUMN "maxTokens" INTEGER;

CREATE INDEX "PromptTemplate_kind_idx" ON "PromptTemplate"("kind");
