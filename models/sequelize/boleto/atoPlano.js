// models/sequelize/boleto/atoPlano.js
//
// Plano de parcelas de uma reserva: o que o Office cobra entre o ato pago e o
// faturamento do contrato no Sienge. UMA linha por reserva.
//
// Nasce quando o ato e pago (boleto ou cartao) e morre de um de quatro jeitos:
//   sienge_faturado    a venda foi FATURADA no Sienge (financial_institution_date,
//                      regra do relatorio de Faturamento) -> o ERP cobra daqui em
//                      diante; previstas viram `transferida`. Titulo NAO conta.
//   repasse_contrato_emitido  repasse no CV em "Contrato Emitido CAIXA" ou depois.
//   reserva_cancelada  a reserva morreu no CV; boletos em aberto sao baixados.
//   manual             alguem encerrou pela tela e disse por que.
//
// As parcelas ficam em `ato_parcelas`; os boletos continuam em `boleto_history`
// (com `parcela_id` preenchido) para reaproveitar verificacao, baixa, PDF e
// timeline sem duplicar nada.
export default (sequelize, DataTypes) => {
    const AtoPlano = sequelize.define('AtoPlano', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        idreserva: { type: DataTypes.INTEGER, allowNull: false, unique: true },

        // Denormalizacoes para a tela nao precisar do CV a cada linha.
        idpessoa_cv: { type: DataTypes.INTEGER, allowNull: true },
        titular_nome: { type: DataTypes.STRING, allowNull: true },
        empreendimento: { type: DataTypes.STRING, allowNull: true },
        idempreendimento_cv: { type: DataTypes.INTEGER, allowNull: true },
        unidade: { type: DataTypes.STRING, allowNull: true },
        cnpj_empresa: { type: DataTypes.STRING, allowNull: true },
        titular_fone: { type: DataTypes.STRING(20), allowNull: true, comment: 'E.164 sem +, gravado ao enviar o aviso de parcela vencida; reconhece o SIM do cliente no WhatsApp.' },

        status: {
            type: DataTypes.STRING(20), allowNull: false, defaultValue: 'ativo',
            comment: 'ativo | pausado | encerrado | cancelado',
        },
        encerrado_motivo: {
            type: DataTypes.STRING(40), allowNull: true,
            comment: 'sienge_faturado | repasse_contrato_emitido | reserva_cancelada | manual | sem_series',
        },
        encerrado_detalhe: { type: DataTypes.TEXT, allowNull: true },
        encerrado_em: { type: DataTypes.DATE, allowNull: true },
        encerrado_por: { type: DataTypes.INTEGER, allowNull: true },
        pausado_por: { type: DataTypes.INTEGER, allowNull: true },
        pausado_em: { type: DataTypes.DATE, allowNull: true },

        // Origem do plano: 'ato_pago' (automatico) ou 'manual' (tela).
        origem: { type: DataTypes.STRING(20), allowNull: true, defaultValue: 'ato_pago' },
        ato_pago_em: { type: DataTypes.DATE, allowNull: true },

        // Contrato do Sienge (tabela local `contracts`, external_id = idreserva).
        sienge_contract_id: { type: DataTypes.BIGINT, allowNull: true },
        // sienge_receivable_bill_id continua no banco fora do model: o titulo nao
        // e criterio (pode ser adiantamento) e saiu da tela em 08/09/2026.
        sienge_venda_faturada_em: { type: DataTypes.DATEONLY, allowNull: true, comment: 'contracts.financial_institution_date - "faturado como venda", regra do relatorio de Faturamento.' },
        sienge_verificado_em: { type: DataTypes.DATE, allowNull: true },
        // Repasse do CV (ultimo da reserva): a partir de "Contrato Emitido CAIXA" o
        // plano encerra (regra de 08/09/2026, etapas em boleto_settings).
        cv_repasse_id: { type: DataTypes.INTEGER, allowNull: true },
        cv_repasse_situacao_id: { type: DataTypes.INTEGER, allowNull: true },
        cv_repasse_situacao: { type: DataTypes.STRING(120), allowNull: true },
        // Alerta de cadastro (texto): CEP recusado pela Caixa, boleto saiu com o
        // endereco da Menin. Limpa sozinho quando a Caixa volta a aceitar o do CV.
        cadastro_alerta: { type: DataTypes.TEXT, allowNull: true },

        // 10/09/2026 (Gustavo): planos com parcela anterior que o Office nunca
        // cobrou (retroativa fora do corte de 08/09). "parcela 3 de 60" entrega
        // ao cliente uma divida de 1 e 2 que ninguem cobrou dele - nas mensagens
        // ao CLIENTE a parcela passa a ser identificada pelo MES do vencimento
        // ("parcela de outubro/2026"). CV, evento e tela seguem numerando.
        numeracao_oculta: {
            type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false,
            comment: 'Mensagens ao cliente identificam a parcela pelo mes do vencimento, nao por "N de TOTAL".',
        },

        // Ultima leitura das condicoes no CV (para a tela mostrar divergencias).
        cv_sincronizado_em: { type: DataTypes.DATE, allowNull: true },
        divergencias: {
            type: DataTypes.TEXT, allowNull: true,
            comment: 'JSON: parcelas ja emitidas cujo valor/vencimento mudou no CV depois.',
            get() {
                const raw = this.getDataValue('divergencias');
                if (!raw) return null;
                try { return JSON.parse(raw); } catch { return null; }
            },
            set(v) { this.setDataValue('divergencias', v == null ? null : JSON.stringify(v)); },
        },

        // Plano de TESTE (origem = 'teste'): reserva que nao existe no CV;
        // titular/unidade/series vivem aqui. Ver AtoParcelaService.criarPlanoTeste.
        teste_dados: {
            type: DataTypes.TEXT, allowNull: true,
            get() { const raw = this.getDataValue('teste_dados'); if (!raw) return null; try { return JSON.parse(raw); } catch { return null; } },
            set(v) { this.setDataValue('teste_dados', v == null ? null : JSON.stringify(v)); },
        },
        observacao: { type: DataTypes.TEXT, allowNull: true },
        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'ato_planos',
        underscored: true,
        timestamps: true,
    });

    AtoPlano.associate = (models) => {
        AtoPlano.hasMany(models.AtoParcela, { foreignKey: 'plano_id', as: 'parcelas' });
    };
    return AtoPlano;
};
