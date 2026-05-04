// Pré-cadastros do CV — 1 linha por idprecadastro.
// Apenas /v1/comercial/precadastro (listar paginado). Sem documentos.
// O resumo da última mensagem vem direto do listar (campo `mensagens`)
// e é gravado em `mensagem_resumo`.
export default (sequelize, DataTypes) => {
    const CvPrecadastro = sequelize.define('CvPrecadastro', {
        idprecadastro: { type: DataTypes.INTEGER, primaryKey: true },

        // Identificação rápida (denormalizado p/ filtros/listagem)
        codigointerno: { type: DataTypes.STRING },
        documento:     { type: DataTypes.STRING }, // doc do cliente
        nome_cliente:  { type: DataTypes.STRING },
        email_cliente: { type: DataTypes.STRING },

        // FKs do CV (úteis para filtros)
        idempreendimento: { type: DataTypes.INTEGER },
        idunidade:        { type: DataTypes.INTEGER },
        idimobiliaria:    { type: DataTypes.INTEGER },
        idcorretor:       { type: DataTypes.INTEGER },
        idcorrespondente: { type: DataTypes.INTEGER },
        idempresa_correspondente: { type: DataTypes.INTEGER },
        idsituacao:       { type: DataTypes.INTEGER },
        situacao_nome:    { type: DataTypes.STRING },

        // Valores numéricos espelhados (DECIMAL p/ relatórios)
        valor_avaliacao:  { type: DataTypes.DECIMAL(15, 2) },
        valor_aprovado:   { type: DataTypes.DECIMAL(15, 2) },
        valor_subsidio:   { type: DataTypes.DECIMAL(15, 2) },
        valor_fgts:       { type: DataTypes.DECIMAL(15, 2) },
        valor_total:      { type: DataTypes.DECIMAL(15, 2) },
        valor_prestacao:  { type: DataTypes.DECIMAL(15, 2) },
        saldo_devedor:    { type: DataTypes.DECIMAL(15, 2) },
        renda_cliente_principal: { type: DataTypes.DECIMAL(15, 2) },
        renda_total:      { type: DataTypes.DECIMAL(15, 2) },

        // Diversos
        prazo:                 { type: DataTypes.STRING },
        prazo_financiamento:   { type: DataTypes.STRING },
        tabela:                { type: DataTypes.STRING },
        carta_credito:         { type: DataTypes.STRING },
        vencimento_aprovacao:  { type: DataTypes.STRING },
        idintencao_compra:     { type: DataTypes.INTEGER },
        intencao_compra:       { type: DataTypes.STRING },
        link:                  { type: DataTypes.TEXT },

        // Datas (a API entrega como string; mantemos DATE p/ ordenação)
        data_cad:           { type: DataTypes.DATE },
        data_fim:           { type: DataTypes.DATE },
        data_cancelamento:  { type: DataTypes.DATE },

        // Blocos JSONB (cópia dos sub-objetos da API)
        empreendimento:        { type: DataTypes.JSONB },
        unidade:               { type: DataTypes.JSONB },
        imobiliaria:           { type: DataTypes.JSONB },
        corretor:              { type: DataTypes.JSONB },
        correspondente:        { type: DataTypes.JSONB },
        empresa_correspondente:{ type: DataTypes.JSONB },
        situacao:              { type: DataTypes.JSONB },
        cliente:               { type: DataTypes.JSONB },
        usuario_aprovou:       { type: DataTypes.JSONB },
        leads_associados:      { type: DataTypes.JSONB, defaultValue: [] },
        fator_social:          { type: DataTypes.JSONB, defaultValue: [] },
        associados:            { type: DataTypes.JSONB },
        campos_adicionais:     { type: DataTypes.JSONB },
        mensagem_resumo:       { type: DataTypes.JSONB }, // último resumo vindo do listar

        // Histórico de status (mais recente em [0])
        status_historico:      { type: DataTypes.JSONB, defaultValue: [] },

        // Espelho cru do listar p/ debug e fallback
        raw:                   { type: DataTypes.JSONB },

        content_hash:          { type: DataTypes.STRING(64) },

        first_seen_at:         { type: DataTypes.DATE },
        last_seen_at:          { type: DataTypes.DATE },
    }, {
        tableName: 'cv_precadastros',
        underscored: true,
        timestamps: true,
        indexes: [
            { fields: ['documento'] },
            { fields: ['idempreendimento'] },
            { fields: ['idimobiliaria'] },
            { fields: ['idcorretor'] },
            { fields: ['idcorrespondente'] },
            { fields: ['idempresa_correspondente'] },
            { fields: ['idsituacao'] },
            { fields: ['data_cad'] },
            { fields: ['last_seen_at'] },
        ]
    });

    return CvPrecadastro;
};
