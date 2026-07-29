// services/sienge/EnterpriseResolverService.js
/**
 * Resolve enterpriseId (erp_cost_center_id) e companyId (company_id)
 * a partir do nome do empreendimento, usando a tabela enterprises
 * (registro unificado CV × Sienge).
 *
 * Padrões de nome conhecidos:
 *  ERP  → "MARILIA/SP - INC. MF PARK ALAMEDA - INCORPORAÇÃO"
 *  CRM  → "PARK ALAMEDA"
 *  Doc  → "INCORPORADORA_MF_PARK_ALAMEDA_SPE_LTDA" ou "MF PARK ALAMEDA SPE"
 *
 * Estratégia: extrair palavras-chave do input, ignorar ruídos (MF, INC,
 * SPE, LTDA, INCORPORA*, etc.) e fazer score por matches.
 * Prefere registros com companyId preenchido.
 */
import { Op } from 'sequelize';
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
    const m = db.OrgEnterprise;
    if (!m) throw new Error('Model OrgEnterprise não encontrado em db.');
    return m;
}

const ATTRS = ['id', 'erp_cost_center_id', 'company_id', 'name', 'city', 'pair_status', 'erp_payload', 'cv_payload'];

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

    /** Lista todos com erp_cost_center_id para o selector. cityFilter restringe por enterprises.city. */
    static async listAll({ cityFilter = null } = {}) {
        const where = {
            erp_cost_center_id: { [Op.ne]: null },
            name: { [Op.ne]: null },
            active: true,
        };
        if (cityFilter) {
            where.city = cityFilter;
        }
        const rows = await model().findAll({
            where,
            attributes: ATTRS,
            order: [['name', 'ASC']],
        });
        return rows.map(EnterpriseResolverService._mapRow);
    }

    /** Busca filtrada por nome (autocomplete). cityFilter restringe por enterprises.city. */
    static async search(q = '', { cityFilter = null } = {}) {
        const where = { erp_cost_center_id: { [Op.ne]: null }, active: true };
        if (q?.trim()) {
            where.name = { [Op.iLike]: `%${q.trim()}%` };
        } else {
            where.name = { [Op.ne]: null };
        }
        if (cityFilter) {
            where.city = cityFilter;
        }
        const rows = await model().findAll({
            where,
            attributes: ATTRS,
            order: [['name', 'ASC']],
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
     * 4. Prefere registros com companyId preenchido
     * 5. Retorna best + até 5 candidatos
     */
    static async resolveByName(name, { cityFilter = null } = {}) {
        if (!name?.trim()) return { best: null, candidates: [] };

        const tokens = tokenize(name);
        if (!tokens.length) return { best: null, candidates: [] };

        // Busca registros que contenham qualquer token significativo
        const baseWhere = {
            erp_cost_center_id: { [Op.ne]: null },
            active: true,
            [Op.or]: tokens.map(t => ({
                name: { [Op.iLike]: `%${t}%` },
            })),
        };
        if (cityFilter) {
            baseWhere.city = cityFilter;
        }
        const rows = await model().findAll({
            where: baseWhere,
            attributes: ATTRS,
            limit: 50,
        });

        if (!rows.length) return { best: null, candidates: [] };

        // Score: hits de tokens + bônus para quem tem companyId
        const scored = rows
            .map(r => {
                const hits = score(tokens, r.name || '');
                const erpBonus = r.company_id != null ? 0.5 : 0;
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

    /** Busca direto por erp_cost_center_id */
    static async getByErpId(erpId) {
        const erpIdNum = Number(erpId);
        if (!erpIdNum || !Number.isFinite(erpIdNum)) return null;
        const row = await model().findOne({
            where: { erp_cost_center_id: erpIdNum, active: true },
            order: [['updated_at', 'DESC']],
        });
        return row ? EnterpriseResolverService._mapRow(row) : null;
    }

    static _mapRow(row) {
        const raw = row.erp_payload || row.cv_payload || {};
        const erpId = row.erp_cost_center_id != null ? Number(row.erp_cost_center_id) : null;
        const companyId = row.company_id != null ? Number(row.company_id) : null;
        return {
            id: row.id,
            erpId,
            companyId,
            name: row.name,
            city: row.city || null,
            source: row.pair_status,
            raw,
        };
    }
}