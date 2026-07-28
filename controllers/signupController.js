// controllers/signupController.js
//
// Fluxo de cadastro de primeiro acesso (login Microsoft auto-provisionado):
//
//   1. GET  /api/auth/signup-options   — opções do formulário (departamentos e
//      cidades ativas). Qualquer autenticado, inclusive não-aprovado (é
//      justamente quem precisa). O usuário NÃO escolhe o próprio cargo.
//   2. POST /api/auth/complete-signup  — usuário 'incomplete' conclui o
//      formulário (nome, nascimento, telefone, departamento, cidade) e vira
//      'pending' (fila de aprovação). Notifica os administradores (sino +
//      e-mail) com deep-link para o painel de Usuários.
//   3. POST /api/auth/users/:id/activate — admin ativa um usuário 'pending'
//      (o cargo é definido pelo admin no modal antes de ativar): aplica as
//      alçadas padrão do departamento do cargo (PermissionProfile vinculado),
//      gera senha provisória e envia e-mail de liberação ao usuário.

import db from '../models/sequelize/index.js';
import responseHandler from '../utils/responseHandler.js';
import { sendEmail } from '../email/email.service.js';
import NotificationService from '../services/notification/NotificationService.js';
import { NotificationType } from '../services/notification/notificationTypes.js';
import { generateSecurePassword } from './authController.js';

const { User, Position, UserCity, Department, PermissionProfile, UserPermission } = db;

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// Sino + e-mail para todos os admins com deep-link que abre o modal do usuário
// direto no painel (bypassPrefs: aviso operacional crítico).
async function notifyAdminsSignup(user, departmentName, cityName) {
  const admins = await User.findAll({
    where: { role: 'admin', status: true },
    attributes: ['id'],
  });
  if (!admins.length) return;

  const body = `${user.username} concluiu o cadastro de primeiro acesso e aguarda liberação. ` +
    `Departamento: ${departmentName || 'não informado'}, cidade: ${cityName || 'não informada'}.`;
  await NotificationService.notify({
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
  });
}

async function uniqueUsername(base) {
  let name = base;
  let counter = 1;
  while (await User.findOne({ where: { username: name } })) {
    name = `${base} ${counter++}`;
  }
  return name;
}

// ── GET /api/auth/signup-options ─────────────────────────────────────────────
export const getSignupOptions = async (req, res) => {
  try {
    const [cities, departments] = await Promise.all([
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

    return responseHandler.success(res, { cities, departments });
  } catch (error) {
    console.error('[Signup] getSignupOptions erro:', error);
    return responseHandler.error(res, 'Erro ao carregar opções de cadastro');
  }
};

// ── POST /api/auth/complete-signup ───────────────────────────────────────────
export const completeSignup = async (req, res) => {
  const { username, birth_date, phone, department_id, city } = req.body || {};

  if (!username?.trim() || !birth_date || !department_id || !city) {
    return responseHandler.error(res, 'Preencha nome, nascimento, departamento e cidade.');
  }

  try {
    const user = await User.findByPk(req.user.id);
    if (!user) return responseHandler.error(res, 'Usuário não encontrado');
    if (user.approval_status === 'approved') {
      return responseHandler.error(res, 'Seu cadastro já foi concluído.');
    }
    // 'incomplete' envia pela primeira vez; 'pending' pode reenviar (corrige
    // dados enquanto aguarda) sem notificar os admins de novo.
    const firstSubmit = user.approval_status === 'incomplete';

    const [department, cityRecord] = await Promise.all([
      Department.findOne({ where: { id: Number(department_id), active: true }, attributes: ['id', 'name'] }),
      UserCity.findOne({ where: { name: city, active: true } }),
    ]);

    if (!department) return responseHandler.error(res, 'Departamento inválido ou inativo');
    if (!cityRecord) return responseHandler.error(res, 'Cidade inválida ou inativa');

    await user.update({
      username: username.trim(),
      birth_date,
      phone: phone || null,
      city: cityRecord.name,
      signup_department_id: department.id,
      approval_status: 'pending',
    });

    if (firstSubmit) {
      notifyAdminsSignup(user, department.name, cityRecord.name)
        .catch(err => console.error('[Signup] notificação de pendência falhou:', err?.message || err));
    }

    return responseHandler.success(res, {
      message: 'Cadastro concluído. Aguardando aprovação do gestor responsável.',
    });
  } catch (error) {
    console.error('[Signup] completeSignup erro:', error);
    return responseHandler.error(res, 'Erro ao concluir o cadastro');
  }
};

// ── POST /api/auth/signup-request (público, rate-limited) ────────────────────
// "Solicite acesso" da tela de login: cria a conta SEM Microsoft, já direto na
// fila de aprovação ('pending'). A senha chega por e-mail na ativação.
export const requestSignup = async (req, res) => {
  const { username, email, birth_date, phone, department_id, city } = req.body || {};

  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!username?.trim() || !cleanEmail || !birth_date || !department_id || !city) {
    return responseHandler.error(res, 'Preencha nome, e-mail, nascimento, departamento e cidade.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return responseHandler.error(res, 'E-mail inválido.');
  }

  try {
    const existing = await User.findOne({ where: { email: cleanEmail } });
    if (existing) {
      return responseHandler.error(res, 'Este e-mail já possui cadastro. Use "Esqueceu a senha?" ou fale com seu gestor.');
    }

    const [department, cityRecord] = await Promise.all([
      Department.findOne({ where: { id: Number(department_id), active: true }, attributes: ['id', 'name'] }),
      UserCity.findOne({ where: { name: city, active: true } }),
    ]);
    if (!department) return responseHandler.error(res, 'Departamento inválido ou inativo');
    if (!cityRecord) return responseHandler.error(res, 'Cidade inválida ou inativa');

    const user = await User.create({
      username: await uniqueUsername(username.trim()),
      // Senha aleatória inutilizável: a provisória real é gerada na ativação.
      password: generateSecurePassword() + generateSecurePassword(),
      email: cleanEmail,
      position: '',
      city: cityRecord.name,
      birth_date,
      phone: phone || null,
      role: 'user',
      status: false,
      approval_status: 'pending',
      signup_department_id: department.id,
      auth_provider: 'INTERNAL',
    });

    notifyAdminsSignup(user, department.name, cityRecord.name)
      .catch(err => console.error('[Signup] notificação de pendência falhou:', err?.message || err));

    return responseHandler.success(res, {
      message: 'Cadastro enviado. Aguardando aprovação do gestor responsável; você receberá um e-mail quando for liberado.',
    });
  } catch (error) {
    console.error('[Signup] requestSignup erro:', error);
    return responseHandler.error(res, 'Erro ao enviar o cadastro');
  }
};

// ── POST /api/auth/users/:id/reject (admin) ──────────────────────────────────
// Reprovar EXCLUI o cadastro: a pessoa é avisada por e-mail e pode solicitar
// acesso novamente do zero (um novo login Microsoft cria outro cadastro).
// Manter o registro bloqueado no banco fazia o retry cair em "usuário
// inválido/inativo" sem explicação.
export const rejectUser = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return responseHandler.error(res, 'ID inválido');
    const reason = String(req.body?.reason || '').trim();

    const user = await User.findByPk(id);
    if (!user) return responseHandler.error(res, 'Usuário não encontrado');
    if (user.approval_status === 'approved') {
      return responseHandler.error(res, 'Este usuário já foi ativado. Use "Acesso ao sistema" para bloquear.');
    }

    const { username, email } = user;

    // Remove o cadastro e qualquer resto que aponte para ele (tokens de sessão
    // etc.), varrendo as FKs dinamicamente para não quebrar com tabela nova.
    const t = await db.sequelize.transaction();
    try {
      const fks = await db.sequelize.query(`
        SELECT tc.table_name, kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
        JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'users' AND ccu.column_name = 'id'
      `, { type: db.Sequelize.QueryTypes.SELECT, transaction: t });

      for (const fk of fks) {
        if (fk.table_name === 'users') {
          await db.sequelize.query(
            `UPDATE users SET ${fk.column_name} = NULL WHERE ${fk.column_name} = :id`,
            { replacements: { id }, transaction: t });
        } else {
          await db.sequelize.query(
            `DELETE FROM ${fk.table_name} WHERE ${fk.column_name} = :id`,
            { replacements: { id }, transaction: t });
        }
      }
      await db.sequelize.query('DELETE FROM users WHERE id = :id', { replacements: { id }, transaction: t });
      await t.commit();
    } catch (err) {
      await t.rollback();
      throw err;
    }

    let emailSent = true;
    try {
      await sendEmail('user.rejected', email, {
        name: username,
        reason: reason || null,
      });
    } catch (err) {
      emailSent = false;
      console.error('[Signup] e-mail de reprovação falhou:', err?.message || err);
    }

    return responseHandler.success(res, {
      message: emailSent
        ? `Cadastro reprovado e removido. ${email} foi avisado por e-mail.`
        : 'Cadastro reprovado e removido, mas o e-mail de aviso FALHOU.',
      emailSent,
    });
  } catch (error) {
    console.error('[Signup] rejectUser erro:', error);
    return responseHandler.error(res, 'Erro ao reprovar cadastro');
  }
};

// ── POST /api/auth/users/:id/activate (admin) ────────────────────────────────
export const activateUser = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return responseHandler.error(res, 'ID inválido');

    const user = await User.findByPk(id);
    if (!user) return responseHandler.error(res, 'Usuário não encontrado');
    if (user.approval_status === 'approved') {
      return responseHandler.error(res, 'Este usuário já foi ativado.');
    }
    // A ativação só vale DEPOIS do formulário de primeiro acesso enviado.
    if (user.approval_status === 'incomplete') {
      return responseHandler.error(res, 'Este usuário ainda não concluiu o formulário de primeiro acesso.');
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
