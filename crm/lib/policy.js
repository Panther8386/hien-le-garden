export async function resolveActivePolicy(db, todayISODate) {
  const row = await db
    .prepare(
      `SELECT id, discount_percent, gift_enabled FROM promo_policy
       WHERE is_active = 1 AND valid_from <= ?1 AND valid_to >= ?1
       ORDER BY id DESC LIMIT 1`
    )
    .bind(todayISODate)
    .first();

  if (!row) {
    return { policyId: null, discountPercent: 0, giftEnabled: false };
  }

  return {
    policyId: row.id,
    discountPercent: row.discount_percent,
    giftEnabled: !!row.gift_enabled,
  };
}
