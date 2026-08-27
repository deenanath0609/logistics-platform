-- AlterTable
ALTER TABLE "shipment" ADD COLUMN     "bookedByCustomerUserId" TEXT;

-- AlterTable
ALTER TABLE "shipment_event" ADD COLUMN     "customerUserId" TEXT;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_bookedByCustomerUserId_fkey" FOREIGN KEY ("bookedByCustomerUserId") REFERENCES "customer_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_event" ADD CONSTRAINT "shipment_event_customerUserId_fkey" FOREIGN KEY ("customerUserId") REFERENCES "customer_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
