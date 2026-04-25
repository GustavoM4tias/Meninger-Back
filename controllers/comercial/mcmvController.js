// controllers/comercial/mcmvController.js
import { Op, where, fn, col, literal } from 'sequelize';
import XLSX from 'xlsx';
import db from '../../models/sequelize/index.js';

const FAIXA3 = 350000;
const FAIXA4 = 500000;

const ATTRS = ['co_ibge', 'no_municipio', 'sg_uf', 'vr_faixa2', 'no_regiao', 'co_recorte', 'co_grupo_regional'];

export async function searchMunicipios(req, res) {
    try {
        const q  = (req.query.q  || '').trim();
        const uf = (req.query.uf || '').trim().toUpperCase();

        if (q.length < 2 && !uf) return res.json({ results: [], faixa3: FAIXA3, faixa4: FAIXA4 });

        const conditions = [];
        if (q.length >= 2) {
            conditions.push(
                where(fn('unaccent', col('no_municipio')), { [Op.iLike]: `%${q.normalize('NFD').replace(/[\u0300-\u036f]/g, '')}%` })
            );
        }
        if (uf) conditions.push({ sg_uf: uf });

        const rows = await db.McmvMunicipio.findAll({
            where: conditions.length === 1 ? conditions[0] : { [Op.and]: conditions },
            order: [['no_municipio', 'ASC']],
            limit: 30,
            attributes: ATTRS,
        });

        res.json({ results: rows, faixa3: FAIXA3, faixa4: FAIXA4 });
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
            faixa3: FAIXA3,
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

            const faixa2Key = Object.keys(row).find(k => k.includes('ATE_4700') || k.includes('ATÉ_4700'));
            const vr_faixa2 = faixa2Key ? parseInt(row[faixa2Key]) : null;

            if (!co_ibge || !no_municipio || !sg_uf || !vr_faixa2) continue;

            records.push({ co_ibge, no_municipio, sg_uf, co_periodo, vr_faixa2, no_regiao, co_recorte, co_grupo_regional });
        }

        if (records.length === 0) {
            return res.status(422).json({ error: 'Nenhum município válido encontrado na planilha' });
        }

        const BATCH = 500;
        for (let i = 0; i < records.length; i += BATCH) {
            await db.McmvMunicipio.bulkCreate(records.slice(i, i + BATCH), {
                updateOnDuplicate: ['no_municipio', 'sg_uf', 'vr_faixa2', 'co_periodo', 'no_regiao', 'co_recorte', 'co_grupo_regional', 'updated_at'],
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
