// controllers/sienge/launchTypeController.js
import db from '../../models/sequelize/index.js';

const Model = () => db.LaunchTypeConfig;

// Dados iniciais — serão inseridos automaticamente se a tabela estiver vazia
const INITIAL_TYPES = [
    {
        name: 'Premiação',
        documento: 'PREM',
        budgetItem: 'Comissões',
        budgetItemCode: '80097',
        financialAccountNumber: '2.02.02.80',
        budgetIndex: 5,
        accountIndex: 158,
    },
    {
        name: 'ITBI',
        documento: 'ITBI',
        budgetItem: 'Taxas e Emolumentos',
        budgetItemCode: '80107',
        financialAccountNumber: '2.02.02.12',
        budgetIndex: 16,
        accountIndex: 105,
    },
    {
        name: 'Marketing',
        documento: 'CT',
        budgetItem: 'Marketing, Brindes, Promoções e Eventos',
        budgetItemCode: '80084',
        financialAccountNumber: '2.02.02.75',
        budgetIndex: 9,
        accountIndex: 154,
    },
    {
        name: 'CEF',
        documento: 'PCEF',
        budgetItem: 'Taxas e Emolumentos',
        budgetItemCode: '80107',
        financialAccountNumber: '2.17.03',
        budgetIndex: 16,
        accountIndex: 424,
    },
    {
        name: 'Cartório',
        documento: 'CART',
        budgetItem: 'Taxas e Emolumentos',
        budgetItemCode: '80107',
        financialAccountNumber: '2.02.02.12',
        budgetIndex: 16,
        accountIndex: 105,
    },
    {
        name: 'Stand',
        documento: 'CT',
        budgetItem: 'Despesas com Estrutura Local e/ou Stand de Vendas',
        budgetItemCode: '80100',
        financialAccountNumber: '2.02.07',
        budgetIndex: 10,
        accountIndex: 184,
    },
];

/**
 * Seed automático — garante que os 6 tipos padrão existam na tabela.
 * Usa findOrCreate: insere apenas se o nome ainda não existir,
 * preservando qualquer modificação admin feita depois.
 * Chamado na inicialização do server.
 */
export async function seedInitialTypes() {
    try {
        let inserted = 0;
        let updated = 0;
        // Campos que podem ser corrigidos pelo seed mesmo após o registro já existir
        const syncFields = ['budgetItem', 'budgetItemCode', 'financialAccountNumber', 'budgetIndex', 'accountIndex', 'documento'];
        for (const type of INITIAL_TYPES) {
            const [record, created] = await Model().findOrCreate({
                where: { name: type.name },
                defaults: type,
            });
            if (created) {
                inserted++;
            } else {
                // Atualiza campos de configuração se o seed tiver valor diferente do DB
                const diff = {};
                for (const f of syncFields) {
                    if (type[f] !== undefined && String(record[f] ?? '') !== String(type[f] ?? '')) {
                        diff[f] = type[f];
                    }
                }
                if (Object.keys(diff).length > 0) {
                    await record.update(diff);
                    updated++;
                }
            }
        }
        if (inserted > 0 || updated > 0) {
            console.log(`[LaunchType] seed: ${inserted} inserido(s), ${updated} atualizado(s)`);
        }
    } catch (err) {
        console.error('[LaunchType] Erro ao fazer seed inicial:', err.message);
    }
}

// ── LIST ──────────────────────────────────────────────────────────────────────
export async function listLaunchTypes(req, res, next) {
    try {
        const includeInactive = req.query.includeInactive === 'true' && req.user?.role === 'admin';
        const where = includeInactive ? {} : { active: true };
        const types = await Model().findAll({
            where,
            order: [['name', 'ASC']],
        });
        return res.json(types);
    } catch (err) { next(err); }
}

// ── CREATE (admin only) ───────────────────────────────────────────────────────
export async function createLaunchType(req, res, next) {
    try {
        if (req.user?.role !== 'admin') {
            return res.status(403).json({ error: 'Apenas administradores podem criar tipos de lançamento.' });
        }
        const { name, documento, budgetItem, budgetItemCode, financialAccountNumber, budgetIndex, accountIndex } = req.body;
        if (!name || !documento || !budgetItem || !financialAccountNumber) {
            return res.status(422).json({ error: 'Campos obrigatórios: name, documento, budgetItem, financialAccountNumber' });
        }
        const existing = await Model().findOne({ where: { name } });
        if (existing) {
            return res.status(409).json({ error: `Tipo "${name}" já existe.` });
        }
        const type = await Model().create({
            name,
            documento,
            budgetItem,
            budgetItemCode: budgetItemCode || null,
            financialAccountNumber,
            budgetIndex: budgetIndex || null,
            accountIndex: accountIndex || null,
            active: true,
            createdBy: req.user?.id || null,
        });
        return res.status(201).json(type);
    } catch (err) { next(err); }
}

// ── UPDATE (admin only) ───────────────────────────────────────────────────────
export async function updateLaunchType(req, res, next) {
    try {
        if (req.user?.role !== 'admin') {
            return res.status(403).json({ error: 'Apenas administradores podem editar tipos de lançamento.' });
        }
        const type = await Model().findByPk(req.params.id);
        if (!type) return res.status(404).json({ error: 'Tipo não encontrado.' });
        const allowed = ['documento', 'budgetItem', 'budgetItemCode', 'financialAccountNumber', 'budgetIndex', 'accountIndex', 'active'];
        const patch = {};
        allowed.forEach(k => { if (req.body[k] !== undefined) patch[k] = req.body[k]; });
        await type.update(patch);
        return res.json(type);
    } catch (err) { next(err); }
}
