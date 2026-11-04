-- 0006 Phase C integration: what counts against the monthly purchase limit.
--
-- 0005's committed_purchases counted orders only. A paid booking is checked against the
-- limit when it is booked (booking.book declares a purchase), so it must also count towards
-- the month's committed amount; otherwise any number of paid bookings could each pass the
-- limit check. Bookings count while submitting (in flight), confirmed, or unknown (an unknown
-- booking may have been made — conservative, as for orders). Free bookings (no price) never
-- count.
--
-- Two columns are added at the end (CREATE OR REPLACE VIEW may only append):
--   kind     'order' | 'booking'
--   step_id  the task step that committed it, so an acknowledged retry of that very step
--            (reconciling an unknown order) does not count its own row twice
--            (agent/context.ts stepCommittedSpend).
-- security_invoker stays on: RLS of orders and bookings applies to the caller.

CREATE OR REPLACE VIEW committed_purchases WITH (security_invoker = true) AS
  SELECT o.user_id, o.currency, o.total_micro, o.created_at, o.status,
         'order'::text AS kind, o.step_id
    FROM orders o
   WHERE o.status IN ('submitting', 'placed', 'unknown')
  UNION ALL
  SELECT b.user_id, b.price_currency AS currency, b.price_micro AS total_micro, b.created_at,
         b.status, 'booking'::text AS kind, b.step_id
    FROM bookings b
   WHERE b.price_micro IS NOT NULL
     AND b.price_micro > 0
     AND b.status IN ('submitting', 'confirmed', 'unknown');
