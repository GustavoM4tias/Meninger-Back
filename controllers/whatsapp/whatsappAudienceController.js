// controllers/whatsapp/whatsappAudienceController.js
//
// Quem recebe pelo WhatsApp.
//
// Não existe mais opt-in (removido em 2026-08-17): estar no Office já autoriza o
// canal, do mesmo jeito que e-mail e sino. O único requisito é ter telefone no
// PERFIL — por isso o que sobra aqui é (a) a info pública do número do sistema e
// (b) a cobertura: quem está sem telefone e portanto não recebe nada.

import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import WhatsAppConfigService from '../../services/whatsapp/WhatsAppConfigService.js';
import { resolveUserPhone, USER_PHONE_ATTRS } from '../../services/whatsapp/whatsappPhone.js';

const { User } = db;

/**
 * GET /api/whatsapp/info
 * Info PÚBLICA do número do sistema, pra qualquer usuário autenticado saber de
 * qual número vai receber. Nunca retorna secrets.
 */
export const getPublicInfo = async (req, res) => {
    try {
        const cfg = await WhatsAppConfigService.getConfig();
        return res.json({
            display_phone: cfg?.display_phone || null,
            display_name:  cfg?.display_name  || null,
            active:        !!cfg?.active && !cfg?.dry_run,
            ready:         !!cfg?.has_access_token && !!cfg?.phone_number_id,
        });
    } catch (err) {
        console.error('[whatsapp/info]', err);
        return res.status(500).json({ error: 'Falha ao carregar info.' });
    }
};

/**
 * GET /api/whatsapp/coverage  (admin)
 *
 * Cobertura do canal: quantos usuários ativos têm telefone e quem está de fora.
 * Sem isso o buraco é invisível — a pessoa simplesmente não recebe e ninguém
 * fica sabendo, que é exatamente o que a remoção do opt-in quis evitar.
 */
export const getCoverage = async (req, res) => {
    try {
        const users = await User.findAll({
            where: { status: true, approval_status: 'approved' },
            attributes: ['id', 'username', 'email', 'position', 'city', ...USER_PHONE_ATTRS],
            order: [['username', 'ASC']],
        });

        const missing = [];
        let withPhone = 0;

        for (const u of users) {
            if (resolveUserPhone(u)) withPhone++;
            else missing.push({
                id: u.id,
                username: u.username,
                email: u.email,
                position: u.position || null,
                city: u.city || null,
            });
        }

        return res.json({
            total: users.length,
            withPhone,
            withoutPhone: missing.length,
            coverage: users.length ? withPhone / users.length : 0,
            missing,
        });
    } catch (err) {
        console.error('[whatsapp/coverage]', err);
        return res.status(500).json({ error: 'Falha ao calcular cobertura.' });
    }
};
