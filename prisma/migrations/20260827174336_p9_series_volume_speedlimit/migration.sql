-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SeriesDocument" ADD VALUE 'DEBIT_NOTE';
ALTER TYPE "SeriesDocument" ADD VALUE 'PAYMENT';
ALTER TYPE "SeriesDocument" ADD VALUE 'VENDOR_PAYMENT';
ALTER TYPE "SeriesDocument" ADD VALUE 'SETTLEMENT';

-- AlterTable
ALTER TABLE "manifest" ADD COLUMN     "totalVolumeCft" DECIMAL(12,3) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "manifest_line" ADD COLUMN     "volumeCft" DECIMAL(10,3) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "vehicle_type" ADD COLUMN     "maxSpeedKmph" INTEGER;
