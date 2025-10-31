import EnterpriseSyncService from '../../services/bulkData/cv/EnterpriseSyncService.js';

export default class EnterprisesSyncController {
    fullSync = async (req, res) => {
        try {
            const svc = new EnterpriseSyncService();
            await svc.loadAll();
            return res.json({ ok: true, message: 'FULL sync de empreendimentos concluído.' });
        } catch (e) {
            return res.status(500).json({ ok: false, error: e?.message || String(e) });
        }
    }

    deltaSync = async (req, res) => {
        try {
            const svc = new EnterpriseSyncService();
            await svc.loadDelta();
            return res.json({ ok: true, message: 'DELTA sync de empreendimentos concluído.' });
        } catch (e) {
            return res.status(500).json({ ok: false, error: e?.message || String(e) });
        }
    }
}
