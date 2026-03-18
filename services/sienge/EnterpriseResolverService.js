// services/sienge/EnterpriseResolverService.js
/**
 * Resolve enterpriseId (erp_id) e companyId (raw_payload.idCompany)
 * a partir do nome do empreendimento, usando a tabela enterprise_cities.
 *
 * Padrões de nome conhecidos:
 *  ERP  → "MARILIA/SP - INC. MF PARK ALAMEDA - INCORPORAÇÃO"
 *  CRM  → "PARK ALAMEDA"
 *  Doc  → "INCORPORADORA_MF_PARK_ALAMEDA_SPE_LTDA" ou "MF PARK ALAMEDA SPE"
 *
 * Estratégia: extrair palavras-chave do input, ignorar ruídos (MF, INC,
 * SPE, LTDA, INCORPORA*, etc.) e fazer score por matches.
 * Prefere registros ERP (têm idCompany no raw_payload).
 */
import { Op, fn, col, where as Sw } from 'sequelize';
import db from '../../models/sequelize/index.js';

// ── Palavras de ruído a ignorar no matching ────────────────────────────────────
const NOISE = new Set([
    'MF', 'INC', 'SPE', 'LTDA', 'SA', 'S/A', 'EIRELI', 'ME', 'EPP',
    'INCORPORADORA', 'INCORPORACAO', 'INCORPORAÇÃO', 'INCORPORACOES',
    'CONSTRUCAO', 'CONSTRUÇÃO', 'CONSTRUTORA', 'EMPREENDIMENTOS',
    'EMPREENDIMENTO', 'ADMINISTRACAO', 'ADMINISTRAÇÃO', 'APORTES',
    'RESIDENCIAL', 'COMERCIAL', 'URBANISMO', 'NEGOCIOS',
    'BRASIL', 'NACIONAL', 'GRUPO',
]);

// ── Prefixos de cidade (ERP usa "MARILIA/SP - ...") ───────────────────────────
const CITY_PREFIX_RE = /^[A-ZÀÁÂÃÄÅÇÉÊÍÓÔÕÚ\s]+\/[A-Z]{2}\s*[-–]\s*/i;

function model() {
    const m = db.EnterpriseCity;
    if (!m) throw new Error('Model EnterpriseCity não encontrado em db.');
    return m;
}

/**
 * Normaliza um nome para matching:
 * - Remove underscores, pontos, hífens e barras
 * - Remove prefixo de cidade (MARILIA/SP -)
 * - Remove palavras de ruído
 * - Retorna array de tokens significativos (≥3 chars)
 */
function tokenize(name) {
    return name
        .toUpperCase()
        .replace(CITY_PREFIX_RE, '')       // remove "MARILIA/SP - "
        .replace(/[_\-\/\.]/g, ' ')        // underscore/hífen/barra → espaço
        .split(/\s+/)
        .map(t => t.replace(/[^A-ZÀÁÂÃÄÅÇÉÊÍÓÔÕÚ0-9]/gi, ''))
        .filter(t => t.length >= 3 && !NOISE.has(t));
}

/**
 * Score de similaridade entre tokens do input e nome do registro.
 * Retorna número de tokens do input encontrados no nome do registro.
 */
function score(inputTokens, recordName) {
    const upper = recordName.toUpperCase();
    return inputTokens.filter(t => upper.includes(t)).length;
}

// ── Público ────────────────────────────────────────────────────────────────────

export class EnterpriseResolverService {

    /** Lista todos com erp_id para o selector. cityFilter restringe por COALESCE(city_override, default_city). */
    static async listAll({ cityFilter = null } = {}) {
        const where = {
            erp_id: { [Op.ne]: null },
            enterprise_name: { [Op.ne]: null },
        };
        if (cityFilter) {
            where[Op.and] = [Sw(fn('COALESCE', col('city_override'), col('default_city')), cityFilter)];
        }
        const rows = await model().findAll({
            where,
            attributes: ['id', 'erp_id', 'enterprise_name', 'default_city', 'city_override', 'raw_payload', 'source'],
            order: [['enterprise_name', 'ASC']],
        });
        return rows.map(EnterpriseResolverService._mapRow);
    }

    /** Busca filtrada por nome (autocomplete). cityFilter restringe por COALESCE(city_override, default_city). */
    static async search(q = '', { cityFilter = null } = {}) {
        const where = { erp_id: { [Op.ne]: null } };
        if (q?.trim()) {
            where.enterprise_name = { [Op.iLike]: `%${q.trim()}%` };
        } else {
            where.enterprise_name = { [Op.ne]: null };
        }
        if (cityFilter) {
            where[Op.and] = [Sw(fn('COALESCE', col('city_override'), col('default_city')), cityFilter)];
        }
        const rows = await model().findAll({
            where,
            attributes: ['id', 'erp_id', 'enterprise_name', 'default_city', 'city_override', 'raw_payload', 'source'],
            order: [['enterprise_name', 'ASC']],
            limit: 100,
        });
        return rows.map(EnterpriseResolverService._mapRow);
    }

    /**
     * Resolve nome extraído de documento → melhor empreendimento.
     *
     * Fluxo:
     * 1. Tokeniza o input (remove ruído, cidade, underscores)
     * 2. Busca todos os registros que contenham pelo menos 1 token (ILIKE)
     * 3. Calcula score por quantidade de tokens que batem
     * 4. Prefere registros ERP (têm companyId) sobre CRM
     * 5. Retorna best + até 5 candidatos
     */
    static async resolveByName(name, { cityFilter = null } = {}) {
        if (!name?.trim()) return { best: null, candidates: [] };

        const tokens = tokenize(name);
        if (!tokens.length) return { best: null, candidates: [] };

        // Busca registros que contenham qualquer token significativo
        const baseWhere = {
            erp_id: { [Op.ne]: null },
            [Op.or]: tokens.map(t => ({
                enterprise_name: { [Op.iLike]: `%${t}%` },
            })),
        };
        if (cityFilter) {
            baseWhere[Op.and] = [Sw(fn('COALESCE', col('city_override'), col('default_city')), cityFilter)];
        }
        const rows = await model().findAll({
            where: baseWhere,
            attributes: ['id', 'erp_id', 'enterprise_name', 'default_city', 'city_override', 'raw_payload', 'source'],
            limit: 50,
        });

        if (!rows.length) return { best: null, candidates: [] };

        // Score: hits de tokens + bônus para ERP (tem companyId)
        const scored = rows
            .map(r => {
                const hits = score(tokens, r.enterprise_name || '');
                const erpBonus = r.source === 'erp' ? 0.5 : 0;
                return { row: r, total: hits + erpBonus, hits };
            })
            .filter(s => s.hits > 0)
            .sort((a, b) => b.total - a.total);

        if (!scored.length) return { best: null, candidates: [] };

        const candidates = scored
            .slice(0, 5)
            .map(s => EnterpriseResolverService._mapRow(s.row));

        return { best: candidates[0], candidates };
    }

    /** Busca direto por erp_id */
    static async getByErpId(erpId) {
        if (!erpId) return null;
        const row = await model().findOne({
            where: { erp_id: String(erpId) },
            order: [['updated_at', 'DESC']],
        });
        return row ? EnterpriseResolverService._mapRow(row) : null;
    }

    static _mapRow(row) {
        const raw = row.raw_payload || {};
        const erpId = row.erp_id != null ? Number(row.erp_id) : null;
        const companyId = raw.idCompany != null ? Number(raw.idCompany) : null;
        return {
            id: row.id,
            erpId,
            companyId,
            name: row.enterprise_name,
            city: row.city_override || row.default_city || null,
            source: row.source,
            raw,
        };
    }
}