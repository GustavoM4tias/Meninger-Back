import supabase from '../config/supabaseClient.js';

const STORAGE_BUCKET = process.env.SUPABASE_BUCKET || 'Office Bucket';

const CONTEXTS = {
    USER_AVATAR: 'user_avatar',
    EVENT_IMAGE: 'event_image',
    SIENGE_ATTACHMENT: 'sienge_attachment',
    // ── PaymentFlow ────────────────────────────────────────────────────────────
    PAYMENT_FLOW_NF: 'payment_flow_nf',           // Nota Fiscal principal
    PAYMENT_FLOW_BOLETO: 'payment_flow_boleto',   // Boleto vinculado
    PAYMENT_FLOW_EXTRA: 'payment_flow_extra',     // Anexos extras (vários)
    // ── Assinatura Digital ─────────────────────────────────────────────────────
    SIGNATURE_DOC: 'signature_doc',               // Documentos para assinar
};

function sanitizeFileName(name = '') {
    return String(name)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, '-')
        .replace(/[^a-zA-Z0-9.\-_]/g, '')
        .toLowerCase();
}

function buildUploadConfig({ context, file, userId, referenceId, resourceType }) {
    const originalName = sanitizeFileName(file.originalname);
    const timestamp = Date.now();

    switch (context) {
        case CONTEXTS.USER_AVATAR:
            if (!userId) throw new Error('Usuário não autenticado');
            if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) {
                throw new Error('Avatar aceita apenas PNG, JPG ou WEBP');
            }
            return {
                bucket: STORAGE_BUCKET,
                path: `office/users/${userId}/avatar/${timestamp}-${originalName}`,
                isPublic: true,
            };

        case CONTEXTS.EVENT_IMAGE:
            if (!referenceId) throw new Error('referenceId é obrigatório para imagem de evento');
            if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) {
                throw new Error('Imagem de evento aceita apenas PNG, JPG ou WEBP');
            }
            return {
                bucket: STORAGE_BUCKET,
                path: `office/marketing/events/${referenceId}/images/${timestamp}-${originalName}`,
                isPublic: true,
            };

        case CONTEXTS.SIENGE_ATTACHMENT:
            if (!referenceId) throw new Error('referenceId é obrigatório para anexo do Sienge');
            if (!resourceType) throw new Error('resourceType é obrigatório para anexo do Sienge');
            if (file.mimetype !== 'application/pdf') {
                throw new Error('Anexo do Sienge aceita apenas PDF');
            }
            return {
                bucket: STORAGE_BUCKET,
                path: `office/sienge/${resourceType}/${referenceId}/attachments/${timestamp}-${originalName}`,
                isPublic: true,
            };

        // ── PaymentFlow: NF ──────────────────────────────────────────────────
        case CONTEXTS.PAYMENT_FLOW_NF:
            if (file.mimetype !== 'application/pdf') {
                throw new Error('NF aceita apenas PDF');
            }
            return {
                bucket: STORAGE_BUCKET,
                // referenceId pode ser o ID do launch (se já criado) ou 'draft'
                path: `office/payment-flow/${referenceId || 'draft'}/${timestamp}-nf-${originalName}`,
                isPublic: true,
            };

        // ── PaymentFlow: Boleto ──────────────────────────────────────────────
        case CONTEXTS.PAYMENT_FLOW_BOLETO:
            if (file.mimetype !== 'application/pdf') {
                throw new Error('Boleto aceita apenas PDF');
            }
            return {
                bucket: STORAGE_BUCKET,
                path: `office/payment-flow/${referenceId || 'draft'}/${timestamp}-boleto-${originalName}`,
                isPublic: true,
            };

        // ── PaymentFlow: Extras (PDF ou imagem) ──────────────────────────────
        case CONTEXTS.PAYMENT_FLOW_EXTRA:
            if (!['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) {
                throw new Error('Anexo extra aceita PDF, PNG, JPG ou WEBP');
            }
            return {
                bucket: STORAGE_BUCKET,
                path: `office/payment-flow/${referenceId || 'draft'}/extras/${timestamp}-${originalName}`,
                isPublic: true,
            };

        // ── Assinatura Digital ─────────────────────────────────────────────────
        case CONTEXTS.SIGNATURE_DOC:
            if (!userId) throw new Error('Usuário não autenticado');
            if (file.mimetype !== 'application/pdf') {
                throw new Error('Documento para assinatura aceita apenas PDF');
            }
            return {
                bucket: STORAGE_BUCKET,
                path: `office/signatures/${userId}/${timestamp}-${originalName}`,
                isPublic: true,
            };

        default:
            throw new Error('Contexto de upload inválido');
    }
}

export async function uploadFile(req, res) {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'Arquivo não enviado' });
        }

        const { context, referenceId, resourceType } = req.body;
        const userId = req.user?.id || null;

        if (!context) {
            return res.status(400).json({ message: 'context é obrigatório' });
        }

        const uploadConfig = buildUploadConfig({
            context,
            file: req.file,
            userId,
            referenceId,
            resourceType,
        });

        const { error: uploadError } = await supabase.storage
            .from(uploadConfig.bucket)
            .upload(uploadConfig.path, req.file.buffer, {
                contentType: req.file.mimetype,
                cacheControl: '3600',
                upsert: false,
            });

        if (uploadError) {
            console.error('Supabase upload error:', uploadError);
            return res.status(500).json({
                message: 'Erro ao enviar arquivo para o Supabase',
                error: uploadError.message,
            });
        }

        const { data } = supabase.storage
            .from(uploadConfig.bucket)
            .getPublicUrl(uploadConfig.path);

        return res.status(201).json({
            message: 'Upload realizado com sucesso',
            context,
            bucket: uploadConfig.bucket,
            path: uploadConfig.path,
            url: data?.publicUrl || null,
            isPublic: true,
            fileName: req.file.originalname,
            mimeType: req.file.mimetype,
            size: req.file.size,
        });
    } catch (error) {
        console.error('Upload controller error:', error);
        return res.status(400).json({
            message: error.message || 'Erro ao processar upload',
        });
    }
}