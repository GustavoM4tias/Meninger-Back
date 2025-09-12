import { makeExtPgClient } from '../../../lib/extDb.js';

export async function fetchObstitByNumbers(numbers = []) {
  if (!numbers.length) return new Map();

  const client = makeExtPgClient();
  await client.connect();

  try {
    const sql = `
      SELECT d2.numdocum, d2.obstit
      FROM dfin_creceber d2
      WHERE d2.numdocum = ANY($1::text[])
    `;
    const { rows } = await client.query(sql, [numbers]);

    const map = new Map();
    for (const r of rows) {
      const key = String(r.numdocum);
      const val = String(r.obstit ?? '');
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(val);
    }
    return map;
  } finally {
    await client.end().catch(() => {});
  }
}