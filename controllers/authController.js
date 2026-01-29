// api/controllers/authController.js
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import db from '../models/sequelize/index.js';
import jwtConfig from '../config/jwtConfig.js';
import responseHandler from '../utils/responseHandler.js';

const { User, Position, UserCity } = db;

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
  const { email, password } = req.body;
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
      attributes: ['id', 'username', 'email', 'position', 'role', 'manager_id', 'city', 'birth_date', 'created_at', 'status', 'face_enabled', 'face_last_update', 'auth_provider', 'external_kind', 'external_id']
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
  const { username, email, position, city, status, birth_date, face_enabled } = req.body;
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
  const { id, username, email, position, role, manager_id, city, status, birth_date } = req.body;

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
      attributes: ['id', 'username', 'email', 'position', 'role', 'manager_id', 'city', 'birth_date', 'created_at', 'status', 'face_enabled', 'face_last_update'],
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
      where: { auth_provider: 'INTERNAL' }
    });
    if (users.length === 0) {
      return responseHandler.error(res, 'Nenhum usuário encontrado');
    }
    return responseHandler.success(res, users);
  } catch (error) {
    return responseHandler.error(res, error);
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
