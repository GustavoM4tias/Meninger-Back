// services/contractAnalysisService.js
import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import apiCv from '../lib/apiCv.js';
import apiValidator from '../lib/apiValidator .js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class ContractAnalysisService {
    constructor() {
        this.targetStatus = 'Analise Contratos';
        this.targetSituationId = 47;
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
    async executeAutomaticAnalysis() {
        console.log('🚀 Iniciando análise automática de contratos...');

        try {
            // Buscar repasses que precisam de análise
            const repasses = await this.getRepassesForAnalysis();
            console.log(`📊 Encontrados ${repasses.length} repasses para análise`);

            if (repasses.length === 0) {
                console.log('✅ Nenhum repasse encontrado para análise');
                return { success: true, processed: 0, message: 'Nenhum repasse para processar' };
            }

            let processed = 0;
            let errors = 0;

            // Processar cada repasse
            for (const repasse of repasses) {
                try {
                    console.log(`🔄 Processando repasse ID: ${repasse.ID} - Reserva: ${repasse.idreserva}`);
                    await this.processRepasse(repasse);
                    processed++;
                    console.log(`✅ Repasse ${repasse.ID} processado com sucesso`);
                } catch (error) {
                    errors++;
                    console.error(`❌ Erro ao processar repasse ${repasse.ID}:`, error.message);
                    await this.logErrorToRepasse(repasse.ID, error.message);
                }
            }

            console.log(`🎉 Análise concluída. Processados: ${processed}, Erros: ${errors}`);
            return {
                success: true,
                processed,
                errors,
                message: `Análise concluída. ${processed} repasses processados, ${errors} erros encontrados.`
            };

        } catch (error) {
            console.error('💥 Erro geral na análise automática:', error.message);
            return {
                success: false,
                error: error.message,
                message: 'Erro geral durante a análise automática'
            };
        }
    }

    /**
     * Buscar repasses que estão na etapa "Analise Contratos"
     */
    async getRepassesForAnalysis() {
        try {
            const response = await apiCv.get(`/v1/cv/repasses?limit=0`);

            if (!response.data?.repasses) {
                throw new Error('Resposta inválida da API de repasses');
            }

            // Filtrar repasses que estão na etapa "Analise Contratos"
            return response.data.repasses.filter(repasse =>
                repasse.status_repasse === this.targetStatus
            );
        } catch (error) {
            console.error('❌ Erro ao buscar repasses:', error.message);
            throw new Error(`Falha ao buscar repasses: ${error.message}`);
        }
    }

    /**
     * Processar um repasse específico
     */
    async processRepasse(repasse) {
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
            await this.updateRepasseSituation(repasse.ID);

            // 8. Limpar arquivos temporários
            await this.cleanupTempFiles(downloadedDocs);

        } catch (error) {
            console.error(`❌ Erro ao processar repasse ${repasse.ID}:`, error.message);
            throw error;
        }
    }

    /**
     * Buscar documentos da reserva
     */
    async getReservaDocuments(idreserva) {
        try {
            const response = await apiCv.get(`/v1/cv/reservas/documentos/${idreserva}`);

            if (!response.data?.dados?.documentos?.titular) {
                throw new Error('Documentos da reserva não encontrados');
            }

            return response.data.dados.documentos.titular;
        } catch (error) {
            console.error(`❌ Erro ao buscar documentos da reserva ${idreserva}:`, error.message);
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

        for (const [tipo, doc] of Object.entries(docs)) {
            try {
                const response = await axios.get(doc.link, { responseType: 'stream' });

                const fileName = `${Date.now()}_${tipo.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
                const filePath = path.join(this.tempDir, fileName);

                const writer = fs.createWriteStream(filePath);
                response.data.pipe(writer);

                await new Promise((resolve, reject) => {
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                });

                downloaded[tipo] = {
                    path: filePath,
                    originalName: doc.nome
                };

                console.log(`📄 Documento baixado: ${tipo} - ${fileName}`);

            } catch (error) {
                console.error(`❌ Erro ao baixar documento ${tipo}:`, error.message);
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

            const response = await apiValidator.post('/validator', formData, {
                headers: {
                    ...formData.getHeaders() // já inclui o boundary correto do multipart
                }
            });

            console.log('🔍 Análise concluída com sucesso');
            return response.data;

        } catch (error) {
            console.error('❌ Erro na análise dos documentos:', error.message);
            throw new Error(`Falha na análise dos documentos: ${error.message}`);
        }
    }

    /**
     * Registrar resultado da análise no CRM
     */
    async logAnalysisResult(idRepasse, analysisResult) {
        try {
            let mensagem = `🤖 ANÁLISE AUTOMÁTICA DE CONTRATOS\n\n`;
            mensagem += `📊 Resultado: ${analysisResult.resultado}\n\n`;

            if (analysisResult.mensagens && analysisResult.mensagens.length > 0) {
                mensagem += `📋 Detalhes da Análise:\n`;

                for (const msg of analysisResult.mensagens) {
                    const emoji = this.getEmojiForLevel(msg.nivel);
                    mensagem += `${emoji} ${msg.tipo}: ${msg.descricao}\n`;
                }
            }

            mensagem += `\n⏰ Processado em: ${new Date().toLocaleString('pt-BR')}`;

            await this.sendMessageToRepasse(idRepasse, mensagem);

        } catch (error) {
            console.error(`❌ Erro ao registrar resultado no repasse ${idRepasse}:`, error.message);
            throw new Error(`Falha ao registrar resultado: ${error.message}`);
        }
    }

    /**
     * Enviar mensagem para o repasse no CRM
     */
    async sendMessageToRepasse(idRepasse, mensagem) {
        try {
            const response = await apiCv.post(`/v2/cv/repasses/mensagens`, {
                idrepasse: idRepasse,
                mensagem: mensagem
            });

            console.log(`📝 Mensagem enviada para repasse ${idRepasse}`);
            return response.data;

        } catch (error) {
            console.error(`❌ Erro ao enviar mensagem para repasse ${idRepasse}:`, error.message);
            throw new Error(`Falha ao enviar mensagem: ${error.message}`);
        }
    }

    /**
     * Atualizar situação do repasse
     */
    async updateRepasseSituation(idRepasse) {
        try {
            const response = await apiCv.post(
                `/v1/cv/repasses/${idRepasse}/alterar-situacao/${this.targetSituationId}`
            );

            console.log(`🔄 Situação do repasse ${idRepasse} alterada para ID: ${this.targetSituationId}`);
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
            const mensagem = `❌ ERRO NA ANÁLISE AUTOMÁTICA\n\n` +
                `🔴 Erro: ${errorMessage}\n\n` +
                `⏰ Ocorrido em: ${new Date().toLocaleString('pt-BR')}\n\n` +
                `⚠️ Necessária análise manual`;

            await this.sendMessageToRepasse(idRepasse, mensagem);

        } catch (error) {
            console.error(`❌ Erro ao registrar erro no repasse ${idRepasse}:`, error.message);
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

    /**
     * Obter emoji baseado no nível da mensagem
     */
    getEmojiForLevel(nivel) {
        switch (nivel) {
            case 'correto': return '✅';
            case 'alerta': return '⚠️';
            case 'incorreto': return '❌';
            default: return '📋';
        }
    }
}

export default ContractAnalysisService;