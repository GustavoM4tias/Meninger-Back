// models/sequelize/paymentFlow/paymentLaunch.js
export default (sequelize, DataTypes) => {
    const PaymentLaunch = sequelize.define(
        "PaymentLaunch",
        {
            id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },

            // ── Empresa / Empreendimento ──────────────────────────────────────
            companyName: { field: "company_name", type: DataTypes.STRING },
            companyId: { field: "company_id", type: DataTypes.INTEGER },
            enterpriseName: { field: "enterprise_name", type: DataTypes.STRING },
            enterpriseId: { field: "enterprise_id", type: DataTypes.INTEGER },

            // ── Fornecedor (conforme documento) ──────────────────────────────
            providerName: { field: "provider_name", type: DataTypes.STRING },
            providerCnpj: { field: "provider_cnpj", type: DataTypes.STRING(18) },

            // ── Credor no Sienge ──────────────────────────────────────────────
            siengeCreditorId: {
                field: "sienge_creditor_id",
                type: DataTypes.INTEGER,
                comment: "ID do credor no Sienge após busca por CNPJ/CPF",
            },
            siengeCreditorName: {
                field: "sienge_creditor_name",
                type: DataTypes.STRING,
                comment: "Nome do credor conforme cadastro no Sienge (pode diferir do doc)",
            },
            siengeCreditorStatus: {
                field: "sienge_creditor_status",
                type: DataTypes.STRING(20),
                defaultValue: "pending",
            },

            // ── Contrato no Sienge ────────────────────────────────────────────
            siengeDocumentId: {
                field: "sienge_document_id",
                type: DataTypes.STRING,
                comment: "documentId do contrato (ex: PCEF)",
            },
            siengeContractNumber: {
                field: "sienge_contract_number",
                type: DataTypes.STRING,
                comment: "contractNumber gerado pelo Sienge",
            },
            siengeContractStatus: {
                field: "sienge_contract_status",
                type: DataTypes.STRING(20),
                defaultValue: "not_searched",
            },
            siengeContractApproval: {
                field: "sienge_contract_approval",
                type: DataTypes.STRING,
                comment: "statusApproval: APPROVED | DISAPPROVED | PENDING",
            },
            siengeContractAuthorized: {
                field: "sienge_contract_authorized",
                type: DataTypes.BOOLEAN,
                defaultValue: false,
            },
            siengeContractAuthLevel: {
                field: "sienge_contract_auth_level",
                type: DataTypes.STRING,
                comment: "currentAuthorizationLevel do contrato",
            },
            siengeContractRaw: {
                field: "sienge_contract_raw",
                type: DataTypes.JSONB,
                comment: "Payload completo do contrato no Sienge",
            },
            siengeContractError: {
                field: "sienge_contract_error",
                type: DataTypes.TEXT,
                comment: "Erro do playwright ao tentar criar contrato",
            },

            // ── Itens / Saldo do contrato ─────────────────────────────────────
            siengeItemsRaw: {
                field: "sienge_items_raw",
                type: DataTypes.JSONB,
                comment: "Array de itens retornado por supply-contracts/items",
            },
            siengeItemBalanceOk: {
                field: "sienge_item_balance_ok",
                type: DataTypes.BOOLEAN,
                comment: "true se há item com saldo suficiente para o lançamento",
            },
            siengeItemBalanceAvailable: {
                field: "sienge_item_balance_available",
                type: DataTypes.DECIMAL(15, 2),
                comment: "Maior saldo disponível entre os itens do contrato",
            },

            // ── Datas do CONTRATO (início e vencimento contratual) ────────────
            contractStartDate: {
                field: "contract_start_date",
                type: DataTypes.DATEONLY,
                comment: "Data de início do contrato (startDate no Sienge)",
            },
            contractEndDate: {
                field: "contract_end_date",
                type: DataTypes.DATEONLY,
                comment: "Data de término do contrato (endDate no Sienge)",
            },

            // ── NF ────────────────────────────────────────────────────────────
            nfUrl: { field: "nf_url", type: DataTypes.TEXT },
            nfPath: { field: "nf_path", type: DataTypes.STRING },
            nfFilename: { field: "nf_filename", type: DataTypes.STRING },
            nfNumber: { field: "nf_number", type: DataTypes.STRING },
            nfType: { field: "nf_type", type: DataTypes.STRING },
            nfIssueDate: {
                field: "nf_issue_date",
                type: DataTypes.DATEONLY,
                comment: "Data de emissão da NF extraída pela IA",
            },

            // ── Boleto ────────────────────────────────────────────────────────
            boletoUrl: { field: "boleto_url", type: DataTypes.TEXT },
            boletoPath: { field: "boleto_path", type: DataTypes.STRING },
            boletoFilename: { field: "boleto_filename", type: DataTypes.STRING },
            boletoBarcode: { field: "boleto_barcode", type: DataTypes.STRING },
            boletoIssueDate: {
                field: "boleto_issue_date",
                type: DataTypes.DATEONLY,
                comment: "Data de emissão do boleto extraída pela IA",
            },
            boletoDueDate: { field: "boleto_due_date", type: DataTypes.DATEONLY },
            boletoAmount: { field: "boleto_amount", type: DataTypes.DECIMAL(15, 2) },

            // ── Extras ────────────────────────────────────────────────────────
            extraAttachments: {
                field: "extra_attachments",
                type: DataTypes.JSONB,
                defaultValue: [],
            },

            // ── Tipo / Classificação ──────────────────────────────────────────
            launchType: {
                field: "launch_type",
                type: DataTypes.STRING(100),
                allowNull: false,
            },
            budgetItem: { field: "budget_item", type: DataTypes.STRING },
            budgetItemCode: {
                type: DataTypes.STRING(20),
                field: 'budget_item_code',
                allowNull: true,
            },
            financialAccountNumber: { field: "financial_account_number", type: DataTypes.STRING },

            // ── Valores ───────────────────────────────────────────────────────
            allocationPercentage: {
                field: "allocation_percentage",
                type: DataTypes.DECIMAL(5, 2),
                defaultValue: 100,
            },
            unitPrice: { field: "unit_price", type: DataTypes.DECIMAL(15, 2) },

            // ── IA ────────────────────────────────────────────────────────────
            aiExtractedData: { field: "ai_extracted_data", type: DataTypes.JSONB },
            aiModel: { field: "ai_model", type: DataTypes.STRING },
            aiTokensUsed: { field: "ai_tokens_used", type: DataTypes.INTEGER },

            // ── Status do lançamento ──────────────────────────────────────────
            // Etapas do processo: fornecedor → contrato → (aditivo → medicao → titulo) → titulo_pago
            // Especiais: cancelado (interrompido), erro (falha em alguma etapa)
            status: {
                field: "status",
                type: DataTypes.STRING(20),
                allowNull: false,
                defaultValue: "fornecedor",
            },

            // ── Estágio da esteira Sienge ─────────────────────────────────────
            pipelineStage: {
                field: "pipeline_stage",
                type: DataTypes.STRING(60),
                defaultValue: "idle",
            },

            // ── Solicitação de cadastro de fornecedor (RID) ───────────────────
            ridEmailSent: {
                field: "rid_email_sent",
                type: DataTypes.BOOLEAN,
                defaultValue: false,
                comment: "true após envio do email de solicitação de cadastro (RID)",
            },
            ridEmailSentAt: {
                field: "rid_email_sent_at",
                type: DataTypes.DATE,
                comment: "Timestamp do envio do email de solicitação RID",
            },
            ridRequestedByEmail: {
                field: "rid_requested_by_email",
                type: DataTypes.STRING,
                comment: "Email do usuário que solicitou o cadastro (copiado no envio)",
            },

            // ── Medição no Sienge ─────────────────────────────────────────────
            siengeMeasurementNumber: {
                field: "sienge_measurement_number",
                type: DataTypes.INTEGER,
                comment: "Número da medição criada no Sienge",
            },
            siengeMeasurementAuthorized: {
                field: "sienge_measurement_authorized",
                type: DataTypes.BOOLEAN,
                defaultValue: false,
            },
            siengeMeasurementApproval: {
                field: "sienge_measurement_approval",
                type: DataTypes.STRING,
                comment: "statusApproval da medição: APPROVED | DISAPPROVED | PENDING",
            },
            siengeMeasurementAuthLevel: {
                field: "sienge_measurement_auth_level",
                type: DataTypes.STRING,
            },
            siengeMeasurementError: {
                field: "sienge_measurement_error",
                type: DataTypes.TEXT,
                comment: "Erro do playwright ao tentar criar medição",
            },

            // ── Credenciais Sienge inválidas ──────────────────────────────────
            siengeCredentialsInvalid: {
                field: "sienge_credentials_invalid",
                type: DataTypes.BOOLEAN,
                defaultValue: false,
                comment: "True quando o Playwright falhou por senha/email errados no Sienge",
            },

            rejectionReason: { field: "rejection_reason", type: DataTypes.TEXT },
            notes: { field: "notes", type: DataTypes.TEXT },

            // ── Auditoria ─────────────────────────────────────────────────────
            createdBy: { field: "created_by", type: DataTypes.INTEGER, allowNull: false },
            createdByName: { field: "created_by_name", type: DataTypes.STRING },
            updatedBy: { field: "updated_by", type: DataTypes.INTEGER },
            updatedByName: { field: "updated_by_name", type: DataTypes.STRING },
            submittedAt: { field: "submitted_at", type: DataTypes.DATE },
            approvedAt: { field: "approved_at", type: DataTypes.DATE },
            paidAt: { field: "paid_at", type: DataTypes.DATE },
        },
        { tableName: "payment_launches", underscored: true }
    );

    PaymentLaunch.associate = (_models) => { };
    return PaymentLaunch;
};