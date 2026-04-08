// api/controllers/authController.js
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import db from '../models/sequelize/index.js';
import jwtConfig from '../config/jwtConfig.js';
import responseHandler from '../utils/responseHandler.js';
import { sendEmail } from '../email/email.service.js';
import { encrypt, decrypt } from '../utils/encryption.js';

const { User, Position, UserCity } = db;
const { Op } = db.Sequelize;

const PASSWORD_RESET_TTL_MIN = Number(process.env.PASSWORD_RESET_TTL_MIN || 10);
const PASSWORD_RESET_RESEND_SEC = Number(process.env.PASSWORD_RESET_RESEND_SEC || 20);
const PASSWORD_RESET_MAX_ATTEMPTS = Number(process.env.PASSWORD_RESET_MAX_ATTEMPTS || 5);

function genCode6() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function neutralResetResponse(res) {
  return responseHandler.success(res, {
    message: 'Enviaremos um código para o e-mail informado.',
  });
}

function isStrongPassword(password) {
  const p = String(password || '');
  return (
    p.length >= 8 &&
    /[A-Z]/.test(p) &&
    /[a-z]/.test(p) &&
    /[0-9]/.test(p) &&
    /[!@#$%^&*()_\-+=[\]{};:,.?/\\|~`"'<>]/.test(p)
  );
}

function generateSecurePassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const special = '!@#$%*_-+=';
  const all = upper + lower + digits + special;

  const password = [
    upper[Math.floor(Math.random() * upper.length)],
    lower[Math.floor(Math.random() * lower.length)],
    digits[Math.floor(Math.random() * digits.length)],
    special[Math.floor(Math.random() * special.length)],
  ];

  for (let i = 4; i < 12; i++) {
    password.push(all[Math.floor(Math.random() * all.length)]);
  }

  for (let i = password.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [password[i], password[j]] = [password[j], password[i]];
  }

  return password.join('');
}

export const registerUser = async (req, res) => {
  const { username, password, email, position, city, birth_date } = req.body;
  if (!username || !password || !email || !position || !city || !birth_date) {
    return responseHandler.error(res, 'Todos os campos são obrigatórios');
  }

  try {
    const existingUser = await User.findOne({ where: { username } });
    if (existingUser) {
      return responseHandler.error(res, 'Nome já existente');
    }

    // 🔹 valida se cargo e cidade existem e estão ativos
    const [positionRecord, cityRecord] = await Promise.all([
      Position.findOne({ where: { name: position, active: true } }),
      UserCity.findOne({ where: { name: city, active: true } }),
    ]);

    if (!positionRecord) {
      return responseHandler.error(res, 'Cargo inválido ou inativo');
    }
    if (!cityRecord) {
      return responseHandler.error(res, 'Cidade inválida ou inativa');
    }

    const user = await User.create({
      username,
      password,
      email,
      position: positionRecord.name,
      city: cityRecord.name,
      birth_date,
    });

    const token = jwt.sign({
      id: user.id,
      position: user.position,
      city: user.city,
      role: user.role,
    }, jwtConfig.secret, { expiresIn: jwtConfig.expiresIn });

    return responseHandler.success(res, { token });
  } catch (error) {
    console.error('Erro no registerUser:', error);
    return responseHandler.error(res, error);
  }
};

export const loginUser = async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  try {
    const user = await User.findOne({ where: { email } });

    if (!user) {
      return responseHandler.error(res, 'Usuário não encontrado');
    }

    if (!user.status) {
      return responseHandler.error(res, 'Conta inativa. Entre em contato com o administrador.');
    }

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return responseHandler.error(res, 'Senha incorreta');
    }

    user.last_login = new Date();
    await user.save();

    const token = jwt.sign({
      id: user.id,
      position: user.position,
      city: user.city,
      role: user.role,
      auth_provider: user.auth_provider,
    }, jwtConfig.secret, { expiresIn: jwtConfig.expiresIn });

    return responseHandler.success(res, { token });
  } catch (error) {
    console.error('Erro no login:', error);
    return responseHandler.error(res, error);
  }
};


export const changePassword = async (req, res) => {
  try {
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');
    const confirmNewPassword = String(req.body?.confirmNewPassword || '');

    if (!currentPassword || !newPassword || !confirmNewPassword) {
      return responseHandler.error(res, 'Todos os campos são obrigatórios');
    }

    if (newPassword !== confirmNewPassword) {
      return responseHandler.error(res, 'As senhas não conferem');
    }

    if (!isStrongPassword(newPassword)) {
      return responseHandler.error(res, 'A senha deve ter no mínimo 8 caracteres, com letra e número');
    }

    const user = await User.findByPk(req.user.id);

    if (!user) {
      return responseHandler.error(res, 'Usuário não encontrado');
    }

    if (!user.password) {
      return responseHandler.error(res, 'Este usuário não possui senha local — use o login Microsoft');
    }

    const passwordMatch = await bcrypt.compare(currentPassword, user.password);
    if (!passwordMatch) {
      return responseHandler.error(res, 'Senha atual incorreta');
    }

    // Prevent reuse of same password
    const isSame = await bcrypt.compare(newPassword, user.password);
    if (isSame) {
      return responseHandler.error(res, 'A nova senha não pode ser igual à senha atual');
    }

    user.password = newPassword; // model hook hashes on save
    await user.save();

    return responseHandler.success(res, { message: 'Senha alterada com sucesso.' });
  } catch (error) {
    console.error('[changePassword] erro:', error);
    return responseHandler.error(res, 'Erro ao alterar senha');
  }
};

export const requestPasswordReset = async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();

    if (!email) {
      return neutralResetResponse(res);
    }

    const user = await User.findOne({
      where: {
        email,
        auth_provider: 'INTERNAL',
        status: true,
      },
    });

    if (!user) {
      return neutralResetResponse(res);
    }

    if (user.reset_password_last_sent_at) {
      const diffSec = (Date.now() - new Date(user.reset_password_last_sent_at).getTime()) / 1000;
      if (diffSec < PASSWORD_RESET_RESEND_SEC) {
        return neutralResetResponse(res);
      }
    }

    const code = genCode6();
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MIN * 60 * 1000);

    await user.update({
      reset_password_code: codeHash,
      reset_password_expires_at: expiresAt,
      reset_password_attempts: 0,
      reset_password_last_sent_at: new Date(),
    });

    await sendEmail('auth.password.reset', user.email, {
      username: user.username,
      code,
      minutes: PASSWORD_RESET_TTL_MIN,
    });

    return neutralResetResponse(res);
  } catch (error) {
    console.error('[requestPasswordReset] erro:', error);
    return neutralResetResponse(res);
  }
};

export const resetPassword = async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const code = String(req.body?.code || '').trim();
    const password = String(req.body?.password || '');
    const confirmPassword = String(req.body?.confirmPassword || '');

    if (!email || !code || !password || !confirmPassword) {
      return responseHandler.error(res, 'Todos os campos são obrigatórios');
    }

    if (code.length !== 6) {
      return responseHandler.error(res, 'Código inválido');
    }

    if (password !== confirmPassword) {
      return responseHandler.error(res, 'As senhas não conferem');
    }

    if (!isStrongPassword(password)) {
      return responseHandler.error(res, 'A senha deve ter no mínimo 8 caracteres, com letra e número');
    }

    const user = await User.findOne({
      where: {
        email,
        auth_provider: 'INTERNAL',
        status: true,
      },
    });

    if (!user || !user.reset_password_code) {
      return responseHandler.error(res, 'Código inválido');
    }

    if (!user.reset_password_expires_at || new Date(user.reset_password_expires_at).getTime() < Date.now()) {
      return responseHandler.error(res, 'Código expirado');
    }

    if ((user.reset_password_attempts || 0) >= PASSWORD_RESET_MAX_ATTEMPTS) {
      return responseHandler.error(res, 'Muitas tentativas. Solicite um novo código.');
    }

    const validCode = await bcrypt.compare(code, user.reset_password_code);

    if (!validCode) {
      await user.update({
        reset_password_attempts: (user.reset_password_attempts || 0) + 1,
      });

      return responseHandler.error(res, 'Código inválido');
    }

    user.password = password;
    user.reset_password_code = null;
    user.reset_password_expires_at = null;
    user.reset_password_attempts = 0;
    user.reset_password_last_sent_at = null;

    await user.save();

    return responseHandler.success(res, {
      message: 'Senha redefinida com sucesso.',
    });
  } catch (error) {
    console.error('[resetPassword] erro:', error);
    return responseHandler.error(res, 'Erro ao redefinir senha');
  }
};

// Util: média de embeddings (vários frames -> 1 vetor)
const distanceEuclidean = (a, b) => {
  if (!a || !b || a.length !== b.length) return Number.POSITIVE_INFINITY;
  let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
};
const averageEmbedding = (arr) => {
  if (!arr?.length) return null;
  const len = arr[0].length;
  const out = new Array(len).fill(0);
  for (const v of arr) for (let i = 0; i < len; i++) out[i] += v[i];
  for (let i = 0; i < len; i++) out[i] /= arr.length;
  return out;
};

export const enrollFace = async (req, res) => {
  // body: { embeddings: number[][], threshold?: number }
  const { embeddings, threshold } = req.body;
  if (!Array.isArray(embeddings) || embeddings.length < 5) {
    return res.status(400).json({ success: false, error: 'Coleta insuficiente' });
  }
  const user = await User.findByPk(req.user.id);
  if (!user) return res.status(404).json({ success: false, error: 'Usuário não encontrado' });

  const mean = averageEmbedding(embeddings);
  user.face_template = mean;
  if (threshold) user.face_threshold = threshold;
  user.face_enabled = true;
  user.face_last_update = new Date();
  await user.save();

  return res.json({ success: true, data: { face_enabled: true } });
};

export const identifyFace = async (req, res) => {
  try {
    let { embedding } = req.body;

    // 🔎 LOG de debug
    const raw = req.body?.embedding;
    console.log('[identifyFace] raw type:', typeof raw, 'isArray:', Array.isArray(raw), 'len:', raw?.length);

    // 🔧 Normalizações comuns
    if (embedding && !Array.isArray(embedding)) {
      // Caso venha como Float32Array/TypedArray
      if (typeof embedding === 'object' && typeof embedding.length === 'number') {
        embedding = Array.from(embedding);
      }
      // Caso venha como { data: [...] }
      else if (embedding && Array.isArray(embedding.data)) {
        embedding = embedding.data;
      }
      // Caso venha como string JSON
      else if (typeof embedding === 'string') {
        try {
          const parsed = JSON.parse(embedding);
          if (Array.isArray(parsed)) embedding = parsed;
        } catch (_) { /* ignora */ }
      }
    }

    // 🔒 Validação final
    if (!Array.isArray(embedding) || embedding.length !== 128 || embedding.some((x) => typeof x !== 'number')) {
      console.log('[identifyFace] payload inválido após normalização:', {
        type: typeof embedding,
        isArray: Array.isArray(embedding),
        len: embedding?.length
      });
      return res.status(400).json({ success: false, error: 'embedding inválido' });
    }

    // Você pode limitar por status/cidade/etc. se quiser reduzir o conjunto:
    const users = await User.findAll({
      where: {
        face_enabled: true,
      },
      attributes: ['id', 'email', 'username', 'position', 'role', 'city', 'face_template', 'face_threshold', 'status'],
    });

    if (!users.length) {
      return res.status(404).json({ success: false, error: 'Sem usuários com face habilitado' });
    }

    let bestUser = null;
    let bestDist = Number.POSITIVE_INFINITY;

    for (const u of users) {
      if (!u.status) continue; // inativo → ignora
      if (!u.face_template) continue;

      // face_template pode estar salvo como array (JSON) ou string JSON
      let tpl = u.face_template;
      if (typeof tpl === 'string') {
        try { tpl = JSON.parse(tpl); } catch { /* pode ser array puro ou string de array */ }
      }
      // Se salvou mean direto: tpl = [128 floats]
      // Se salvou objeto: {mean:[...], embeddings:[...]}
      let dists = [];
      if (Array.isArray(tpl)) {
        dists.push(distanceEuclidean(embedding, tpl));
      } else if (tpl && Array.isArray(tpl.mean)) {
        dists.push(distanceEuclidean(embedding, tpl.mean));
        if (Array.isArray(tpl.embeddings)) {
          for (const e of tpl.embeddings) dists.push(distanceEuclidean(embedding, e));
        }
      } else {
        continue; // sem template válido
      }

      const minDist = Math.min(...dists);
      if (minDist < bestDist) {
        bestDist = minDist;
        bestUser = u;
      }
    }

    // limiar
    const threshold = parseFloat(process.env.FACE_THRESHOLD || '0.60');
    const passed = bestUser && bestDist <= threshold;

    console.log(`[faceIdentify] best=${bestUser?.email} dist=${bestDist?.toFixed(4)} thr=${threshold} ok=${passed}`);

    if (!passed) {
      return res.status(401).json({
        success: false,
        error: 'Não reconhecido',
        data: { meta: { dist: bestDist, threshold } },
      });
    }

    // sucesso → gera o MESMO JWT do login por senha
    const token = jwt.sign({
      id: bestUser.id,
      position: bestUser.position,
      city: bestUser.city,
      role: bestUser.role
    }, jwtConfig.secret, { expiresIn: jwtConfig.expiresIn });

    bestUser.last_login = new Date();
    await bestUser.save();

    return res.json({
      success: true,
      data: {
        token,
        user: { id: bestUser.id, email: bestUser.email, username: bestUser.username },
        meta: { dist: bestDist, threshold },
      }
    });
  } catch (err) {
    console.error('[identifyFace] erro:', err);
    return res.status(500).json({ success: false, error: 'erro interno' });
  }
};

export const getUserInfo = async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: ['id', 'username', 'email', 'position', 'role', 'manager_id', 'city', 'birth_date', 'created_at', 'status', 'face_enabled', 'face_last_update', 'auth_provider', 'external_kind', 'external_id', 'phone']
    });
    if (!user) {
      return responseHandler.error(res, 'Usuário não encontrado');
    }
    return responseHandler.success(res, user);
  } catch (error) {
    return responseHandler.error(res, error);
  }
};

export const updateMe = async (req, res) => {
  const { username, email, position, city, status, birth_date, face_enabled, phone } = req.body;
  if (!username || !email || !position || !city || status === undefined || !birth_date || face_enabled === undefined) {
    return responseHandler.error(res, 'Todos os campos são obrigatórios');
  }

  try {
    const [positionRecord, cityRecord] = await Promise.all([
      Position.findOne({ where: { name: position, active: true } }),
      UserCity.findOne({ where: { name: city, active: true } }),
    ]);

    if (!positionRecord) return responseHandler.error(res, 'Cargo inválido ou inativo');
    if (!cityRecord) return responseHandler.error(res, 'Cidade inválida ou inativa');

    const [affectedRows] = await User.update(
      {
        username,
        email,
        position: positionRecord.name,
        city: cityRecord.name,
        status,
        birth_date,
        face_enabled,
        phone: phone ?? null,
      },
      { where: { id: req.user.id } }
    );

    if (affectedRows === 0) {
      return responseHandler.error(res, 'Usuário não encontrado');
    }
    return responseHandler.success(res, { message: 'Informações atualizadas com sucesso' });
  } catch (error) {
    return responseHandler.error(res, error);
  }
};

export const updateUser = async (req, res) => {
  const { id, username, email, position, role, manager_id, city, status, birth_date, show_in_organogram, phone } = req.body;

  if (!id || !username || !email || !position || !city || status === undefined || !birth_date) {
    return responseHandler.error(res, 'Todos os campos são obrigatórios');
  }

  try {
    const [positionRecord, cityRecord] = await Promise.all([
      Position.findOne({ where: { name: position, active: true } }),
      UserCity.findOne({ where: { name: city, active: true } }),
    ]);

    if (!positionRecord) return responseHandler.error(res, 'Cargo inválido ou inativo');
    if (!cityRecord) return responseHandler.error(res, 'Cidade inválida ou inativa');

    const payload = {
      username,
      email,
      position: positionRecord.name,
      manager_id,
      city: cityRecord.name,
      status,
      birth_date,
      show_in_organogram: show_in_organogram ?? false,
      phone: phone ?? null,
    };
    if (role !== undefined) payload.role = role; // admin/user

    const [affectedRows] = await User.update(payload, { where: { id } });
    if (affectedRows === 0) return responseHandler.error(res, 'Usuário não encontrado');
    return responseHandler.success(res, { message: 'Informações atualizadas com sucesso' });
  } catch (error) {
    return responseHandler.error(res, error);
  }
};

export const getAllUsers = async (req, res) => {
  try {
    const users = await User.findAll({
      attributes: ['id', 'username', 'email', 'position', 'role', 'manager_id', 'city', 'birth_date', 'created_at', 'status', 'face_enabled', 'face_last_update', 'microsoft_id', 'sienge_email', 'show_in_organogram', 'auth_provider', 'phone'],
      include: [
        {
          model: User,
          as: 'manager',
          attributes: ['id', 'username']
        },
        {
          model: User,
          as: 'subordinates',
          attributes: ['id', 'username']
        }
      ],
      where: {
        auth_provider: { [Op.ne]: 'CVCRM' },
      },
    });
    if (users.length === 0) {
      return responseHandler.error(res, 'Nenhum usuário encontrado');
    }
    return responseHandler.success(res, users);
  } catch (error) {
    return responseHandler.error(res, error);
  }
};

// ── Credenciais Sienge ────────────────────────────────────────────────────────

/**
 * GET /api/auth/user/sienge-credentials
 * Retorna se o usuário tem credenciais Sienge configuradas e o email mascarado.
 */
export const getSiengeCredentials = async (req, res) => {
    try {
        const user = await User.findByPk(req.user.id, {
            attributes: ['id', 'sienge_email', 'sienge_password'],
        });
        if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });

        const hasCredentials = !!(user.sienge_email && user.sienge_password);
        let maskedEmail = null;
        if (hasCredentials) {
            const email = decrypt(user.sienge_email);
            if (email) {
                const [local, domain] = email.split('@');
                maskedEmail = `${local.slice(0, 3)}***@${domain}`;
            }
        }
        return res.json({ hasCredentials, maskedEmail });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

/**
 * PUT /api/auth/user/sienge-credentials
 * Salva email e senha Sienge criptografados no perfil do usuário.
 */
export const saveSiengeCredentials = async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email?.trim() || !password?.trim()) {
            return res.status(422).json({ error: 'Email e senha são obrigatórios.' });
        }
        const user = await User.findByPk(req.user.id);
        if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });

        await user.update({
            sienge_email: encrypt(email.trim()),
            sienge_password: encrypt(password),
        });

        // Limpa o flag de credenciais inválidas em todos os lançamentos do usuário
        await db.PaymentLaunch.update(
            { siengeCredentialsInvalid: false },
            { where: { createdBy: req.user.id, siengeCredentialsInvalid: true } }
        );

        return res.json({ success: true, message: 'Credenciais Sienge salvas com segurança.' });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

// ── Reset de senha pelo admin ─────────────────────────────────────────────────

/**
 * POST /api/auth/users/:id/reset-password  (admin only)
 * Gera uma senha aleatória segura e substitui a senha atual do usuário.
 * Retorna a senha gerada para que o admin possa repassá-la.
 */
export const adminResetUserPassword = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return responseHandler.error(res, 'ID inválido');

    const user = await User.findByPk(id);
    if (!user) return responseHandler.error(res, 'Usuário não encontrado');

    const newPassword = generateSecurePassword();

    user.password = newPassword;
    user.reset_password_code = null;
    user.reset_password_expires_at = null;
    user.reset_password_attempts = 0;
    user.reset_password_last_sent_at = null;
    await user.save();

    return responseHandler.success(res, {
      password: newPassword,
      message: 'Senha resetada com sucesso.',
    });
  } catch (error) {
    console.error('[adminResetUserPassword] erro:', error);
    return responseHandler.error(res, 'Erro ao resetar senha');
  }
};

export const getUserById = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id, {
      attributes: ['username', 'email', 'position', 'role', 'manager_id', 'city', 'birth_date', 'created_at', 'status', 'face_enabled', 'face_last_update'],
      include: [
        {
          model: User,
          as: 'manager',
          attributes: ['id', 'username']
        },
        {
          model: User,
          as: 'subordinates',
          attributes: ['id', 'username']
        }
      ]
    });
    if (!user) {
      return responseHandler.error(res, 'Usuário não encontrado');
    }
    return responseHandler.success(res, user);
  } catch (error) {
    return responseHandler.error(res, error);
  }
};
