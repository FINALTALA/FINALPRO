// Sprint 14 review fix: which fulfilment methods a branch can actually
// offer, and a valid default. A physical branch can offer pick-up; any
// branch with delivery slots can offer delivery. An online-only branch
// (is_physical = false) has NO pick-up, so a hard-coded PICKUP default
// would lead straight into a 409 PICKUP_REQUIRES_PHYSICAL_BRANCH.

export type FulfilmentMethod = "PICKUP" | "DELIVERY";

export interface BranchFulfilmentInfo {
  is_physical: boolean;
  available_slots: unknown[];
}

export function availableMethods(branch: BranchFulfilmentInfo | undefined): FulfilmentMethod[] {
  if (!branch) return [];
  const methods: FulfilmentMethod[] = [];
  if (branch.is_physical) methods.push("PICKUP");
  if (branch.available_slots.length > 0) methods.push("DELIVERY");
  return methods;
}

/** Pick-up for a physical branch; delivery for an online-only branch with slots; null if neither. */
export function defaultMethod(branch: BranchFulfilmentInfo | undefined): FulfilmentMethod | null {
  return availableMethods(branch)[0] ?? null;
}

/** Keeps the current choice if the branch still offers it, else falls back to the default. */
export function coerceMethod(
  branch: BranchFulfilmentInfo | undefined,
  current: FulfilmentMethod | null,
): FulfilmentMethod | null {
  return current !== null && availableMethods(branch).includes(current) ? current : defaultMethod(branch);
}

/** True only when every group has a usable fulfilment method. */
export function allGroupsFulfillable(methods: (FulfilmentMethod | null)[]): boolean {
  return methods.length > 0 && methods.every((m) => m !== null);
}
