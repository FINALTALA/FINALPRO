import { Prisma } from '../../generated/prisma/client';

/**
 * Sprint 17b (FR-CAT-009): pg_trgm-based near-duplicate check,
 * warning-only - never blocks creation, only requires the caller to
 * explicitly confirm past it (see each controller's own
 * confirm_despite_duplicate_warning handling). Scoped to Category,
 * Brand, and CanonicalProduct only - AttributeDefinition is out of
 * scope (that model doesn't exist in this codebase). Threshold 0.6,
 * approved default.
 */
export const DUPLICATE_SIMILARITY_THRESHOLD = 0.6;

export interface DuplicateCandidate {
  id: string;
  similarity: number;
}

export async function findSimilarCategories(
  tx: Prisma.TransactionClient,
  nameAr: string,
  nameEn: string,
): Promise<(DuplicateCandidate & { name_ar: string; name_en: string })[]> {
  return tx.$queryRaw`
    SELECT id, "nameAr" AS name_ar, "nameEn" AS name_en,
      GREATEST(similarity("nameAr", ${nameAr}), similarity("nameEn", ${nameEn})) AS similarity
    FROM categories
    WHERE similarity("nameAr", ${nameAr}) >= ${DUPLICATE_SIMILARITY_THRESHOLD}
       OR similarity("nameEn", ${nameEn}) >= ${DUPLICATE_SIMILARITY_THRESHOLD}
    ORDER BY similarity DESC
    LIMIT 5
  `;
}

export async function findSimilarBrands(
  tx: Prisma.TransactionClient,
  name: string,
): Promise<(DuplicateCandidate & { name: string })[]> {
  return tx.$queryRaw`
    SELECT id, name, similarity(name, ${name}) AS similarity
    FROM brands
    WHERE similarity(name, ${name}) >= ${DUPLICATE_SIMILARITY_THRESHOLD}
    ORDER BY similarity DESC
    LIMIT 5
  `;
}

export async function findSimilarCanonicalProducts(
  tx: Prisma.TransactionClient,
  modelName: string,
): Promise<(DuplicateCandidate & { model_name: string })[]> {
  return tx.$queryRaw`
    SELECT id, "modelName" AS model_name, similarity("modelName", ${modelName}) AS similarity
    FROM canonical_products
    WHERE similarity("modelName", ${modelName}) >= ${DUPLICATE_SIMILARITY_THRESHOLD}
    ORDER BY similarity DESC
    LIMIT 5
  `;
}
