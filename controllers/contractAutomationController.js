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

            // Executar análise
            const origem = req?.method === 'SCHEDULED' ? 'agendado' : 'manual';
            const result = await this.contractService.executeAutomaticAnalysis(origem);

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

    /**
     * Configurar análise automática agendada
     */
    // async configureScheduledAnalysis(req, res) {
    //     try {
    //         const { enabled, interval } = req.body;

    //         contractValidatorScheduler.updateConfig({ enabled, interval });

    //         res.status(200).json({
    //             success: true,
    //             message: 'Configuração de agendamento atualizada com sucesso',
    //             config: contractValidatorScheduler.getStatus()
    //         });

    //     } catch (error) {
    //         console.error('❌ Erro ao configurar análise agendada:', error.message);

    //         res.status(500).json({
    //             success: false,
    //             error: error.message,
    //             message: 'Erro ao configurar análise agendada'
    //         });
    //     }
    // }
}

// Instância ÚNICA: o scheduler e as rotas precisam enxergar o mesmo estado.
// Com um `new` em cada lugar, /status respondia sempre "isRunning: false,
// lastExecution: null" mesmo com o job rodando, e um disparo manual entrava em
// paralelo com o agendado - dois processos analisando o mesmo repasse.
const contractAutomationController = new ContractAutomationController();

export default contractAutomationController;

