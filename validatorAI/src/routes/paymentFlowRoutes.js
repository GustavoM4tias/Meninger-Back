// validatorAI/src/routes/paymentFlowRoutes.js
import express from 'express';
import fs from 'fs/promises';
import { PaymentExtractorService, LAUNCH_TYPE_DEFAULTS } from '../services/PaymentExtractorService.js';

/**
 * @param {import('multer').Multer} upload
 */
export function paymentFlowRoutes(upload) {
    const router = express.Router();

    // ── Helper: limpa arquivo temporário do multer ────────────────────────────
    async function cleanupTempFile(filePath) {
        if (!filePath) return;
        try { await fs.unlink(filePath); } catch (_) { /* ignora */ }
    }

    /**
     * POST /ai/payment-flow/extract/nf
     * Extrai dados de uma Nota Fiscal / documento fiscal.
     */
    router.post('/extract/nf', upload.single('document'), async (req, res, next) => {
        try {
            if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });

            const result = await PaymentExtractorService.extractFromPdf(req.file.path, 'nf');
            await cleanupTempFile(req.file.path);

            if (result.error && !result.extracted) {
                return res.status(422).json({ error: result.error });
            }

            const today = req.body?.today || new Date().toISOString().slice(0, 10);
            const prefill = PaymentExtractorService.buildNfPrefill(result.extracted, today);

            return res.json({
                prefill,
                detectedMode: result.detectedMode,
                meta: {
                    tokensUsed: result.tokensUsed,
                    model: result.model,
                    numpages: result.numpages,
                    confidence: result.extracted?.confidence || null,
                    warning: result.error || null,
                },
            });
        } catch (err) {
            await cleanupTempFile(req.file?.path);
            next(err);
        }
    });

    /**
     * POST /ai/payment-flow/extract/boleto
     * Extrai dados de um Boleto Bancário.
     */
    router.post('/extract/boleto', upload.single('document'), async (req, res, next) => {
        try {
            if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });

            const result = await PaymentExtractorService.extractFromPdf(req.file.path, 'boleto');
            await cleanupTempFile(req.file.path);

            if (result.error && !result.extracted) {
                return res.status(422).json({ error: result.error });
            }

            const prefill = PaymentExtractorService.buildBoletoPrefill(result.extracted);

            return res.json({
                prefill,
                detectedMode: result.detectedMode,
                meta: {
                    tokensUsed: result.tokensUsed,
                    model: result.model,
                    numpages: result.numpages,
                    confidence: result.extracted?.confidence || null,
                    warning: result.error || null,
                },
            });
        } catch (err) {
            await cleanupTempFile(req.file?.path);
            next(err);
        }
    });

    /**
     * POST /ai/payment-flow/extract/auto
     * Detecta automaticamente se é NF ou Boleto e extrai os dados.
     * Usado no fluxo de "primeiro documento" quando o tipo ainda é desconhecido.
     */
    router.post('/extract/auto', upload.single('document'), async (req, res, next) => {
        try {
            if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });

            const result = await PaymentExtractorService.extractFromPdf(req.file.path, 'auto');
            await cleanupTempFile(req.file.path);

            if (result.error && !result.extracted) {
                return res.status(422).json({
                    error: result.error,
                    detectedMode: result.detectedMode || null,
                });
            }

            const today = req.body?.today || new Date().toISOString().slice(0, 10);
            const prefill = result.detectedMode === 'boleto'
                ? PaymentExtractorService.buildBoletoPrefill(result.extracted)
                : PaymentExtractorService.buildNfPrefill(result.extracted, today);

            return res.json({
                prefill,
                detectedMode: result.detectedMode,
                meta: {
                    tokensUsed: result.tokensUsed,
                    model: result.model,
                    numpages: result.numpages,
                    confidence: result.extracted?.confidence || null,
                    warning: result.error || null,
                },
            });
        } catch (err) {
            await cleanupTempFile(req.file?.path);
            next(err);
        }
    });

    /**
     * GET /ai/payment-flow/defaults
     * Retorna os defaults de orçamento/conta por tipo de lançamento.
     */
    router.get('/defaults', (_req, res) => {
        res.json(LAUNCH_TYPE_DEFAULTS);
    });

    return router;
}