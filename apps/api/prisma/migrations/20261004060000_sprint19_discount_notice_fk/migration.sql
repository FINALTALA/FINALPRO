-- Sprint 19 review-round fix: discount_activation_notices.outboxEventId
-- was a plain column with no real foreign key, unlike every other
-- Sprint 19 table that references outbox_events (notifications,
-- outbox_delivery_targets both have one). The table was introduced in
-- this same sprint, so there is no pre-existing data that could violate
-- the constraint - no backfill needed, a direct ADD CONSTRAINT is safe.
ALTER TABLE "discount_activation_notices" ADD CONSTRAINT "discount_activation_notices_outboxEventId_fkey" FOREIGN KEY ("outboxEventId") REFERENCES "outbox_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
