// services/academy/prerequisiteService.js
//
// Pré-requisitos entre trilhas. Cada trilha pode exigir que outras estejam
// completas (STRICT) ou iniciadas (LENIENT) antes que o aluno consiga acessar.
//
// Integração:
//   - trackService.listTracks / getTrack chamam isUnlocked() para marcar trilhas LOCKED
//   - markProgress (transição → COMPLETED) dispara notify nas trilhas que dependiam dela

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import NotificationService from '../notification/NotificationService.js';
import { NotificationType } from '../notification/notificationTypes.js';

const POLICIES = ['STRICT', 'LENIENT'];

function normalizePolicy(p) {
    const v = String(p || 'STRICT').toUpperCase();
    return POLICIES.includes(v) ? v : 'STRICT';
}

const prerequisiteService = {
    async list({ trackSlug }) {
        const slug = String(trackSlug || '').trim();
        if (!slug) throw new Error('Slug inválido.');
        const rows = await db.AcademyTrackPrerequisite.findAll({
            where: { trackSlug: slug },
            attributes: ['id', 'trackSlug', 'requiredTrackSlug', 'policy', 'createdAt'],
            order: [['createdAt', 'ASC']],
            raw: true,
        });

        // anexa título da required track (snapshot leve)
        const requiredSlugs = [...new Set(rows.map(r => r.requiredTrackSlug))];
        const tracks = requiredSlugs.length
            ? await db.AcademyTrack.findAll({
                where: { slug: { [Op.in]: requiredSlugs } },
                attributes: ['slug', 'title', 'status'],
                raw: true,
            })
            : [];
        const titleBySlug = Object.fromEntries(tracks.map(t => [t.slug, t.title]));
        const statusBySlug = Object.fromEntries(tracks.map(t => [t.slug, t.status]));

        return {
            results: rows.map(r => ({
                ...r,
                requiredTrackTitle: titleBySlug[r.requiredTrackSlug] || r.requiredTrackSlug,
                requiredTrackStatus: statusBySlug[r.requiredTrackSlug] || 'UNKNOWN',
            })),
        };
    },

    async add({ trackSlug, requiredTrackSlug, policy }) {
        const slug = String(trackSlug || '').trim();
        const reqSlug = String(requiredTrackSlug || '').trim();
        if (!slug || !reqSlug) throw new Error('Slug inválido.');
        if (slug === reqSlug) throw new Error('Trilha não pode ser pré-requisito de si mesma.');

        // valida que ambas as trilhas existem
        const [track, reqTrack] = await Promise.all([
            db.AcademyTrack.findOne({ where: { slug }, attributes: ['id'], raw: true }),
            db.AcademyTrack.findOne({ where: { slug: reqSlug }, attributes: ['id'], raw: true }),
        ]);
        if (!track) throw new Error('Trilha não encontrada.');
        if (!reqTrack) throw new Error('Trilha de pré-requisito não encontrada.');

        // anti-ciclo: a trilha pré-requisito não pode ter ESTA trilha como pré-req (direto ou transitivo)
        const wouldCycle = await prerequisiteService.checkCycle(slug, reqSlug);
        if (wouldCycle) {
            throw new Error('Esta dependência criaria um ciclo entre trilhas.');
        }

        try {
            const created = await db.AcademyTrackPrerequisite.create({
                trackSlug: slug,
                requiredTrackSlug: reqSlug,
                policy: normalizePolicy(policy),
            });
            return { prerequisite: created.toJSON() };
        } catch (err) {
            if (err?.name === 'SequelizeUniqueConstraintError') {
                throw new Error('Este pré-requisito já existe.');
            }
            throw err;
        }
    },

    async remove({ id }) {
        const row = await db.AcademyTrackPrerequisite.findByPk(Number(id));
        if (!row) throw new Error('Pré-requisito não encontrado.');
        await row.destroy();
        return { ok: true };
    },

    /**
     * Detecta ciclo: se eu adicionar trackSlug → requiredTrackSlug, requiredTrackSlug
     * (transitivamente) depende de trackSlug?
     * BFS no grafo de pré-requisitos.
     */
    async checkCycle(trackSlug, requiredTrackSlug) {
        // Pega TODO o grafo (em produção, trilhas são poucas — OK ler tudo).
        const all = await db.AcademyTrackPrerequisite.findAll({
            attributes: ['trackSlug', 'requiredTrackSlug'],
            raw: true,
        });
        const graph = new Map(); // trackSlug → [requiredTrackSlug...]
        for (const r of all) {
            if (!graph.has(r.trackSlug)) graph.set(r.trackSlug, []);
            graph.get(r.trackSlug).push(r.requiredTrackSlug);
        }
        // Adiciona a aresta proposta
        if (!graph.has(trackSlug)) graph.set(trackSlug, []);
        graph.get(trackSlug).push(requiredTrackSlug);

        // BFS partindo de requiredTrackSlug. Se alcançar trackSlug → ciclo.
        const visited = new Set();
        const queue = [requiredTrackSlug];
        while (queue.length) {
            const cur = queue.shift();
            if (cur === trackSlug) return true;
            if (visited.has(cur)) continue;
            visited.add(cur);
            const next = graph.get(cur) || [];
            for (const n of next) queue.push(n);
        }
        return false;
    },

    /**
     * Devolve estado de bloqueio de UMA trilha para UM user.
     * Retorna { locked: bool, blockedBy: [{slug, title, policy, userProgressPercent}] }
     */
    async getLockState({ trackSlug, userId }) {
        const slug = String(trackSlug || '').trim();
        if (!slug) return { locked: false, blockedBy: [] };

        const prereqs = await db.AcademyTrackPrerequisite.findAll({
            where: { trackSlug: slug },
            attributes: ['requiredTrackSlug', 'policy'],
            raw: true,
        });
        if (!prereqs.length) return { locked: false, blockedBy: [] };

        const uid = Number(userId);
        if (!Number.isFinite(uid) || uid <= 0) {
            // Sem user logado: trata como locked (sem progresso → bloqueia tudo)
            return {
                locked: true,
                blockedBy: prereqs.map(p => ({ slug: p.requiredTrackSlug, policy: p.policy })),
            };
        }

        const requiredSlugs = prereqs.map(p => p.requiredTrackSlug);
        const progress = await db.AcademyUserTrackProgress.findAll({
            where: { userId: uid, trackSlug: { [Op.in]: requiredSlugs } },
            attributes: ['trackSlug', 'status', 'progressPercent'],
            raw: true,
        });
        const progressBySlug = new Map(progress.map(p => [p.trackSlug, p]));

        const tracks = await db.AcademyTrack.findAll({
            where: { slug: { [Op.in]: requiredSlugs } },
            attributes: ['slug', 'title'],
            raw: true,
        });
        const titleBySlug = Object.fromEntries(tracks.map(t => [t.slug, t.title]));

        const blockedBy = [];
        for (const p of prereqs) {
            const prog = progressBySlug.get(p.requiredTrackSlug);
            const percent = Number(prog?.progressPercent || 0);
            const ok = p.policy === 'STRICT'
                ? percent >= 100
                : percent > 0;
            if (!ok) {
                blockedBy.push({
                    slug: p.requiredTrackSlug,
                    title: titleBySlug[p.requiredTrackSlug] || p.requiredTrackSlug,
                    policy: p.policy,
                    userProgressPercent: percent,
                });
            }
        }

        return { locked: blockedBy.length > 0, blockedBy };
    },

    /**
     * Para várias trilhas de uma vez (otimização do listTracks).
     * Retorna Map<trackSlug, {locked, blockedBy}>
     */
    async getLockStateBulk({ trackSlugs, userId }) {
        const out = new Map();
        if (!Array.isArray(trackSlugs) || !trackSlugs.length) return out;

        const prereqs = await db.AcademyTrackPrerequisite.findAll({
            where: { trackSlug: { [Op.in]: trackSlugs } },
            attributes: ['trackSlug', 'requiredTrackSlug', 'policy'],
            raw: true,
        });

        // Inicializa todas como desbloqueadas
        for (const s of trackSlugs) out.set(s, { locked: false, blockedBy: [] });

        if (!prereqs.length) return out;

        const uid = Number(userId);
        const allRequiredSlugs = [...new Set(prereqs.map(p => p.requiredTrackSlug))];
        const progressBySlug = new Map();
        if (Number.isFinite(uid) && uid > 0) {
            const rows = await db.AcademyUserTrackProgress.findAll({
                where: { userId: uid, trackSlug: { [Op.in]: allRequiredSlugs } },
                attributes: ['trackSlug', 'progressPercent'],
                raw: true,
            });
            for (const r of rows) progressBySlug.set(r.trackSlug, Number(r.progressPercent || 0));
        }

        const tracks = await db.AcademyTrack.findAll({
            where: { slug: { [Op.in]: allRequiredSlugs } },
            attributes: ['slug', 'title'],
            raw: true,
        });
        const titleBySlug = Object.fromEntries(tracks.map(t => [t.slug, t.title]));

        for (const p of prereqs) {
            const percent = progressBySlug.get(p.requiredTrackSlug) || 0;
            const ok = p.policy === 'STRICT' ? percent >= 100 : percent > 0;
            if (!ok) {
                const state = out.get(p.trackSlug);
                state.locked = true;
                state.blockedBy.push({
                    slug: p.requiredTrackSlug,
                    title: titleBySlug[p.requiredTrackSlug] || p.requiredTrackSlug,
                    policy: p.policy,
                    userProgressPercent: percent,
                });
            }
        }

        return out;
    },

    /**
     * Notifica usuários quando uma trilha que era pré-requisito foi concluída.
     * Chamado por trackService.markProgress na transição → 100.
     */
    async notifyUnlocks({ userId, completedTrackSlug }) {
        try {
            const uid = Number(userId);
            if (!Number.isFinite(uid) || uid <= 0) return;
            const slug = String(completedTrackSlug || '').trim();
            if (!slug) return;

            // Quais trilhas dependiam dessa que foi concluída?
            const deps = await db.AcademyTrackPrerequisite.findAll({
                where: { requiredTrackSlug: slug },
                attributes: ['trackSlug'],
                raw: true,
            });
            if (!deps.length) return;

            const dependentSlugs = deps.map(d => d.trackSlug);

            // De cada uma, checa se o user AGORA tem TODAS as pré-reqs satisfeitas.
            const stateMap = await prerequisiteService.getLockStateBulk({
                trackSlugs: dependentSlugs,
                userId: uid,
            });

            const unlockedNow = [];
            for (const [trackSlug, state] of stateMap.entries()) {
                if (!state.locked) unlockedNow.push(trackSlug);
            }

            if (!unlockedNow.length) return;

            // Pega títulos para notificação
            const tracks = await db.AcademyTrack.findAll({
                where: { slug: { [Op.in]: unlockedNow }, status: 'PUBLISHED' },
                attributes: ['slug', 'title'],
                raw: true,
            });

            for (const t of tracks) {
                NotificationService.notify({
                    type: NotificationType.ACADEMY_TRACK_ASSIGNED, // reusa tipo (preferência já existe)
                    recipients: { users: [uid] },
                    title: `Nova trilha desbloqueada: ${t.title}`,
                    body: 'Você concluiu o pré-requisito. Esta trilha está agora disponível.',
                    data: { trackSlug: t.slug, unlockedAfter: slug },
                    link: `/academy/tracks/${encodeURIComponent(t.slug)}`,
                    importance: 6,
                }).catch(err => console.warn('[academy.prereq.notifyUnlocks]', err?.message));
            }
        } catch (err) {
            console.warn('[academy.prereq.notifyUnlocks] failed', err?.message);
        }
    },
};

export default prerequisiteService;
