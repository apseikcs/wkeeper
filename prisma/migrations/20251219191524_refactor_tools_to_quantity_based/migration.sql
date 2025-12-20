/*
  Warnings:

  - You are about to drop the column `status` on the `tool` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "public"."ToolAssignment" DROP CONSTRAINT "ToolAssignment_toolId_fkey";

-- DropForeignKey
ALTER TABLE "public"."ToolAssignment" DROP CONSTRAINT "ToolAssignment_workerId_fkey";

-- AlterTable
ALTER TABLE "public"."ToolAssignment" ADD COLUMN     "quantity" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "public"."tool" DROP COLUMN "status",
ADD COLUMN     "availableQuantity" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "totalQuantity" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AddForeignKey
ALTER TABLE "public"."ToolAssignment" ADD CONSTRAINT "ToolAssignment_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "public"."tool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ToolAssignment" ADD CONSTRAINT "ToolAssignment_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "public"."worker"("id") ON DELETE CASCADE ON UPDATE CASCADE;
