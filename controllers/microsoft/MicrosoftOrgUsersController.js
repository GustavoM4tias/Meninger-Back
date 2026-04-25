// controllers/microsoft/MicrosoftOrgUsersController.js
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import db from '../../models/sequelize/index.js';
import orgUsersService from '../../services/microsoft/MicrosoftOrgUsersService.js';
import { sendEmail } from '../../email/email.service.js';
import { EmailType } from '../../email/types.js';

class MicrosoftOrgUsersController {

    async _getAdminUser(userId) {
        return db.User.findByPk(userId, {
            attributes: ['id', 'microsoft_id', 'microsoft_access_token', 'microsoft_refresh_token', 'microsoft_token_expires_at'],
        });
    }

    // ── GET /api/microsoft/org-users ──────────────────────────────────────────
    // Lista todos os usuários da organização Microsoft com status de importação.
    listOrgUsers = async (req, res) => {
        try {
            const adminUser = await this._getAdminUser(req.user.id);
            if (!adminUser?.microsoft_id) {
                return res.status(401).json({ error: 'Conta Microsoft não conectada. Vincule sua conta para usar esta funcionalidade.' });
            }

            const [orgUsers, importedIds] = await Promise.all([
                orgUsersService.listOrgUsers(adminUser),
                orgUsersService.getImportedIds(),
            ]);

            const result = orgUsers.map(u => ({
                ...u,
                imported: importedIds.has(u.microsoft_id),
            }));

            return res.json({ users: result, total: result.length });
        } catch (err) {
            console.error('❌ [OrgUsers] listOrgUsers:', err?.response?.data || err.message);
            return res.status(err?.response?.status || 500).json({ error: err.message });
        }
    };

    // ── POST /api/microsoft/org-users/import ─────────────────────────────────
    // Importa uma lista de usuários Microsoft criando contas no sistema.
    // Body: { users: [{ microsoft_id, name, email, phone, city, sendInvite }] }
    importOrgUsers = async (req, res) => {
        try {
            const adminUser = await this._getAdminUser(req.user.id);
            if (!adminUser?.microsoft_id) {
                return res.status(401).json({ error: 'Conta Microsoft não conectada.' });
            }

            const { users } = req.body;
            if (!Array.isArray(users) || users.length === 0) {
                return res.status(400).json({ error: 'Informe ao menos um usuário para importar.' });
            }

            const created = [];
            const skipped = [];
            const errors = [];

            for (const u of users) {
                try {
                    const { microsoft_id, name, email, phone, city, sendInvite } = u;

                    if (!microsoft_id || !email) {
                        errors.push({ microsoft_id, reason: 'microsoft_id e email são obrigatórios.' });
                        continue;
                    }

                    // Verifica duplicidade por microsoft_id ou email
                    const existing = await db.User.findOne({
                        where: {
                            [db.Sequelize.Op.or]: [
                                { microsoft_id },
                                { email },
                            ],
                        },
                        attributes: ['id', 'email', 'username'],
                    });

                    if (existing) {
                        skipped.push({ microsoft_id, email, reason: 'Usuário já existe no sistema.' });
                        continue;
                    }

                    // Nome exatamente como vem da Microsoft
                    const microsoftName = name?.trim() || email.split('@')[0];

                    // Username único usando o próprio nome da Microsoft
                    const username = await this._uniqueUsername(microsoftName);

                    // Senha aleatória — auth via Microsoft, nunca usada
                    const randomPassword = crypto.randomBytes(32).toString('hex');

                    const newUser = await db.User.create({
                        name: microsoftName,
                        username: microsoftName,
                        password: randomPassword,
                        email,
                        phone: phone || null,
                        city: city || '',
                        position: '',
                        role: 'user',
                        status: true,
                        auth_provider: 'MICROSOFT',
                        microsoft_id,
                        show_in_organogram: false,
                    });

                    created.push({ id: newUser.id, email, username });

                    if (sendInvite) {
                        sendEmail(EmailType.MICROSOFT_USER_INVITE, email, {
                            name: name || username,
                            systemUrl: 'https://office.menin.com.br/',
                        }).catch(err => console.error(`[OrgUsers] Falha ao enviar convite para ${email}:`, err.message));
                    }
                } catch (itemErr) {
                    console.error(`❌ [OrgUsers] Erro ao importar ${u.email}:`, itemErr.message);
                    errors.push({ microsoft_id: u.microsoft_id, email: u.email, reason: itemErr.message });
                }
            }

            return res.json({ created, skipped, errors });
        } catch (err) {
            console.error('❌ [OrgUsers] importOrgUsers:', err.message);
            return res.status(500).json({ error: err.message });
        }
    };

    async _uniqueUsername(base) {
        let name = base;
        let counter = 1;
        while (await db.User.findOne({ where: { username: name } })) {
            name = `${base}${counter++}`;
        }
        return name;
    }
}

export default new MicrosoftOrgUsersController();
