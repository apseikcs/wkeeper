-- AlterTable
ALTER TABLE "public"."User" ADD COLUMN     "permissions" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "role" TEXT NOT NULL DEFAULT 'worker';

-- AlterTable
ALTER TABLE "public"."transaction" ADD COLUMN     "authorId" INTEGER;

-- AddForeignKey
ALTER TABLE "public"."transaction" ADD CONSTRAINT "transaction_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
