import { Prisma } from '../../generated/prisma/client';

export interface LockedStock {
  id: string;
  quantity: number;
  reservedQuantity: number;
}

export interface StockKey {
  vendorId: string;
  branchId: string;
  offerVariantId: string;
}

export interface WindowDateKey {
  deliveryWindowId: string;
  scheduledDate: Date;
}

/**
 * Codex review round 3 on commit 3d81c9b (fix #3): locks a single
 * CheckoutReservation row by id, existence-tolerant (a reservation a
 * concurrent cancel()/confirm() already fully deleted simply matches
 * zero rows - not an error, just nothing left to lock or act on).
 * Exported so every caller that needs to hold this lock (the sweep
 * below, cancelReservation(), confirm()) takes it the exact same way.
 */
export async function lockReservationRowIfExists(
  tx: Prisma.TransactionClient,
  reservationId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM checkout_reservations WHERE id = ${reservationId} FOR UPDATE`;
  return rows.length > 0;
}

/**
 * Codex review round 4 on commit 95a8430: locks a whole SET of
 * CheckoutReservation rows in one sorted pass - the shared primitive
 * every multi-resource lock plan (reserve()'s batch sweep below) uses
 * to take its position-1 locks before touching anything else.
 */
export async function lockReservationRowsSorted(
  tx: Prisma.TransactionClient,
  reservationIds: string[],
): Promise<void> {
  const sorted = [...new Set(reservationIds)].sort();
  for (const id of sorted) {
    await lockReservationRowIfExists(tx, id);
  }
}

/**
 * Codex review round 4 on commit 95a8430 (fix #1): a read-only,
 * batched scan across MULTIPLE stock keys at once - finds every
 * distinct reservationId with an expired item on ANY of them, in a
 * single query, so a caller that will touch several stock rows (only
 * reserve() does) can determine its FULL reservation-lock set up front
 * instead of discovering (and locking) reservations one stock row at a
 * time. Discovering and locking incrementally, per row, is exactly
 * what let a global lock-order invariant get violated in round 3: two
 * different resource "batches" could each hold a lock the other one
 * was still waiting for.
 */
export async function findExpiredReservationIdsForStockKeys(
  tx: Prisma.TransactionClient,
  keys: StockKey[],
): Promise<string[]> {
  if (keys.length === 0) return [];
  const rows = await tx.checkoutReservationItem.findMany({
    where: {
      OR: keys.map((k) => ({
        vendorId: k.vendorId,
        branchId: k.branchId,
        offerVariantId: k.offerVariantId,
      })),
      reservation: { expiresAt: { lt: new Date() } },
    },
    select: { reservationId: true },
  });
  return [...new Set(rows.map((r) => r.reservationId))];
}

/**
 * Codex review round 4 on commit 95a8430 (fix #1): the same batched,
 * read-only discovery as findExpiredReservationIdsForStockKeys above,
 * but for expired CheckoutReservationSlot rows on the (window, date)
 * pairs a DELIVERY checkout will touch - reserve()'s lock plan must
 * include these too, or a slot-expiry cleanup taken after the window
 * lock (see reserveDeliverySlotAlreadyLocked) could still race an
 * un-locked reservation the same way stock rows could.
 */
export async function findExpiredReservationIdsForWindowKeys(
  tx: Prisma.TransactionClient,
  keys: WindowDateKey[],
): Promise<string[]> {
  if (keys.length === 0) return [];
  const rows = await tx.checkoutReservationSlot.findMany({
    where: {
      OR: keys.map((k) => ({
        deliveryWindowId: k.deliveryWindowId,
        scheduledDate: k.scheduledDate,
      })),
      reservation: { expiresAt: { lt: new Date() } },
    },
    select: { reservationId: true },
  });
  return [...new Set(rows.map((r) => r.reservationId))];
}

/**
 * Codex review round 2 on commit d0ea80d: the ONE place that locks a
 * BranchStock row AND sweeps its expired reservation holds - every
 * writer of `quantity`/`reservedQuantity` (checkout reserve, checkout
 * confirm's real decrement, InventoryController's POS/manual-movement
 * decrement) must call this first, or expiry stays "lazy" in name only
 * for whichever path skips it (the exact bug flagged in review: a
 * hold that nobody re-reserves against never gets swept, so it keeps
 * blocking POS/other reservations indefinitely).
 *
 * Codex review round 4 on commit 95a8430 (fix #1): the row-lock-then-
 * sweep work is now split in two. This function is the STANDALONE
 * entry point - used only by InventoryController's POS/manual-movement
 * path, which only ever touches ONE stock row per call, so discovering
 * and locking its own (small) reservation set right here is still
 * globally safe (reservation-row lock, then this one stock row -
 * nothing else in this transaction needs any other resource type).
 * reserve() - which may touch SEVERAL stock rows in one transaction -
 * must NOT use this; it needs its full reservation-lock set determined
 * and acquired up front, across every stock/window key it will touch,
 * before locking any of them (see
 * lockAndSweepStockRowAssumingReservationsLocked below).
 */
export async function lockAndSweepStockRow(
  tx: Prisma.TransactionClient,
  vendorId: string,
  branchId: string,
  offerVariantId: string,
): Promise<LockedStock | null> {
  const reservationIds = (
    await findExpiredReservationIdsForStockKeys(tx, [
      { vendorId, branchId, offerVariantId },
    ])
  ).sort();
  await lockReservationRowsSorted(tx, reservationIds);
  return lockAndSweepStockRowAssumingReservationsLocked(
    tx,
    vendorId,
    branchId,
    offerVariantId,
    reservationIds,
  );
}

/**
 * Codex review round 4 on commit 95a8430 (fix #1): locks and sweeps
 * ONE stock row, but assumes the caller ALREADY holds a lock on every
 * reservation row that might have an expired item on it (passed in as
 * `lockedReservationIds`) - no reservation discovery or locking happens
 * here. This is what reserve() uses, once per stock key in its own
 * canonical order, AFTER it has already locked its FULL, pre-computed
 * reservation-lock set (see reserve()'s own comment for the full lock
 * plan: reservations, then vendors, then stock, then windows).
 */
export async function lockAndSweepStockRowAssumingReservationsLocked(
  tx: Prisma.TransactionClient,
  vendorId: string,
  branchId: string,
  offerVariantId: string,
  lockedReservationIds: string[],
): Promise<LockedStock | null> {
  const rows = await tx.$queryRaw<LockedStock[]>`
    SELECT id, quantity, "reservedQuantity" FROM branch_stock
    WHERE "vendorId" = ${vendorId} AND "branchId" = ${branchId} AND "offerVariantId" = ${offerVariantId}
    FOR UPDATE`;
  const stock = rows[0];
  if (!stock) return null;
  if (lockedReservationIds.length === 0) return stock;

  // Re-read now that both the reservation row(s) and this stock row
  // are locked - a concurrent cancelReservation()/confirm() this call
  // just waited behind may have already deleted some (or all) of
  // these items (CheckoutReservationItem cascades away with its
  // CheckoutReservation), in which case they are correctly no longer
  // "expired items to sweep" - already gone, accounted for by
  // whichever side got there first. Only ids we actually hold a lock
  // on are ever considered here.
  const expired = await tx.checkoutReservationItem.findMany({
    where: {
      vendorId,
      branchId,
      offerVariantId,
      reservationId: { in: lockedReservationIds },
      reservation: { expiresAt: { lt: new Date() } },
    },
  });
  if (expired.length === 0) return stock;

  const releasedQty = expired.reduce((sum, e) => sum + e.quantity, 0);
  await tx.checkoutReservationItem.deleteMany({
    where: { id: { in: expired.map((e) => e.id) } },
  });
  await tx.branchStock.update({
    where: { id: stock.id },
    data: { reservedQuantity: { decrement: releasedQty } },
  });
  return { ...stock, reservedQuantity: stock.reservedQuantity - releasedQty };
}

/**
 * Sprint 21b (EPIC-RET, review-round lock-order fix): the multi-key
 * sibling of lockSweepOrCreateStockRow below - for a caller (only
 * fulfillExchange()) that must touch SEVERAL stock keys in one
 * transaction. Calling the single-key, standalone primitive once per
 * key sequentially is exactly the bug the round-4 comment on
 * findExpiredReservationIdsForStockKeys warns about: each call would
 * independently discover-and-lock its OWN reservation set, so two
 * concurrent multi-key callers touching the same two keys in opposite
 * orders could each hold one key's reservation lock while waiting on
 * the other's - a real deadlock risk, not merely a style preference.
 *
 * Lock order here matches reserve()'s own established plan: every
 * key's advisory creation lock first (sorted), THEN the full
 * reservation-lock set for ALL keys combined (one batched discovery,
 * one sorted lock pass), THEN each stock row in sorted order via
 * lockAndSweepStockRowAssumingReservationsLocked - never the
 * standalone single-key primitive, which would re-discover and
 * re-lock reservations per key and reintroduce the same hazard.
 */
export async function lockSweepOrCreateStockRowsSorted(
  tx: Prisma.TransactionClient,
  keys: StockKey[],
): Promise<Map<string, LockedStock>> {
  const sortKey = (k: StockKey) => `${k.branchId}:${k.offerVariantId}`;
  const uniqueKeys = [
    ...new Map(keys.map((k) => [sortKey(k), k])).values(),
  ].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

  for (const k of uniqueKeys) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('finalpro:branch_stock:' || ${k.branchId} || ':' || ${k.offerVariantId}))`;
  }

  const reservationIds = (
    await findExpiredReservationIdsForStockKeys(tx, uniqueKeys)
  ).sort();
  await lockReservationRowsSorted(tx, reservationIds);

  const result = new Map<string, LockedStock>();
  for (const k of uniqueKeys) {
    let locked = await lockAndSweepStockRowAssumingReservationsLocked(
      tx,
      k.vendorId,
      k.branchId,
      k.offerVariantId,
      reservationIds,
    );
    if (!locked) {
      await tx.branchStock.create({
        data: {
          vendorId: k.vendorId,
          branchId: k.branchId,
          offerVariantId: k.offerVariantId,
          quantity: 0,
        },
      });
      locked = await lockAndSweepStockRowAssumingReservationsLocked(
        tx,
        k.vendorId,
        k.branchId,
        k.offerVariantId,
        reservationIds,
      );
      if (!locked) {
        throw new Error(
          'unreachable: branch_stock row created above was not found immediately after',
        );
      }
    }
    result.set(sortKey(k), locked);
  }
  return result;
}

/**
 * Sprint 21b (EPIC-RET, PDR §3.5's exchange reservation): the exchange
 * module's own stock entry point - built on lockAndSweepStockRow
 * (never a parallel, weaker lock), because a plain FOR UPDATE alone
 * would not sweep a stale checkout hold first and could reject an
 * exchange approval with a false "not enough stock" (the exact bug
 * flagged in the review round that asked for this). The ONE thing
 * lockAndSweepStockRow doesn't do - create the row if it doesn't exist
 * yet - is exactly what a RESELLABLE exchange's returned-item leg
 * needs (the receiving branch may never have sold this variant
 * before). The advisory lock (same key convention as returns.service
 * .ts's own incrementBranchStockWithLock) serializes two concurrent
 * creators for the same (branchId, offerVariantId) before either one
 * even looks for the row.
 *
 * Single-key only: safe for approveReturn()'s exchange-reservation
 * step and the sweep's own release (each touches exactly one stock
 * key per transaction). A caller touching MORE than one stock key in
 * the same transaction (only fulfillExchange()) must use
 * lockSweepOrCreateStockRowsSorted above instead, never this one per
 * key in a loop - see that function's own comment for why.
 */
export async function lockSweepOrCreateStockRow(
  tx: Prisma.TransactionClient,
  vendorId: string,
  branchId: string,
  offerVariantId: string,
): Promise<LockedStock> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('finalpro:branch_stock:' || ${branchId} || ':' || ${offerVariantId}))`;
  const existing = await lockAndSweepStockRow(
    tx,
    vendorId,
    branchId,
    offerVariantId,
  );
  if (existing) return existing;

  await tx.branchStock.create({
    data: { vendorId, branchId, offerVariantId, quantity: 0 },
  });
  // Re-locked via the same call: the row now exists, and no checkout
  // reservation could possibly reference a row that didn't exist a
  // moment ago, so the sweep here is a guaranteed no-op - this just
  // reuses the one function rather than hand-rolling a second raw
  // SELECT ... FOR UPDATE.
  const created = await lockAndSweepStockRow(
    tx,
    vendorId,
    branchId,
    offerVariantId,
  );
  if (!created) {
    throw new Error(
      'unreachable: branch_stock row created above was not found immediately after',
    );
  }
  return created;
}

/**
 * Sprint 24 (FR-FAV-004): one entry in a lockOffersWideForRestock()
 * batch. Every mutation's own (branchId, offerVariantId) is a REAL
 * write - the branch whose stock is actually changing by
 * `quantityDelta` (positive = increase, negative = decrease). `
 * siblingBranchIds`, when present, marks this mutation as
 * restock-alert-eligible: every OTHER active, non-archived physical
 * branch of this vendor that also carries this offerVariant, read-only,
 * used solely to compute the offer-wide BEFORE/AFTER total. A plain
 * decrease (e.g. an exchange replacement hand-over) omits
 * `siblingBranchIds` entirely - it still gets the full sweep-then-write
 * treatment below, it just never contributes to or triggers a
 * back-in-stock alert.
 */
export interface RestockMutation {
  vendorId: string;
  branchId: string;
  offerVariantId: string;
  quantityDelta: number;
  /** Optional - applied alongside quantityDelta in the SAME update,
   * for a write that also needs to release/take a reservation hold
   * NOT tracked via CheckoutReservationItem (e.g. an exchange's own
   * approval-time reservedQuantity bracket - see fulfillExchange()).
   * Independent of the expired-reservation sweep below, which always
   * runs regardless and is folded into the same final write. */
  reservedQuantityDelta?: number;
  siblingBranchIds?: string[];
}

export interface RestockMutationResult {
  targetStock: LockedStock;
  /** Only set when this mutation carried `siblingBranchIds`. */
  before?: number;
  after?: number;
}

function offerKey(branchId: string, offerVariantId: string): string {
  return `${branchId}:${offerVariantId}`;
}

/**
 * Sprint 24 (FR-FAV-004, four correction rounds to get this right -
 * see the plan's own §6 history if this ever needs re-deriving):
 * the ONE primitive every quantity-increasing writer (manual/POS
 * movement, regular-return restock, exchange's RESELLABLE-original-
 * item leg, order-cancellation's stock restore) and every quantity-
 * decreasing writer that shares a transaction with one of those
 * (exchange's replacement hand-over) goes through, batched across
 * every offerVariant the transaction touches - never sequential
 * per-offer calls, which would reopen the exact AB-BA lock-order
 * deadlock S21b's own round-1 fix already had to close once
 * (operation A locking offers [X, Y] while operation B locks [Y, X]).
 *
 * Deliberately NOT built on lockSweepOrCreateStockRowsSorted: that
 * primitive materializes a `quantity: 0` row for every key it's given
 * that doesn't already exist - correct for its own callers (which
 * only ever pass keys they're about to legitimately write), wrong
 * here, where `siblingBranchIds` are read-only inputs used purely to
 * compute a total. A restock in one branch must never create phantom
 * zero-stock rows in every OTHER branch just because an alert decision
 * needed to read their current totals.
 *
 * Lock order, matching this file's own established sequence exactly
 * (advisory locks -> expired-reservation discovery -> reservation
 * locks -> stock-row locks), batched across the FULL set this call
 * touches rather than per-mutation:
 *   1. Union of every mutation's own TARGET key plus every
 *      alert-eligible mutation's SIBLING keys, deduped, sorted once by
 *      the same global `branchId:offerVariantId` order every other
 *      primitive in this file uses. This single combined sort is what
 *      actually neutralizes caller order as a deadlock vector - two
 *      transactions passing the same offers in opposite literal order
 *      still acquire locks in the identical sequence.
 *   2. pg_advisory_xact_lock for every key in that one order.
 *   3. Expired-reservation discovery for every MUTATION TARGET key
 *      (never sibling keys - nothing is ever swept on a branch this
 *      call isn't writing to) - one batched call.
 *   4. lockReservationRowsSorted() on the discovered ids.
 *   5. FOR UPDATE on every row that actually EXISTS across the full
 *      union - sibling keys read-only (contribute to BEFORE, nothing
 *      else), target keys get the real sweep-then-delta treatment
 *      every pre-existing single-key writer already got (this is what
 *      preserves exchange's own replacement-leg sweep behavior - a
 *      decreasing mutation is swept exactly as before, just inside
 *      this batched pass instead of its own standalone call).
 *
 * BEFORE/AFTER are computed only for alert-eligible mutations, from
 * the one consistent pre-write snapshot taken in step 5 - never
 * re-queried mid-loop.
 *
 * Review-round fix: two mutations in the same batch sharing a target
 * key are normalized (merged) BEFORE any lock is taken, never left to
 * `results.set()`'s own last-write-wins overwrite (which previously
 * could compute `reservedQuantity` off the pre-loop snapshot a second
 * time, silently discarding the first mutation's own write) - see the
 * normalization step below. This never depends on any caller already
 * de-duplicating its own mutation list.
 *
 * Review-round fix: the step-5 `FOR UPDATE` now carries an explicit
 * `ORDER BY "branchId", "offerVariantId"` matching the exact same
 * global order the advisory-lock loop already uses - row-lock
 * acquisition order was previously left to Postgres's own unspecified
 * scan order for that one multi-row statement, which is not
 * guaranteed to agree with the advisory-lock order and could in
 * principle still deadlock two batches touching an overlapping key
 * set in reversed order, defeating the whole point of the advisory
 * pre-pass. The two must match exactly, explicitly, not by accident.
 */
export async function lockOffersWideForRestock(
  tx: Prisma.TransactionClient,
  mutations: RestockMutation[],
): Promise<Map<string, RestockMutationResult>> {
  // Normalize: two mutations targeting the SAME (branchId,
  // offerVariantId) are merged into one before anything else happens -
  // quantityDelta/reservedQuantityDelta summed, siblingBranchIds
  // unioned (so the merged mutation stays alert-eligible if ANY of its
  // sources was) - never silently processed twice against a stale
  // snapshot, and never assumed away as "not a real scenario."
  const mergedByKey = new Map<string, RestockMutation>();
  for (const m of mutations) {
    const key = offerKey(m.branchId, m.offerVariantId);
    const existing = mergedByKey.get(key);
    if (!existing) {
      mergedByKey.set(key, { ...m });
      continue;
    }
    if (existing.vendorId !== m.vendorId) {
      throw new Error(
        `lockOffersWideForRestock: conflicting vendorId for the same target key (${key})`,
      );
    }
    existing.quantityDelta += m.quantityDelta;
    existing.reservedQuantityDelta =
      (existing.reservedQuantityDelta ?? 0) + (m.reservedQuantityDelta ?? 0);
    if (m.siblingBranchIds) {
      existing.siblingBranchIds = [
        ...new Set([
          ...(existing.siblingBranchIds ?? []),
          ...m.siblingBranchIds,
        ]),
      ];
    }
  }
  const normalizedMutations = [...mergedByKey.values()];

  interface KeyInfo {
    branchId: string;
    offerVariantId: string;
  }
  const allKeysMap = new Map<string, KeyInfo>();
  for (const m of normalizedMutations) {
    allKeysMap.set(offerKey(m.branchId, m.offerVariantId), {
      branchId: m.branchId,
      offerVariantId: m.offerVariantId,
    });
    for (const sib of m.siblingBranchIds ?? []) {
      allKeysMap.set(offerKey(sib, m.offerVariantId), {
        branchId: sib,
        offerVariantId: m.offerVariantId,
      });
    }
  }
  const allKeys = [...allKeysMap.values()].sort((a, b) =>
    offerKey(a.branchId, a.offerVariantId).localeCompare(
      offerKey(b.branchId, b.offerVariantId),
    ),
  );

  // Step 1-2: advisory locks for the full union, sorted.
  for (const k of allKeys) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('finalpro:branch_stock:' || ${k.branchId} || ':' || ${k.offerVariantId}))`;
  }

  // Step 3-4: expired-reservation discovery + lock, for every
  // MUTATION TARGET key only - never sibling keys.
  const targetKeys: StockKey[] = normalizedMutations.map((m) => ({
    vendorId: m.vendorId,
    branchId: m.branchId,
    offerVariantId: m.offerVariantId,
  }));
  const reservationIds = (
    await findExpiredReservationIdsForStockKeys(tx, targetKeys)
  ).sort();
  await lockReservationRowsSorted(tx, reservationIds);

  // Step 5: FOR UPDATE on every EXISTING row across the full union -
  // one query, never a per-key loop (which would re-open the exact
  // per-key-discovery hazard this file's own round-4 comment already
  // warns about elsewhere) - with an explicit ORDER BY matching the
  // advisory-lock order exactly, so Postgres's own row-lock
  // acquisition order is never left unspecified.
  const pairs = allKeys.map(
    (k) => Prisma.sql`(${k.branchId}, ${k.offerVariantId})`,
  );
  const existingRows = await tx.$queryRaw<
    {
      id: string;
      branchId: string;
      offerVariantId: string;
      quantity: number;
      reservedQuantity: number;
    }[]
  >`
    SELECT id, "branchId", "offerVariantId", quantity, "reservedQuantity"
    FROM branch_stock
    WHERE ("branchId", "offerVariantId") IN (${Prisma.join(pairs)})
    ORDER BY "branchId", "offerVariantId"
    FOR UPDATE
  `;
  const existingByKey = new Map(
    existingRows.map((r) => [offerKey(r.branchId, r.offerVariantId), r]),
  );

  const results = new Map<string, RestockMutationResult>();
  for (const m of normalizedMutations) {
    const tKey = offerKey(m.branchId, m.offerVariantId);
    const existingTarget = existingByKey.get(tKey);

    let before: number | undefined;
    if (m.siblingBranchIds) {
      before = existingTarget?.quantity ?? 0;
      for (const sib of m.siblingBranchIds) {
        before +=
          existingByKey.get(offerKey(sib, m.offerVariantId))?.quantity ?? 0;
      }
    }

    let targetStock: LockedStock;
    if (existingTarget) {
      // Sweep: release whichever already-locked reservation(s) had an
      // expired item on THIS specific target key - same release logic
      // as lockAndSweepStockRowAssumingReservationsLocked, just reading
      // from the reservation locks this batch already took above
      // instead of taking its own.
      const expiredHere = await tx.checkoutReservationItem.findMany({
        where: {
          vendorId: m.vendorId,
          branchId: m.branchId,
          offerVariantId: m.offerVariantId,
          reservationId: { in: reservationIds },
          reservation: { expiresAt: { lt: new Date() } },
        },
      });
      let reservedQuantity = existingTarget.reservedQuantity;
      if (expiredHere.length > 0) {
        const releasedQty = expiredHere.reduce((sum, e) => sum + e.quantity, 0);
        await tx.checkoutReservationItem.deleteMany({
          where: { id: { in: expiredHere.map((e) => e.id) } },
        });
        reservedQuantity -= releasedQty;
      }
      // Folded into ONE final update with the sweep's own adjustment
      // (if any) above - never two separate writes to reservedQuantity,
      // which would risk the second overwriting the first.
      reservedQuantity += m.reservedQuantityDelta ?? 0;
      await tx.branchStock.update({
        where: { id: existingTarget.id },
        data: {
          quantity: { increment: m.quantityDelta },
          reservedQuantity,
        },
      });
      targetStock = {
        id: existingTarget.id,
        quantity: existingTarget.quantity + m.quantityDelta,
        reservedQuantity,
      };
    } else {
      if (m.quantityDelta < 0) {
        throw new Error(
          `lockOffersWideForRestock: cannot decrement a nonexistent branch_stock row (${tKey})`,
        );
      }
      const created = await tx.branchStock.create({
        data: {
          vendorId: m.vendorId,
          branchId: m.branchId,
          offerVariantId: m.offerVariantId,
          quantity: m.quantityDelta,
        },
      });
      targetStock = {
        id: created.id,
        quantity: created.quantity,
        reservedQuantity: 0,
      };
    }

    let after: number | undefined;
    if (m.siblingBranchIds) {
      after =
        (before ?? 0) - (existingTarget?.quantity ?? 0) + targetStock.quantity;
    }

    results.set(tKey, { targetStock, before, after });
  }

  return results;
}

/** Single-mutation wrapper over lockOffersWideForRestock() - for the
 * two call sites that only ever touch one offerVariant per transaction
 * (plain manual/POS movement, plain regular-return restock). No
 * duplicated logic - just a one-element batch. */
export async function lockOfferWideForRestock(
  tx: Prisma.TransactionClient,
  mutation: RestockMutation,
): Promise<RestockMutationResult> {
  const results = await lockOffersWideForRestock(tx, [mutation]);
  return results.get(offerKey(mutation.branchId, mutation.offerVariantId))!;
}
