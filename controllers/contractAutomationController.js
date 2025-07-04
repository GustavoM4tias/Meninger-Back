// controllers/contractAutomationController.js
import ContractAnalysisService from '../services/contractAnalysisService.js'; 
import apiCv from '../lib/apiCv.js';

class ContractAutomationController {
    constructor() {
        this.contractService = new ContractAnalysisService();
        this.isRunning = false;
        this.lastExecution = null;
    }

    /**
     * Executar análise automática manualmente
     */
    async executeAnalysis(req, res) {
        try {
            // Verificar se já está executando
            if (this.isRunning) {
                return res.status(409).json({
                    success: false,
                    message: 'Análise já está em execução',
                    status: 'running'
                });
            }

            this.isRunning = true;
            const startTime = new Date();

            console.log('🚀 Iniciando análise automática via API...');

            // Executar análise
            const result = await this.contractService.executeAutomaticAnalysis();

            const endTime = new Date();
            const duration = Math.round((endTime - startTime) / 1000);

            this.lastExecution = {
                startTime,
                endTime,
                duration,
                result
            };

            this.isRunning = false;

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
            const status = {
                isRunning: this.isRunning,
                lastExecution: this.lastExecution,
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
            const response = await apiCv.get(`/v1/cv/repasses?ID=${idRepasse}`);

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

    //         contractScheduler.updateConfig({ enabled, interval });

    //         res.status(200).json({
    //             success: true,
    //             message: 'Configuração de agendamento atualizada com sucesso',
    //             config: contractScheduler.getStatus()
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

export default ContractAutomationController;