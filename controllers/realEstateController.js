// controllers/realEstateController.js
//
// Cadastro de imobiliárias no CV CRM.
// Rotas autenticadas (tela do Office): listar, criar convite público, revogar,
// cadastrar direto, reprocessar, parsear cartão CNPJ.
// Rotas públicas (lp.menin.com.br/imobiliaria/<token>): consultar convite,
// parsear cartão CNPJ e submeter o formulário.

import crypto from 'crypto';
import db from '../models/sequelize/index.js';
import { parseCnpjCard } from '../services/realestate/cnpjCardParser.js';
import {
    processRegistration,
    validateSubmission,
    onlyDigits,
} from '../services/realestate/realEstateRegistrationService.js';

const { RealEstateRegistration } = db;

const isAdmin = (req) => req.user?.role === 'admin';

// Sanitiza um registro para o front do Office.
function toListItem(reg) {
    const r = reg.toJSON ? reg.toJSON() : reg;
    return {
        id: r.id,
        token: r.token,
        source: r.source,
        status: r.status,
        label: r.label,
        enterprises: r.enterprises || [],
        form: r.form || null,
        result: r.result || null,
        error: r.error,
        created_by: r.created_by,
        creator_name: r.creator?.username || null,
        submitted_at: r.submitted_at,
        completed_at: r.completed_at,
        createdAt: r.createdAt,
    };
}

function normalizeEnterprises(input) {
    if (!Array.isArray(input)) return [];
    return input
        .map(e => ({ id: Number(e?.id ?? e?.idempreendimento), nome: String(e?.nome || '').trim() }))
        .filter(e => Number.isFinite(e.id));
}

// ── Rotas autenticadas (Office) ──────────────────────────────────────────────

export async function listRegistrations(req, res) {
    try {
        const where = {};
        if (!isAdmin(req)) where.created_by = req.user.id;

        const rows = await RealEstateRegistration.findAll({
            where,
            include: db.User ? [{ model: db.User, as: 'creator', attributes: ['id', 'username'] }] : [],
            order: [['id', 'DESC']],
            limit: 300,
        });
        return res.json({ ok: true, registrations: rows.map(toListItem) });
    } catch (err) {
        console.error('[realestate] listRegistrations:', err);
        return res.status(500).json({ ok: false, error: 'Erro ao listar cadastros.' });
    }
}

export async function createInvite(req, res) {
    try {
        const enterprises = normalizeEnterprises(req.body?.enterprises);
        if (!enterprises.length) {
            return res.status(400).json({ ok: false, error: 'Selecione ao menos um empreendimento.' });
        }

        const reg = await RealEstateRegistration.create({
            token: crypto.randomBytes(24).toString('hex'),
            source: 'public',
            status: 'invite',
            label: String(req.body?.label || '').trim() || null,
            enterprises,
            created_by: req.user.id,
        });
        return res.status(201).json({ ok: true, registration: toListItem(reg) });
    } catch (err) {
        console.error('[realestate] createInvite:', err);
        return res.status(500).json({ ok: false, error: 'Erro ao gerar o link.' });
    }
}

export async function revokeInvite(req, res) {
    try {
        const reg = await RealEstateRegistration.findByPk(req.params.id);
        if (!reg) return res.status(404).json({ ok: false, error: 'Cadastro não encontrado.' });
        if (!isAdmin(req) && reg.created_by !== req.user.id) {
            return res.status(403).json({ ok: false, error: 'Sem permissão sobre este link.' });
        }
        if (reg.status !== 'invite') {
            return res.status(400).json({ ok: false, error: 'Só é possível revogar links ainda não preenchidos.' });
        }
        await reg.update({ status: 'revoked' });
        return res.json({ ok: true, registration: toListItem(reg) });
    } catch (err) {
        console.error('[realestate] revokeInvite:', err);
        return res.status(500).json({ ok: false, error: 'Erro ao revogar o link.' });
    }
}

export async function createInternalRegistration(req, res) {
    try {
        const enterprises = normalizeEnterprises(req.body?.enterprises);
        const form = req.body?.form || {};

        if (!enterprises.length) {
            return res.status(400).json({ ok: false, error: 'Selecione ao menos um empreendimento.' });
        }
        const errors = validateSubmission(form);
        if (errors.length) return res.status(400).json({ ok: false, error: errors.join(' '), errors });

        const reg = await RealEstateRegistration.create({
            source: 'internal',
            status: 'processing',
            label: String(form?.imobiliaria?.nome || '').trim() || null,
            enterprises,
            form,
            created_by: req.user.id,
            submitted_at: new Date(),
        });

        try {
            await processRegistration(reg);
        } catch (err) {
            return res.status(502).json({ ok: false, error: err.message, registration: toListItem(reg) });
        }
        return res.status(201).json({ ok: true, registration: toListItem(reg) });
    } catch (err) {
        console.error('[realestate] createInternalRegistration:', err);
        return res.status(500).json({ ok: false, error: 'Erro ao cadastrar a imobiliária.' });
    }
}

export async function retryRegistration(req, res) {
    try {
        const reg = await RealEstateRegistration.findByPk(req.params.id);
        if (!reg) return res.status(404).json({ ok: false, error: 'Cadastro não encontrado.' });
        if (!isAdmin(req) && reg.created_by !== req.user.id) {
            return res.status(403).json({ ok: false, error: 'Sem permissão sobre este cadastro.' });
        }
        if (reg.status !== 'error') {
            return res.status(400).json({ ok: false, error: 'Só cadastros com erro podem ser reprocessados.' });
        }

        try {
            await processRegistration(reg);
        } catch (err) {
            return res.status(502).json({ ok: false, error: err.message, registration: toListItem(reg) });
        }
        return res.json({ ok: true, registration: toListItem(reg) });
    } catch (err) {
        console.error('[realestate] retryRegistration:', err);
        return res.status(500).json({ ok: false, error: 'Erro ao reprocessar o cadastro.' });
    }
}

export async function parseCardAuthenticated(req, res) {
    return handleParseCard(req, res);
}

// ── Rotas públicas (link do convite) ─────────────────────────────────────────

async function findInviteByToken(token) {
    const t = String(token || '').trim();
    if (!/^[a-f0-9]{40,64}$/i.test(t)) return null;
    return RealEstateRegistration.findOne({ where: { token: t } });
}

export async function getPublicInvite(req, res) {
    try {
        const reg = await findInviteByToken(req.params.token);
        if (!reg || reg.status === 'revoked') {
            return res.status(404).json({ ok: false, error: 'Link inválido ou cancelado.' });
        }
        return res.json({
            ok: true,
            invite: {
                label: reg.label,
                status: reg.status,
                enterprises: (reg.enterprises || []).map(e => ({ nome: e.nome })),
                // Já preenchido: a página mostra "cadastro concluído/em análise".
                done: reg.status !== 'invite',
                completed: reg.status === 'completed',
            },
        });
    } catch (err) {
        console.error('[realestate] getPublicInvite:', err);
        return res.status(500).json({ ok: false, error: 'Erro ao consultar o link.' });
    }
}

export async function submitPublicInvite(req, res) {
    try {
        const reg = await findInviteByToken(req.params.token);
        if (!reg || reg.status === 'revoked') {
            return res.status(404).json({ ok: false, error: 'Link inválido ou cancelado.' });
        }
        if (reg.status !== 'invite') {
            return res.status(409).json({ ok: false, error: 'Este link já foi utilizado.' });
        }

        // Honeypot anti-bot: campo invisível preenchido = descarta em silêncio.
        if (String(req.body?.website || '').trim()) {
            return res.json({ ok: true });
        }

        const form = req.body?.form || {};
        const errors = validateSubmission(form);
        if (errors.length) return res.status(400).json({ ok: false, error: errors.join(' '), errors });

        await reg.update({ form, submitted_at: new Date() });

        try {
            await processRegistration(reg);
        } catch (err) {
            // O cadastro fica registrado com erro; o Office reprocessa. Para quem
            // preencheu, o envio foi recebido — não expor detalhes internos do CV.
            console.error('[realestate] processamento do convite falhou:', err?.message);
            return res.json({
                ok: true,
                pending: true,
                message: 'Cadastro recebido! Assim que o acesso estiver disponível, enviaremos as instruções para o e-mail do gerente.',
            });
        }
        return res.json({ ok: true, message: 'Imobiliária cadastrada com sucesso! Enviamos os dados de acesso para o e-mail do gerente.' });
    } catch (err) {
        console.error('[realestate] submitPublicInvite:', err);
        return res.status(500).json({ ok: false, error: 'Erro ao enviar o cadastro.' });
    }
}

export async function parseCardPublic(req, res) {
    const reg = await findInviteByToken(req.params.token);
    if (!reg || reg.status !== 'invite') {
        return res.status(404).json({ ok: false, error: 'Link inválido ou já utilizado.' });
    }
    return handleParseCard(req, res);
}

// ── Parse do cartão CNPJ (comum aos dois fluxos) ─────────────────────────────

async function handleParseCard(req, res) {
    try {
        if (!req.file?.buffer) {
            return res.status(400).json({ ok: false, error: 'Envie o cartão CNPJ em PDF.' });
        }
        if (req.file.mimetype !== 'application/pdf') {
            return res.status(400).json({ ok: false, error: 'O cartão CNPJ deve ser um PDF.' });
        }

        const data = await parseCnpjCard(req.file.buffer);
        if (!onlyDigits(data.cnpj)) {
            return res.status(422).json({
                ok: false,
                error: 'Não foi possível ler o CNPJ neste PDF (pode ser um arquivo escaneado). Preencha os campos manualmente.',
            });
        }
        return res.json({ ok: true, data });
    } catch (err) {
        console.error('[realestate] handleParseCard:', err);
        return res.status(422).json({
            ok: false,
            error: 'Não foi possível ler este PDF. Preencha os campos manualmente.',
        });
    }
}
