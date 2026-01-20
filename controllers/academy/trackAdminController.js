import trackAdminService from '../../services/academy/trackAdminService.js';

const trackAdminController = {
  async list(req, res) {
    try {
      const audience = req.query.audience || 'BOTH';
      const status = req.query.status || ''; // '' | DRAFT | PUBLISHED
      return res.json(await trackAdminService.list({ audience, status }));
    } catch (err) {
      console.error('[academy.tracksAdmin.list]', err);
      return res.status(400).json({ message: err.message || 'Erro ao listar trilhas (admin).' });
    }
  },

  async get(req, res) {
    try {
      const { slug } = req.params;
      const data = await trackAdminService.get({ slug });
      return res.json(data);
    } catch (err) {
      console.error('[academy.tracksAdmin.get]', err);
      return res.status(400).json({ message: err.message || 'Erro ao carregar trilha (admin).' });
    }
  },

  async create(req, res) {
    try {
      const data = await trackAdminService.create({ payload: req.body });
      return res.status(201).json(data);
    } catch (err) {
      console.error('[academy.tracksAdmin.create]', err);
      return res.status(400).json({ message: err.message || 'Erro ao criar trilha.' });
    }
  },

  async update(req, res) {
    try {
      const { slug } = req.params;
      const data = await trackAdminService.update({ slug, payload: req.body });
      return res.json(data);
    } catch (err) {
      console.error('[academy.tracksAdmin.update]', err);
      return res.status(400).json({ message: err.message || 'Erro ao atualizar trilha.' });
    }
  },

  async setPublish(req, res) {
    try {
      const { slug } = req.params;
      const publish = !!req.body?.publish;
      return res.json(await trackAdminService.setPublish({ slug, publish }));
    } catch (err) {
      console.error('[academy.tracksAdmin.publish]', err);
      return res.status(400).json({ message: err.message || 'Erro ao publicar/despublicar trilha.' });
    }
  },

  async addItem(req, res) {
    try {
      const { slug } = req.params;
      const data = await trackAdminService.addItem({ slug, payload: req.body });
      return res.status(201).json(data);
    } catch (err) {
      console.error('[academy.tracksAdmin.addItem]', err);
      return res.status(400).json({ message: err.message || 'Erro ao adicionar item.' });
    }
  },

  async updateItem(req, res) {
    try {
      const { slug, itemId } = req.params;
      const data = await trackAdminService.updateItem({
        slug,
        itemId: Number(itemId),
        payload: req.body,
      });
      return res.json(data);
    } catch (err) {
      console.error('[academy.tracksAdmin.updateItem]', err);
      return res.status(400).json({ message: err.message || 'Erro ao atualizar item.' });
    }
  },

  async removeItem(req, res) {
    try {
      const { slug, itemId } = req.params;
      return res.json(await trackAdminService.removeItem({ slug, itemId: Number(itemId) }));
    } catch (err) {
      console.error('[academy.tracksAdmin.removeItem]', err);
      return res.status(400).json({ message: err.message || 'Erro ao remover item.' });
    }
  },

  async reorder(req, res) {
    try {
      const { slug } = req.params;
      const order = Array.isArray(req.body?.order) ? req.body.order : [];
      return res.json(await trackAdminService.reorder({ slug, order }));
    } catch (err) {
      console.error('[academy.tracksAdmin.reorder]', err);
      return res.status(400).json({ message: err.message || 'Erro ao reordenar itens.' });
    }
  },

  async remove(req, res) {
    try {
      const { slug } = req.params;
      return res.json(await trackAdminService.remove({ slug }));
    } catch (err) {
      console.error('[academy.tracksAdmin.remove]', err);
      return res.status(400).json({ message: err.message || 'Erro ao excluir trilha.' });
    }
  },
};

export default trackAdminController;
