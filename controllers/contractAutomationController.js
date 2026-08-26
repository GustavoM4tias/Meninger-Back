// controllers/contractAutomationController.js
import ContractAnalysisService from '../services/contractAnalysisService.js'; 
import apiCv from '../lib/apiCv.js';

// Uma execução que passa disso não está rodando: está pendurada. Sem prazo,
// bastava um download estancado para deixar isRunning=true para sempre - e daí
// todo ciclo seguinte era pulado calado, com o servidor no ar e a fila parada.
const PRAZO_EXECUCAO_MS = Number(process.env.CONTRACT_RUN_MAX_MS || 20 * 60 * 1000);

export class ContractAutomationController {
    constructor() {
        this.contractService = new ContractAnalysisService();
        this.isRunning = false;
        this.runningSince = null;
        this.lastExecution = null;
    }

    /** Está rodando de verdade? Execução vencida conta como morta. */
    estaRodando() {
        if (!this.isRunning) return false;

        const ha = this.runningSince ? Date.now() - this.runningSince : Infinity;
        if (ha > PRAZO_EXECUCAO_MS) {
            console.warn(`⚠️ Execução anterior passou de ${Math.round(ha / 60000)} min sem terminar; liberando o job.`);
            this.isRunning = false;
            this.runningSince = null;
            return false;
        }
        return true;
    }

    /**
     * Executar análise automática manualmente
     */
    async executeAnalysis(req, res) {
        try {
            // Verificar se já está executando
            if (this.estaRodando()) {
                return res.status(409).json({
                    success: false,
                    message: 'Análise já está em execução',
                    status: 'running'
                });
            }

            this.isRunning = true;
            this.runningSince = Date.now();
            const startTime = new Date();

            console.log('🚀 Iniciando análise automática via API...');

            // Sem cron, toda varredura é pedido de gente: recuperação de algo
            // que o webhook perdeu, ou backfill depois de indisponibilidade.
            const result = await this.contractService.executeAutomaticAnalysis('manual');

            const endTime = new Date();
            const duration = Math.round((endTime - startTime) / 1000);

            this.lastExecution = {
                startTime,
                endTime,
                duration,
                result
            };

            this.isRunning = false;
            this.runningSince = null;

            res.status(200).json({
                ...result,
                execution: {
                    startTime: startTime.toISOString(),
                    endTime: endTime.toISOString(),
                    duration: `${duration}s`
                }
            });

        } catch (error) {
            this.isRunning = false;
            this.runningSince = null;
            console.error('💥 Erro na análise automática:', error.message);

            res.status(500).json({
                success: false,
                error: error.message,
                message: 'Erro interno durante a análise automática'
            });
        }
    }

    /**
     * Verificar status da análise
     */
    async getAnalysisStatus(req, res) {
        try {
            // O que está na memória vale para a execução de agora; o histórico
            // e o quadro de parados vêm do banco, que é o único lugar onde a
            // resposta sobrevive a um restart do processo.
            const { default: db } = await import('../models/sequelize/index.js');
            const [execucoes, parados] = await Promise.all([
                db.ContractValidatorRun.findAll({ order: [['started_at', 'DESC']], limit: 10, raw: true }),
                db.ContractValidatorStuck.findAll({ order: [['status_since', 'ASC']], raw: true }),
            ]);

            const status = {
                isRunning: this.estaRodando(),
                runningSince: this.runningSince ? new Date(this.runningSince).toISOString() : null,
                lastExecution: this.lastExecution,
                execucoes,
                parados,
                service: 'Contract Analysis Automation',
                timestamp: new Date().toISOString()
            };

            res.status(200).json(status);

        } catch (error) {
            console.error('❌ Erro ao obter status:', error.message);
            res.status(500).json({
                success: false,
                error: error.message,
                message: 'Erro ao obter status da análise'
            });
        }
    }

    /**
     * Webhook CONTRATOS_IA do CV — o repasse entrou em "Analise Contratos".
     *
     * Responde 200 SEMPRE que o segredo confere, inclusive quando a chamada não
     * vira análise. O CV trata resposta ruim como falha de entrega e repete, e
     * repetir análise custa modelo; além disso, um 4xx aqui não teria como ser
     * consertado do lado de lá. O que aconteceu de verdade fica em
     * contract_validator_runs.
     */
    async receiveWebhook(req, res) {
        const { tokenConfere, extrairIdRepasse, registrarChamada, processarWebhook } =
            await import('../services/contractWebhookService.js');

        if (!await tokenConfere(req.params?.token)) {
            console.warn('[CONTRATOS_IA] chamada com segredo inválido — ignorada.');
            return res.status(401).json({ error: 'Token inválido.' });
        }

        const idrepasse = extrairIdRepasse(req.body);
        await registrarChamada(idrepasse);

        if (!idrepasse) {
            console.warn('[CONTRATOS_IA] corpo sem id de repasse:', JSON.stringify(req.body || {}).slice(0, 500));
            return res.status(200).json({ received: true, processado: false, motivo: 'corpo sem id de repasse' });
        }

        res.status(200).json({ received: true, idrepasse });

        processarWebhook(idrepasse)
            .catch(err => console.error('[CONTRATOS_IA] erro no processamento em background:', err.message));
    }

    /**
     * O endereço para colar no painel do CV, e a prova de que ele está sendo
     * chamado (última chamada e total). Admin — é um segredo.
     */
    async getWebhookInfo(req, res) {
        try {
            const { obterConfig, montarEndereco } = await import('../services/contractWebhookService.js');
            const base = `${req.protocol}://${req.get('host')}`;
            const [config, endereco] = await Promise.all([obterConfig(), montarEndereco(base)]);

            res.status(200).json({
                nome: 'CONTRATOS_IA',
                funcionalidade: 'Repasse',
                gatilho: 'Quando entrar na situação Analise Contratos',
                endereco,
                ativo: config.active,
                ultima_chamada: config.last_call_at,
                ultimo_idrepasse: config.last_idrepasse,
                chamadas_total: config.calls_total,
            });
        } catch (error) {
            console.error('❌ Erro ao montar o endereço do webhook:', error.message);
            res.status(500).json({ success: false, error: error.message });
        }
    }

    /**
     * Processar um repasse específico
     */
    async processSpecificRepasse(req, res) {
        try {
            const { idRepasse } = req.params;

            if (!idRepasse) {
                return res.status(400).json({
                    success: false,
                    message: 'ID do repasse é obrigatório'
                });
            }

            // Buscar o repasse específico
            const repasse = await this.getRepasseById(idRepasse);

            if (!repasse) {
                return res.status(404).json({
                    success: false,
                    message: 'Repasse não encontrado'
                });
            }

            console.log(`🔄 Processando repasse específico: ${idRepasse}`);

            // Processar o repasse
            await this.contractService.processRepasse(repasse);

            res.status(200).json({
                success: true,
                message: `Repasse ${idRepasse} processado com sucesso`,
                repasse: {
                    id: repasse.ID,
                    idreserva: repasse.idreserva,
                    status: repasse.status_repasse
                }
            });

        } catch (error) {
            console.error(`❌ Erro ao processar repasse ${req.params.idRepasse}:`, error.message);

            res.status(500).json({
                success: false,
                error: error.message,
                message: 'Erro ao processar repasse específico'
            });
        }
    }

    /**
     * Buscar repasse por ID
     */
    async getRepasseById(idRepasse) {
        try {
            const response = await apiCv.get(`/v1/financeiro/repasses?ID=${idRepasse}`);

            if (!response.data?.repasses) {
                throw new Error('Resposta inválida da API de repasses');
            }

            return response.data.repasses.find(repasse => repasse.ID == idRepasse);
        } catch (error) {
            console.error('❌ Erro ao buscar repasse:', error.message);
            throw new Error(`Falha ao buscar repasse: ${error.message}`);
        }
    }

    /**
     * Listar repasses que precisam de análise
     */
    async listPendingRepasses(req, res) {
        try {
            const repasses = await this.contractService.getRepassesForAnalysis();

            res.status(200).json({
                success: true,
                total: repasses.length,
                repasses: repasses.map(repasse => ({
                    ID: repasse.ID,
                    idreserva: repasse.idreserva,
                    documento: repasse.documento,
                    empreendimento: repasse.empreendimento,
                    unidade: repasse.unidade,
                    status_repasse: repasse.status_repasse,
                    data_status_repasse: repasse.data_status_repasse
                }))
            });

        } catch (error) {
            console.error('❌ Erro ao listar repasses pendentes:', error.message);

            res.status(500).json({
                success: false,
                error: error.message,
                message: 'Erro ao listar repasses pendentes'
            });
        }
    }

}

// Instância ÚNICA: webhook, varredura manual e /status precisam enxergar o
// mesmo estado. Com um `new` em cada lugar, /status respondia sempre
// "isRunning: false, lastExecution: null" mesmo com análise rodando, e dois
// disparos entravam em paralelo no mesmo repasse.
const contractAutomationController = new ContractAutomationController();

export default contractAutomationController;

