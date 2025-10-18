-- Create schemas with deleted flags from start
CREATE TABLE "product" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "nameNormalized" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL CHECK ("quantity" >= 0 AND "quantity" <= 65535),
    "sku" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "product_nameNormalized_key" ON "product"("nameNormalized");

CREATE TABLE "worker" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "fullName" TEXT NOT NULL,
    "phone" TEXT,
    "position" TEXT,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "supplier" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "supplier_name_key" ON "supplier"("name");

CREATE TABLE "location" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "city" TEXT,
    "district" TEXT,
    "address" TEXT,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "location_name_key" ON "location"("name");

CREATE TABLE "transaction" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "productName" TEXT NOT NULL,
    "productId" INTEGER,
    "delta" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "date" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supplierName" TEXT,
    "destinationName" TEXT,
    "supplierId" INTEGER,
    "destinationId" INTEGER,
    "workerId" INTEGER,
    "note" TEXT,
    FOREIGN KEY ("productId") REFERENCES "product" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    FOREIGN KEY ("supplierId") REFERENCES "supplier" ("id") ON DELETE SET NULL ON UPDATE CASCADE, 
    FOREIGN KEY ("destinationId") REFERENCES "location" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    FOREIGN KEY ("workerId") REFERENCES "worker" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "tool" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'not_assigned',
    "assignedToId" INTEGER,
    "assignedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("assignedToId") REFERENCES "worker" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
