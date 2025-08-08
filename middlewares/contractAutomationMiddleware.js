// middleware/contractAutomationMiddleware.js
import axios from 'axios';

/**
 * Middleware para validar conexão com APIs
 */
export const validateApiConnection = async (req, res, next) => {
    try {
        // Verificar se a API do CRM está acessível
        const crmResponse = await axios.get('https://menin.cvcrm.com.br/api/v1/financeiro/repasses?limit=1', {
            timeout: 5000
        });

        if (!crmResponse.data) {
            throw new Error('API do CRM não está respondendo corretamente');
        }

        // Verificar se o serviço de validação está acessível
        const validatorResponse = await axios.get('http://localhost:5000/api/ai/token', {
            timeout: 5000
        });

        if (!validatorResponse.data) {
            throw new Error('Serviço de validação não está respondendo corretamente');
        }

        next();
    } catch (error) {
        console.error('❌ Erro na validação de conectividade:', error.message);

        res.status(503).json({
            success: false,
            error: 'Serviços não disponíveis',
            message: 'Um ou mais serviços necessários não estão acessíveis',
            details: error.message
        });
    }
};

/**
 * Middleware para log de operações
 */
export const logOperation = (operation) => {
    return (req, res, next) => {
        const startTime = new Date();
        console.log(`📊 [${operation}] Iniciado em: ${startTime.toISOString()}`);

        // Interceptar o res.json para logar o resultado
        const originalJson = res.json;
        res.json = function (data) {
            const endTime = new Date();
            const duration = endTime - startTime;
            console.log(`📊 [${operation}] Concluído em: ${endTime.toISOString()} (${duration}ms)`);
            return originalJson.call(this, data);
        };

        next();
    };
};

/**
 * Middleware para validar parâmetros
 */
export const validateParams = (requiredParams) => {
    return (req, res, next) => {
        const missingParams = [];

        for (const param of requiredParams) {
            if (!req.params[param] && !req.body[param] && !req.query[param]) {
                missingParams.push(param);
            }
        }

        if (missingParams.length > 0) {
            return res.status(400).json({
                success: false,
                error: 'Parâmetros obrigatórios ausentes',
                message: `Os seguintes parâmetros são obrigatórios: ${missingParams.join(', ')}`
            });
        }

        next();
    };
};

/**
 * Middleware para tratamento de erros
 */
export const errorHandler = (err, req, res, next) => {
    console.error('💥 Erro capturado pelo middleware:', err);

    // Erro de timeout
    if (err.code === 'ECONNABORTED') {
        return res.status(408).json({
            success: false,
            error: 'Timeout',
            message: 'Operação excedeu o tempo limite'
        });
    }

    // Erro de conexão
    if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
        return res.status(503).json({
            success: false,
            error: 'Serviço indisponível',
            message: 'Não foi possível conectar com o serviço externo'
        });
    }

    // Erro HTTP
    if (err.response && err.response.status) {
        return res.status(err.response.status).json({
            success: false,
            error: 'Erro na API externa',
            message: err.response.data?.message || 'Erro desconhecido da API externa'
        });
    }

    // Erro genérico
    res.status(500).json({
        success: false,
        error: 'Erro interno do servidor',
        message: err.message || 'Erro desconhecido'
    });
};

/**
 * Middleware para rate limiting simples
 */
export const rateLimiter = (maxRequests = 10, windowMs = 60000) => {
    const requests = new Map();

    return (req, res, next) => {
        const clientId = req.ip || 'unknown';
        const now = Date.now();

        // Limpar entradas antigas
        for (const [id, data] of requests.entries()) {
            if (now - data.firstRequest > windowMs) {
                requests.delete(id);
            }
        }

        // Verificar limite do cliente atual
        if (!requests.has(clientId)) {
            requests.set(clientId, {
                count: 1,
                firstRequest: now
            });
        } else {
            const clientData = requests.get(clientId);
            if (clientData.count >= maxRequests) {
                return res.status(429).json({
                    success: false,
                    error: 'Limite de requisições excedido',
                    message: `Máximo ${maxRequests} requisições por minuto`
                });
            }
            clientData.count++;
        }

        next();
    };
};