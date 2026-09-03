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
import { findUserByEmailCI } from '../utils/userEmail.js';
import { urlDeEnv, ehProducao } from '../utils/envUrl.js';

const { User, Position, UserCity, Department, PermissionProfile, UserPermission } = db;

// ── Endereço do front ────────────────────────────────────────────────────────
//
// Lido a cada uso, e não no import: em 26/08/2026 a variável de produção estava
// valendo literalmente `"https:` - truncada e com a aspa da colagem - e o `||`
// de antes aceitava isso numa boa, porque valor quebrado não é valor vazio. O
// callback da Microsoft mandava a pessoa para um endereço que não existe.
//
// urlDeEnv exige URL absoluta de verdade e cai no endereço do Office quando o
// que veio do ambiente não presta.
const FRONT_PROD = 'https://office.menin.com.br';
const FRONT_DEV = 'http://localhost:5173';

function frontendUrl() {
    return urlDeEnv('FRONTEND_URL', ehProducao() ? FRONT_PROD : FRONT_DEV);
}

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

// Nome único (users.username tem UNIQUE). excludeId permite o próprio usuário
// manter o nome que já é dele ao reenviar o formulário.
async function uniqueUsername(base, excludeId = null) {
  let name = base;
  let counter = 1;
  for (;;) {
    const existing = await User.findOne({ where: { username: name } });
    if (!existing || existing.id === excludeId) return name;
    name = `${base} ${counter++}`;
  }
}

// Remove o usuário e qualquer resto que aponte para ele (tokens de sessão
// etc.), varrendo as FKs dinamicamente para não quebrar com tabela nova.
// Roda DENTRO da transação recebida — quem chama faz commit/rollback.
async function deleteUserCascade(id, t) {
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
  const { username, birth_date, phone, department_id, city, city_id } = req.body || {};

  if (!username?.trim() || !birth_date || !department_id || (!city && !city_id)) {
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

    // city_id resolve municípios homônimos (Bom Jesus/PI × Bom Jesus/RS);
    // `city` por nome segue aceito por compatibilidade.
    const [department, cityRecord] = await Promise.all([
      Department.findOne({ where: { id: Number(department_id), active: true }, attributes: ['id', 'name'] }),
      city_id
        ? UserCity.findOne({ where: { id: Number(city_id), active: true } })
        : UserCity.findOne({ where: { name: city, active: true } }),
    ]);

    if (!department) return responseHandler.error(res, 'Departamento inválido ou inativo');
    if (!cityRecord) return responseHandler.error(res, 'Cidade inválida ou inativa');

    await user.update({
      // Sufixa se o nome já existir (ex.: o admin já cadastrou a pessoa à mão);
      // sem isso o UNIQUE de username derruba o formulário com erro genérico.
      username: await uniqueUsername(username.trim(), user.id),
      birth_date,
      phone: phone || null,
      city: cityRecord.name,
      city_id: cityRecord.id,
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
  const { username, email, birth_date, phone, department_id, city, city_id } = req.body || {};

  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!username?.trim() || !cleanEmail || !birth_date || !department_id || (!city && !city_id)) {
    return responseHandler.error(res, 'Preencha nome, e-mail, nascimento, departamento e cidade.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return responseHandler.error(res, 'E-mail inválido.');
  }

  try {
    const existing = await findUserByEmailCI(cleanEmail);
    if (existing) {
      return responseHandler.error(res, 'Este e-mail já possui cadastro. Use "Esqueceu a senha?" ou fale com seu gestor.');
    }

    const [department, cityRecord] = await Promise.all([
      Department.findOne({ where: { id: Number(department_id), active: true }, attributes: ['id', 'name'] }),
      city_id
        ? UserCity.findOne({ where: { id: Number(city_id), active: true } })
        : UserCity.findOne({ where: { name: city, active: true } }),
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
      city_id: cityRecord.id,
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

    const t = await db.sequelize.transaction();
    try {
      await deleteUserCascade(id, t);
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

// Mescla o cadastro pendente (primeiro acesso) no usuário já existente com o
// mesmo e-mail e ativa o EXISTENTE: preserva cargo/gestor/posição no
// organograma do antigo, traz do pendente o vínculo Microsoft e os dados de
// formulário que faltavam, e remove o registro duplicado.
async function mergeAndActivateTwin(res, pending, twin) {
  // Dados do formulário que o cadastro antigo não tinha
  if (!twin.birth_date && pending.birth_date) twin.birth_date = pending.birth_date;
  if (!twin.phone && pending.phone) twin.phone = pending.phone;
  if (!twin.signup_department_id && pending.signup_department_id) {
    twin.signup_department_id = pending.signup_department_id;
  }
  if (!twin.position && pending.position) {
    twin.position = pending.position;
    twin.position_id = pending.position_id;
  }
  if (!twin.city && pending.city) {
    twin.city = pending.city;
    twin.city_id = pending.city_id;
  }

  // Vínculo Microsoft migra para o cadastro que fica
  if (pending.microsoft_id) {
    twin.microsoft_id = pending.microsoft_id;
    twin.microsoft_access_token = pending.microsoft_access_token;
    twin.microsoft_refresh_token = pending.microsoft_refresh_token;
    twin.microsoft_token_expires_at = pending.microsoft_token_expires_at;
    twin.auth_provider = 'MICROSOFT';
  }

  // Alçadas padrão do departamento — mesma regra da ativação normal
  let appliedProfile = null;
  if (twin.role !== 'admin') {
    const positionRecord = await Position.findOne({ where: { name: twin.position } });
    if (positionRecord && !twin.position_id) twin.position_id = positionRecord.id;
    if (positionRecord?.department_id) {
      appliedProfile = await PermissionProfile.findOne({
        where: { department_id: positionRecord.department_id, active: true },
      });
    }
    if (appliedProfile && !twin.permission_profile_id) {
      twin.permission_profile_id = appliedProfile.id;
    }
  }

  const provisionalPassword = generateSecurePassword();
  twin.password = provisionalPassword;
  twin.status = true;
  twin.reset_password_code = null;
  twin.reset_password_expires_at = null;
  twin.reset_password_attempts = 0;
  twin.reset_password_last_sent_at = null;

  // O UNIQUE de microsoft_id exige remover o pendente ANTES de salvar o antigo.
  const t = await db.sequelize.transaction();
  try {
    await deleteUserCascade(pending.id, t);
    await twin.save({ transaction: t });
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }

  let emailSent = true;
  try {
    await sendEmail('user.activated', twin.email, {
      name: twin.username,
      email: twin.email,
      password: provisionalPassword,
      loginUrl: frontendUrl(),
    });
  } catch (err) {
    emailSent = false;
    console.error('[Signup] e-mail de liberação falhou:', err?.message || err);
  }

  return responseHandler.success(res, {
    message: emailSent
      ? `Cadastro mesclado com o usuário já existente "${twin.username}" (o duplicado foi removido; a posição no organograma foi mantida). E-mail com senha provisória enviado para ${twin.email}.`
      : `Cadastro mesclado com o usuário já existente "${twin.username}", mas o e-mail de liberação FALHOU. Use "Resetar senha" no modal e repasse manualmente.`,
    emailSent,
    mergedInto: twin.id,
    profileApplied: appliedProfile ? appliedProfile.name : null,
    routesApplied: appliedProfile && Array.isArray(appliedProfile.routes) ? appliedProfile.routes : [],
  });
}

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

    // Gêmeo manual: o admin muitas vezes já cadastrou a pessoa à mão (para o
    // organograma) antes do primeiro login Microsoft. Se existe OUTRO usuário
    // aprovado com o mesmo e-mail (sem case), ativa NELE: o cadastro antigo
    // mantém cargo/gestor/posição no organograma e ganha o vínculo Microsoft;
    // o registro do primeiro acesso é removido — nada de pessoa duplicada.
    const twin = await findUserByEmailCI(user.email, { excludeId: user.id });
    if (twin && twin.approval_status === 'approved') {
      return mergeAndActivateTwin(res, user, twin);
    }

    // Alçadas padrão do departamento — modelo PERFIL VIVO: em vez de copiar as
    // rotas (foto congelada), o usuário passa a APONTAR para o perfil do
    // departamento. Editar o perfil depois propaga para todos os vinculados.
    let appliedProfile = null;
    if (user.role !== 'admin') {
      const positionRecord = await Position.findOne({ where: { name: user.position } });
      if (positionRecord && !user.position_id) user.position_id = positionRecord.id;
      if (positionRecord?.department_id) {
        appliedProfile = await PermissionProfile.findOne({
          where: { department_id: positionRecord.department_id, active: true },
        });
      }
      if (appliedProfile && !user.permission_profile_id) {
        user.permission_profile_id = appliedProfile.id;
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
        loginUrl: frontendUrl(),
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
      routesApplied: appliedProfile && Array.isArray(appliedProfile.routes) ? appliedProfile.routes : [],
    });
  } catch (error) {
    console.error('[Signup] activateUser erro:', error);
    return responseHandler.error(res, 'Erro ao ativar usuário');
  }
};
