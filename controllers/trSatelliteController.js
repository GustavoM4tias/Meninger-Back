// controllers/trSatelliteController.js
import db from '../models/sequelize/index.js';

const { TrSatelliteEnterprise } = db;

function sanitizePartnerIds(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    const seen = new Set();
    for (const v of value) {
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) continue;
        if (seen.has(n)) continue;
        seen.add(n);
        out.push(n);
    }
    return out;
}

function serialize(row) {
    return {
        id: row.id,
        satellite_enterprise_id: row.satellite_enterprise_id,
        satellite_enterprise_name: row.satellite_enterprise_name,
        partner_enterprise_ids: Array.isArray(row.partner_enterprise_ids) ? row.partner_enterprise_ids : [],
        description: row.description,
    };
}

// GET aberto a todos os autenticados — a regra é aplicada no relatório de
// qualquer usuário, então o frontend precisa do mapeamento.
export async function listTrSatellites(req, res) {
    try {
        if (!req.user) return res.status(401).json({ error: 'Não autenticado.' });

        const rows = await TrSatelliteEnterprise.findAll({
            where: { active: true },
            order: [['satellite_enterprise_id', 'ASC']]
        });

        return res.json({
            count: rows.length,
            results: rows.map(serialize)
        });
    } catch (err) {
        console.error('[listTrSatellites]', err);
        return res.status(500).json({ error: 'Erro ao listar satélites de TR.' });
    }
}

export async function addTrSatellite(req, res) {
    try {
        if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Acesso negado.' });

        const {
            satellite_enterprise_id,
            satellite_enterprise_name,
            partner_enterprise_ids,
            description
        } = req.body;

        const satId = Number(satellite_enterprise_id);
        if (!Number.isInteger(satId) || satId <= 0) {
            return res.status(400).json({ error: 'satellite_enterprise_id inválido.' });
        }

        const partners = sanitizePartnerIds(partner_enterprise_ids);
        if (!partners.length) {
            return res.status(400).json({ error: 'partner_enterprise_ids deve conter ao menos um id.' });
        }
        if (partners.includes(satId)) {
            return res.status(400).json({ error: 'O satélite não pode ser parceiro de si mesmo.' });
        }

        const [row, created] = await TrSatelliteEnterprise.findOrCreate({
            where: { satellite_enterprise_id: satId },
            defaults: {
                satellite_enterprise_id: satId,
                satellite_enterprise_name: satellite_enterprise_name || null,
                partner_enterprise_ids: partners,
                description: description || null,
                active: true
            }
        });

        if (!created) {
            row.satellite_enterprise_name = satellite_enterprise_name || row.satellite_enterprise_name;
            row.partner_enterprise_ids = partners;
            row.description = description ?? row.description;
            row.active = true;
            await row.save();
        }

        return res.status(200).json(serialize(row));
    } catch (err) {
        console.error('[addTrSatellite]', err);
        return res.status(500).json({ error: 'Erro ao salvar satélite de TR.' });
    }
}

export async function updateTrSatellite(req, res) {
    try {
        if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Acesso negado.' });

        const idInt = Number(req.params.id);
        if (!Number.isInteger(idInt)) return res.status(400).json({ error: 'ID inválido.' });

        const row = await TrSatelliteEnterprise.findByPk(idInt);
        if (!row || row.active === false) return res.status(404).json({ error: 'Registro não encontrado.' });

        const { satellite_enterprise_name, partner_enterprise_ids, description } = req.body;

        if (satellite_enterprise_name !== undefined) row.satellite_enterprise_name = satellite_enterprise_name || null;
        if (description !== undefined) row.description = description || null;
        if (partner_enterprise_ids !== undefined) {
            const partners = sanitizePartnerIds(partner_enterprise_ids);
            if (!partners.length) return res.status(400).json({ error: 'partner_enterprise_ids deve conter ao menos um id.' });
            if (partners.includes(row.satellite_enterprise_id)) {
                return res.status(400).json({ error: 'O satélite não pode ser parceiro de si mesmo.' });
            }
            row.partner_enterprise_ids = partners;
        }

        await row.save();
        return res.json(serialize(row));
    } catch (err) {
        console.error('[updateTrSatellite]', err);
        return res.status(500).json({ error: 'Erro ao atualizar satélite de TR.' });
    }
}

export async function removeTrSatellite(req, res) {
    try {
        if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Acesso negado.' });

        const idInt = Number(req.params.id);
        if (!Number.isInteger(idInt)) return res.status(400).json({ error: 'ID inválido.' });

        const row = await TrSatelliteEnterprise.findByPk(idInt);
        if (!row) return res.status(404).json({ error: 'Registro não encontrado.' });

        row.active = false;
        await row.save();
        return res.json({ success: true });
    } catch (err) {
        console.error('[removeTrSatellite]', err);
        return res.status(500).json({ error: 'Erro ao remover satélite de TR.' });
    }
}
