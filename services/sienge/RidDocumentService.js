/**
 * RidDocumentService.js
 * Gera o DOCX da Planilha de Qualificação de Fornecedores (RID-12)
 * a partir dos dados preenchidos no formulário do sistema.
 *
 * Layout fiel ao original: tabela 3 colunas no cabeçalho + célula única no corpo.
 */

import {
    Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
    AlignmentType, BorderStyle, WidthType, ShadingType, VerticalAlign,
    HeadingLevel,
} from 'docx';

// Constantes de medida (DXA: 1440 = 1 polegada, A4 ~11906 x 16838)
const PAGE_W = 11906;
const PAGE_H = 16838;
const MARGIN = 851; // ~1.5 cm
const CONTENT_W = PAGE_W - MARGIN * 2; // ~10204

// Larguras das colunas do cabeçalho (proporcional ao original)
const COL1 = 2482;
const COL2 = 5420;
const COL3 = CONTENT_W - COL1 - COL2;

const BORDER_THIN = { style: BorderStyle.SINGLE, size: 4, color: '000000' };
const BORDER_NONE = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const BORDER_ALL = { top: BORDER_THIN, bottom: BORDER_THIN, left: BORDER_THIN, right: BORDER_THIN };
const BORDER_NONE_ALL = { top: BORDER_NONE, bottom: BORDER_NONE, left: BORDER_NONE, right: BORDER_NONE };

const CELL_MARGINS = { top: 80, bottom: 80, left: 120, right: 120 };

// ── Helpers ──────────────────────────────────────────────────────────────────

function bold(text, size = 22) {
    return new TextRun({ text, bold: true, size, font: 'Arial' });
}
function normal(text, size = 22) {
    return new TextRun({ text, size, font: 'Arial' });
}
function para(children, opts = {}) {
    return new Paragraph({ children, alignment: opts.align || AlignmentType.LEFT, spacing: { after: opts.after ?? 80, before: opts.before ?? 0 }, ...opts });
}
function hLine(label, value = '') {
    // Linha: "Label: _valor__________"
    const dots = value ? '' : '  ___________________________________________';
    return para([bold(label + ': '), normal(value || dots)]);
}
function radioGroup(options, selected) {
    // ex: "(  X  ) SIM     (     ) NÃO"
    return options.map(({ key, label }) => {
        const mark = selected === key ? '  X  ' : '     ';
        return new TextRun({ text: `(${mark}) ${label}   `, size: 22, font: 'Arial' });
    });
}
function sectionTitle(text) {
    return para([bold(text, 22)], { spacing: { before: 160, after: 80 }, shading: { fill: 'D9D9D9', type: ShadingType.CLEAR } });
}
function subLine(label, value = '') {
    const dots = value ? '' : '  ____________________________';
    return para([normal('   '), bold(label + ': '), normal(value || dots)]);
}
function simNaoNa(selected) {
    return radioGroup(
        [{ key: 'sim', label: 'SIM' }, { key: 'nao', label: 'NÃO' }, { key: 'na', label: 'Não aplicável' }],
        selected
    );
}
function avaliacao(text) {
    return para([bold('Avaliação: '), normal(text || '___________________________________________________________')]);
}

// ── Gerador principal ────────────────────────────────────────────────────────

/**
 * @param {object} data  Dados do formulário (vide schema abaixo)
 * @returns {Promise<Buffer>}  Buffer do arquivo .docx
 */
export async function generateRidDocx(data) {
    const d = data || {};

    // Linha separadora (usada no corpo)
    function bodyCell(children) {
        return new TableCell({
            columnSpan: 3,
            borders: BORDER_ALL,
            margins: { top: 120, bottom: 120, left: 200, right: 200 },
            children,
        });
    }

    // ── Cabeçalho ─────────────────────────────────────────────────────────────
    const headerRow = new TableRow({
        children: [
            // Col 1: espaço para logo (sem imagem — texto substituto)
            new TableCell({
                width: { size: COL1, type: WidthType.DXA },
                borders: BORDER_ALL,
                margins: CELL_MARGINS,
                verticalAlign: VerticalAlign.CENTER,
                children: [para([bold('MENIN', 28)], { align: AlignmentType.CENTER })],
            }),
            // Col 2: título SGI
            new TableCell({
                width: { size: COL2, type: WidthType.DXA },
                borders: BORDER_ALL,
                margins: CELL_MARGINS,
                verticalAlign: VerticalAlign.CENTER,
                children: [para([bold('SISTEMA DE GESTÃO INTEGRADO', 24)], { align: AlignmentType.CENTER })],
            }),
            // Col 3: departamento e código
            new TableCell({
                width: { size: COL3, type: WidthType.DXA },
                borders: BORDER_ALL,
                margins: CELL_MARGINS,
                verticalAlign: VerticalAlign.CENTER,
                children: [
                    para([normal('Departamento', 20)], { align: AlignmentType.CENTER }),
                    para([bold('SUPRIMENTOS', 20)], { align: AlignmentType.CENTER }),
                    para([bold('RID 12/05', 20)], { align: AlignmentType.CENTER }),
                ],
            }),
        ],
    });

    // ── Linha de título ────────────────────────────────────────────────────────
    const titleRow = new TableRow({
        children: [
            new TableCell({
                columnSpan: 3,
                borders: BORDER_ALL,
                margins: CELL_MARGINS,
                children: [para([bold('PLANILHA DE QUALIFICAÇÃO DE FORNECEDORES', 26)], { align: AlignmentType.CENTER })],
            }),
        ],
    });

    // ── Corpo — Seção 1: Identificação ────────────────────────────────────────
    const sec1 = [
        sectionTitle('1. IDENTIFICAÇÃO DO FORNECEDOR'),
        hLine('Razão Social', d.razaoSocial),
        hLine('CNPJ', d.cnpj),
        hLine('Inscrição Estadual', d.inscricaoEstadual),
        hLine('Endereço', d.endereco),
        hLine('Bairro', d.bairro),
        para([bold('CEP: '), normal(d.cep || '_______________'), normal('   '), bold('Cidade: '), normal(d.cidade || '_______________________'), normal('   '), bold('Estado: '), normal(d.estado || '____')]),
        para([bold('Telefone: '), normal(d.telefone || '___________________'), normal('   '), bold('Contato: '), normal(d.contato || '___________________________')]),
        hLine('Serviço / Material que fornece', d.servicoMaterial),
        hLine('E-mail', d.email),
        hLine('Classificação Tributária', d.classificacaoTributaria),
    ];

    // ── Corpo — Seção 2.1 ─────────────────────────────────────────────────────
    const sec21 = [
        sectionTitle('2. QUALIFICAÇÃO PARA FORNECIMENTO'),
        para([bold('2.1.  '), bold('Tem sistema da qualidade (ISO 9001 ou PBQP-H)? '),
            ...radioGroup([{ key: 'sim', label: 'SIM' }, { key: 'nao', label: 'NÃO' }], d.temSistemaQualidade),
        ]),
    ];
    if (d.temSistemaQualidade === 'sim') {
        sec21.push(para([bold('       Qual? '), normal(d.qualSistema || '___________________________________________')]));
    }

    // ── Corpo — Seção 2.2 ─────────────────────────────────────────────────────
    const itens22 = [
        { key: 'alvaraFuncionamento', label: 'Alvará de funcionamento (Prefeitura Municipal)' },
        { key: 'avcb', label: 'Auto de Vistoria do Corpo de Bombeiros (AVCB)' },
        { key: 'licencaOperacao', label: 'Licença de Operação (CETESB, IBAMA, etc.)' },
        { key: 'fispq', label: 'Apresenta FISPQ ou similar dos produtos?' },
        { key: 'fornecedorControle', label: 'É fornecedor de controle tecnológico?' },
    ];
    const sec22 = [
        para([bold('2.2.  '), bold('A empresa possui?'), normal('   '), normal('(Enviar cópias dos documentos disponíveis)')]),
        ...itens22.map(item =>
            para([normal('   • '), normal(item.label + ':  '), ...simNaoNa(d[item.key])])
        ),
        // Subitem acreditação
        para([
            normal('         Caso sim acima, a empresa é acreditada:  '),
            ...radioGroup(
                [{ key: 'inmetro', label: 'INMETRO' }, { key: 'iso9001', label: 'ISO 9001' }, { key: 'nao_certificada', label: 'Não certificada' }],
                d.acreditacao
            ),
        ]),
    ];

    // ── Corpo — Seção 2.3 ─────────────────────────────────────────────────────
    const empresas = Array.isArray(d.empresas) ? d.empresas : [];
    const sec23 = [
        para([bold('2.3.  '), bold('Empresas para as quais fornece:')]),
        ...([0, 1, 2]).map(i => {
            const emp = empresas[i] || {};
            return para([
                bold(`   ${i + 1}. Razão Social: `), normal(emp.razaoSocial || '______________________________'),
                bold('   Fone: '), normal(emp.fone || '________________'),
                bold('   Contato: '), normal(emp.contato || '______________________'),
            ]);
        }),
    ];

    // ── Corpo — Seções 2.4 a 2.7 ─────────────────────────────────────────────
    function secAvaliacao(num, label, field, avField) {
        const rows = [para([bold(`${num}.  `), bold(label + ':  '), ...simNaoNa(d[field])])];
        if (d[field] === 'sim' && avField) {
            rows.push(avaliacao(d[avField]));
        }
        return rows;
    }

    const sec24 = secAvaliacao('2.4', 'Verificação do serviço aplicado em outros locais', 'verificacaoServico', 'verificacaoServicoAvaliacao');
    const sec25 = secAvaliacao('2.5', 'Visita às instalações do fornecedor', 'visitaInstalacoes', 'visitaInstalacoesAvaliacao');
    const sec26 = secAvaliacao('2.6', 'Análise do curriculum do fornecedor', 'analiseCurriculum', 'analiseCurriculumAvaliacao');
    const sec27 = [
        para([bold('2.7.  '), bold('Atende aos requisitos de fornecimento da Empresa?  '),
            ...radioGroup([{ key: 'sim', label: 'SIM' }, { key: 'nao', label: 'NÃO' }], d.atendeRequisitos),
        ]),
    ];

    // ── OBS ───────────────────────────────────────────────────────────────────
    const obs = [
        para([bold('OBS: '), normal('Se necessário, use outras páginas ou o verso desta página para anotações adicionais.')], { after: 0 }),
    ];

    // ── Data e Assinatura ──────────────────────────────────────────────────────
    const hoje = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const assinatura = [
        para([]),
        para([normal(`Data de preenchimento: ${hoje}`)]),
        para([normal('Solicitado por: '), bold(d.requesterName || '___________________________'), normal('   ('), normal(d.requesterEmail || ''), normal(')')]),
    ];

    // ── Montagem da tabela principal ──────────────────────────────────────────
    const bodyChildren = [
        ...sec1, ...sec21, ...sec22, ...sec23,
        ...sec24, ...sec25, ...sec26, ...sec27,
        ...obs, ...assinatura,
    ];

    const bodyRow = new TableRow({
        children: [bodyCell(bodyChildren)],
    });

    // ── Documento final ───────────────────────────────────────────────────────
    const doc = new Document({
        styles: {
            default: {
                document: { run: { font: 'Arial', size: 22 } },
            },
        },
        sections: [{
            properties: {
                page: {
                    size: { width: PAGE_W, height: PAGE_H },
                    margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN },
                },
            },
            children: [
                new Table({
                    width: { size: CONTENT_W, type: WidthType.DXA },
                    columnWidths: [COL1, COL2, COL3],
                    rows: [headerRow, titleRow, bodyRow],
                }),
            ],
        }],
    });

    return Packer.toBuffer(doc);
}
