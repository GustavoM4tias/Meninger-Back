// controllers/correspondentController.js
//
// Tela Comercial > Correspondentes. Regra do módulo: a resposta do POST do CV
// não é prova de nada - toda confirmação passa pelo GET de usuários.
//
// Formato de resposta: `res.json({ ok: true, ... })` PLANO, igual ao
// realEstateController. O `requestWithAuth` do front devolve o corpo inteiro
// sem desembrulhar, então envelopar em { success, data } faria a store ler o
// nível errado e a tela aparecer vazia. Erros seguem no responseHandler, que
// devolve { error } com o status certo - é o que o front lê para a mensagem.

import db from '../models/sequelize/index.js';
import responseHandler from '../utils/responseHandler.js';
import { parsePessoas } from '../services/correspondent/correspondentParser.js';
import correspondentService from '../services/correspondent/correspondentService.js';

const { CorrespondentCompany, CorrespondentRegistration, CorrespondentInvite, User } = db;

const erro = (res, err) => responseHandler.error(res, err?.message || 'Erro inesperado.', err?.statusCode || 500);

/** Panorama: empresas + usuários agrupados (espelho local do CV). */
export async function getOverview(req, res) {
    try {
        const data = await correspondentService.montarPanorama();
        return res.json({ ok: true, ...data });
    } catch (err) {
        return erro(res, err);
    }
}

/** Sincroniza o espelho de usuários com o CV. */
export async function syncCorrespondents(req, res) {
    try {
        const sincronizados = await correspondentService.sincronizarEspelho();
        const data = await correspondentService.montarPanorama();
        return res.json({ ok: true, ...data, sincronizados });
    } catch (err) {
        return erro(res, err);
    }
}

/** Prévia da colagem: devolve as pessoas encontradas, sem gravar nada. */
export async function previewPaste(req, res) {
    try {
        const { texto } = req.body || {};
        const { pessoas, ignorados } = parsePessoas(texto);

        // Marca quem já está no CV para a tela avisar antes de tentar criar.
        const noCv = await db.CvCorrespondent.findAll({ attributes: ['documento', 'nome', 'idempresa'] });
        const porCpf = new Map(noCv.map((u) => [String(u.documento || '').replace(/\D/g, ''), u]));

        const enriquecidas = pessoas.map((p) => {
            const existente = p.documento ? porCpf.get(p.documento) : null;
            return {
                ...p,
                ja_cadastrado: !!existente,
                ja_cadastrado_em: existente ? existente.idempresa : null,
                avisos: existente ? [...p.avisos, 'Já cadastrado no CV'] : p.avisos,
            };
        });

        return res.json({ ok: true, pessoas: enriquecidas, ignorados });
    } catch (err) {
        return erro(res, err);
    }
}

// ── Empresas ────────────────────────────────────────────────────────────────

export async function listCompanies(req, res) {
    try {
        const empresas = await CorrespondentCompany.findAll({
            order: [['nome', 'ASC']],
            include: User ? [{ model: User, as: 'creator', attributes: ['id', 'username'] }] : [],
        });
        return res.json({ ok: true, empresas });
    } catch (err) {
        return erro(res, err);
    }
}

/**
 * Cria a empresa: grava local e dispara o POST no CV.
 * O CV não devolve o id, então a empresa nasce com status `pending` e a tela
 * cobra o vínculo do código depois.
 */
export async function createCompany(req, res) {
    try {
        const b = req.body || {};
        const empresa = await CorrespondentCompany.create({
            nome: b.nome,
            regiao: b.regiao,
            estado: b.estado,
            cidade: b.cidade,
            endereco: b.endereco,
            telefone: b.telefone || null,
            email: b.email || null,
            dias_agendamento: Number(b.dias_agendamento) || 5,
            observacao: b.observacao || null,
            status: b.somente_local ? 'external' : 'pending',
            created_by: req.user?.id,
        });

        // `somente_local` = empresa que JÁ existe no CV; só registramos aqui.
        if (b.somente_local) {
            if (b.cv_idempresa) await correspondentService.vincularEmpresa(empresa.id, b.cv_idempresa);
            return res.json({ ok: true, empresa: await empresa.reload() });
        }

        const envio = await correspondentService.criarEmpresaNoCv(empresa);
        return res.json({ ok: true, empresa, envio });
    } catch (err) {
        return erro(res, err);
    }
}

/** Amarra o idempresa conferido no CV. */
export async function linkCompany(req, res) {
    try {
        const empresa = await correspondentService.vincularEmpresa(req.params.id, req.body?.cv_idempresa);
        return res.json({ ok: true, empresa });
    } catch (err) {
        return erro(res, err);
    }
}

/** Edita os dados LOCAIS. O CV não tem update - a tela deixa isso explícito. */
export async function updateCompany(req, res) {
    try {
        const empresa = await CorrespondentCompany.findByPk(req.params.id);
        if (!empresa) return responseHandler.error(res, 'Empresa não encontrada.', 404);
        const b = req.body || {};
        await empresa.update({
            nome: b.nome ?? empresa.nome,
            regiao: b.regiao ?? empresa.regiao,
            estado: b.estado ?? empresa.estado,
            cidade: b.cidade ?? empresa.cidade,
            endereco: b.endereco ?? empresa.endereco,
            telefone: b.telefone ?? empresa.telefone,
            email: b.email ?? empresa.email,
            dias_agendamento: b.dias_agendamento ?? empresa.dias_agendamento,
            observacao: b.observacao ?? empresa.observacao,
        });
        return res.json({ ok: true, empresa });
    } catch (err) {
        return erro(res, err);
    }
}

// ── Usuários ────────────────────────────────────────────────────────────────

export async function createUsers(req, res) {
    try {
        const { pessoas, company_id } = req.body || {};
        const out = await correspondentService.criarUsuarios({
            pessoas,
            companyId: company_id,
            userId: req.user?.id,
        });
        return res.json({ ok: true, ...out });
    } catch (err) {
        return erro(res, err);
    }
}

export async function listRegistrations(req, res) {
    try {
        const registros = await CorrespondentRegistration.findAll({
            order: [['id', 'DESC']],
            limit: 500,
            include: [
                ...(User ? [{ model: User, as: 'creator', attributes: ['id', 'username'] }] : []),
                { model: CorrespondentCompany, as: 'company', attributes: ['id', 'nome'] },
            ],
        });
        return res.json({ ok: true, registros });
    } catch (err) {
        return erro(res, err);
    }
}

// ── Convites (link público) ─────────────────────────────────────────────────

export async function listInvites(req, res) {
    try {
        const convites = await CorrespondentInvite.findAll({
            order: [['id', 'DESC']],
            include: [
                ...(User ? [{ model: User, as: 'creator', attributes: ['id', 'username'] }] : []),
                { model: CorrespondentCompany, as: 'company', attributes: ['id', 'nome'] },
            ],
        });
        return res.json({ ok: true, convites });
    } catch (err) {
        return erro(res, err);
    }
}

export async function createInvite(req, res) {
    try {
        const convite = await correspondentService.criarConvite({
            companyId: req.body?.company_id,
            label: req.body?.label,
            expiresAt: req.body?.expires_at || null,
            userId: req.user?.id,
        });
        return res.json({ ok: true, convite });
    } catch (err) {
        return erro(res, err);
    }
}

export async function revokeInvite(req, res) {
    try {
        const convite = await correspondentService.revogarConvite(req.params.id);
        return res.json({ ok: true, convite });
    } catch (err) {
        return erro(res, err);
    }
}

export async function retryRegistration(req, res) {
    try {
        const registro = await correspondentService.reprocessar(req.params.id);
        return res.json({ ok: true, registro });
    } catch (err) {
        return erro(res, err);
    }
}

export default {
    getOverview,
    syncCorrespondents,
    previewPaste,
    listCompanies,
    createCompany,
    linkCompany,
    updateCompany,
    createUsers,
    listRegistrations,
    retryRegistration,
    listInvites,
    createInvite,
    revokeInvite,
};
