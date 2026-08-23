-- CreateTable
CREATE TABLE "ModelCooldown" (
    "model" TEXT NOT NULL,
    "until" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "daily" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelCooldown_pkey" PRIMARY KEY ("model")
);

-- CreateIndex
CREATE INDEX "ModelCooldown_until_idx" ON "ModelCooldown"("until");

