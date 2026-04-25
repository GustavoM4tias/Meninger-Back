// /controllers/permissionProfileController.js
import db from '../models/sequelize/index.js';

export async function getProfiles(req, res) {
  try {
    const profiles = await db.PermissionProfile.findAll({
      where: { active: true },
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
    const { name, description, routes } = req.body;
    if (!name?.trim() || !Array.isArray(routes)) {
      return res.status(400).json({ message: 'Nome e rotas são obrigatórios.' });
    }

    const profile = await db.PermissionProfile.create({
      name: name.trim(),
      description: description?.trim() || null,
      routes,
    });

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
    const { name, description, routes } = req.body;

    const profile = await db.PermissionProfile.findByPk(id);
    if (!profile) return res.status(404).json({ message: 'Perfil não encontrado.' });

    if (name !== undefined) profile.name = name.trim();
    if (description !== undefined) profile.description = description?.trim() || null;
    if (Array.isArray(routes)) profile.routes = routes;

    await profile.save();
    return res.json(profile);
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ message: 'Já existe um perfil com este nome.' });
    }
    console.error('[PermissionProfile] updateProfile error:', err);
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
