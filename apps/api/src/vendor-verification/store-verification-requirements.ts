import { Prisma } from '../../generated/prisma/client';

/**
 * VIA Control Center phase 2A: the ONE evaluation of what a store's
 * verification still needs, shared by the branch-evidence and the
 * warehouse-evidence services (each still owns its own evidence type's
 * decision and record - this only reads), the reviewer's evidence
 * details, and the storefront publish gate.
 *
 * What a store type needs (PDR-035 + the approved HYBRID lifecycle):
 *  - PHYSICAL:    every non-archived physical branch APPROVED, and at
 *                 least one of them.
 *  - ONLINE_ONLY: the latest warehouse evidence APPROVED.
 *  - HYBRID:      both of the above.
 *
 * During the initial review (vendor UNDER_REVIEW) the vendor becomes
 * APPROVED only once `complete` is true - checked by the deciding
 * service under the vendor row lock, in the same transaction as its own
 * decision, so two decisions on the two evidence types can never both
 * read the other as unfinished. Approval is still NOT activation: the
 * owner activates the trial (APPROVED -> ACTIVE) and publishes the
 * storefront separately, as before.
 */

export type RequirementState =
  | 'APPROVED'
  | 'PENDING_REVIEW'
  | 'AWAITING_SUBMISSION'
  | 'RESUBMISSION_REQUESTED'
  | 'REJECTED';

export interface BranchRequirement {
  branch_id: string;
  name: string;
  state: RequirementState;
}

export interface WarehouseRequirement {
  /** The latest evidence row, or null when nothing was ever submitted. */
  evidence_id: string | null;
  state: RequirementState;
}

/**
 * What happens next for this store, outside any approval count:
 *  - REVIEW: a reviewer has evidence to decide;
 *  - OWNER_SUBMISSION: the owner must submit or resubmit evidence;
 *  - OWNER_ACTIVATION: verification is done, the owner activates the trial;
 *  - NONE: nothing outstanding;
 *  - CLOSED: the application is closed (rejected/cancelled/suspended).
 */
export type VerificationNextStep =
  'REVIEW' | 'OWNER_SUBMISSION' | 'OWNER_ACTIVATION' | 'NONE' | 'CLOSED';

export interface StoreVerificationRequirements {
  vendor_id: string;
  vendor_status: string;
  store_type: string;
  physical_required: boolean;
  warehouse_required: boolean;
  /** Non-archived physical branches only - the ones that count. */
  branches: BranchRequirement[];
  warehouse: WarehouseRequirement | null;
  /** Every requirement of this store type is APPROVED. */
  complete: boolean;
  next_step: VerificationNextStep;
}

export function needsPhysicalVerification(storeType: string): boolean {
  return storeType === 'PHYSICAL' || storeType === 'HYBRID';
}

export function needsWarehouseVerification(storeType: string): boolean {
  return storeType === 'ONLINE_ONLY' || storeType === 'HYBRID';
}

function branchState(b: {
  verificationStatus: string;
  evidenceRevision: number;
  evidenceSubmittedAt: Date | null;
}): RequirementState {
  switch (b.verificationStatus) {
    case 'APPROVED':
      return 'APPROVED';
    case 'REJECTED':
      return 'REJECTED';
    case 'RESUBMISSION_REQUESTED':
      return 'RESUBMISSION_REQUESTED';
    default:
      return b.evidenceRevision >= 1 && b.evidenceSubmittedAt !== null
        ? 'PENDING_REVIEW'
        : 'AWAITING_SUBMISSION';
  }
}

function warehouseState(status: string | undefined): RequirementState {
  switch (status) {
    case 'APPROVED':
      return 'APPROVED';
    case 'REJECTED':
      return 'REJECTED';
    case 'RESUBMISSION_REQUESTED':
      // The decided row stays as history; the owner submits a new one.
      return 'RESUBMISSION_REQUESTED';
    case 'PENDING':
      return 'PENDING_REVIEW';
    default:
      return 'AWAITING_SUBMISSION';
  }
}

/** The latest warehouse evidence decides (same order as the storefront's
 * is_verified and the comparison badge). */
const LATEST_EVIDENCE_ORDER: Prisma.WarehouseVerificationEvidenceOrderByWithRelationInput[] =
  [{ submittedAt: 'desc' }, { id: 'desc' }];

export async function evaluateStoreVerification(
  db: Prisma.TransactionClient,
  vendorId: string,
): Promise<StoreVerificationRequirements> {
  const vendor = await db.vendor.findUniqueOrThrow({
    where: { id: vendorId },
    select: { id: true, status: true, storeType: true },
  });
  const physicalRequired = needsPhysicalVerification(vendor.storeType);
  const warehouseRequired = needsWarehouseVerification(vendor.storeType);

  const branches = physicalRequired
    ? (
        await db.storeBranch.findMany({
          where: { vendorId, isPhysical: true, archivedAt: null },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            name: true,
            verificationStatus: true,
            evidenceRevision: true,
            evidenceSubmittedAt: true,
          },
        })
      ).map((b) => ({ branch_id: b.id, name: b.name, state: branchState(b) }))
    : [];

  let warehouse: WarehouseRequirement | null = null;
  if (warehouseRequired) {
    const latest = await db.warehouseVerificationEvidence.findFirst({
      where: { vendorId },
      orderBy: LATEST_EVIDENCE_ORDER,
      select: { id: true, status: true },
    });
    warehouse = {
      evidence_id: latest?.id ?? null,
      state: warehouseState(latest?.status),
    };
  }

  const physicalOk =
    !physicalRequired ||
    (branches.length > 0 && branches.every((b) => b.state === 'APPROVED'));
  const warehouseOk = !warehouseRequired || warehouse?.state === 'APPROVED';
  const complete = physicalOk && warehouseOk;

  const states = [
    ...branches.map((b) => b.state),
    ...(warehouse ? [warehouse.state] : []),
  ];
  let nextStep: VerificationNextStep;
  if (['REJECTED', 'CANCELLED', 'SUSPENDED'].includes(vendor.status)) {
    nextStep = 'CLOSED';
  } else if (vendor.status === 'APPROVED') {
    nextStep = 'OWNER_ACTIVATION';
  } else if (states.includes('PENDING_REVIEW')) {
    nextStep = 'REVIEW';
  } else if (vendor.status === 'ACTIVE') {
    // A late branch waiting for its owner, or nothing outstanding.
    nextStep = states.some(
      (s) => s === 'AWAITING_SUBMISSION' || s === 'RESUBMISSION_REQUESTED',
    )
      ? 'OWNER_SUBMISSION'
      : 'NONE';
  } else {
    nextStep = complete ? 'NONE' : 'OWNER_SUBMISSION';
  }

  return {
    vendor_id: vendor.id,
    vendor_status: vendor.status,
    store_type: vendor.storeType,
    physical_required: physicalRequired,
    warehouse_required: warehouseRequired,
    branches,
    warehouse,
    complete,
    next_step: nextStep,
  };
}

/**
 * Vendors (of those given) whose LATEST warehouse evidence is APPROVED.
 * This is what verifies a store's non-physical branches: they cannot
 * carry branch evidence (BRANCH_NOT_PHYSICAL), so no branch decision
 * can ever approve them - the warehouse review is their verification.
 */
export async function warehouseApprovedVendorIds(
  db: Prisma.TransactionClient,
  vendorIds: string[],
): Promise<Set<string>> {
  const ids = [...new Set(vendorIds)];
  const result = new Set<string>();
  if (ids.length === 0) return result;
  const rows = await db.warehouseVerificationEvidence.findMany({
    where: { vendorId: { in: ids } },
    orderBy: LATEST_EVIDENCE_ORDER,
    select: { vendorId: true, status: true },
  });
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.vendorId)) continue;
    seen.add(r.vendorId);
    if (r.status === 'APPROVED') result.add(r.vendorId);
  }
  return result;
}
