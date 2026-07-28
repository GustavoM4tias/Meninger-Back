// controllers/signupController.js
//
// Fluxo de cadastro de primeiro acesso (login Microsoft auto-provisionado):
//
//   1. GET  /api/auth/signup-options   — opções do formulário (departamentos,
//      cargos ativos internos e cidades ativas). Qualquer autenticado, inclusive
//      pendente de aprovação (é justamente quem precisa).
//   2. POST /api/auth/complete-signup  — usuário PENDENTE conclui o formulário
//      (nome, nascimento, telefone, departamento, cargo, cidade). Notifica os
//      administradores (sino + e-mail) com deep-link para o painel de Usuários.
//   3. POST /api/auth/users/:id/activate — admin ativa o usuário: aplica as
//      alçadas padrão do departamento (PermissionProfile vinculado), gera senha
//      provisória e envia e-mail de liberação ao usuário.

import db from '../models/sequelize/index.js';
import responseHandler from '../utils/responseHandler.js';
import { sendEmail } from '../email/email.service.js';
import NotificationService from '../services/notification/NotificationService.js';
import { NotificationType } from '../services/notification/notificationTypes.js';
import { generateSecurePassword } from './authController.js';

const { User, Position, UserCity, Department, PermissionProfile, UserPermission } = db;

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// ── GET /api/auth/signup-options ─────────────────────────────────────────────
export const getSignupOptions = async (req, res) => {
  try {
    const [positions, cities, departments] = await Promise.all([
      Position.findAll({
        where: { active: true, is_internal: true },
        attributes: ['id', 'name', 'description', 'department_id'],
        order: [['name', 'ASC']],
      }),
      UserCity.findAll({
        where: { active: true },
        attributes: ['id', 'name', 'uf'],
        order: [['name', 'ASC']],
      }),
      Department.findAll({
        where: { active: true },
        attributes: ['id', 'name'],
        order: [['name', 'ASC']],
      }),
    ]);

    return responseHandler.success(res, { positions, cities, departments });
  } catch (error) {
    console.error('[Signup] getSignupOptions erro:', error);
    return responseHandler.error(res, 'Erro ao carregar opções de cadastro');
  }
};

// ── POST /api/auth/complete-signup ───────────────────────────────────────────
export const completeSignup = async (req, res) => {
  const { username, birth_date, phone, department_id, position, city } = req.body || {};

  if (!username?.trim() || !birth_date || !department_id || !position || !city) {
    return responseHandler.error(res, 'Preencha nome, nascimento, departamento, cargo e cidade.');
  }

  try {
    const user = await User.findByPk(req.user.id);
    if (!user) return responseHandler.error(res, 'Usuário não encontrado');
    if (user.approval_status !== 'pending') {
      return responseHandler.error(res, 'Seu cadastro já foi concluído.');
    }

    const [positionRecord, cityRecord] = await Promise.all([
      Position.findOne({ where: { name: position, active: true, is_internal: true } }),
      UserCity.findOne({ where: { name: city, active: true } }),
    ]);

    if (!positionRecord) return responseHandler.error(res, 'Cargo inválido ou inativo');
    if (Number(positionRecord.department_id) !== Number(department_id)) {
      return responseHandler.error(res, 'O cargo selecionado não pertence ao departamento escolhido.');
    }
    if (!cityRecord) return responseHandler.error(res, 'Cidade inválida ou inativa');

    await user.update({
      username: username.trim(),
      birth_date,
      phone: phone || null,
      position: positionRecord.name,
      city: cityRecord.name,
    });

    const department = await Department.findByPk(positionRecord.department_id, { attributes: ['id', 'name'] });

    // Avisa os administradores: sino + e-mail com deep-link que abre o modal
    // do usuário direto no painel (bypassPrefs: aviso operacional crítico).
    const admins = await User.findAll({
      where: { role: 'admin', status: true },
      attributes: ['id'],
    });

    if (admins.length) {
      const body = `${user.username} concluiu o cadastro de primeiro acesso e aguarda liberação. ` +
        `Cargo: ${positionRecord.name} (${department?.name || 'sem departamento'}), cidade: ${cityRecord.name}.`;
      NotificationService.notify({
        type: NotificationType.USER_SIGNUP_PENDING,
        recipients: { users: admins.map(a => a.id) },
        title: 'Novo cadastro aguardando aprovação',
        body,
        link: `/settings/users?user=${user.id}`,
        importance: 8,
        bypassPrefs: true,
        data: { userId: user.id },
        emailData: {
          title: 'Novo cadastro aguardando aprovação',
          preview: `${user.username} aguarda liberação de acesso`,
          body: `${body}\n\nAcesse o painel de Usuários do Menin Office para revisar e ativar.`,
        },
      }).catch(err => console.error('[Signup] notificação de pendência falhou:', err?.message || err));
    }

    return responseHandler.success(res, {
      message: 'Cadastro concluído. Aguardando aprovação do gestor responsável.',
    });
  } catch (error) {
    console.error('[Signup] completeSignup erro:', error);
    return responseHandler.error(res, 'Erro ao concluir o cadastro');
  }
};

// ── POST /api/auth/users/:id/activate (admin) ────────────────────────────────
export const activateUser = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return responseHandler.error(res, 'ID inválido');

    const user = await User.findByPk(id);
    if (!user) return responseHandler.error(res, 'Usuário não encontrado');
    if (user.approval_status !== 'pending') {
      return responseHandler.error(res, 'Este usuário já foi ativado.');
    }

    // Alçadas padrão do departamento (perfil vinculado via department_id).
    // Não-admin: aplica em união com o que o usuário eventualmente já tenha.
    let appliedProfile = null;
    let appliedRoutes = [];
    if (user.role !== 'admin') {
      const positionRecord = await Position.findOne({ where: { name: user.position } });
      if (positionRecord?.department_id) {
        appliedProfile = await PermissionProfile.findOne({
          where: { department_id: positionRecord.department_id, active: true },
        });
      }
      if (appliedProfile) {
        const existing = await UserPermission.findOne({ where: { userId: user.id } });
        const merged = new Set([
          ...(Array.isArray(existing?.routes) ? existing.routes : []),
          ...(Array.isArray(appliedProfile.routes) ? appliedProfile.routes : []),
        ]);
        appliedRoutes = [...merged];
        await UserPermission.upsert({ userId: user.id, routes: appliedRoutes });
      }
    }

    // Senha provisória: enviada por e-mail junto com o aviso de liberação.
    const provisionalPassword = generateSecurePassword();
    user.password = provisionalPassword;
    user.status = true;
    user.approval_status = 'approved';
    user.reset_password_code = null;
    user.reset_password_expires_at = null;
    user.reset_password_attempts = 0;
    user.reset_password_last_sent_at = null;
    await user.save();

    let emailSent = true;
    try {
      await sendEmail('user.activated', user.email, {
        name: user.username,
        email: user.email,
        password: provisionalPassword,
        loginUrl: FRONTEND_URL,
      });
    } catch (err) {
      emailSent = false;
      console.error('[Signup] e-mail de liberação falhou:', err?.message || err);
    }

    return responseHandler.success(res, {
      message: emailSent
        ? `Usuário ativado. E-mail de liberação com senha provisória enviado para ${user.email}.`
        : 'Usuário ativado, mas o e-mail de liberação FALHOU. Use "Resetar senha" no modal e repasse manualmente.',
      emailSent,
      profileApplied: appliedProfile ? appliedProfile.name : null,
      routesApplied: appliedRoutes,
    });
  } catch (error) {
    console.error('[Signup] activateUser erro:', error);
    return responseHandler.error(res, 'Erro ao ativar usuário');
  }
};
