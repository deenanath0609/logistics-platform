-- E-commerce last mile becomes a service mode of its own.
--
-- Not folded into COURIER: the process differs where it counts. COD sits on
-- most consignments rather than a few, RTO and reverse pickup are ordinary
-- outcomes instead of exceptions, and the seller manifests in bulk rather
-- than booking one consignment at a time. A carrier selling only this needs
-- a different set of modules from one selling parcel courier.
ALTER TYPE "ShipmentMode" ADD VALUE IF NOT EXISTS 'ECOMMERCE';
