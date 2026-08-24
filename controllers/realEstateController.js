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

// Data de hoje 'YYYY-MM-DD' no fuso de Brasília (DATEONLY comparável por string).
const todayBR = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

// Estado da janela de um link multi-uso: 'not_started' | 'open' | 'expired'.
// Link de uso único é sempre 'open' (o controle é o status, não a janela).
function windowState(reg) {
    if (!reg.multi_use) return 'open';
    const today = todayBR();
    if (reg.starts_at && today < reg.starts_at) return 'not_started';
    if (reg.ends_at && today > reg.ends_at) return 'expired';
    return 'open';
}

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
        multi_use: !!r.multi_use,
        starts_at: r.starts_at || null,
        ends_at: r.ends_at || null,
        parent_id: r.parent_id || null,
        submissions: r.multi_use ? (r.submissions || []) : undefined,
        submissions_count: r.multi_use ? (r.submissions || []).length : undefined,
        window_state: r.multi_use ? windowState(r) : undefined,
        submitted_at: r.submitted_at,
        completed_at: r.completed_at,
        createdAt: r.createdAt,
    };
}

// Aceita 'YYYY-MM-DD' (ou vazio) e devolve a data validada ou null.
function parseDateOnly(value) {
    const s = String(value || '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
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

        // Teto alto o bastante para caber o histórico real (convite multi-uso
        // gera um registro-FILHO por preenchimento, então a lista cresce
        // rápido). Se um dia estourar, a tela AVISA em vez de omitir calado.
        const LIMITE = 2000;
        const total = await RealEstateRegistration.count({ where });
        const rows = await RealEstateRegistration.findAll({
            where,
            include: db.User ? [{ model: db.User, as: 'creator', attributes: ['id', 'username'] }] : [],
            order: [['id', 'DESC']],
            limit: LIMITE,
        });
        return res.json({
            ok: true,
            registrations: rows.map(toListItem),
            total,
            truncated: total > rows.length,
        });
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

        const multiUse = !!req.body?.multi_use;
        let startsAt = null;
        let endsAt = null;
        if (multiUse) {
            startsAt = parseDateOnly(req.body?.starts_at) || todayBR();
            endsAt = parseDateOnly(req.body?.ends_at);
            if (!endsAt) {
                return res.status(400).json({ ok: false, error: 'Informe a data de encerramento do link.' });
            }
            if (endsAt < startsAt) {
                return res.status(400).json({ ok: false, error: 'A data de encerramento deve ser igual ou posterior ao início.' });
            }
        }

        const reg = await RealEstateRegistration.create({
            token: crypto.randomBytes(24).toString('hex'),
            source: 'public',
            status: 'invite',
            label: String(req.body?.label || '').trim() || null,
            enterprises,
            created_by: req.user.id,
            multi_use: multiUse,
            starts_at: startsAt,
            ends_at: endsAt,
            submissions: multiUse ? [] : null,
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
        // Uso único: só antes do preenchimento. Multi-uso: pode revogar a
        // qualquer momento (encerra o link; os cadastros já feitos permanecem).
        if (!reg.multi_use && reg.status !== 'invite') {
            return res.status(400).json({ ok: false, error: 'Só é possível revogar links ainda não preenchidos.' });
        }
        await reg.update({ status: 'revoked' });
        return res.json({ ok: true, registration: toListItem(reg) });
    } catch (err) {
        console.error('[realestate] revokeInvite:', err);
        return res.status(500).json({ ok: false, error: 'Erro ao revogar o link.' });
    }
}

// Edita a janela de um link multi-uso (início/encerramento). Estender o
// encerramento reabre um link já encerrado; revogado continua morto (a rota
// pública checa status='revoked' antes da janela).
export async function updateInvite(req, res) {
    try {
        const reg = await RealEstateRegistration.findByPk(req.params.id);
        if (!reg) return res.status(404).json({ ok: false, error: 'Cadastro não encontrado.' });
        if (!isAdmin(req) && reg.created_by !== req.user.id) {
            return res.status(403).json({ ok: false, error: 'Sem permissão sobre este link.' });
        }
        if (!reg.multi_use) {
            return res.status(400).json({ ok: false, error: 'Só links de uso múltiplo têm período editável.' });
        }
        if (reg.status === 'revoked') {
            return res.status(400).json({ ok: false, error: 'Link revogado não pode ser alterado. Gere um novo link.' });
        }

        const startsAt = parseDateOnly(req.body?.starts_at) || reg.starts_at || todayBR();
        const endsAt = parseDateOnly(req.body?.ends_at);
        if (!endsAt) {
            return res.status(400).json({ ok: false, error: 'Informe a data de encerramento do link.' });
        }
        if (endsAt < startsAt) {
            return res.status(400).json({ ok: false, error: 'A data de encerramento deve ser igual ou posterior ao início.' });
        }

        await reg.update({ starts_at: startsAt, ends_at: endsAt });
        return res.json({ ok: true, registration: toListItem(reg) });
    } catch (err) {
        console.error('[realestate] updateInvite:', err);
        return res.status(500).json({ ok: false, error: 'Erro ao atualizar o link.' });
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

// ── Relatório de imobiliárias (backup cv_imobiliarias) ───────────────────────
// A montagem vive em services/realestate/realEstateReportService.js — reusada
// pela Eme (RealEstateTools) com o mesmo escopo de acesso desta tela.

// Freio do botão "Sincronizar": a varredura é uma chamada ao CV que devolve a
// lista inteira. Sem freio, dois cliques (ou dois usuários) disparavam duas
// varreduras simultâneas contra a API do CV. Quem chega durante uma varredura
// em curso ESPERA a mesma e recebe o resultado dela.
let syncEmVoo = null;

export async function syncImobiliarias(req, res) {
    try {
        if (!syncEmVoo) {
            const { default: ImobiliariaSyncService } = await import('../services/bulkData/cv/ImobiliariaSyncService.js');
            const { invalidarCacheDoRelatorio } = await import('../services/realestate/realEstateReportService.js');
            const svc = new ImobiliariaSyncService();
            // O botão faz a varredura completa: cadastro + associação com os
            // empreendimentos. A associação é a que responde "essa imobiliária
            // trabalha com quais empreendimentos" - o cadastro sozinho não diz.
            syncEmVoo = svc.syncAll()
                .then(async (count) => { await svc.syncAssociacoes().catch(e => console.warn('[realestate] associações:', e.message)); return count; })
                .finally(() => { syncEmVoo = null; invalidarCacheDoRelatorio(); });
        }
        const count = await syncEmVoo;
        return res.json({ ok: true, count });
    } catch (err) {
        console.error('[realestate] syncImobiliarias:', err);
        return res.status(502).json({ ok: false, error: 'Erro ao sincronizar imobiliárias do CV.' });
    }
}

export async function getImobiliariasReport(req, res) {
    try {
        const { buildImobiliariasReport } = await import('../services/realestate/realEstateReportService.js');
        const { total, last_sync, imobiliarias } = await buildImobiliariasReport({
            user: req.user,
            q: req.query.q,
            cidade: req.query.cidade,
            empreendimento: req.query.empreendimento,
        });
        return res.json({ ok: true, total, last_sync, imobiliarias });
    } catch (err) {
        console.error('[realestate] getImobiliariasReport:', err);
        return res.status(500).json({ ok: false, error: 'Erro ao montar o relatório de imobiliárias.' });
    }
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

        const enterprises = (reg.enterprises || []).map(e => ({ nome: e.nome }));

        if (reg.multi_use) {
            const state = windowState(reg);
            return res.json({
                ok: true,
                invite: {
                    label: reg.label,
                    multi_use: true,
                    enterprises,
                    window_state: state,          // not_started | open | expired
                    starts_at: reg.starts_at,
                    ends_at: reg.ends_at,
                    // Link multi-uso nunca "trava" por preenchimento; só a janela.
                    done: false,
                    completed: false,
                },
            });
        }

        return res.json({
            ok: true,
            invite: {
                label: reg.label,
                multi_use: false,
                status: reg.status,
                enterprises,
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

const PENDING_MSG = 'Cadastro recebido! Assim que o acesso estiver disponível, enviaremos as instruções para o e-mail do gerente.';
const SUCCESS_MSG = 'Imobiliária cadastrada com sucesso! Enviamos os dados de acesso para o e-mail do gerente.';

export async function submitPublicInvite(req, res) {
    try {
        const reg = await findInviteByToken(req.params.token);
        if (!reg || reg.status === 'revoked') {
            return res.status(404).json({ ok: false, error: 'Link inválido ou cancelado.' });
        }

        // Honeypot anti-bot: campo invisível preenchido = descarta em silêncio.
        if (String(req.body?.website || '').trim()) {
            return res.json({ ok: true });
        }

        const form = req.body?.form || {};
        const errors = validateSubmission(form);
        if (errors.length) return res.status(400).json({ ok: false, error: errors.join(' '), errors });

        // ── Link multi-uso: janela + bloqueio de CNPJ repetido + registro-filho ──
        if (reg.multi_use) {
            const state = windowState(reg);
            if (state === 'not_started') {
                return res.status(403).json({ ok: false, error: 'Este link ainda não está ativo. Tente novamente na data de início.' });
            }
            if (state === 'expired') {
                return res.status(403).json({ ok: false, error: 'O período deste link foi encerrado.' });
            }

            const cnpj = onlyDigits(form?.imobiliaria?.cnpj);
            const submissions = Array.isArray(reg.submissions) ? reg.submissions : [];
            if (submissions.some(s => onlyDigits(s.cnpj) === cnpj)) {
                return res.status(409).json({ ok: false, error: 'Este CNPJ já foi cadastrado por este link.' });
            }

            const child = await RealEstateRegistration.create({
                source: 'public',
                status: 'processing',
                label: String(form?.imobiliaria?.nome || '').trim() || reg.label || null,
                enterprises: reg.enterprises,
                form,
                created_by: reg.created_by,
                parent_id: reg.id,
                submitted_at: new Date(),
            });

            let childStatus = 'completed';
            try {
                await processRegistration(child);
            } catch (err) {
                childStatus = 'error';
                console.error('[realestate] processamento de submissão multi-uso falhou:', err?.message);
            }

            // Registra a submissão no convite (bloqueia reenvio do mesmo CNPJ).
            await reg.update({
                submissions: [
                    ...submissions,
                    {
                        cnpj,
                        nome: form?.imobiliaria?.nome || null,
                        gerente: form?.gerente?.nome || null,
                        registration_id: child.id,
                        status: childStatus,
                        at: new Date().toISOString(),
                    },
                ],
            });

            return res.json({
                ok: true,
                multi_use: true,
                pending: childStatus === 'error',
                message: childStatus === 'error' ? PENDING_MSG : SUCCESS_MSG,
            });
        }

        // ── Link de uso único: comportamento original ───────────────────────────
        if (reg.status !== 'invite') {
            return res.status(409).json({ ok: false, error: 'Este link já foi utilizado.' });
        }

        await reg.update({ form, submitted_at: new Date() });

        try {
            await processRegistration(reg);
        } catch (err) {
            // O cadastro fica registrado com erro; o Office reprocessa. Para quem
            // preencheu, o envio foi recebido — não expor detalhes internos do CV.
            console.error('[realestate] processamento do convite falhou:', err?.message);
            return res.json({ ok: true, pending: true, message: PENDING_MSG });
        }
        return res.json({ ok: true, message: SUCCESS_MSG });
    } catch (err) {
        console.error('[realestate] submitPublicInvite:', err);
        return res.status(500).json({ ok: false, error: 'Erro ao enviar o cadastro.' });
    }
}

export async function parseCardPublic(req, res) {
    const reg = await findInviteByToken(req.params.token);
    if (!reg || reg.status === 'revoked') {
        return res.status(404).json({ ok: false, error: 'Link inválido ou cancelado.' });
    }
    // Uso único já preenchido, ou multi-uso fora da janela: não lê o cartão.
    const usable = reg.multi_use ? windowState(reg) === 'open' : reg.status === 'invite';
    if (!usable) {
        return res.status(404).json({ ok: false, error: 'Link indisponível no momento.' });
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
                error: 'Não foi possível ler o CNPJ neste PDF. Confira se o arquivo é o cartão CNPJ da Receita ou preencha os campos manualmente.',
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

// ── Credencial do painel do CV (APIs v3) ─────────────────────────────────────
//
// A associação imobiliária x empreendimento só é legível pela v3, que exige
// e-mail e senha de um usuário do CV — e o CV força troca de senha de tempos em
// tempos. Por isso a credencial é editável por tela: rotação de senha vira um
// formulário, não um deploy.

const PAINEIS_VALIDOS = ['gestor', 'corretor', 'imobiliaria'];

export async function getCvPanel(req, res) {
    try {
        const { statusV3 } = await import('../lib/apiCvV3.js');
        const status = await statusV3();

        // Nomes de quem é avisado, para a tela não mostrar só números.
        let notificados = [];
        if (status.notify_user_ids?.length) {
            notificados = await db.User.findAll({
                where: { id: status.notify_user_ids },
                attributes: ['id', 'username', 'email'],
                raw: true,
            });
        }
        return res.json({ ok: true, ...status, notificados });
    } catch (err) {
        console.error('[realestate] getCvPanel:', err);
        return res.status(500).json({ ok: false, error: 'Erro ao ler a credencial do CV.' });
    }
}

export async function updateCvPanel(req, res) {
    try {
        const patch = {};

        if (req.body.email !== undefined) {
            const email = String(req.body.email || '').trim();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                return res.status(400).json({ ok: false, error: 'Informe um e-mail válido.' });
            }
            patch.email = email;
        }

        // Senha em branco NÃO apaga a que está gravada: a tela nunca recebe a
        // senha de volta, então mandar vazio significa "não mexi neste campo".
        if (req.body.senha) patch.senha = String(req.body.senha);

        if (req.body.painel !== undefined) {
            const painel = String(req.body.painel || '').trim().toLowerCase();
            if (!PAINEIS_VALIDOS.includes(painel)) {
                return res.status(400).json({ ok: false, error: `Painel inválido. Use: ${PAINEIS_VALIDOS.join(', ')}.` });
            }
            patch.painel = painel;
        }

        if (req.body.notify_user_ids !== undefined) {
            const ids = Array.isArray(req.body.notify_user_ids)
                ? [...new Set(req.body.notify_user_ids.map(Number).filter(Number.isInteger))]
                : [];
            if (ids.length) {
                const achados = await db.User.count({ where: { id: ids } });
                if (achados !== ids.length) {
                    return res.status(400).json({ ok: false, error: 'Há usuário inexistente na lista de avisados.' });
                }
            }
            patch.notify_user_ids = ids;
        }

        if (!Object.keys(patch).length) {
            return res.status(400).json({ ok: false, error: 'Nada para salvar.' });
        }

        let s = await db.CvPanelSettings.findByPk(1);
        if (!s) s = await db.CvPanelSettings.create({ id: 1, painel: 'gestor' });
        await s.update(patch);

        // Salvar sem testar deixaria o admin achando que resolveu. Testa na
        // hora e devolve o veredito para a tela mostrar.
        const { testarCredencial, statusV3 } = await import('../lib/apiCvV3.js');
        const teste = (patch.email || patch.senha || patch.painel)
            ? await testarCredencial()
            : { ok: true, mensagem: 'Destinatários atualizados.' };

        return res.json({ ok: true, teste, ...(await statusV3()) });
    } catch (err) {
        console.error('[realestate] updateCvPanel:', err);
        return res.status(500).json({ ok: false, error: 'Erro ao salvar a credencial do CV.' });
    }
}

/** Testa a credencial já gravada, sem alterar nada. */
export async function testCvPanel(req, res) {
    try {
        const { testarCredencial, statusV3 } = await import('../lib/apiCvV3.js');
        const teste = await testarCredencial();
        return res.json({ ok: true, teste, ...(await statusV3()) });
    } catch (err) {
        console.error('[realestate] testCvPanel:', err);
        return res.status(500).json({ ok: false, error: 'Erro ao testar a credencial do CV.' });
    }
}
