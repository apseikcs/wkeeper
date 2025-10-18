/*
  Warnings:

  - You are about to drop the column `assignedAt` on the `tool` table. All the data in the column will be lost.
  - You are about to drop the column `assignedToId` on the `tool` table. All the data in the column will be lost.

*/
-- CreateTable
CREATE TABLE "ToolAssignment" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "toolId" INTEGER NOT NULL,
    "workerId" INTEGER NOT NULL,
    "assignedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "returnedAt" DATETIME,
    CONSTRAINT "ToolAssignment_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "tool" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ToolAssignment_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "worker" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_tool" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'available',
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_tool" ("createdAt", "id", "name", "status") SELECT "createdAt", "id", "name", "status" FROM "tool";
DROP TABLE "tool";
ALTER TABLE "new_tool" RENAME TO "tool";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ToolAssignment_toolId_idx" ON "ToolAssignment"("toolId");

-- CreateIndex
CREATE INDEX "ToolAssignment_workerId_idx" ON "ToolAssignment"("workerId");
