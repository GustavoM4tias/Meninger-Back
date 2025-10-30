// src/routes/validator/history.js
import express from 'express';
import db from '../../../models/sequelize/index.js';

const router = express.Router();

/**
 * GET /validator/history
 * - ?summary=true  -> oculta 'mensagens'
 *
 * Retorno: APENAS o array de registros (sem count/offset), preservando o formato do frontend.
 * Regra de cidade (não-admin):
 *   EXISTS enterprise_cities ec
 *     WHERE ec.source='crm'
 *       AND COALESCE(ec.city_override, ec.default_city) = :userCity
 *       AND ec.enterprise_name ILIKE '%' || vh.empreendimento || '%'
 */
router.get('/', async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Usuário não autenticado.' });
    }

    const isAdmin = req.user.role === 'admin';
    const userCity = req.user.city || null;

    const summary = String(req.query?.summary || '').toLowerCase() === 'true';

    const cols = [
      'vh.id',
      'vh.empreendimento',
      'vh.cliente',
      'vh.status',
      summary ? null : 'vh.mensagens',
      'vh.tokens_used',
      'vh.model',
      'vh.created_at',
      'vh.updated_at',
    ].filter(Boolean).join(', ');

    const where = [];
    const repl = {};

    if (!isAdmin) {
      if (!userCity) {
        return res.status(400).json({ error: 'Cidade do usuário ausente no token.' });
      }
      repl.userCity = userCity;

      where.push(`
        EXISTS (
          SELECT 1
          FROM enterprise_cities ec
          WHERE
            ec.source = 'crm'
            AND COALESCE(ec.city_override, ec.default_city) = :userCity
            AND ec.enterprise_name ILIKE '%' || vh.empreendimento || '%'
        )
      `);
    }

    const sql = `
      SELECT ${cols}
      FROM validation_histories vh
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY vh.created_at DESC
    `;

    const rows = await db.sequelize.query(sql, {
      replacements: repl,
      type: db.Sequelize.QueryTypes.SELECT,
    });

    // 🔙 retorna somente a lista, sem metadados
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

export default router;
