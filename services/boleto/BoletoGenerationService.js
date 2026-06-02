// services/boleto/BoletoGenerationService.js
import db from '../../models/sequelize/index.js';
import apiCv from '../../lib/apiCv.js';
import { runEcoCobrancaBoleto } from '../../playwright/services/ecocobrancaService.js';
import { createClient } from '@supabase/supabase-js';
import { validateTitular, formatTitularErrorsMessage } from './titularValidator.js';

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

// Extrai mensagem legível da resposta de erro do CV, achatando objetos comuns
// (data.mensagem, data.erro, data.errors[]). Cai pra err.message se nada bater.
function describeCvError(err) {
    const data = err?.response?.data;
    if (data) {
        if (typeof data === 'string') return data;
        if (data.mensagem) return String(data.mensagem);
        if (data.erro)     return String(data.erro);
        if (data.message)  return String(data.message);
        if (Array.isArray(data.errors) && data.errors.length) {
            return data.errors.map(e => e.mensagem || e.message || JSON.stringify(e)).join(' | ');
        }
        try { return JSON.stringify(data).slice(0, 500); } catch { /* noop */ }
    }
    return err?.message || 'erro desconhecido';
}

async function sendCvMessage(idreserva, mensagem) {
    try {
        await apiCv.post('/v2/comercial/reservas/mensagens', { idreserva, mensagem });
        return { ok: true };
    } catch (err) {
        const detail = describeCvError(err);
        console.error(`[BOLETO] Falha ao enviar mensagem na reserva ${idreserva}: ${detail}`);
        return { ok: false, error: detail };
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
        return { ok: true };
    } catch (err) {
        const detail = describeCvError(err);
        console.error(
            `[BOLETO] Falha ao alterar situação da reserva ${idreserva} para ${idsituacao}: ${detail}`
        );
        return { ok: false, error: detail };
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
        return { ok: false, skipped: true, error: 'cv_idtipo_documento não configurado nas Configurações.' };
    }
    try {
        const base64 = buffer.toString('base64');
        // Endpoint v3 — idreserva vai na URL e os documentos em array no body.
        // Doc: POST /v3/comercial/reservas/{idreserva}/documentos
        await apiCv.post(`/v3/comercial/reservas/${Number(idreserva)}/documentos`, {
            documentos: [
                {
                    idtipo: Number(settings.cv_idtipo_documento),
                    documento_base64: base64,
                },
            ],
        });
        return { ok: true };
    } catch (err) {
        const detail = describeCvError(err);
        const status = err?.response?.status;
        console.error(
            `[BOLETO] Falha ao anexar boleto na reserva ${idreserva} (HTTP ${status || '??'}): ${detail}`
        );
        return { ok: false, error: detail, httpStatus: status || null };
    }
}

// ── Processamento principal ───────────────────────────────────────────────────

/**
 * Processa um webhook recebido do CV: busca dados da reserva, emite boleto no
 * Ecobrança, anexa na reserva do CV e registra tudo no histórico interno.
 */
export async function processBoletoWebhook({ idreserva, idtransacao }) {
    console.log(`[BOLETO] Iniciando processamento — reserva ${idreserva}`);

    const settings = await getSettings();

    if (!settings.active) {
        console.log('[BOLETO] Processamento desabilitado nas configurações. Ignorando.');
        return;
    }

    if (!settings.eco_usuario || !settings.eco_senha) {
        console.error('[BOLETO] Credenciais Ecobrança não configuradas.');
        return;
    }

    const history = await db.BoletoHistory.create({
        idreserva,
        idtransacao: idtransacao || null,
        status: 'processing',
    });

    // Avisos por etapa que não jogam exceção (anexo CV, mensagem CV, alteração
    // de situação). Persistidos em `history.warnings` ao final pra aparecerem
    // no log do frontend mesmo quando o boleto foi emitido com sucesso.
    const warnings = [];
    const pushWarn = (result, etapa) => {
        if (!result?.ok) {
            warnings.push({
                etapa,
                erro: result?.error || 'erro desconhecido',
                ...(result?.httpStatus ? { httpStatus: result.httpStatus } : {}),
                ...(result?.skipped ? { skipped: true } : {}),
            });
        }
        return !!result?.ok;
    };

    try {
        // ── 1. Busca dados da reserva no CV ───────────────────────────────────
        console.log(`[BOLETO] Buscando reserva ${idreserva} no CV...`);
        const reservaResp = await apiCv.get(`/v1/comercial/reservas/${idreserva}`);
        const reservaData = reservaResp.data?.[idreserva];
        if (!reservaData) throw new Error(`Reserva ${idreserva} não encontrada no CV.`);

        const { titular, condicoes, unidade } = reservaData;

        // ── 2. Localiza séries de entrada configuradas ────────────────────────
        // Flatten defensivo: tolera dados legados aninhados (ex.: [[[21,9]]]) que
        // possam ter ficado em produção antes do fix do setter.
        const rawIdseries = Array.isArray(settings.idserie_ra) ? settings.idserie_ra : [settings.idserie_ra];
        const idseriesAlvo = Array.from(new Set(
            rawIdseries.flat(Infinity).map(Number).filter(n => Number.isFinite(n) && n > 0)
        ));
        if (idseriesAlvo.length === 0) idseriesAlvo.push(21);

        const seriesEncontradas = (condicoes?.series || []).filter(
            s => idseriesAlvo.includes(Number(s.idserie))
        );

        if (seriesEncontradas.length === 0) {
            throw new Error(
                `Nenhuma série de entrada encontrada na reserva. IDs configurados: [${idseriesAlvo.join(', ')}].`
            );
        }

        // Regra: somente 1 parcela de entrada é permitida por reserva
        if (seriesEncontradas.length > 1) {
            const detalhe = seriesEncontradas
                .map(s => `série ${s.idserie} — venc. ${formatDate(s.vencimento)} — ${formatCurrency(s.valor)}`)
                .join('\n• ');
            const msg = [
                '❌ Boleto não emitido: múltiplas parcelas de entrada detectadas.',
                '',
                'A reserva possui mais de 1 parcela com ID de série de entrada configurado.',
                'Somente 1 parcela de 1 série de entrada é permitida por reserva.',
                '',
                'Parcelas encontradas:',
                `• ${detalhe}`,
            ].join('\n');
            const msgOk = pushWarn(await sendCvMessage(idreserva, msg), 'cv_mensagem');
            let situacaoAlterada = false;
            if (settings.situacao_erro_id) {
                situacaoAlterada = pushWarn(
                    await alterarSituacaoCv(idreserva, settings.situacao_erro_id),
                    'cv_situacao',
                );
            }
            await history.update({
                status: 'error',
                error_message: `Múltiplas parcelas de entrada detectadas (${seriesEncontradas.length}).`,
                titular_nome: titular?.nome,
                empreendimento: unidade?.empreendimento,
                idpessoa_cv: titular?.idpessoa_cv,
                cv_mensagem_enviada: msgOk,
                cv_situacao_alterada: situacaoAlterada,
                warnings: warnings.length ? warnings : null,
            });
            return;
        }

        const serie = seriesEncontradas[0];
        console.log(`[BOLETO] Série encontrada: idserie=${serie.idserie}`);

        // ── 2.5. Valida dados do titular antes de qualquer chamada cara ──────
        // O portal Ecobrança rejeita silenciosamente endereços/CPF/CEP malformados
        // com "ENDERECO SACADO INVALIDO" etc. Validamos antes pra dar feedback
        // claro ao admin sobre o que ajustar no CV.
        const titularCheck = validateTitular(titular);
        if (!titularCheck.valid) {
            console.warn(
                `[BOLETO] Titular com divergências (${titularCheck.errors.length}): `
                + titularCheck.errors.map(e => `${e.campo}=${e.motivo}`).join('; ')
            );
            const msg = formatTitularErrorsMessage(titularCheck.errors);
            const msgOk = pushWarn(await sendCvMessage(idreserva, msg), 'cv_mensagem');

            let situacaoAlterada = false;
            if (settings.situacao_erro_id) {
                situacaoAlterada = pushWarn(
                    await alterarSituacaoCv(idreserva, settings.situacao_erro_id),
                    'cv_situacao',
                );
            }

            const resumoErro = `Divergência nos dados do titular: ${titularCheck.errors.map(e => e.campo).join(', ')}.`;
            await history.update({
                status: 'error',
                error_message: resumoErro,
                titular_nome: titular?.nome,
                empreendimento: unidade?.empreendimento,
                idpessoa_cv: titular?.idpessoa_cv,
                valor: parseFloat(serie.valor),
                vencimento: serie.vencimento,
                cv_mensagem_enviada: msgOk,
                cv_situacao_alterada: situacaoAlterada,
                warnings: warnings.length ? warnings : null,
            });
            return;
        }

        // ── 2b. Aplica regra de comissão embutida (se houver para o empreendimento) ─
        const valorOriginal = parseFloat(serie.valor);
        let valorEmitir = valorOriginal;
        let comissaoPercentualAplicada = null;
        let comissaoRuleId = null;

        if (unidade?.idempreendimento_cv) {
            const rule = await db.BoletoComissionRule.findOne({
                where: {
                    idempreendimento_cv: Number(unidade.idempreendimento_cv),
                    active: true,
                },
            });
            if (rule) {
                const pct = parseFloat(rule.percentual_boleto);
                if (Number.isFinite(pct) && pct >= 0 && pct < 100) {
                    valorEmitir = Number((valorOriginal * (pct / 100)).toFixed(2));
                    comissaoPercentualAplicada = pct;
                    comissaoRuleId = rule.id;
                    console.log(
                        `[BOLETO] Regra de comissão aplicada (empreendimento ${unidade.idempreendimento_cv}): `
                        + `${pct}% de ${formatCurrency(valorOriginal)} = ${formatCurrency(valorEmitir)}`
                    );
                }
            }
        }

        // Substitui o valor da série pelo valor a emitir (mantém referência ao original).
        serie.valor = valorEmitir;

        // ── 3. Valida vencimento (deve ser >= hoje) ───────────────────────────
        const vencimento = serie.vencimento;
        const hoje = new Date();
        hoje.setHours(0, 0, 0, 0);
        const vencDate = new Date(vencimento + 'T00:00:00');

        if (vencDate < hoje) {
            const msg = `❌ Boleto não emitido: data de vencimento ${formatDate(vencimento)} está no passado.\nSomente vencimentos a partir de hoje são aceitos.`;
            const msgOk = pushWarn(await sendCvMessage(idreserva, msg), 'cv_mensagem');

            let situacaoAlterada = false;
            if (settings.situacao_erro_id) {
                situacaoAlterada = pushWarn(
                    await alterarSituacaoCv(idreserva, settings.situacao_erro_id),
                    'cv_situacao',
                );
            }

            await history.update({
                status: 'error',
                error_message: `Vencimento ${formatDate(vencimento)} está no passado.`,
                titular_nome: titular?.nome,
                empreendimento: unidade?.empreendimento,
                idpessoa_cv: titular?.idpessoa_cv,
                valor: valorEmitir,
                valor_original: valorOriginal,
                comissao_percentual_aplicada: comissaoPercentualAplicada,
                vencimento,
                cv_mensagem_enviada: msgOk,
                cv_situacao_alterada: situacaoAlterada,
                warnings: warnings.length ? warnings : null,
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
            valor: valorEmitir,
            valor_original: valorOriginal,
            comissao_percentual_aplicada: comissaoPercentualAplicada,
            vencimento,
        });

        // ── 6. Calcula sequência do Nosso Número para evitar duplicata ───────────
        // Conta boletos anteriores (qualquer status) para este idpessoa_cv
        // 1º boleto → "11000000{id}", 2º → "11000000{id}1", 3º → "11000000{id}2" ...
        const boletosAnteriores = await db.BoletoHistory.count({
            where: {
                idpessoa_cv: titular.idpessoa_cv,
                id: { [db.Sequelize.Op.lt]: history.id }, // apenas registros anteriores a este
            },
        });
        const sufixo = boletosAnteriores > 0 ? String(boletosAnteriores) : '';
        const nossoNumeroCalculado = `11000000${titular.idpessoa_cv}${sufixo}`;
        console.log(`[BOLETO] Nosso Número calculado: ${nossoNumeroCalculado} (seq: ${boletosAnteriores})`);

        // ── 7. Executa automação Ecobrança via Playwright ──────────────────
        console.log(`[BOLETO] Iniciando Playwright Ecobrança...`);
        const { boletoBuffer, nossoNumero, seuNumero } = await runEcoCobrancaBoleto({
            credentials: { usuario: settings.eco_usuario, senha: settings.eco_senha },
            cnpj_empresa: cnpjEmpresa,
            idpessoa_cv: titular.idpessoa_cv,
            nossoNumero: nossoNumeroCalculado,
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
        const documentoAnexado = pushWarn(
            await attachToCV(idreserva, boletoBuffer, settings),
            'cv_anexo',
        );

        // ── 9. Altera situação para "em processamento/emitido" ────────────────
        let situacaoAlteradaSucesso = false;
        if (settings.situacao_sucesso_id) {
            situacaoAlteradaSucesso = pushWarn(
                await alterarSituacaoCv(idreserva, settings.situacao_sucesso_id),
                'cv_situacao',
            );
        }

        // ── 10. Envia mensagem de sucesso com resumo completo do boleto ────────
        const linhaValor = comissaoPercentualAplicada != null
            ? `💰 Valor: ${formatCurrency(valorEmitir)} (${comissaoPercentualAplicada}% de ${formatCurrency(valorOriginal)} — comissão embutida deduzida)`
            : `💰 Valor: ${formatCurrency(valorEmitir)}`;

        const msgSucesso = [
            '✅ Boleto Caixa emitido com sucesso!',
            '',
            `📋 Empreendimento: ${unidade.empreendimento}`,
            `👤 Titular: ${titular.nome}`,
            `🪪 CPF/CNPJ: ${titular.documento}`,
            linhaValor,
            `📅 Vencimento: ${formatDate(vencimento)}`,
            `🔢 Nosso Número: ${nossoNumero}`,
            `📄 Nº Documento: ${seuNumero}`,
            supabaseUrl ? `🔗 Boleto: ${supabaseUrl}` : null,
        ].filter(Boolean).join('\n');

        const msgSucessoOk = pushWarn(await sendCvMessage(idreserva, msgSucesso), 'cv_mensagem');

        // Boleto foi emitido — status segue 'success' mesmo com warnings de
        // etapas pós-emissão (anexo/situação/mensagem). O frontend mostra os
        // avisos via `warnings` pra o admin agir.
        await history.update({
            status: 'success',
            cv_mensagem_enviada: msgSucessoOk,
            cv_documento_anexado: documentoAnexado,
            cv_situacao_alterada: situacaoAlteradaSucesso,
            warnings: warnings.length ? warnings : null,
        });

        if (warnings.length) {
            console.warn(
                `[BOLETO] Reserva ${idreserva} emitida com ${warnings.length} aviso(s) pós-emissão: `
                + warnings.map(w => `${w.etapa}=${w.erro}`).join(' | ')
            );
        } else {
            console.log(`[BOLETO] Reserva ${idreserva} processada com sucesso.`);
        }

    } catch (err) {
        console.error(`[BOLETO] Erro no processamento da reserva ${idreserva}:`, err.message);

        const msgErro = `❌ Falha na emissão do boleto:\n${err.message}`;
        const msgOk = pushWarn(await sendCvMessage(idreserva, msgErro), 'cv_mensagem');

        let situacaoAlterada = false;
        if (settings.situacao_erro_id) {
            situacaoAlterada = pushWarn(
                await alterarSituacaoCv(idreserva, settings.situacao_erro_id),
                'cv_situacao',
            );
        }

        await history.update({
            status: 'error',
            error_message: err.message,
            cv_mensagem_enviada: msgOk,
            cv_situacao_alterada: situacaoAlterada,
            warnings: warnings.length ? warnings : null,
        }).catch(() => {});
    }
}
