// services/contractAnalysisService.js
import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import apiCv from '../lib/apiCv.js';
import apiValidator from '../lib/apiValidator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// De onde veio a execução. 'webhook' é o caminho normal desde que o CV passou a
// avisar na entrada da etapa; 'manual' é a varredura de recuperação; 'agendado'
// só existe no histórico, de quando isto rodava em cron.
const ORIGENS_VALIDAS = new Set(['webhook', 'manual', 'agendado']);

// Repasses em análise AGORA, não importa por qual porta. As duas portas
// (webhook e varredura manual) escrevem no MESMO repasse no CV: sem este
// registro, uma varredura disparada no meio de um webhook analisaria o mesmo
// contrato duas vezes — duas mensagens no protocolo, dois gastos de modelo e
// duas trocas de etapa em cima da mesma reserva.
const emAnalise = new Set();

class ContractAnalysisService {
    constructor() {
        this.targetStatus = 'Analise Contratos';
        this.targetSituationId = 47;
        this.reprovedSituationId = 66;
        this.requiredDocTypes = ['CONFISSÃO DE DÍVIDA', 'CONTRATO CEF'];
        this.tempDir = path.join(__dirname, '../temp');

        // Criar diretório temporário se não existir
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }

    /**
     * Método principal para executar a análise automática
     */
    async executeAutomaticAnalysis(origem = 'agendado') {
        console.log('🚀 Iniciando análise automática de contratos...');

        // Toda execução deixa rastro, inclusive a que não acha nada e a que
        // morre no meio: sem isso, "o job não rodou" e "o job rodou e falhou"
        // ficam idênticos vistos do banco.
        const execucao = await this._abrirExecucao(origem);

        try {
            // Buscar repasses que precisam de análise
            const repasses = await this.getRepassesForAnalysis();
            console.log(`📊 Encontrados ${repasses.length} repasses para análise`);

            if (repasses.length === 0) {
                console.log('✅ Nenhum repasse encontrado para análise');
                await this._sincronizarParados([]);
                await this._fecharExecucao(execucao, { found: 0, processed: 0, errors: 0 });
                return { success: true, processed: 0, message: 'Nenhum repasse para processar' };
            }

            let processed = 0;
            let errors = 0;
            const desfechos = new Map();

            // Processar cada repasse
            for (const repasse of repasses) {
                try {
                    console.log(`🔄 Processando repasse ID: ${repasse.ID} - Reserva: ${repasse.idreserva}`);
                    const analysisResult = await this.processRepasse(repasse);

                    // O webhook pegou este primeiro: não conta como processado
                    // nem como erro, e o quadro de parados é dele.
                    if (analysisResult?.ignorado) continue;

                    processed++;
                    const deuErro = analysisResult?.status?.toUpperCase?.() === 'ERRO';
                    if (deuErro) {
                        errors++;
                    }
                    desfechos.set(Number(repasse.ID), {
                        ok: !deuErro,
                        erro: deuErro ? this._motivo(analysisResult) : null,
                    });

                    console.log(`✅ Repasse ${repasse.ID} processado com sucesso`);
                } catch (error) {
                    errors++;
                    desfechos.set(Number(repasse.ID), { ok: false, erro: error.message });
                    console.error(`❌ Erro ao processar repasse ${repasse.ID}:`, error.message);
                    await this.logErrorToRepasse(repasse.ID, error.message);
                }
            }

            await this._sincronizarParados(repasses, desfechos);
            await this._fecharExecucao(execucao, { found: repasses.length, processed, errors });

            console.log(`🎉 Análise concluída. Processados: ${processed}, Erros: ${errors}`);
            return {
                success: true,
                processed,
                errors,
                message: `Análise concluída. ${processed} repasses processados, ${errors} erros encontrados.`
            };

        } catch (error) {
            console.error('💥 Erro geral na análise automática:', error.message);
            await this._fecharExecucao(execucao, { message: error.message });
            return {
                success: false,
                error: error.message,
                message: 'Erro geral durante a análise automática'
            };
        }
    }

    /**
     * Analisa UM repasse, avisado pelo webhook CONTRATOS_IA do CV.
     *
     * A situação é RELIDA do CV, nunca aceita do corpo do webhook: o endereço
     * é público e o painel dispara em transições que não são a nossa. Repasse
     * que não está em "Analise Contratos" na hora da leitura vira registro de
     * execução e nada mais — não gasta modelo.
     */
    async analisarPorId(idrepasse, origem = 'webhook') {
        const execucao = await this._abrirExecucao(origem);

        try {
            const repasse = await this.buscarRepasseNaEtapa(idrepasse);

            if (!repasse) {
                const aviso = `Repasse ${idrepasse} não está em "${this.targetStatus}"; nada a analisar.`;
                console.log(`↩️  [CONTRATOS_IA] ${aviso}`);
                await this._fecharExecucao(execucao, { found: 0, processed: 0, errors: 0, message: aviso });
                return { success: true, ignorado: 'fora_da_etapa', message: aviso };
            }

            console.log(`🔄 [CONTRATOS_IA] Analisando repasse ${repasse.ID} - Reserva: ${repasse.idreserva}`);

            try {
                const analysisResult = await this.processRepasse(repasse);

                if (analysisResult?.ignorado) {
                    const aviso = `Repasse ${idrepasse} já estava em análise por outra porta.`;
                    await this._fecharExecucao(execucao, { found: 1, processed: 0, errors: 0, message: aviso });
                    return { success: true, ignorado: 'em_analise', message: aviso };
                }

                const deuErro = analysisResult?.status?.toUpperCase?.() === 'ERRO';

                await this._registrarParado(repasse, { ok: !deuErro, erro: deuErro ? this._motivo(analysisResult) : null });
                await this._fecharExecucao(execucao, { found: 1, processed: 1, errors: deuErro ? 1 : 0 });

                console.log(`✅ [CONTRATOS_IA] Repasse ${repasse.ID}: ${analysisResult?.status}`);
                return { success: true, status: analysisResult?.status, idrepasse: Number(idrepasse) };

            } catch (error) {
                // Mesmo desfecho da varredura: o erro vira mensagem no CRM, o
                // repasse fica na etapa e entra no quadro de parados.
                console.error(`❌ [CONTRATOS_IA] Erro no repasse ${repasse.ID}:`, error.message);
                await this.logErrorToRepasse(repasse.ID, error.message);
                await this._registrarParado(repasse, { ok: false, erro: error.message });
                await this._fecharExecucao(execucao, { found: 1, processed: 1, errors: 1 });
                return { success: false, error: error.message, idrepasse: Number(idrepasse) };
            }

        } catch (error) {
            console.error('💥 [CONTRATOS_IA] Falha antes da análise:', error.message);
            await this._fecharExecucao(execucao, { message: error.message });
            return { success: false, error: error.message };
        }
    }

    /**
     * O repasse, e só se ele estiver mesmo na etapa alvo.
     *
     * O CV aceita filtro por ID (medido: 1 item em ~3s, contra 10 MB da lista
     * inteira), mas filtro ignorado devolve tudo — por isso o ID é procurado
     * dentro do que voltou, em vez de confiar na primeira linha.
     */
    async buscarRepasseNaEtapa(idrepasse) {
        const id = Number(idrepasse);
        const response = await apiCv.get(`/v1/financeiro/repasses?ID=${id}`);
        const lista = response.data?.repasses;

        if (!Array.isArray(lista)) throw new Error('Resposta inválida da API de repasses');

        const repasse = lista.find(r => Number(r.ID) === id);
        if (!repasse) return null;

        return repasse.status_repasse === this.targetStatus ? repasse : null;
    }

    /**
     * Buscar repasses que estão na etapa "Analise Contratos"
     */
    async getRepassesForAnalysis() {
        try {
            const response = await apiCv.get(`/v1/financeiro/repasses?limit=0`);

            if (!response.data?.repasses) {
                throw new Error('Resposta inválida da API de repasses');
            }

            // Filtrar repasses que estão na etapa "Analise Contratos"
            return response.data.repasses.filter(repasse =>
                repasse.status_repasse === this.targetStatus
            );
        } catch (error) {
            console.error('Erro ao buscar repasses:', error.message);
            throw new Error(`Falha ao buscar repasses: ${error.message}`);
        }
    }

    /**
     * Processar um repasse específico
     */
    async processRepasse(repasse) {
        const idRepasse = Number(repasse.ID);

        // Porta única: quem já está sendo analisado não entra de novo, venha a
        // segunda chamada do webhook ou da varredura.
        if (emAnalise.has(idRepasse)) {
            console.log(`⏭️  Repasse ${idRepasse} já está em análise por outra porta; não vou analisar duas vezes.`);
            return { status: 'IGNORADO', ignorado: 'em_analise', mensagens: [] };
        }
        emAnalise.add(idRepasse);

        try {
            // 1. Buscar documentos da reserva
            const documentos = await this.getReservaDocuments(repasse.idreserva);

            // 2. Filtrar documentos necessários
            const requiredDocs = this.filterRequiredDocuments(documentos);

            // 3. Validar se tem os documentos necessários
            this.validateRequiredDocuments(requiredDocs);

            // 4. Baixar documentos
            const downloadedDocs = await this.downloadDocuments(requiredDocs);

            // 5. Enviar para análise
            const analysisResult = await this.analyzeDocuments(downloadedDocs);

            // 6. Registrar resultado no CRM
            await this.logAnalysisResult(repasse.ID, analysisResult);

            // 7. Alterar situação do repasse
            await this.updateRepasseSituation(repasse.ID, analysisResult);

            // 8. Limpar arquivos temporários
            await this.cleanupTempFiles(downloadedDocs);

            return analysisResult;
        } catch (error) {
            console.error(`Erro ao processar repasse ${repasse.ID}:`, error.message);
            throw error;
        } finally {
            emAnalise.delete(idRepasse);
        }
    }

    /**
     * Buscar documentos da reserva
     */
    async getReservaDocuments(idreserva) {
        try {
            const response = await apiCv.get(`/v1/comercial/reservas/${idreserva}/documentos`);

            if (!response.data?.dados?.documentos?.titular) {
                throw new Error('Documentos da reserva não encontrados');
            }

            return response.data.dados.documentos.titular;
        } catch (error) {
            console.error(`Erro ao buscar documentos da reserva ${idreserva}:`, error.message);
            throw new Error(`Falha ao buscar documentos da reserva: ${error.message}`);
        }
    }

    /**
     * Filtrar documentos necessários para análise
     */
    filterRequiredDocuments(documentos) {
        const filtered = {};

        for (const doc of documentos) {
            if (this.requiredDocTypes.includes(doc.tipo)) {
                filtered[doc.tipo] = doc;
            }
        }

        return filtered;
    }

    /**
     * Validar se os documentos necessários estão presentes
     */
    validateRequiredDocuments(docs) {
        const missingDocs = this.requiredDocTypes.filter(type => !docs[type]);

        if (missingDocs.length > 0) {
            throw new Error(`Documentos obrigatórios não encontrados: ${missingDocs.join(', ')}`);
        }
    }

    /**
     * Baixar documentos do CRM
     */
    async downloadDocuments(docs) {
        const downloaded = {};
        const PRAZO_MS = Number(process.env.CONTRACT_DOWNLOAD_TIMEOUT_MS || 120000);

        for (const [tipo, doc] of Object.entries(docs)) {
            try {
                const response = await axios.get(doc.link, { responseType: 'stream', timeout: PRAZO_MS });

                const fileName = `${Date.now()}_${tipo.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
                const filePath = path.join(this.tempDir, fileName);

                // O download PRECISA terminar de um jeito ou de outro. Antes a
                // Promise só resolvia no 'finish' do writer e ignorava erro do
                // lado da resposta: um corpo que estancava no meio pendurava a
                // execução para sempre e, como o job só roda uma de cada vez, a
                // fila inteira parava calada até o próximo deploy.
                await new Promise((resolve, reject) => {
                    const writer = fs.createWriteStream(filePath);
                    let terminou = false;
                    let prazo = null;

                    const encerrar = (err) => {
                        if (terminou) return;
                        terminou = true;
                        if (prazo) clearTimeout(prazo);
                        if (err) {
                            response.data.destroy();
                            writer.destroy();
                            return reject(err);
                        }
                        return resolve();
                    };

                    prazo = setTimeout(
                        () => encerrar(new Error(`download de ${tipo} passou de ${PRAZO_MS}ms`)),
                        PRAZO_MS
                    );

                    response.data.on('error', encerrar);
                    writer.on('error', encerrar);
                    writer.on('finish', () => encerrar());
                    response.data.pipe(writer);
                });

                downloaded[tipo] = {
                    path: filePath,
                    originalName: doc.nome
                };

                console.log(`📄 Documento baixado: ${tipo} - ${fileName}`);

            } catch (error) {
                console.error(`Erro ao baixar documento ${tipo}:`, error.message);
                throw new Error(`Falha ao baixar documento ${tipo}: ${error.message}`);
            }
        }

        return downloaded;
    }

    /**
     * Enviar documentos para análise
     */
    async analyzeDocuments(docs) {
        try {
            const formData = new FormData();

            // Adicionar arquivos ao FormData
            if (docs['CONTRATO CEF']) {
                formData.append('contrato_caixa', fs.createReadStream(docs['CONTRATO CEF'].path));
            }

            if (docs['CONFISSÃO DE DÍVIDA']) {
                formData.append('confissao_divida', fs.createReadStream(docs['CONFISSÃO DE DÍVIDA'].path));
            }

            const { INTERNAL_JOB_TOKEN, INTERNAL_JOB_HEADER } = await import('../security/internalJobToken.js');
            const response = await apiValidator.post('/validator', formData, {
                headers: {
                    ...formData.getHeaders(), // já inclui o boundary correto do multipart
                    [INTERNAL_JOB_HEADER]: INTERNAL_JOB_TOKEN,
                }
            });

            console.log('🔍 Análise concluída com sucesso');
            return response.data;

        } catch (error) {
            console.error('Erro na análise dos documentos:', error.message);
            throw new Error(`Falha na análise dos documentos: ${error.message}`);
        }
    }

    /**
     * Registrar resultado da análise no CRM
     */
    async logAnalysisResult(idRepasse, analysisResult) {
        try {
            let mensagem = `ANÁLISE AUTOMÁTICA DE CONTRATOS\n\n`;
            mensagem += `Resultado: ${analysisResult.status}\n\n`;

            const msgs = Array.isArray(analysisResult.mensagens) ? analysisResult.mensagens : [];

            if (msgs.length === 0 && analysisResult.status === 'ERRO') {
                msgs.push({
                    tipo: "Sistema",
                    descricao: analysisResult?.resultado || "Erro inesperado sem detalhes.",
                    nivel: "incorreto"
                });
            }

            mensagem += `DETALHES:\n`;
            for (const m of msgs) {
                mensagem += `- [${m.nivel?.toUpperCase() ?? "INFO"}] ${m.tipo ?? "Geral"}: ${m.descricao}\n`;
            }

            mensagem += `\nProcessado em: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`;

            await this.sendMessageToRepasse(idRepasse, mensagem);

        } catch (error) {
            console.error(`Erro ao registrar resultado no repasse ${idRepasse}:`, error.message);
            throw new Error(`Falha ao registrar resultado: ${error.message}`);
        }
    }

    /**
     * Enviar mensagem para o repasse no CRM
     */
    async sendMessageToRepasse(idRepasse, mensagem) {
        try {
            const response = await apiCv.post(`/v2/financeiro/repasses/mensagens`, {
                idrepasse: idRepasse,
                mensagem: mensagem
            });

            console.log(`📝 Mensagem enviada para repasse ${idRepasse}`);
            return response.data;

        } catch (error) {
            console.error(`Erro ao enviar mensagem para repasse ${idRepasse}:`, error.message);
            throw new Error(`Falha ao enviar mensagem: ${error.message}`);
        }
    }

    /**
     * Atualizar situação do repasse
     */
    async updateRepasseSituation(idRepasse, analysisResult) {
        const status = analysisResult.status?.toUpperCase();

        if (status === "ERRO") {
            console.log(`⚠️ Repasse ${idRepasse} ficou em ERRO → não altera situação, apenas mensagem`);
            return; // não muda de etapa
        }

        let targetId;
        if (status === "APROVADO") {
            targetId = this.targetSituationId; // 47
        } else if (status === "REPROVADO") {
            targetId = this.reprovedSituationId; // 66
        }

        const urlTarget = `/v1/financeiro/repasses/${idRepasse}/alterar-situacao/${targetId}`;
        try {
            const response = await apiCv.post(urlTarget);
            console.log(`🔄 Situação do repasse ${idRepasse} alterada para ID: ${targetId}`);
            return response.data;
        } catch (error) {
            console.error(`❌ Erro ao alterar situação do repasse ${idRepasse}:`, error.message);
            throw new Error(`Falha ao alterar situação: ${error.message}`);
        }
    }

    /**
     * Registrar erro no repasse
     */
    async logErrorToRepasse(idRepasse, errorMessage) {
        try {
            const mensagem =
                `ERRO NA ANALISE AUTOMATICA\n\n` +
                `ERRO: ${errorMessage}\n\n` +
                `OCORRIDO EM: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}\n\n` +
                `ACAO: Necessaria analise manual`;

            console.error(`Logando erro no repasse ${idRepasse}: ${errorMessage}`);
            await this.sendMessageToRepasse(idRepasse, mensagem);

        } catch (error) {
            console.error(`❌ Erro ao registrar erro no repasse ${idRepasse}:`, error.message);
        }
    }


    // ── Rastro da execução e quadro do que ficou preso ──────────────────────
    // Tudo daqui para baixo é best-effort: registrar não pode derrubar análise.

    async _db() {
        const { default: db } = await import('../models/sequelize/index.js');
        return db;
    }

    async _abrirExecucao(origem) {
        try {
            const db = await this._db();
            return await db.ContractValidatorRun.create({
                origin: ORIGENS_VALIDAS.has(origem) ? origem : 'webhook',
                started_at: new Date(),
            });
        } catch (error) {
            console.warn('[validador] não consegui registrar o início da execução:', error.message);
            return null;
        }
    }

    async _fecharExecucao(execucao, dados) {
        if (!execucao) return;
        try {
            await execucao.update({ ...dados, finished_at: new Date() });
        } catch (error) {
            console.warn('[validador] não consegui fechar o registro da execução:', error.message);
        }
    }

    /** A primeira mensagem da análise já diz por que ela não passou. */
    _motivo(analysisResult) {
        const msgs = Array.isArray(analysisResult?.mensagens) ? analysisResult.mensagens : [];
        return msgs[0]?.descricao || analysisResult?.resultado || 'erro sem detalhe';
    }

    /**
     * O CV devolve 'YYYY-MM-DD HH:MM:SS' no horário de Brasília, sem fuso
     * escrito. Deixar o Node adivinhar daria 3 horas de erro no servidor (que
     * roda em UTC) e nenhuma na máquina de quem testa - o tipo de conta errada
     * que só aparece em produção.
     */
    _desdeQuando(repasse) {
        const bruto = repasse?.data_status_repasse;
        if (!bruto) return null;
        const data = new Date(`${String(bruto).replace(' ', 'T')}-03:00`);
        return Number.isNaN(data.getTime()) ? null : data;
    }

    /**
     * Espelha em contract_validator_stuck quem continua em "Analise Contratos".
     * Quem saiu da etapa andou e some do quadro; quem ficou acumula tentativa e
     * o motivo da última falha.
     */
    async _sincronizarParados(repasses, desfechos = new Map()) {
        try {
            const db = await this._db();
            const { Op } = await import('sequelize');
            const naEtapa = repasses.map(r => Number(r.ID)).filter(Boolean);

            await db.ContractValidatorStuck.destroy({
                where: naEtapa.length ? { idrepasse: { [Op.notIn]: naEtapa } } : {},
            });

            for (const repasse of repasses) {
                await this._registrarParado(repasse, desfechos.get(Number(repasse.ID)));
            }
        } catch (error) {
            console.warn('[validador] não consegui atualizar o quadro de parados:', error.message);
        }
    }

    /**
     * Um repasse no quadro de parados. Separado da varredura porque o webhook
     * cuida de um repasse só e não pode limpar a linha de quem ele nem olhou.
     */
    async _registrarParado(repasse, desfecho) {
        try {
            const db = await this._db();
            const id = Number(repasse.ID);

            if (desfecho?.ok) {
                await db.ContractValidatorStuck.destroy({ where: { idrepasse: id } });
                return;
            }

            const [linha] = await db.ContractValidatorStuck.findOrCreate({
                where: { idrepasse: id },
                defaults: { idrepasse: id, attempts: 0 },
            });

            await linha.update({
                idreserva: repasse.idreserva || null,
                cliente: repasse.nome_cliente || null,
                empreendimento: repasse.empreendimento || null,
                status_since: this._desdeQuando(repasse) || linha.status_since,
                last_error: desfecho?.erro ? String(desfecho.erro).slice(0, 1000) : linha.last_error,
                attempts: (linha.attempts || 0) + (desfecho ? 1 : 0),
            });

            await this._avisarSeParado(linha);
        } catch (error) {
            console.warn('[validador] não consegui registrar o repasse parado:', error.message);
        }
    }

    /** Um aviso por episódio: o registro sai do quadro quando o repasse anda. */
    async _avisarSeParado(linha) {
        const limiteHoras = Number(process.env.CONTRACT_STUCK_ALERT_HOURS || 4);
        if (linha.alerted_at || !linha.status_since) return;

        const horasParado = (Date.now() - new Date(linha.status_since).getTime()) / 3600000;
        if (horasParado < limiteHoras) return;

        try {
            const [{ default: NotificationService }, { NotificationType }, db] = await Promise.all([
                import('./notification/NotificationService.js'),
                import('./notification/notificationTypes.js'),
                this._db(),
            ]);

            const users = (await db.User.findAll({
                where: { role: 'admin' }, attributes: ['id'], raw: true,
            })).map(u => u.id);
            if (!users.length) return;

            await NotificationService.notify({
                type: NotificationType.CONTRACT_VALIDATOR_STUCK,
                recipients: { users },
                title: 'Contrato parado na análise automática',
                body: `${linha.cliente || 'Um cliente'} (${linha.empreendimento || 'empreendimento não identificado'}) `
                    + `está em "Analise Contratos" há ${Math.floor(horasParado)}h. `
                    + `Último erro: ${linha.last_error || 'não registrado'}.`,
                link: '/validator',
                importance: 7,
            });

            await linha.update({ alerted_at: new Date() });
        } catch (error) {
            console.warn('[validador] não consegui avisar sobre o contrato parado:', error.message);
        }
    }

    /**
     * Limpar arquivos temporários
     */
    async cleanupTempFiles(docs) {
        for (const [tipo, doc] of Object.entries(docs)) {
            try {
                if (fs.existsSync(doc.path)) {
                    fs.unlinkSync(doc.path);
                    console.log(`🗑️ Arquivo temporário removido: ${tipo}`);
                }
            } catch (error) {
                console.error(`⚠️ Erro ao remover arquivo temporário ${tipo}:`, error.message);
            }
        }
    }

}

export default ContractAnalysisService;