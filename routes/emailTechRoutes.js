// api/routes/emailTechRoutes.js
import express from 'express';
import { verifySmtp, sendTestEmail } from '../email/email.service.js';

const router = express.Router();

// ✅ Testa conectividade SMTP (Railway -> seu host)
router.get('/_email/verify', async (req, res) => {
    const result = await verifySmtp();
    res.status(result.ok ? 200 : 500).json(result);
});

// ✅ Envia e-mail real para TEST_TO
router.post('/_email/send-test', async (req, res) => {
    try {
        const info = await sendTestEmail();
        res.json({
            success: true,
            messageId: info?.messageId,
            accepted: info?.accepted,
            rejected: info?.rejected,
            response: info?.response,
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err?.message || String(err) });
    }
});

export default router;
