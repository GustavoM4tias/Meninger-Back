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

// Normalização compatível com a lógica de cidade usada no resto do sistema:
// sem acento, maiúsculas, não-alfanumérico vira espaço.
const normCity = (s) => ` ${String(s || '')
    .normalize('NFD').replace(/\p{M}/gu, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, ' ')
    .trim()} `;
const cityMatches = (value, needle) => {
    const n = normCity(needle);
    return n.trim() ? normCity(value).includes(n) : true;
};

export async function syncImobiliarias(req, res) {
    try {
        const { default: ImobiliariaSyncService } = await import('../services/bulkData/cv/ImobiliariaSyncService.js');
        const count = await new ImobiliariaSyncService().syncAll();
        return res.json({ ok: true, count });
    } catch (err) {
        console.error('[realestate] syncImobiliarias:', err);
        return res.status(502).json({ ok: false, error: 'Erro ao sincronizar imobiliárias do CV.' });
    }
}

export async function getImobiliariasReport(req, res) {
    try {
        // Primeira visita sem backup: sincroniza na hora (uma chamada ao CV).
        let total = await db.CvImobiliaria.count();
        if (!total) {
            const { default: ImobiliariaSyncService } = await import('../services/bulkData/cv/ImobiliariaSyncService.js');
            await new ImobiliariaSyncService().syncAll().catch(e =>
                console.error('[realestate] sync inicial falhou:', e?.message));
        }

        const [imobs, links, ents, regs] = await Promise.all([
            db.CvImobiliaria.findAll({ order: [['nome', 'ASC']], raw: true }),
            // Vínculo por atividade: reservas ligam imobiliária (cnpj) a empreendimento (nome).
            db.sequelize.query(`
                SELECT DISTINCT (imobiliaria->>'cnpj') AS cnpj, empreendimento
                FROM reservas
                WHERE COALESCE(imobiliaria->>'cnpj', '') <> '' AND COALESCE(empreendimento, '') <> ''
            `, { type: db.Sequelize.QueryTypes.SELECT }),
            db.sequelize.query(
                'SELECT idempreendimento, nome, cidade, foto_listagem, foto, logo, situacao_obra_nome FROM cv_enterprises',
                { type: db.Sequelize.QueryTypes.SELECT }
            ),
            // Vínculo por cadastro do Office: associações escolhidas na criação.
            db.RealEstateRegistration.findAll({ where: { status: 'completed' }, raw: true }),
        ]);

        const entById = new Map(ents.map(e => [Number(e.idempreendimento), e]));
        const entByName = new Map(ents.map(e => [normCity(e.nome).trim(), e]));

        // Card básico do empreendimento no relatório (foto p/ o front).
        const entCard = (hit, fallbackNome) => hit
            ? {
                id: Number(hit.idempreendimento),
                nome: hit.nome,
                cidade: hit.cidade || null,
                foto: hit.foto_listagem || hit.foto || hit.logo || null,
                situacao: hit.situacao_obra_nome || null,
            }
            : { id: null, nome: fallbackNome, cidade: null, foto: null, situacao: null };

        // cnpj → Map(idOuNome → entCard)
        const linksByCnpj = new Map();
        const addLink = (cnpj, ent) => {
            if (!cnpj || !ent?.nome) return;
            const key = onlyDigits(cnpj);
            if (!linksByCnpj.has(key)) linksByCnpj.set(key, new Map());
            linksByCnpj.get(key).set(ent.id ?? normCity(ent.nome).trim(), ent);
        };

        for (const l of links) {
            const hit = entByName.get(normCity(l.empreendimento).trim());
            addLink(l.cnpj, entCard(hit, l.empreendimento));
        }
        // Cadastros do Office: origem (interno x link) + gerente de fallback.
        const regByCnpj = new Map();
        for (const r of regs) {
            const cnpj = onlyDigits(r.form?.imobiliaria?.cnpj);
            if (cnpj) regByCnpj.set(cnpj, r);
            for (const e of (r.enterprises || [])) {
                const hit = entById.get(Number(e.id));
                addLink(cnpj, hit ? entCard(hit) : { id: Number(e.id), nome: e.nome, cidade: null, foto: null, situacao: null });
            }
        }

        const q = String(req.query.q || '').trim();
        const cidadeFilter = String(req.query.cidade || '').trim();
        const entFilter = String(req.query.empreendimento || '').trim();
        const isUserAdmin = isAdmin(req);
        const userCity = req.user?.city || '';

        const rows = [];
        for (const i of imobs) {
            const vinculos = [...(linksByCnpj.get(onlyDigits(i.cnpj)) || new Map()).values()];
            // Cidade efetiva: a da própria imobiliária; sem endereço, herda as
            // cidades dos empreendimentos vinculados.
            const cidades = i.cidade
                ? [i.cidade]
                : [...new Set(vinculos.map(v => v.cidade).filter(Boolean))];

            // Escopo de acesso: não-admin só vê imobiliárias das suas cidades.
            if (!isUserAdmin) {
                if (!cidades.length) continue;
                if (!cidades.some(c => cityMatches(c, userCity))) continue;
            }

            if (cidadeFilter && !cidades.some(c => cityMatches(c, cidadeFilter))) continue;
            if (entFilter && !vinculos.some(v =>
                String(v.id) === entFilter || cityMatches(v.nome, entFilter))) continue;
            if (q) {
                const alvo = normCity(`${i.nome} ${i.razao_social} ${i.cnpj} ${i.gerente_nome || ''}`);
                if (!alvo.includes(normCity(q))) continue;
            }

            // Origem: cadastrada pelo Office (via link público ou tela interna)
            // ou direto no CV. O codigointerno OFFICE-<id> cobre cadastros cujo
            // registro local se perdeu.
            const reg = regByCnpj.get(onlyDigits(i.cnpj));
            const origem = reg
                ? (reg.source === 'public' ? 'link' : 'office')
                : (String(i.raw?.codigointerno || '').startsWith('OFFICE-') ? 'office' : 'cv');

            // Gerente: campos do CV; vazios em cadastros do Office (o gerente lá
            // vira usuário-imobiliária) → fallback para o formulário enviado.
            const regGer = reg?.form?.gerente || {};

            rows.push({
                idimobiliaria: i.idimobiliaria,
                nome: i.nome,
                razao_social: i.razao_social,
                cnpj: i.cnpj,
                sigla: i.sigla,
                creci: i.creci,
                validade_creci: i.validade_creci,
                ativo: i.ativo,
                ativo_painel: i.ativo_painel,
                micro_empresa: i.micro_empresa,
                origem,
                email: i.email,
                telefone: i.telefone,
                celular: i.celular,
                gerente_nome: i.gerente_nome || regGer.nome || null,
                gerente_email: i.gerente_email || regGer.email || null,
                gerente_celular: i.gerente_celular || regGer.celular || null,
                gerente_telefone: i.raw?.gerente_telefone || regGer.telefone || null,
                gerente_cpf: i.raw?.gerente_cpf || regGer.documento || null,
                cidade: i.cidade,
                estado: i.estado,
                cidades,
                cidade_origem: i.cidade ? 'imobiliaria' : (cidades.length ? 'empreendimentos' : null),
                empreendimentos: vinculos.sort((a, b) => String(a.nome).localeCompare(String(b.nome))),
                data_cad: i.data_cad,
                synced_at: i.synced_at,
            });
        }

        const lastSync = imobs.reduce((max, i) =>
            (!max || (i.synced_at && i.synced_at > max)) ? i.synced_at : max, null);

        return res.json({ ok: true, total: rows.length, last_sync: lastSync, imobiliarias: rows });
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
