// services/boleto/BoletoGenerationService.js
import db from '../../models/sequelize/index.js';
import apiCv from '../../lib/apiCv.js';
import { runEcoCobrancaBoleto } from '../../playwright/services/ecocobrancaService.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SECRET_KEY
);
const BUCKET = process.env.SUPABASE_BUCKET || 'Office Bucket';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatCurrency(value) {
    return parseFloat(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatDate(isoDate) {
    if (!isoDate) return '-';
    const [y, m, d] = String(isoDate).split('-');
    return `${d}/${m}/${y}`;
}

async function getSettings() {
    let s = await db.BoletoSettings.findByPk(1);
    if (!s) s = await db.BoletoSettings.create({ id: 1 });
    return s;
}

async function sendCvMessage(idreserva, mensagem) {
    try {
        await apiCv.post('/v2/comercial/reservas/mensagens', { idreserva, mensagem });
    } catch (err) {
        console.error(`[BOLETO] Falha ao enviar mensagem na reserva ${idreserva}:`, err.message);
    }
}

/**
 * Altera a situação da reserva para um ID específico via API CV.
 * Usa o endpoint de alteração de situação do workflow.
 */
async function alterarSituacaoCv(idreserva, idsituacao) {
    try {
        await apiCv.post('/v1/comercial/reservas/alterar-situacao', {
            idreserva_cv: Number(idreserva),
            idsituacao_destino: Number(idsituacao),
            comentario: 'Alteração automática — Boleto Caixa',
        });
        return true;
    } catch (err) {
        const responseData = err.response?.data;
        console.error(
            `[BOLETO] Falha ao alterar situação da reserva ${idreserva} para ${idsituacao}:`,
            err.message,
            responseData ? JSON.stringify(responseData) : ''
        );
        return false;
    }
}

async function uploadToSupabase(buffer, historyId, idreserva) {
    const timestamp = Date.now();
    const fileName = `boleto-${idreserva}-${timestamp}.pdf`;
    const filePath = `office/boleto-caixa/${historyId}/${fileName}`;

    const { error } = await supabase.storage
        .from(BUCKET)
        .upload(filePath, buffer, { contentType: 'application/pdf', upsert: false });

    if (error) throw new Error(`Supabase upload falhou: ${error.message}`);

    const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(filePath);
    return { path: filePath, url: urlData?.publicUrl || null };
}

async function attachToCV(idreserva, buffer, settings) {
    if (!settings.cv_idtipo_documento) {
        console.warn('[BOLETO] cv_idtipo_documento não configurado — boleto não será anexado no CV.');
        return false;
    }
    const base64 = buffer.toString('base64');
    await apiCv.post('/v1/comercial/reservas/documentos', {
        idreserva,
        idtipo: settings.cv_idtipo_documento,
        documento_base64: base64,
    });
    return true;
}

// ── Processamento principal ───────────────────────────────────────────────────

/**
 * Processa um webhook recebido do CV: busca dados da reserva, emite boleto no
 * ECO Cobrança, anexa na reserva do CV e registra tudo no histórico interno.
 */
export async function processBoletoWebhook({ idreserva, idtransacao }) {
    console.log(`[BOLETO] Iniciando processamento — reserva ${idreserva}`);

    const settings = await getSettings();

    if (!settings.active) {
        console.log('[BOLETO] Processamento desabilitado nas configurações. Ignorando.');
        return;
    }

    if (!settings.eco_usuario || !settings.eco_senha) {
        console.error('[BOLETO] Credenciais ECO Cobrança não configuradas.');
        return;
    }

    const history = await db.BoletoHistory.create({
        idreserva,
        idtransacao: idtransacao || null,
        status: 'processing',
    });

    try {
        // ── 1. Busca dados da reserva no CV ───────────────────────────────────
        console.log(`[BOLETO] Buscando reserva ${idreserva} no CV...`);
        const reservaResp = await apiCv.get(`/v1/comercial/reservas/${idreserva}`);
        const reservaData = reservaResp.data?.[idreserva];
        if (!reservaData) throw new Error(`Reserva ${idreserva} não encontrada no CV.`);

        const { titular, condicoes, unidade } = reservaData;

        // ── 2. Localiza a série Recurso Próprio a Vista ───────────────────────
        const idserieAlvo = settings.idserie_ra || 21;
        const serie = (condicoes?.series || []).find(s => s.idserie === idserieAlvo);
        if (!serie) {
            throw new Error(
                `Série com idserie=${idserieAlvo} (Recurso Próprio a Vista) não encontrada nas condições da reserva.`
            );
        }

        // ── 3. Valida vencimento ──────────────────────────────────────────────
        const vencimento = serie.vencimento;
        const hoje = new Date();
        hoje.setHours(0, 0, 0, 0);
        const vencDate = new Date(vencimento + 'T00:00:00');

        if (vencDate < hoje) {
            const msg = `❌ Boleto não emitido: data de vencimento ${formatDate(vencimento)} está no passado.`;
            await sendCvMessage(idreserva, msg);

            let situacaoAlterada = false;
            if (settings.situacao_erro_id) {
                situacaoAlterada = await alterarSituacaoCv(idreserva, settings.situacao_erro_id);
            }

            await history.update({
                status: 'error',
                error_message: `Vencimento ${formatDate(vencimento)} está no passado.`,
                titular_nome: titular?.nome,
                empreendimento: unidade?.empreendimento,
                idpessoa_cv: titular?.idpessoa_cv,
                valor: parseFloat(serie.valor),
                vencimento,
                cv_mensagem_enviada: true,
                cv_situacao_alterada: situacaoAlterada,
            });
            return;
        }

        // ── 4. Busca CNPJ do empreendimento no CV ─────────────────────────────
        const idempreendimento = unidade?.idempreendimento_cv;
        if (!idempreendimento) throw new Error('idempreendimento_cv não encontrado na reserva.');

        console.log(`[BOLETO] Buscando empreendimento ${idempreendimento}...`);
        const empResp = await apiCv.get(`/v1/cadastros/empreendimentos/${idempreendimento}`, {
            params: { limite_dados_unidade: 1 },
        });
        const cnpjEmpresa = empResp.data?.cnpj_empesa;
        if (!cnpjEmpresa) throw new Error(`CNPJ do empreendimento ${idempreendimento} não encontrado.`);

        // ── 5. Atualiza histórico com dados coletados ─────────────────────────
        await history.update({
            idpessoa_cv: titular.idpessoa_cv,
            titular_nome: titular.nome,
            empreendimento: unidade.empreendimento,
            cnpj_empresa: cnpjEmpresa,
            valor: parseFloat(serie.valor),
            vencimento,
        });

        // ── 6. Executa automação ECO Cobrança via Playwright ──────────────────
        console.log(`[BOLETO] Iniciando Playwright ECO Cobrança...`);
        const { boletoBuffer, nossoNumero, seuNumero } = await runEcoCobrancaBoleto({
            credentials: { usuario: settings.eco_usuario, senha: settings.eco_senha },
            cnpj_empresa: cnpjEmpresa,
            idpessoa_cv: titular.idpessoa_cv,
            vencimento,
            valor: serie.valor,
            nome: titular.nome,
            documento: titular.documento,
            endereco: titular.endereco,
            numero: titular.numero,
            complemento: titular.complemento || '',
            bairro: titular.bairro,
            cep: titular.cep,
            cidade: titular.cidade,
            estado: titular.estado,
        });

        // ── 7. Upload para Supabase ───────────────────────────────────────────
        const { path: supabasePath, url: supabaseUrl } = await uploadToSupabase(
            boletoBuffer, history.id, idreserva
        );
        await history.update({
            boleto_supabase_path: supabasePath,
            boleto_supabase_url: supabaseUrl,
            nosso_numero: nossoNumero,
            seu_numero: seuNumero,
        });

        // ── 8. Anexa boleto na reserva do CV ──────────────────────────────────
        let documentoAnexado = false;
        try {
            documentoAnexado = await attachToCV(idreserva, boletoBuffer, settings);
        } catch (attachErr) {
            console.error(`[BOLETO] Falha ao anexar no CV: ${attachErr.message}`);
        }

        // ── 9. Altera situação para "em processamento/emitido" ────────────────
        let situacaoAlteradaSucesso = false;
        if (settings.situacao_sucesso_id) {
            situacaoAlteradaSucesso = await alterarSituacaoCv(idreserva, settings.situacao_sucesso_id);
        }

        // ── 10. Envia mensagem de sucesso com resumo completo do boleto ────────
        const msgSucesso = [
            '✅ Boleto Caixa emitido com sucesso!',
            '',
            `📋 Empreendimento: ${unidade.empreendimento}`,
            `👤 Titular: ${titular.nome}`,
            `🪪 CPF/CNPJ: ${titular.documento}`,
            `💰 Valor: ${formatCurrency(serie.valor)}`,
            `📅 Vencimento: ${formatDate(vencimento)}`,
            `🔢 Nosso Número: ${nossoNumero}`,
            `📄 Nº Documento: ${seuNumero}`,
            supabaseUrl ? `🔗 Boleto: ${supabaseUrl}` : null,
        ].filter(Boolean).join('\n');

        await sendCvMessage(idreserva, msgSucesso);

        await history.update({
            status: 'success',
            cv_mensagem_enviada: true,
            cv_documento_anexado: documentoAnexado,
            cv_situacao_alterada: situacaoAlteradaSucesso,
        });

        console.log(`[BOLETO] Reserva ${idreserva} processada com sucesso.`);

    } catch (err) {
        console.error(`[BOLETO] Erro no processamento da reserva ${idreserva}:`, err.message);

        const msgErro = `❌ Falha na emissão do boleto:\n${err.message}`;
        await sendCvMessage(idreserva, msgErro);

        let situacaoAlterada = false;
        if (settings.situacao_erro_id) {
            situacaoAlterada = await alterarSituacaoCv(idreserva, settings.situacao_erro_id);
        }

        await history.update({
            status: 'error',
            error_message: err.message,
            cv_mensagem_enviada: true,
            cv_situacao_alterada: situacaoAlterada,
        }).catch(() => {});
    }
}
