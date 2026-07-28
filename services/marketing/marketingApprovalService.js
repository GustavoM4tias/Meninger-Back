// services/marketing/marketingApprovalService.js
// Aprovações de Marketing: tickets do departamento p/ a diretoria.
// Fluxo: solicitante cria ticket escolhendo perfis de autorização; cada perfil
// dá UMA decisão (qualquer membro decide por ele); todos aprovando → aprovado
// (com ressalva se alguma decisão tiver nota); qualquer reprovação encerra.
// Centro de custo = cdempreendview do Sienge (leitura ao vivo do backup).
import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import { siengeQuery } from '../../lib/siengeReadDb.js';
import NotificationService from '../notification/NotificationService.js';
import { NotificationType } from '../notification/notificationTypes.js';

const plain = (r) => (r?.get ? r.get({ plain: true }) : r);
const normIds = (arr) => (Array.isArray(arr) ? [...new Set(arr.map(Number).filter(Boolean))] : []);

const STATUS_LABEL = {
    pending: 'Pendente',
    approved: 'Aprovada',
    approved_with_notes: 'Aprovada com ressalva',
    rejected: 'Reprovada',
    cancelled: 'Cancelada',
};

function httpError(message, status, code = null) {
    const e = new Error(message);
    e.httpStatus = status;
    if (code) e.code = code;
    return e;
}

// ── Settings (linha única, lazy) ──────────────────────────────────────────────

export async function getSettings() {
    const row = await db.MarketingApprovalSettings.findOne();
    return plain(row || await db.MarketingApprovalSettings.create({}));
}

export async function updateSettings({ payload = {}, userId }) {
    const row = (await db.MarketingApprovalSettings.findOne()) || (await db.MarketingApprovalSettings.create({}));
    if (Array.isArray(payload.types)) {
        const types = payload.types
            .map((t) => ({
                key: String(t.key || '').trim(),
                label: String(t.label || '').trim(),
                active: t.active !== false,
            }))
            .filter((t) => t.key && t.label);
        if (!types.length) throw httpError('Informe ao menos um tipo de solicitação.', 400);
        row.types = types;
    }
    if ('reminder_days' in payload) {
        const days = Number(payload.reminder_days);
        if (!Number.isInteger(days) || days < 1) throw httpError('reminder_days deve ser um inteiro >= 1.', 400);
        row.reminder_days = days;
    }
    row.updated_by = userId || null;
    await row.save();
    return plain(row);
}

export async function listActiveTypes() {
    const settings = await getSettings();
    return (settings.types || []).filter((t) => t.active !== false);
}

// ── Perfis de autorização (admin gerencia; mesmo padrão do checklist) ─────────

export async function listProfiles() {
    const rows = await db.MarketingApprovalAuthProfile.findAll({ order: [['name', 'ASC']] });
    return rows.map(plain);
}

export async function createProfile({ payload = {}, userId }) {
    const name = (payload.name || '').trim();
    if (!name) throw httpError('Nome do perfil é obrigatório.', 400);
    const userIds = normIds(payload.user_ids);
    if (!userIds.length) throw httpError('O perfil precisa de ao menos um membro.', 400);
    const row = await db.MarketingApprovalAuthProfile.create({
        name,
        description: payload.description?.trim() || null,
        user_ids: userIds,
        is_active: payload.is_active !== false,
        created_by: userId || null,
        updated_by: userId || null,
    });
    return plain(row);
}

export async function updateProfile({ id, payload = {}, userId }) {
    const row = await db.MarketingApprovalAuthProfile.findByPk(Number(id));
    if (!row) throw httpError('Perfil não encontrado.', 404);
    if ('name' in payload) row.name = (payload.name || '').trim() || row.name;
    if ('description' in payload) row.description = payload.description?.trim() || null;
    if ('user_ids' in payload) {
        const userIds = normIds(payload.user_ids);
        if (!userIds.length) throw httpError('O perfil precisa de ao menos um membro.', 400);
        row.user_ids = userIds;
    }
    if ('is_active' in payload) row.is_active = !!payload.is_active;
    row.updated_by = userId || null;
    await row.save();
    return plain(row);
}

async function activeProfilesByIds(profileIds = []) {
    const ids = normIds(profileIds);
    if (!ids.length) return [];
    return db.MarketingApprovalAuthProfile.findAll({ where: { id: ids, is_active: true }, raw: true });
}

export async function profilesForUser(userId) {
    if (!userId) return [];
    const rows = await db.MarketingApprovalAuthProfile.findAll({ where: { is_active: true }, raw: true });
    return rows.filter((p) => (p.user_ids || []).map(Number).includes(Number(userId)));
}

// Membro de qualquer perfil ativo = "aprovador" (vê todos os tickets).
export async function approvalMe(user) {
    const profiles = await profilesForUser(user.id);
    return {
        isApprover: profiles.length > 0,
        isAdmin: user.role === 'admin',
        profileIds: profiles.map((p) => p.id),
    };
}

// Lista de usuários internos p/ montar perfis (admin) — padrão do checklist.
export async function listUsers() {
    return db.User.findAll({
        where: { status: true },
        attributes: ['id', 'username', 'email', 'position'],
        order: [['username', 'ASC']],
        raw: true,
    });
}

// ── Centros de custo (Sienge ao vivo, cache TTL em memória) ───────────────────

const CC_CACHE_TTL_MS = Number(process.env.MARKETING_APPROVAL_CC_TTL_MS || 10 * 60 * 1000);
let _ccCache = { at: 0, items: null };

export async function listCostCenters() {
    if (_ccCache.items && Date.now() - _ccCache.at < CC_CACHE_TTL_MS) {
        return { items: _ccCache.items };
    }
    try {
        const res = await siengeQuery(`
            SELECT cdempreendview AS code, nmempreend AS name
            FROM ecadempreend
            WHERE cdempreendview IS NOT NULL
            ORDER BY nmempreend NULLS LAST
        `);
        // Override administrativo de nome (mesma precedência das telas de Custos).
        const overrides = await db.CostCenterOverride.findAll({
            attributes: ['cost_center_id', 'display_name'], raw: true,
        }).catch(() => []);
        const nameByCc = new Map(overrides.map((o) => [Number(o.cost_center_id), o.display_name]));
        const items = res.rows.map((r) => ({
            code: Number(r.code),
            name: nameByCc.get(Number(r.code)) || r.name || `CC ${r.code}`,
        }));
        _ccCache = { at: Date.now(), items };
        return { items };
    } catch (err) {
        // Sienge fora do ar não pode travar o form — o vínculo é opcional.
        console.warn('[marketingApproval.listCostCenters]', err?.message || err);
        return { items: _ccCache.items || [], unavailable: true };
    }
}

// ── Protocolo sequencial MKT-ANO-SEQ ──────────────────────────────────────────

async function nextProtocol(year, t) {
    const max = await db.MarketingApprovalRequest.max('protocol_seq', {
        where: { protocol_year: year }, transaction: t,
    });
    const seq = (Number(max) || 0) + 1;
    return { year, seq, protocol: `MKT-${year}-${String(seq).padStart(4, '0')}` };
}

// ── Notificações (best-effort, nunca lançam) ──────────────────────────────────

async function notifyRequested({ request, actorId }) {
    try {
        const profiles = await activeProfilesByIds(request.auth_profile_ids);
        const userIds = [...new Set(profiles.flatMap((p) => (p.user_ids || []).map(Number)))]
            .filter((u) => u && u !== actorId);
        if (!userIds.length) return;
        const amount = Number(request.amount).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
        await NotificationService.notify({
            type: NotificationType.MARKETING_APPROVAL_REQUESTED,
            recipients: { users: userIds },
            title: `Aprovação pendente ${request.protocol}: ${request.type_label}`,
            body: `${amount}${request.cost_center_name ? ` · ${request.cost_center_name}` : ''}`,
            data: { requestId: request.id, protocol: request.protocol },
            link: `/aprovacoes/${request.id}`,
            importance: 7,
        });
    } catch (err) { console.warn('[marketingApproval.notifyRequested]', err?.message || err); }
}

async function notifyDecided({ request, note }) {
    try {
        const resultLabel = STATUS_LABEL[request.status] || request.status;
        await NotificationService.notify({
            type: NotificationType.MARKETING_APPROVAL_DECIDED,
            recipients: { users: [request.requester_id] },
            title: `${resultLabel}: ${request.protocol} (${request.type_label})`,
            body: note || null,
            data: {
                requestId: request.id,
                protocol: request.protocol,
                resultLabel,
                note: note || '-',
            },
            link: `/aprovacoes/${request.id}`,
            importance: 7,
        });
    } catch (err) { console.warn('[marketingApproval.notifyDecided]', err?.message || err); }
}

// Dispara o template WhatsApp com botões (módulo próprio; import dinâmico para
// evitar ciclo — o módulo WhatsApp importa este service p/ decidir via botão).
async function dispatchWhatsApp(request) {
    try {
        const { sendApprovalRequests } = await import('./marketingApprovalWhatsApp.js');
        await sendApprovalRequests(request);
    } catch (err) { console.warn('[marketingApproval.dispatchWhatsApp]', err?.message || err); }
}

// ── Tickets ───────────────────────────────────────────────────────────────────

const ATTACHMENT_FIELDS = ['file_name', 'mime_type', 'url', 'storage_path', 'size'];

function normalizeItems(raw) {
    return (Array.isArray(raw) ? raw : [])
        .map((it) => ({
            name: String(it?.name || '').trim(),
            description: String(it?.description || '').trim() || null,
            amount: Number(it?.amount),
        }))
        .filter((it) => it.name && Number.isFinite(it.amount) && it.amount >= 0);
}

function normalizeAttachment(payload = {}, userId) {
    if (!payload.url || !payload.file_name) return null;
    const att = { uploaded_by: userId || null };
    for (const f of ATTACHMENT_FIELDS) att[f] = payload[f] ?? null;
    att.kind = String(payload.mime_type || '').startsWith('image/') ? 'IMAGE' : 'FILE';
    return att;
}

export async function createRequest({ payload = {}, user }) {
    const types = await listActiveTypes();
    const type = types.find((t) => t.key === payload.type_key);
    if (!type) throw httpError('Tipo de solicitação inválido ou inativo.', 400);

    // Itens da ficha (nome, descrição, valor). Vários itens = várias aprovações
    // numa só ficha; o valor total é a soma deles.
    const items = normalizeItems(payload.items);
    if (!items.length) throw httpError('Adicione ao menos um item com nome e valor.', 400);
    const amount = items.reduce((sum, i) => sum + i.amount, 0);

    // Descrição geral opcional; se vazia, sintetiza a partir dos nomes dos itens
    // (mantém a coluna NOT NULL preenchida e a busca/listagem com texto útil).
    const description = (payload.description || '').trim()
        || items.map((i) => i.name).join(', ').slice(0, 500);

    const profileIds = normIds(payload.auth_profile_ids);
    if (!profileIds.length) throw httpError('Selecione ao menos um perfil de autorização.', 400);
    const profiles = await activeProfilesByIds(profileIds);
    if (profiles.length !== profileIds.length) {
        throw httpError('Perfil de autorização inválido ou inativo.', 400);
    }

    // Snapshot do nome do CC (cache Sienge; se indisponível, usa o que o front mandou).
    let costCenterId = payload.cost_center_id ? Number(payload.cost_center_id) : null;
    let costCenterName = null;
    if (costCenterId) {
        const { items } = await listCostCenters();
        costCenterName = items.find((c) => c.code === costCenterId)?.name
            || (payload.cost_center_name || '').trim() || null;
        if (!costCenterName) throw httpError('Centro de custo não encontrado.', 400);
    }

    const attachments = (Array.isArray(payload.attachments) ? payload.attachments : [])
        .map((a) => normalizeAttachment(a, user.id)).filter(Boolean);

    const year = new Date().getFullYear();
    let request = null;
    // Retry na colisão do protocolo (unique year+seq) — criações concorrentes.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            request = await db.sequelize.transaction(async (t) => {
                const { seq, protocol } = await nextProtocol(year, t);
                const row = await db.MarketingApprovalRequest.create({
                    protocol,
                    protocol_year: year,
                    protocol_seq: seq,
                    requester_id: user.id,
                    type_key: type.key,
                    type_label: type.label,
                    cost_center_id: costCenterId,
                    cost_center_name: costCenterName,
                    description,
                    justification: (payload.justification || '').trim() || null,
                    items,
                    amount,
                    supplier: (payload.supplier || '').trim() || null,
                    due_date: payload.due_date || null,
                    auth_profile_ids: profileIds,
                    approval_history: [{
                        action: 'created', user_id: user.id, username: user.username,
                        at: new Date().toISOString(), note: null,
                    }],
                }, { transaction: t });
                if (attachments.length) {
                    await db.MarketingApprovalAttachment.bulkCreate(
                        attachments.map((a) => ({ ...a, request_id: row.id })),
                        { transaction: t },
                    );
                }
                return row;
            });
            break;
        } catch (err) {
            if (err?.name === 'SequelizeUniqueConstraintError' && attempt < 3) continue;
            throw err;
        }
    }

    const created = plain(request);
    await notifyRequested({ request: created, actorId: user.id });
    await dispatchWhatsApp(created);
    return getOne({ id: created.id, user });
}

export async function list({ user, filters = {} }) {
    const me = await approvalMe(user);
    const where = {};
    if (!me.isApprover && !me.isAdmin) where.requester_id = user.id;
    if (filters.status) where.status = filters.status;
    if (filters.type_key) where.type_key = filters.type_key;
    if (filters.cost_center_id) where.cost_center_id = Number(filters.cost_center_id);
    if (filters.from || filters.to) {
        where.created_at = {};
        if (filters.from) where.created_at[Op.gte] = new Date(`${filters.from}T00:00:00`);
        if (filters.to) where.created_at[Op.lte] = new Date(`${filters.to}T23:59:59`);
    }
    if (filters.q) {
        const q = `%${String(filters.q).trim()}%`;
        where[Op.or] = [
            { protocol: { [Op.iLike]: q } },
            { description: { [Op.iLike]: q } },
            { supplier: { [Op.iLike]: q } },
        ];
    }
    // "Pendentes de mim": tickets pendentes em que algum perfil MEU ainda não decidiu.
    if (filters.mine === 'pending' && me.profileIds.length) {
        where.status = 'pending';
    }

    const limit = Math.min(Number(filters.limit) || 50, 200);
    const offset = Number(filters.offset) || 0;
    const { rows, count } = await db.MarketingApprovalRequest.findAndCountAll({
        where,
        include: [
            { association: 'requester', attributes: ['id', 'username'], required: false },
            { association: 'decisions', required: false },
        ],
        order: [['created_at', 'DESC']],
        limit, offset, distinct: true,
    });

    let items = rows.map(plain);
    if (filters.mine === 'pending' && me.profileIds.length) {
        items = items.filter((r) => {
            const decided = new Set((r.decisions || []).map((d) => d.profile_id));
            return (r.auth_profile_ids || []).some((p) => me.profileIds.includes(Number(p)) && !decided.has(Number(p)));
        });
    }
    return { items, total: count, me };
}

export async function getOne({ id, user }) {
    const row = await db.MarketingApprovalRequest.findByPk(Number(id), {
        include: [
            { association: 'requester', attributes: ['id', 'username', 'email'], required: false },
            {
                association: 'decisions',
                required: false,
                include: [
                    { association: 'user', attributes: ['id', 'username'], required: false },
                    { association: 'profile', attributes: ['id', 'name'], required: false },
                ],
            },
            { association: 'attachments', required: false },
        ],
        order: [[{ model: db.MarketingApprovalDecision, as: 'decisions' }, 'created_at', 'ASC']],
    });
    if (!row) throw httpError('Solicitação não encontrada.', 404);
    const request = plain(row);

    const me = await approvalMe(user);
    const isRequester = Number(request.requester_id) === Number(user.id);
    if (!isRequester && !me.isApprover && !me.isAdmin) {
        throw httpError('Sem acesso a esta solicitação.', 403);
    }

    // Estado por perfil p/ a UI (nome + decidido/pendente + se EU posso decidir).
    const profiles = await db.MarketingApprovalAuthProfile.findAll({
        where: { id: normIds(request.auth_profile_ids) }, raw: true,
    });
    const decidedByProfile = new Map((request.decisions || []).map((d) => [Number(d.profile_id), d]));
    request.profiles_state = profiles.map((p) => ({
        id: p.id,
        name: p.name,
        decision: decidedByProfile.get(Number(p.id)) || null,
        can_decide: request.status === 'pending'
            && !decidedByProfile.has(Number(p.id))
            && (p.user_ids || []).map(Number).includes(Number(user.id)),
    }));
    request.viewer = { ...me, isRequester };
    return request;
}

// Núcleo da decisão. A decisão do usuário vale para TODOS os perfis pendentes
// dele no ticket. Reprovação encerra na hora; ticket aprova quando todos os
// perfis tiverem decisão (ressalva em qualquer um → approved_with_notes).
export async function decide({ id, payload = {}, user, via = 'office' }) {
    const decision = String(payload.decision || '').trim();
    if (!['approved', 'approved_with_notes', 'rejected'].includes(decision)) {
        throw httpError('Decisão inválida.', 400);
    }
    const comment = (payload.comment || '').trim() || null;
    if (!comment && decision !== 'approved') {
        throw httpError(decision === 'rejected'
            ? 'Justificativa é obrigatória para reprovar.'
            : 'Descreva a ressalva para aprovar com ressalva.', 400);
    }

    const result = await db.sequelize.transaction(async (t) => {
        const row = await db.MarketingApprovalRequest.findByPk(Number(id), {
            transaction: t, lock: t.LOCK.UPDATE,
        });
        if (!row) throw httpError('Solicitação não encontrada.', 404);
        if (row.status !== 'pending') {
            throw httpError(`Solicitação já ${STATUS_LABEL[row.status]?.toLowerCase() || 'decidida'}.`, 409, 'ALREADY_DECIDED');
        }

        const authIds = normIds(row.auth_profile_ids);
        const profiles = await db.MarketingApprovalAuthProfile.findAll({
            where: { id: authIds }, raw: true, transaction: t,
        });
        const myProfiles = profiles.filter((p) => (p.user_ids || []).map(Number).includes(Number(user.id)));
        const existing = await db.MarketingApprovalDecision.findAll({
            where: { request_id: row.id }, raw: true, transaction: t,
        });
        const decidedSet = new Set(existing.map((d) => Number(d.profile_id)));
        const pendingMine = myProfiles.filter((p) => !decidedSet.has(Number(p.id)));
        if (!pendingMine.length) {
            throw httpError('Você não tem autorização pendente nesta solicitação.', 403);
        }

        const now = new Date();
        await db.MarketingApprovalDecision.bulkCreate(pendingMine.map((p) => ({
            request_id: row.id,
            profile_id: p.id,
            user_id: user.id,
            decision,
            comment,
            via,
        })), { transaction: t });

        const history = [...(row.approval_history || [])];
        for (const p of pendingMine) {
            history.push({
                action: decision, user_id: user.id, username: user.username,
                profile_id: p.id, profile_name: p.name,
                at: now.toISOString(), note: comment,
            });
        }

        const allDecisions = [
            ...existing,
            ...pendingMine.map((p) => ({ profile_id: p.id, decision, comment })),
        ];
        let finalized = false;
        if (decision === 'rejected') {
            row.status = 'rejected';
            finalized = true;
        } else if (authIds.every((pid) => allDecisions.some((d) => Number(d.profile_id) === pid))) {
            row.status = allDecisions.some((d) => d.decision === 'approved_with_notes')
                ? 'approved_with_notes' : 'approved';
            finalized = true;
        }
        if (finalized) row.finalized_at = now;
        row.approval_history = history;
        row.changed('approval_history', true);
        await row.save({ transaction: t });

        const notes = allDecisions.map((d) => d.comment).filter(Boolean);
        return { request: plain(row), finalized, note: notes.join(' · ') || null };
    });

    if (result.finalized) {
        await notifyDecided({ request: result.request, note: result.note });
        // Botões pendentes de outros aprovadores não valem mais.
        await db.MarketingApprovalWaMessage.update(
            { status: 'expired' },
            { where: { request_id: result.request.id, status: 'sent' } },
        ).catch(() => {});
    }
    return getOne({ id: result.request.id, user });
}

export async function cancel({ id, user }) {
    const request = await db.sequelize.transaction(async (t) => {
        const row = await db.MarketingApprovalRequest.findByPk(Number(id), {
            transaction: t, lock: t.LOCK.UPDATE,
        });
        if (!row) throw httpError('Solicitação não encontrada.', 404);
        const isRequester = Number(row.requester_id) === Number(user.id);
        if (!isRequester && user.role !== 'admin') throw httpError('Só o solicitante pode cancelar.', 403);
        if (row.status !== 'pending') {
            throw httpError('Só solicitações pendentes podem ser canceladas.', 409);
        }
        const now = new Date();
        row.status = 'cancelled';
        row.cancelled_at = now;
        row.approval_history = [...(row.approval_history || []), {
            action: 'cancelled', user_id: user.id, username: user.username,
            at: now.toISOString(), note: null,
        }];
        row.changed('approval_history', true);
        await row.save({ transaction: t });
        return plain(row);
    });

    await db.MarketingApprovalWaMessage.update(
        { status: 'expired' },
        { where: { request_id: request.id, status: 'sent' } },
    ).catch(() => {});
    return getOne({ id: request.id, user });
}

export async function addAttachment({ id, payload = {}, user }) {
    const row = await db.MarketingApprovalRequest.findByPk(Number(id));
    if (!row) throw httpError('Solicitação não encontrada.', 404);
    if (Number(row.requester_id) !== Number(user.id) && user.role !== 'admin') {
        throw httpError('Só o solicitante pode anexar.', 403);
    }
    if (row.status !== 'pending') throw httpError('Solicitação já decidida: anexos bloqueados.', 409);
    const att = normalizeAttachment(payload, user.id);
    if (!att) throw httpError('Anexo inválido (url e file_name são obrigatórios).', 400);
    const created = await db.MarketingApprovalAttachment.create({ ...att, request_id: row.id });
    return plain(created);
}

export async function removeAttachment({ attachmentId, user }) {
    const att = await db.MarketingApprovalAttachment.findByPk(Number(attachmentId));
    if (!att) throw httpError('Anexo não encontrado.', 404);
    const row = await db.MarketingApprovalRequest.findByPk(att.request_id);
    if (Number(row?.requester_id) !== Number(user.id) && user.role !== 'admin') {
        throw httpError('Só o solicitante pode remover anexos.', 403);
    }
    if (row.status !== 'pending') throw httpError('Solicitação já decidida: anexos bloqueados.', 409);
    await att.destroy();
    return { ok: true };
}

// PDF de autorização. Aprovada (com ou sem ressalva) → comprovante com as
// decisões. Pendente → versão p/ coleta de assinatura presencial (quadros em
// branco por perfil; ver registerSignedDocument). getOne já aplica o gate de
// acesso (requester/aprovador/admin) e traz decisões+requester+profiles_state.
export async function generateAuthorizationPdf({ id, user }) {
    const request = await getOne({ id, user });
    if (!['pending', 'approved', 'approved_with_notes'].includes(request.status)) {
        throw httpError('PDF indisponível para solicitações reprovadas ou canceladas.', 409);
    }
    const { default: pdfService } = await import('./marketingApprovalPdfService.js');
    const buffer = await pdfService.render({ request });
    return { buffer, protocol: request.protocol };
}

// ── Autorização assinada fora do sistema ──────────────────────────────────────
// Fluxo: o solicitante imprime o PDF pendente, colhe as assinaturas em papel e
// anexa o documento assinado (qualquer arquivo) como comprovante. O anexo
// aprova TODOS os perfis pendentes de uma vez, em nome de quem anexou
// (via='signature', anexo vinculado como evidência). O registro guarda quem
// pediu e quem anexou — não quem assinou no papel.

export async function registerSignedDocument({ id, payload = {}, user }) {
    const request = await getOne({ id, user }); // gate de acesso
    if (!request.viewer.isRequester && !request.viewer.isAdmin) {
        throw httpError('Só o solicitante pode anexar o documento de autorização.', 403);
    }
    if (request.status !== 'pending') {
        throw httpError(`Solicitação já ${STATUS_LABEL[request.status]?.toLowerCase() || 'decidida'}.`, 409, 'ALREADY_DECIDED');
    }

    const att = normalizeAttachment(payload, user.id);
    if (!att) throw httpError('Anexo inválido (url e file_name são obrigatórios).', 400);
    att.kind = 'SIGNED_DOCUMENT';

    const result = await db.sequelize.transaction(async (t) => {
        const row = await db.MarketingApprovalRequest.findByPk(Number(id), {
            transaction: t, lock: t.LOCK.UPDATE,
        });
        if (!row || row.status !== 'pending') {
            throw httpError('Solicitação já decidida.', 409, 'ALREADY_DECIDED');
        }

        const authIds = normIds(row.auth_profile_ids);
        const existing = await db.MarketingApprovalDecision.findAll({
            where: { request_id: row.id }, raw: true, transaction: t,
        });
        const decidedSet = new Set(existing.map((d) => Number(d.profile_id)));
        const pendingIds = authIds.filter((pid) => !decidedSet.has(pid));
        if (!pendingIds.length) throw httpError('Não há autorizações pendentes nesta solicitação.', 409);

        const evidence = await db.MarketingApprovalAttachment.create(
            { ...att, request_id: row.id }, { transaction: t },
        );

        const comment = 'Autorização assinada fora do sistema — documento anexado como comprovante.';
        await db.MarketingApprovalDecision.bulkCreate(pendingIds.map((pid) => ({
            request_id: row.id,
            profile_id: pid,
            user_id: user.id,
            decision: 'approved',
            comment,
            via: 'signature',
            attachment_id: evidence.id,
        })), { transaction: t });

        const now = new Date();
        row.status = existing.some((d) => d.decision === 'approved_with_notes')
            ? 'approved_with_notes' : 'approved';
        row.finalized_at = now;
        row.approval_history = [...(row.approval_history || []), {
            action: 'signed', user_id: user.id, username: user.username,
            at: now.toISOString(), note: att.file_name,
        }];
        row.changed('approval_history', true);
        await row.save({ transaction: t });
        return plain(row);
    });

    await notifyDecided({ request: result, note: null });
    await db.MarketingApprovalWaMessage.update(
        { status: 'expired' },
        { where: { request_id: result.id, status: 'sent' } },
    ).catch(() => {});
    return getOne({ id, user });
}

export default {
    getSettings, updateSettings, listActiveTypes,
    listProfiles, createProfile, updateProfile, profilesForUser, approvalMe, listUsers,
    listCostCenters,
    createRequest, list, getOne, decide, cancel,
    addAttachment, removeAttachment, generateAuthorizationPdf, registerSignedDocument,
};
