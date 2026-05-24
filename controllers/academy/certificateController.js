import certificateService from '../../services/academy/certificateService.js';
import certificatePdfService from '../../services/academy/certificatePdfService.js';

function resolveUserId(req) {
    if (req.user?.id) return req.user.id;
    const headerId = Number(req.headers['x-user-id']);
    return Number.isFinite(headerId) && headerId > 0 ? headerId : null;
}

const certificateController = {
    // 🌐 PÚBLICO — sem auth. URL que vai no QR code do PDF.
    async verify(req, res) {
        try {
            const data = await certificateService.verify({ code: req.params.code });
            return res.json(data);
        } catch (err) {
            console.error('[academy.cert.verify]', err);
            return res.status(500).json({ valid: false, reason: 'error' });
        }
    },

    // 🔒 AUTH — meus certificados
    async listMine(req, res) {
        try {
            const userId = resolveUserId(req);
            if (!userId) return res.status(401).json({ message: 'Não autenticado.' });
            const data = await certificateService.listMine({ userId });
            return res.json(data);
        } catch (err) {
            console.error('[academy.cert.listMine]', err);
            return res.status(500).json({ message: 'Erro ao listar certificados.' });
        }
    },

    // 🔒 AUTH — detalhe (com evidence só para o dono)
    async getByCode(req, res) {
        try {
            const userId = resolveUserId(req);
            const data = await certificateService.getByCode({ code: req.params.code, userId });
            if (!data) return res.status(404).json({ message: 'Certificado não encontrado.' });
            return res.json(data);
        } catch (err) {
            console.error('[academy.cert.getByCode]', err);
            return res.status(500).json({ message: 'Erro ao carregar certificado.' });
        }
    },

    // 🌐 Download de PDF. Sem auth — quem tem o code, tem o PDF.
    // (O code é privado: só o dono recebe + admin pode mandar por e-mail.)
    async downloadPdf(req, res) {
        try {
            const cert = await certificateService.verify({ code: req.params.code });
            if (!cert?.valid) {
                return res.status(404).json({ message: 'Certificado inválido ou inexistente.' });
            }

            const pdfBuffer = await certificatePdfService.render({
                certificate: cert,
            });

            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader(
                'Content-Disposition',
                `inline; filename="certificado-${cert.code}.pdf"`
            );
            return res.end(pdfBuffer);
        } catch (err) {
            console.error('[academy.cert.downloadPdf]', err);
            return res.status(500).json({ message: 'Erro ao gerar PDF do certificado.' });
        }
    },

    // 🔒 ADMIN — revogar
    async revoke(req, res) {
        try {
            const userId = resolveUserId(req);
            const { reason } = req.body || {};
            const data = await certificateService.revoke({
                code: req.params.code,
                reason,
                byUserId: userId,
            });
            return res.json(data);
        } catch (err) {
            console.error('[academy.cert.revoke]', err);
            return res.status(400).json({ message: err.message || 'Erro ao revogar certificado.' });
        }
    },
};

export default certificateController;
