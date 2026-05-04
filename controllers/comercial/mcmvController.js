// controllers/comercial/mcmvController.js
import { Op, where, fn, col } from 'sequelize';
import XLSX from 'xlsx';
import db from '../../models/sequelize/index.js';

const FAIXA4 = 600000;

const ATTRS = [
    'co_ibge', 'no_municipio', 'sg_uf',
    'vr_faixa2', 'vr_faixa3', 'vr_anterior',
    'no_regiao', 'co_recorte', 'co_grupo_regional',
    'denominacao_hierarquia', 'populacao',
];

// Encontra coluna pelo nome parcial (robusto a acentos/encoding da planilha)
function findKey(row, ...hints) {
    const keys = Object.keys(row);
    for (const hint of hints) {
        const found = keys.find(k => k.toUpperCase().includes(hint.toUpperCase()));
        if (found) return found;
    }
    return null;
}

export async function searchMunicipios(req, res) {
    try {
        const q  = (req.query.q  || '').trim();
        const uf = (req.query.uf || '').trim().toUpperCase();

        if (q.length < 2 && !uf) return res.json({ results: [], faixa4: FAIXA4 });

        const conditions = [];
        if (q.length >= 2) {
            conditions.push(
                where(fn('unaccent', col('no_municipio')), {
                    [Op.iLike]: `%${q.normalize('NFD').replace(/[̀-ͯ]/g, '')}%`,
                })
            );
        }
        if (uf) conditions.push({ sg_uf: uf });

        const rows = await db.McmvMunicipio.findAll({
            where: conditions.length === 1 ? conditions[0] : { [Op.and]: conditions },
            order: [['no_municipio', 'ASC']],
            limit: 30,
            attributes: ATTRS,
        });

        res.json({ results: rows, faixa4: FAIXA4 });
    } catch (e) {
        console.error('[mcmv] searchMunicipios:', e.message);
        res.status(500).json({ error: 'Erro ao buscar municípios' });
    }
}

export async function getInfo(req, res) {
    try {
        const count = await db.McmvMunicipio.count();

        const periodo = count > 0
            ? await db.McmvMunicipio.findOne({ attributes: ['co_periodo'], order: [['updated_at', 'DESC']] })
            : null;

        const lastImport = await db.McmvImportLog.findOne({
            order: [['created_at', 'DESC']],
            attributes: ['username', 'imported_count', 'created_at'],
        });

        res.json({
            total: count,
            co_periodo: periodo?.co_periodo ?? null,
            faixa4: FAIXA4,
            last_import: lastImport
                ? {
                    username:       lastImport.username,
                    imported_count: lastImport.imported_count,
                    imported_at:    lastImport.created_at,
                  }
                : null,
        });
    } catch (e) {
        console.error('[mcmv] getInfo:', e.message);
        res.status(500).json({ error: 'Erro ao buscar informações da tabela' });
    }
}

export async function importXlsx(req, res) {
    try {
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Acesso restrito ao administrador' });
        }
        if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

        const wb    = XLSX.read(req.file.buffer, { type: 'buffer' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows  = XLSX.utils.sheet_to_json(sheet);

        const records = [];
        for (const row of rows) {
            const co_ibge      = String(row['CO_IBGE'] ?? '').replace('.0', '').trim();
            const no_municipio = String(row['NO_MUNICIPIO'] ?? '').trim();
            const sg_uf        = String(row['SG_UF'] ?? '').trim();
            const co_periodo   = String(row['CO_PERIODO'] ?? '').trim();
            const no_regiao    = String(row['NO_REGIAO'] ?? '').trim() || null;
            const co_recorte   = String(row['CO_RECORTE'] ?? '').trim() || null;
            const co_grupo_regional = row['CO_GRUPO_REGIONAL'] ? parseInt(row['CO_GRUPO_REGIONAL']) : null;

            const faixa2Key   = findKey(row, 'ATE_4700');
            const faixa3Key   = findKey(row, 'ACIMA_4700');
            const anteriorKey = findKey(row, 'ANTERIOR');
            const denomKey    = findKey(row, 'HIERARQUIA', 'DENOMINA');
            const popKey      = findKey(row, 'POPULA');

            const vr_faixa2              = faixa2Key   ? parseInt(row[faixa2Key])   : null;
            const vr_faixa3              = faixa3Key   ? parseInt(row[faixa3Key])   : null;
            const vr_anterior            = anteriorKey ? parseInt(row[anteriorKey]) : null;
            const denominacao_hierarquia = denomKey    ? String(row[denomKey]).trim() || null : null;
            const populacao              = popKey      ? parseInt(row[popKey])       : null;

            if (!co_ibge || !no_municipio || !sg_uf || !vr_faixa2) continue;

            records.push({
                co_ibge, no_municipio, sg_uf, co_periodo,
                vr_faixa2, vr_faixa3, vr_anterior,
                no_regiao, co_recorte, co_grupo_regional,
                denominacao_hierarquia, populacao,
            });
        }

        if (records.length === 0) {
            return res.status(422).json({ error: 'Nenhum município válido encontrado na planilha' });
        }

        const BATCH = 500;
        for (let i = 0; i < records.length; i += BATCH) {
            await db.McmvMunicipio.bulkCreate(records.slice(i, i + BATCH), {
                updateOnDuplicate: [
                    'no_municipio', 'sg_uf', 'co_periodo',
                    'vr_faixa2', 'vr_faixa3', 'vr_anterior',
                    'no_regiao', 'co_recorte', 'co_grupo_regional',
                    'denominacao_hierarquia', 'populacao',
                    'updated_at',
                ],
            });
        }

        await db.McmvImportLog.create({
            user_id:        req.user.id,
            username:       req.user.username,
            imported_count: records.length,
        });

        res.json({ imported: records.length });
    } catch (e) {
        console.error('[mcmv] importXlsx:', e.message);
        res.status(500).json({ error: e.message || 'Erro ao importar planilha' });
    }
}

// ── Endpoint para ferramentas de IA ──────────────────────────────────────────
// Retorna dados estruturados de um município pelo nome exato ou IBGE
export async function queryForAI(req, res) {
    try {
        const q = (req.query.q || '').trim();
        if (!q) return res.status(400).json({ error: 'Parâmetro q obrigatório' });

        const conditions = [
            where(fn('unaccent', col('no_municipio')), {
                [Op.iLike]: `%${q.normalize('NFD').replace(/[̀-ͯ]/g, '')}%`,
            }),
        ];

        const rows = await db.McmvMunicipio.findAll({
            where: { [Op.or]: [
                where(fn('unaccent', col('no_municipio')), { [Op.iLike]: `%${q.normalize('NFD').replace(/[̀-ͯ]/g, '')}%` }),
                { co_ibge: q },
            ]},
            limit: 5,
            attributes: [...ATTRS, 'co_periodo'],
        });

        const results = rows.map(m => ({
            municipio:              m.no_municipio,
            uf:                     m.sg_uf,
            ibge:                   m.co_ibge,
            regiao:                 m.no_regiao,
            hierarquia:             m.denominacao_hierarquia,
            populacao:              m.populacao,
            teto_faixa2:            m.vr_faixa2,
            teto_faixa3:            m.vr_faixa3,
            teto_faixa4:            FAIXA4,
            teto_vigencia_anterior: m.vr_anterior,
            recorte:                m.co_recorte,
            grupo_regional:         m.co_grupo_regional,
            vigencia:               m.co_periodo,
        }));

        res.json({ results });
    } catch (e) {
        console.error('[mcmv] queryForAI:', e.message);
        res.status(500).json({ error: 'Erro ao consultar dados MCMV' });
    }
}
