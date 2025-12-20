-- CreateIndex
CREATE INDEX "product_nameNormalized_idx" ON "public"."product"("nameNormalized");

-- CreateIndex
CREATE INDEX "transaction_date_idx" ON "public"."transaction"("date");

-- CreateIndex
CREATE INDEX "transaction_supplierId_idx" ON "public"."transaction"("supplierId");
