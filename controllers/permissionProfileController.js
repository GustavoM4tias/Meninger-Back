// /controllers/permissionProfileController.js
import { Op } from 'sequelize';
import db from '../models/sequelize/index.js';
import { defaultRoutesForDepartment } from '../lib/ensureSignupApprovalSchema.js';

// Garante no máximo UM perfil padrão por departamento: ao vincular um perfil a
// um departamento, desvincula qualquer outro que apontasse para ele.
async function claimDepartment(departmentId, profileId) {
  if (!departmentId) return;
  await db.PermissionProfile.update(
    { department_id: null },
    { where: { department_id: departmentId, id: { [Op.ne]: profileId } } },
  );
}

export async function getProfiles(req, res) {
  try {
    // Inclui os INATIVOS. Esconder perfil inativo da tela que administra perfil
    // é esconder justamente o que precisa de atenção: ele continua vinculado a
    // gente e não concede nada. O `active` vai no payload e a tela rotula.
    const profiles = await db.PermissionProfile.findAll({
      order: [['name', 'ASC']],
    });
    return res.json(profiles);
  } catch (err) {
    console.error('[PermissionProfile] getProfiles error:', err);
    return res.status(500).json({ message: err.message });
  }
}

export async function createProfile(req, res) {
  try {
    const { name, description, routes, department_id } = req.body;
    if (!name?.trim() || !Array.isArray(routes)) {
      return res.status(400).json({ message: 'Nome e rotas são obrigatórios.' });
    }

    const profile = await db.PermissionProfile.create({
      name: name.trim(),
      description: description?.trim() || null,
      routes,
      department_id: Number(department_id) || null,
    });
    await claimDepartment(profile.department_id, profile.id);

    return res.status(201).json(profile);
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ message: 'Já existe um perfil com este nome.' });
    }
    console.error('[PermissionProfile] createProfile error:', err);
    return res.status(500).json({ message: err.message });
  }
}

export async function updateProfile(req, res) {
  try {
    const { id } = req.params;
    const { name, description, routes, department_id } = req.body;

    const profile = await db.PermissionProfile.findByPk(id);
    if (!profile) return res.status(404).json({ message: 'Perfil não encontrado.' });

    if (name !== undefined) profile.name = name.trim();
    if (description !== undefined) profile.description = description?.trim() || null;
    if (Array.isArray(routes)) {
      profile.routes = routes;
      // Edição do admin manda: o seed de perfis padrão para de re-sincronizar
      // as telas deste perfil (volta a valer só com "Restaurar padrão").
      profile.routes_customized = true;
    }
    if (department_id !== undefined) profile.department_id = Number(department_id) || null;

    await profile.save();
    await claimDepartment(profile.department_id, profile.id);
    return res.json(profile);
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ message: 'Já existe um perfil com este nome.' });
    }
    console.error('[PermissionProfile] updateProfile error:', err);
    return res.status(500).json({ message: err.message });
  }
}

// POST /api/permissions/profiles/:id/reset-default
// Volta o perfil para o conjunto de telas padrão do departamento vinculado e
// devolve o perfil ao seed (routes_customized=false), que passa a mantê-lo
// atualizado de novo conforme o sistema ganha telas.
export async function resetProfileToDefault(req, res) {
  try {
    const { id } = req.params;
    const profile = await db.PermissionProfile.findByPk(id);
    if (!profile) return res.status(404).json({ message: 'Perfil não encontrado.' });
    if (!profile.department_id) {
      return res.status(400).json({ message: 'Perfil avulso não tem padrão de departamento. Vincule um departamento primeiro.' });
    }

    const dept = await db.Department.findByPk(profile.department_id);
    if (!dept) return res.status(400).json({ message: 'Departamento do perfil não encontrado.' });

    await profile.update({
      routes: defaultRoutesForDepartment(dept),
      seed_code: dept.code || profile.seed_code || null,
      routes_customized: false,
    });
    return res.json(profile);
  } catch (err) {
    console.error('[PermissionProfile] resetProfileToDefault error:', err);
    return res.status(500).json({ message: err.message });
  }
}

export async function deleteProfile(req, res) {
  try {
    const { id } = req.params;
    const profile = await db.PermissionProfile.findByPk(id);
    if (!profile) return res.status(404).json({ message: 'Perfil não encontrado.' });

    await profile.update({ active: false });
    return res.json({ success: true });
  } catch (err) {
    console.error('[PermissionProfile] deleteProfile error:', err);
    return res.status(500).json({ message: err.message });
  }
}
