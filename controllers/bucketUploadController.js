// /controllers/bucketUploadController.js
import XLSX from 'xlsx';
import { Storage } from '@google-cloud/storage';
import crypto from 'crypto';
import db from '../models/sequelize/index.js';

const GCS_BUCKET = process.env.GCS_BUCKET || 'bucket-menin';

const VALID_FOLDERS = ['encaminhados', 'test-robot'];

const SHEET_MAP = [
    { sheetName: 'Engenharia',           outputName: 'Engenharia.csv' },
    { sheetName: 'Area Contruida Total', outputName: 'Area_construida_total.csv' },
];

// ── GCS client ──────────────────────────────────────────────────────────────
let storage;
try {
    const credJson = process.env.GCS_CREDENTIALS_JSON;
    const keyFile  = process.env.GCS_KEY_FILE;

    if (credJson) {
        storage = new Storage({ credentials: JSON.parse(credJson) });
    } else if (keyFile) {
        storage = new Storage({ keyFilename: keyFile });
    } else {
        console.warn('[BucketUpload] GCS_CREDENTIALS_JSON e GCS_KEY_FILE não configurados. Upload desativado.');
        // Não instancia Storage sem credenciais — evita tentativa de ADC que trava em ambientes não-GCP
    }
} catch (e) {
    console.error('[BucketUpload] GCS init error:', e.message);
}

// ── Temp store (preview, TTL 10 min) ────────────────────────────────────────
const tempStore = new Map();
setInterval(() => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [k, v] of tempStore.entries()) {
        if (v.createdAt < cutoff) tempStore.delete(k);
    }
}, 60_000);

// ── Helpers ──────────────────────────────────────────────────────────────────

function sanitize(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\x00-\x7F]/g, '')
        .trim();
}

function sheetToCSV(sheet) {
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    return rows
        .map(row =>
            row.map(cell => {
                const val = sanitize(cell);
                return val.includes(',') || val.includes('\n') || val.includes('"')
                    ? `"${val.replace(/"/g, '""')}"`
                    : val;
            }).join(',')
        )
        .join('\n');
}

function sheetToPreviewRows(sheet) {
    return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' })
        .map(row => row.map(sanitize));
}

function countDataRows(sheet) {
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    return rows.length;
}

// ── Controllers ──────────────────────────────────────────────────────────────

/**
 * POST /api/bucket-upload/preview
 * Recebe o arquivo XLSX, extrai as abas, gera preview e armazena CSVs em memória.
 * Os nomes dos arquivos já seguem o padrão {dataType}_{yyyymmdd}_{hhmmss}.csv.
 */
export async function previewUpload(req, res) {
    try {
        if (!req.file) return res.status(400).json({ message: 'Arquivo não enviado.' });

        const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
        const available = workbook.SheetNames;

        const missing = SHEET_MAP.filter(m => !workbook.Sheets[m.sheetName]);
        if (missing.length > 0) {
            return res.status(400).json({
                message: `Aba(s) não encontrada(s): ${missing.map(m => `"${m.sheetName}"`).join(', ')}. Abas disponíveis: ${available.join(', ')}.`,
            });
        }

        const files = SHEET_MAP.map(({ sheetName, outputName }) => {
            const sheet = workbook.Sheets[sheetName];
            return {
                name: outputName,
                csv: sheetToCSV(sheet),
                previewRows: sheetToPreviewRows(sheet),
                totalRows: countDataRows(sheet),
            };
        });

        const tempId = crypto.randomUUID();
        tempStore.set(tempId, {
            files: files.map(f => ({ name: f.name, csv: f.csv })),
            originalFileName: req.file.originalname,
            createdAt: Date.now(),
        });

        return res.json({
            tempId,
            files: files.map(f => ({
                name:        f.name,
                previewRows: f.previewRows,
                totalRows:   f.totalRows,
            })),
        });
    } catch (err) {
        console.error('[BucketUpload] preview error:', err);
        return res.status(500).json({ message: 'Erro ao processar planilha: ' + err.message });
    }
}

/**
 * POST /api/bucket-upload/confirm
 * Confirma o envio dos CSVs para o GCS.
 * Body: { tempId, folder } — folder: 'encaminhados' (padrão) | 'test-robot'
 */
export async function confirmUpload(req, res) {
    const { tempId, folder = 'encaminhados' } = req.body;

    if (!tempId) return res.status(400).json({ message: 'tempId é obrigatório.' });

    if (!VALID_FOLDERS.includes(folder)) {
        return res.status(400).json({
            message: `Pasta inválida: "${folder}". Use "encaminhados" ou "test-robot".`,
        });
    }

    const temp = tempStore.get(tempId);
    if (!temp) return res.status(400).json({ message: 'Preview expirado ou inválido. Recarregue o arquivo.' });

    if (!storage) {
        return res.status(500).json({
            message: 'Google Cloud Storage não configurado. Configure a variável GCS_CREDENTIALS_JSON ou GCS_KEY_FILE no servidor.',
        });
    }

    try {
        const bucket   = storage.bucket(GCS_BUCKET);
        const uploaded = [];

        for (const file of temp.files) {
            const destPath = `${folder}/${file.name}`;
            await bucket.file(destPath).save(file.csv, {
                contentType: 'text/csv; charset=utf-8',
                resumable:   false,
                metadata:    { cacheControl: 'no-cache' },
            });
            uploaded.push({ name: file.name, path: destPath });
        }

        tempStore.delete(tempId);

        await db.BucketUploadHistory.create({
            userId:        req.user?.id ?? null,
            userName:      req.user?.username ?? req.user?.name ?? 'Desconhecido',
            userEmail:     req.user?.email ?? null,
            sourceFile:    temp.originalFileName,
            folder,
            status:        'success',
            filesUploaded: uploaded.map(u => u.name),
            gcsPaths:      uploaded.map(u => u.path),
            errorMessage:  null,
        });

        return res.json({
            success: true,
            message: `Arquivos enviados com sucesso para ${GCS_BUCKET}/${folder}/`,
            folder,
            files: uploaded,
        });
    } catch (err) {
        console.error('[BucketUpload] confirm error:', err);

        try {
            await db.BucketUploadHistory.create({
                userId:        req.user?.id ?? null,
                userName:      req.user?.username ?? req.user?.name ?? 'Desconhecido',
                userEmail:     req.user?.email ?? null,
                sourceFile:    temp.originalFileName,
                folder,
                status:        'error',
                filesUploaded: [],
                gcsPaths:      [],
                errorMessage:  err.message,
            });
        } catch { /* ignorar falha de log */ }

        return res.status(500).json({ message: 'Erro ao enviar para o bucket: ' + err.message });
    }
}

/**
 * GET /api/bucket-upload/history
 */
export async function getHistory(req, res) {
    try {
        const history = await db.BucketUploadHistory.findAll({
            order: [['created_at', 'DESC']],
            limit: 50,
        });
        return res.json(history);
    } catch (err) {
        console.error('[BucketUpload] history error:', err);
        return res.status(500).json({ message: err.message });
    }
}
