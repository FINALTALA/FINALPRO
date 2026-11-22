import * as request from 'supertest';

/**
 * Sprint 27 (product taxonomy): every product created through
 * POST /vendors/:vendorId/offers is born classified, and a classified
 * product's variants are created ONLY as combinations
 * (POST .../offers/:offerId/combinations). This is the one shared way
 * the older suites now build their catalogue through the real API.
 */
export const TEST_CLASSIFICATION = {
  audiences: ['WOMEN'],
  categories: ['TOPS'],
};

// Adult sizes from the seeded taxonomy - handed out in order when a test
// does not care which size its combination is (two combinations of one
// product must differ in colour or size).
const SPARE_SIZES = ['M', 'L', 'S', 'XL', 'XS', 'XXL', 'XXXL', 'XXXXL'];

export interface CombinationInput {
  base_price: number;
  sale_price?: number | null;
  discount_percent?: number | null;
  discount_start_at?: string | null;
  discount_end_at?: string | null;
  color_code?: string | null;
  size_code?: string | null;
  stock?: { branch_id: string; quantity: number }[];
  seller_sku?: string;
  store_inventory_barcode?: string;
  identifier_type?: string;
  identifier_value?: string;
  condition?: string;
  specs_text_ar?: string;
  specs_text_en?: string;
}

/**
 * Creates ONE combination on a classified offer. The price is sent only
 * with the offer's first combination (afterwards it is offer-level and
 * every combination inherits it). On 201 the body is the ordinary
 * variant DTO (GET .../variants), so callers keep reading `id`,
 * `match_proposal_status`, `store_inventory_barcode`, ...; on an error
 * it is the combinations endpoint's own error body.
 */
export async function postCombination(
  server: Parameters<typeof request>[0],
  token: string,
  vendorId: string,
  offerId: string,
  input: CombinationInput,
): Promise<{ status: number; body: any }> {
  const base = `/api/v1/vendors/${vendorId}/offers/${offerId}`;
  const existing = await request(server)
    .get(`${base}/combinations`)
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  const items: { color_code: string | null; size_code: string | null }[] =
    existing.body.items;
  const {
    base_price,
    sale_price,
    discount_percent,
    discount_start_at,
    discount_end_at,
    stock,
    ...rest
  } = input;
  const color_code = input.color_code ?? null;
  let size_code = input.size_code ?? null;
  if (color_code === null && size_code === null) {
    size_code =
      SPARE_SIZES.find(
        (s) => !items.some((i) => i.color_code === null && i.size_code === s),
      ) ?? null;
  }
  const price = Object.fromEntries(
    Object.entries({
      base_price,
      sale_price,
      discount_percent,
      discount_start_at,
      discount_end_at,
    }).filter(([, v]) => v !== undefined),
  );
  const res = await request(server)
    .post(`${base}/combinations`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      items: [{ ...rest, color_code, size_code, stock: stock ?? [] }],
      ...(items.length === 0 ? { price } : {}),
    });
  if (res.status !== 201) return { status: res.status, body: res.body };
  const variantId: string = res.body.created[0].variant_id;
  const list = await request(server)
    .get(`${base}/variants`)
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  const rows: any[] = Array.isArray(list.body) ? list.body : list.body.items;
  return { status: 201, body: rows.find((v) => v.id === variantId) };
}
