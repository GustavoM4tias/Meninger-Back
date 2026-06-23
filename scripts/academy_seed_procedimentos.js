/**
 * SEED de PROCEDIMENTOS OPERACIONAIS - Base de Conhecimento do Academy.
 *
 * Importa procedimentos antigos (PDF/Word) para a KB do Academy como artigos
 * markdown. É IDEMPOTENTE: identifica cada procedimento pelo `slug` - se já
 * existir, ATUALIZA o conteúdo; senão, cria. Pode rodar quantas vezes quiser.
 *
 * Diferente do fluxo de publicação pela API (`kbAdminService.publish`), este
 * script grava direto no model - então NÃO dispara notificação para todos os
 * funcionários a cada importação. Ideal para popular a base em lote.
 *
 * Visibilidade: cada procedimento define `audiences` (tokens de público).
 *   ['INTERNAL'] = somente funcionários Menin (+ gestores + admin).
 *   Externos (corretores, imobiliárias, correspondentes) NÃO veem.
 *
 * Como rodar (a partir de Meninger-Back/):
 *   node scripts/academy_seed_procedimentos.js
 *
 * Atenção: usa a mesma conexão de banco do app (config/config.cjs + .env).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * RADAR DE CONEXÕES (cross-links a criar quando os artigos-alvo existirem)
 * Os termos em **negrito** no corpo apontam para futuros artigos. Quando eles
 * forem criados, basta editar este procedimento e trocar o termo por um link
 * `[termo](/academy/kb/<categoria>/<slug>)`. Dar bons `aliases` ao artigo-alvo
 * faz ele aparecer no picker "🔗 Artigo" do editor.
 *
 *   - CV CRM ...................... ["CV", "CV CRM", "CVCRM"]
 *   - Contrato Caixa (CEF) ........ ["Contrato Caixa", "Contrato CEF", "CEF", "B.4", "B.4.2"]
 *   - Certificação Digital / ICP .. ["ICP Brasil", "Certificação Digital", "Certificado Digital"]
 *   - Etapa de Repasse no CV ...... ["Repasse", "Contratos Assinados MCMV"]
 *   - Recursos Próprios ........... ["Recurso Próprio", "Recurso à Vista", "Recursos Próprios"]
 *   - Desconto Construtora ........ ["Desconto Construtora", "Descontos Construtora"]
 *   - Subsídios (Est/Fed/FGTS) .... ["Subsídio", "Subsídios", "FGTS"]
 *   - Programa Minha Casa Minha Vida ["MCMV", "Minha Casa Minha Vida"]
 *   - Contas a Receber / Extrato .. ["Contas a Receber", "Extrato do cliente"]
 * ─────────────────────────────────────────────────────────────────────────
 */

import db from '../models/sequelize/index.js';
import {
    normalizeAudiences,
    deriveLegacyAudience,
    canonicalizeAudiences,
    visibilityToAudiences,
} from '../services/academy/audience.js';

// Autor opcional (id de um usuário interno). Deixe null para "sem autor".
const AUTHOR_USER_ID = process.env.SEED_AUTHOR_USER_ID
    ? Number(process.env.SEED_AUTHOR_USER_ID)
    : 1; // default: Gustavo Diniz (id 1) - todos os procedimentos são dele

// Subcategoria (2º nível da KB) por slug de artigo: Comercial > <sub> > artigo.
// Um procedimento pode sobrescrever com seu próprio campo `subcategorySlug`.
const SUBCATEGORY_BY_SLUG = {
    'programa-minha-casa-minha-vida': 'caixa-economica',
    'contrato-caixa-cef': 'caixa-economica',
    'demanda-minima': 'caixa-economica',
    'registro-de-contratos-empreendimentos-mcmv': 'cartorio',
    'ri-digital': 'cartorio',
    // cv-crm: sem subcategoria - é a visão geral da categoria Construtor de Vendas.
    'certificacao-digital': 'assinatura-e-certificacao',
    'icp-brasil': 'assinatura-e-certificacao',
    'cv-leads-andamento': 'leads',
    'cv-leads-cadastro': 'leads',
    // Gestor
    'painel-do-gestor-guia-inicial': 'painel-do-gestor',
    'cv-empresas-correspondentes': 'painel-do-gestor',
    'cv-usuario-correspondente': 'painel-do-gestor',
    'cv-imobiliarias': 'painel-do-gestor',
    'cv-usuario-imobiliaria': 'painel-do-gestor',
    'cv-cadastro-corretor': 'painel-do-gestor',
    'cv-vincular-imobiliaria-empreendimento': 'painel-do-gestor',
    'cv-vincular-corretor-empreendimento': 'painel-do-gestor',
    'cv-campos-obrigatorios-reservas': 'painel-do-gestor',
};

// ── Procedimentos a importar. Para "seguir para mais", basta adicionar itens. ──
const PROCEDURES = [
{
        code: 'MCMV',
        slug: 'programa-minha-casa-minha-vida',
        title: 'Programa Minha Casa Minha Vida (MCMV)',
        categorySlug: 'comercial',
        authorUserId: 1, // Gustavo Diniz
        audiences: ['INTERNAL'], // somente internos Menin Office
        aliases: [
            'MCMV',
            'Minha Casa Minha Vida',
            'Programa Minha Casa Minha Vida',
        ],
        body: `# Programa Minha Casa Minha Vida (MCMV)

> **Base de Conhecimento - Comercial** · Guia introdutório
> Condições vigentes desde **22/04/2026** · Conteúdo atualizado em jun/2026

## O que é

O **Minha Casa Minha Vida (MCMV)** é o principal programa habitacional do Governo Federal. O objetivo é facilitar o acesso à casa própria para famílias de baixa e média renda por meio de três alavancas: **subsídio** (desconto dado pelo governo), **juros reduzidos** e uso do **FGTS**.

Foi criado em 2009, substituído pelo programa "Casa Verde e Amarela" (2020-2022) e **relançado em 2023** pela **Lei nº 14.620/2023**, retomando o nome Minha Casa Minha Vida.

## Quem é quem

- **Ministério das Cidades** - define as regras e normativas do programa.
- **Conselho Curador do FGTS** - aprova as condições financiadas com recursos do **FGTS**.
- **Caixa Econômica Federal** e **Banco do Brasil** - operam o financiamento: analisam o crédito e liberam os recursos.
- **Construtoras / incorporadoras** (como a Menin) - produzem os empreendimentos enquadrados e vendem as unidades.

## Como funciona

A casa é financiada em parcelas que cabem no orçamento da família. Conforme a renda, o programa combina:

1. **Subsídio** - valor que o governo abate do preço do imóvel e que **não precisa ser devolvido**. Quanto menor a renda, maior o subsídio.
2. **Juros reduzidos** - taxas abaixo das de mercado, que variam por faixa de renda e por região.
3. **Uso do FGTS** - o saldo do FGTS pode ser usado como entrada, para abater parcelas ou reduzir o saldo devedor.
4. **Prazo longo** - financiamento de **120 a 420 meses** (até 35 anos).

## Faixas de renda (condições de 22/04/2026)

O enquadramento é definido pela **renda familiar bruta mensal**:

| Faixa | Renda familiar/mês | Subsídio | Juros (a.a.) | Imóvel até |
| --- | --- | --- | --- | --- |
| **Faixa 1** | até R$ 3.200 | até R$ 55 mil (R$ 65 mil no Norte) | a partir de 4% (N/NE) ou 5,25% | ~R$ 275 mil* |
| **Faixa 2** | R$ 3.200 a R$ 5.000 | até R$ 35 mil | 4,75% a 7% | ~R$ 275 mil* |
| **Faixa 3** | R$ 5.000 a R$ 9.600 | sem subsídio direto | 7,66% a 8,16% | R$ 400 mil |
| **Faixa 4** (Classe Média) | R$ 9.600 a R$ 13.000 | sem subsídio | até ~10% nominal | R$ 600 mil |

\\* Faixas 1 e 2: o teto do imóvel varia por região e porte do município (aprox. R$ 210 mil a R$ 275 mil).

> ⚠️ **Valores, juros e subsídios mudam por normativa e por região.** Antes de fechar uma venda, confirme o enquadramento, a taxa e o subsídio no **Simulador Habitacional da Caixa** (simuladorhabitacao.caixa.gov.br) ou no App Habitação CAIXA.

### A novidade: Faixa 4 (Classe Média)

Criada para atender famílias de renda média que antes não se enquadravam:

- **Sem subsídio** - o benefício é o acesso ao **Sistema Financeiro de Habitação (SFH)** com teto de juros (até ~10% a.a.).
- **Entrada mínima de 20%** do valor do imóvel.
- Aceita imóvel **novo, usado ou na planta** (na planta, a obra precisa ser financiada pela Caixa).
- Teto do imóvel: **R$ 600 mil**.

## Modalidades

- **MCMV Urbano** - imóveis em áreas urbanas (foco da maior parte das vendas).
- **MCMV Rural** - moradia para trabalhadores e produtores do campo.
- **MCMV Entidades / Cidades** - produção via prefeituras, associações e cooperativas habitacionais.

## Requisitos gerais para participar

Variam por faixa e por banco, mas em regra o cliente precisa:

- Ter **renda familiar dentro da faixa**;
- **Não ser proprietário** de outro imóvel residencial nem ter financiamento habitacional ativo no **SFH**;
- Não constar em cadastros impeditivos (ex.: já ter sido beneficiado antes);
- Ter CPF regular e crédito aprovado pelo banco.

Sobre a inscrição: a **Faixa 1** costuma ser cadastrada via **CadÚnico / prefeitura**; as **Faixas 2, 3 e 4** são contratadas direto no banco ou por **correspondente** (ex.: o setor comercial da construtora).

## Por que isso importa para a venda

O preço, o subsídio e a parcela que o cliente enxerga dependem do **enquadramento correto** na faixa. Erros de renda ou de documentação atrasam o financiamento. Na formalização, os valores precisam bater exatamente entre o **Contrato Caixa (CEF)** e a **Confissão de Dívida** - veja o procedimento **CONF01** para os detalhes.

## Normativas de referência

- **Lei nº 14.620/2023** - relançou o programa.
- Regras operacionais definidas pelo **Ministério das Cidades** (portarias) e pelo **Conselho Curador do FGTS**.
- **Condições atuais em vigor desde 22/04/2026** (atualização de faixas, tetos de imóvel, juros e prazos).

---

**Fonte:** Ministério das Cidades (gov.br/cidades) e Caixa Econômica Federal. Conteúdo educativo - confirme sempre as condições vigentes no simulador oficial da Caixa.`,
    },
{
        code: 'CEF-CONTRATO',
        slug: 'contrato-caixa-cef',
        title: 'Contrato Caixa (CEF)',
        categorySlug: 'comercial',
        authorUserId: 1, // Gustavo Diniz
        audiences: ['INTERNAL'],
        aliases: ['Contrato Caixa (CEF)', 'Contrato Caixa', 'Contrato da Caixa', 'Contrato CEF', 'CEF'],
        body: `# Contrato Caixa (CEF)

> **Base de Conhecimento - Comercial** · Guia introdutório

## O que é

O **Contrato Caixa** é o instrumento que formaliza, ao mesmo tempo, a **compra do imóvel** e o **financiamento habitacional** concedido pela Caixa Econômica Federal dentro do Programa Minha Casa Minha Vida. É o documento principal da venda financiada: sem ele não há liberação de recursos.

É um contrato **por instrumento particular com força de escritura pública** (Sistema Financeiro da Habitação), assinado por todas as partes e registrado no Cartório de Registro de Imóveis.

## Quem assina

- O(s) **comprador(es)/associado(s)** e seus cônjuges;
- A **construtora/vendedora**;
- A **Caixa Econômica Federal**, como agente financeiro.

Todas as assinaturas seguem o padrão de Certificação Digital ICP-Brasil - a regra completa de assinatura está na Confissão de Dívida (procedimento CONF01).

## O que o contrato traz

- Identificação das partes e do imóvel;
- **Valor de venda** do imóvel;
- **Composição dos recursos**: subsídios, FGTS, recursos próprios (à vista/parcelado) e o valor financiado;
- Condições do financiamento (prazo, taxa, garantia por alienação fiduciária).

### Cláusulas usadas na conferência

No nosso processo, duas referências do contrato são centrais:

- **B.4 - Valor de venda** do imóvel.
- **B.4.2 - Composição de recursos** (soma de recurso à vista, parcelado e Desconto Construtora).

> A numeração/letra das cláusulas segue o modelo de contrato vigente da Caixa e pode variar entre versões - confirme sempre no contrato do cliente.

## Relação com a Confissão de Dívida

A Confissão de Dívida precisa **refletir fielmente** os valores do Contrato Caixa (data de assinatura, valor de venda, recursos e subsídios). Qualquer divergência - até de centavos - compromete a formalização. O passo a passo está no procedimento CONF01.

## No sistema

Depois de assinado, o contrato é vinculado no CV CRM, na etapa de repasse, com o tipo de documento \`Contrato CEF - ASSINADO\`.`,
    },
{
        code: 'CV-CRM',
        slug: 'cv-crm',
        title: 'CV CRM (Construtor de Vendas)',
        categorySlug: 'construtor-de-vendas',
        authorUserId: 1, // Gustavo Diniz
        audiences: ['INTERNAL'],
        aliases: ['CV CRM', 'CVCRM', 'Construtor de Vendas', 'CV'],
        body: `# CV CRM (Construtor de Vendas)

> **Base de Conhecimento - Comercial** · Guia introdutório

## O que é

O **CV CRM** (originalmente **Construtor de Vendas**, do Grupo Softplan) é a plataforma de CRM e gestão comercial usada por incorporadoras e construtoras. Cobre toda a jornada da venda - do **lead** ao **pós-venda** -, reunindo atendimento, reservas, negociação, documentação e repasse num só lugar.

É o sistema onde o time comercial registra e acompanha as vendas.

## Para que usamos no dia a dia

- Cadastro e acompanhamento de **reservas e vendas**;
- **Documentação** do cliente e da venda;
- **Conferência interna** de documentos (ex.: anexar a Confissão de Dívida);
- **Etapa de repasse**: vínculo dos documentos assinados e mudança de situação.

## Conceitos importantes

- **Etapa de repasse** - fase em que os documentos pós-assinatura são vinculados e autorizados.
- **Tipos de documento** - categorias usadas no vínculo, como \`Contrato CEF - ASSINADO\` e \`Confissão de Dívida - ASSINADO\`.
- **Situação** - status do processo, como \`CONTRATOS ASSINADOS MCMV\`.

## Relação com os contratos

Na venda financiada pela Caixa (Programa Minha Casa Minha Vida), o **Contrato Caixa (CEF)** e a **Confissão de Dívida** são anexados e vinculados no CV CRM. O passo a passo de geração e vínculo está no procedimento CONF01.

> As regras de tipo de documento, situação e etapa seguem a configuração interna do nosso CV CRM.`,
    },
{
        code: 'CERT-DIGITAL',
        slug: 'certificacao-digital',
        title: 'Certificação Digital',
        categorySlug: 'comercial',
        authorUserId: 1, // Gustavo Diniz
        audiences: ['INTERNAL'],
        aliases: ['Certificação Digital', 'Certificado Digital'],
        body: `# Certificação Digital

> **Base de Conhecimento - Comercial** · Guia introdutório

## O que é

A **Certificação Digital** é uma identidade eletrônica que permite assinar documentos com **validade jurídica**. Funciona como um "RG eletrônico": usa criptografia para garantir **autenticidade** (quem assinou é quem diz ser) e **integridade** (o documento não foi alterado depois de assinado).

A peça central é o **Certificado Digital**, emitido por uma Autoridade Certificadora credenciada.

## Validade jurídica

A base legal é a **Medida Provisória nº 2.200-2/2001**. Pelo art. 10, documentos assinados com Certificado Digital no padrão ICP-Brasil têm **presunção de veracidade** e a mesma validade de um documento em papel assinado de próprio punho.

## Tipos de assinatura eletrônica

- **Simples** - apenas identifica o signatário.
- **Avançada** - garante integridade e vínculo com o signatário.
- **Qualificada** - usa Certificado Digital no padrão ICP-Brasil; é o nível mais alto de segurança jurídica.

## No nosso processo

Para a Confissão de Dívida e o Contrato Caixa (CEF), a **única certificação aceita é a do padrão ICP-Brasil**, com o Certificado Digital de cada assinante. Assinaturas físicas ou com outras certificações (como "GOV") não são aceitas, salvo exceções. Detalhes no procedimento CONF01.`,
    },
{
        code: 'ICP-BRASIL',
        slug: 'icp-brasil',
        title: 'ICP-Brasil',
        categorySlug: 'comercial',
        authorUserId: 1, // Gustavo Diniz
        audiences: ['INTERNAL'],
        aliases: ['ICP-Brasil', 'ICP Brasil'],
        body: `# ICP-Brasil

> **Base de Conhecimento - Comercial** · Guia introdutório

## O que é

A **ICP-Brasil** (Infraestrutura de Chaves Públicas Brasileira) é o sistema nacional de certificação digital. Foi criada pela **Medida Provisória nº 2.200-2/2001** para padronizar e dar validade legal aos certificados digitais emitidos no país.

É o padrão que sustenta a Certificação Digital com valor jurídico no Brasil.

## Como é organizada

- **AC Raiz** - no topo da cadeia está o **ITI** (Instituto Nacional de Tecnologia da Informação), que credencia e audita as demais.
- **Autoridades Certificadoras (AC)** - emitem os certificados.
- **Autoridades de Registro (AR)** - fazem a identificação presencial do solicitante.

## Tipos de certificado

- **A1** - fica em software (arquivo no computador), validade de até 1 ano.
- **A3** - fica em cartão ou token, validade de até 3 anos.
- **e-CPF** e **e-CNPJ** - identidades digitais de pessoa física e jurídica.

> A ICP-Brasil atualiza periodicamente seus modelos de certificado - confirme os tipos vigentes no ITI.

## Validade jurídica

Pelo art. 10 da MP 2.200-2/2001, documentos assinados com certificado ICP-Brasil têm presunção de veracidade e a mesma validade de um documento em papel.

## No nosso processo

É o **único padrão aceito** para assinar a Confissão de Dívida e o Contrato Caixa (CEF). A explicação geral de assinatura está em Certificação Digital; a regra do processo está no procedimento CONF01.

- **A Menin custeia a emissão** do certificado digital de cada cliente.
- O certificado costuma ser emitido com **validade de 90 dias** - o prazo mínimo disponível.
- **Todas as pessoas presentes no Contrato Caixa (CEF) precisam assinar** - logo, cada uma precisa do seu próprio certificado digital.
- **Gestão atual (via WhatsApp):** as solicitações são organizadas em grupos de comunicação no WhatsApp. O **gestor do empreendimento** é o responsável por solicitar a certificação dos seus clientes assim que eles **iniciam a etapa de repasse no CV CRM**.`,
    },
{
        code: 'COMRC1',
        slug: 'registro-de-contratos-empreendimentos-mcmv',
        title: 'Registro de Contratos - Empreendimentos MCMV',
        categorySlug: 'comercial', // Cartório/Registro fica em Comercial (sub 'cartorio' via SUBCATEGORY_BY_SLUG)
        authorUserId: 1, // Gustavo Diniz
        audiences: ['INTERNAL'],
        aliases: ['COMRC1', 'Registro de Contratos', 'Registro de Contratos MCMV'],
        body: `# Registro de Contratos - Empreendimentos MCMV

> **Procedimento Operacional - Departamento Comercial**
> **Código:** COMRC1 · **Revisão:** 00

**Objetivo:** registrar no Cartório de Registro de Imóveis o **Contrato Caixa (CEF)** e a **Confissão de Dívida** dos empreendimentos do **Programa Minha Casa Minha Vida**, garantindo que cada empreendimento tenha saldo na plataforma **RI Digital** para não travar prazos.

## Como funciona hoje

O registro passou a ser **provisionado por empreendimento**, de forma proativa:

- Todo empreendimento **tem (ou deve ter) uma conta no RI Digital**.
- **Antes de assinar a demanda mínima**, o **gestor** aciona a **equipe comercial interna**, informando a necessidade de preparar o sistema e os valores para o registro dos contratos.
- A equipe faz o **levantamento e projeta o custo** de **prenotação + registro**, que a **construtora carrega na plataforma RI Digital**.
- O **saldo fica na conta do empreendimento** e é de **uso único e exclusivo** para esse fim. A equipe interna **acompanha para validar o uso correto**.
- **Antes de o saldo acabar**, é preciso **notificar a equipe** para novas entradas - para não criar gargalos nos prazos de pagamento nem morosidade no registro.

## Pré-requisito do contrato

O contrato só avança para prenotação/registro quando está na etapa \`Contrato Assinado MCMV\` (ou posterior) no **Construtor de Vendas** (CV CRM).

## ITBI

- **Com isenção:** anexar a **Certidão de Isenção** aos documentos enviados ao cartório.
- **Sem isenção:** anexar a **guia de ITBI paga** para envio a Registro.

## RI Digital - consultar e adicionar saldo

Plataforma: **registradores.onr.org.br**. O login é normalmente via **gov.br**, mas a incorporadora pode disponibilizar um acesso próprio para o **gestor** ou o **CCA**.

- **Consultar o valor da prenotação:** tela inicial → **E-Protocolo** → **Consultar valor do Serviço** → selecionar o cartório.
- **Adicionar saldo (Conta RI Digital):** acessar com a conta do **responsável pelo Registro** (CCA ou Gerente de Vendas) → **Compra e Crédito** → **+ Opções** → **Novo Pedido** → emitir o boleto bancário no valor total.

## Custas estaduais ou municipais divergentes

Havendo custas estaduais ou municipais diferentes das previstas neste procedimento, **informar as equipes Financeira e Comercial com antecedência** para análise.

---

**Dúvidas:** Departamento Comercial - comercial@menin.com.br`,
    },
{
        code: 'DEMANDA-MINIMA',
        slug: 'demanda-minima',
        title: 'Demanda Mínima (MCMV)',
        categorySlug: 'comercial',
        authorUserId: 1, // Gustavo Diniz
        audiences: ['INTERNAL'],
        aliases: ['Demanda Mínima', 'demanda mínima', 'demanda minima'],
        body: `# Demanda Mínima (MCMV)

> **Base de Conhecimento - Comercial** · Guia introdutório

## O que é

A **demanda mínima** é a **quantidade mínima de unidades comercializadas** (clientes identificados e aprovados) que um empreendimento precisa atingir para que a **Caixa Econômica Federal** libere o **financiamento da obra** e a construtora possa iniciar a construção.

Em outras palavras: antes de "subir" o empreendimento, é preciso comprovar que existe procura real pelas unidades.

## Por que existe

Protege todos os envolvidos - Caixa, construtora e compradores:

- Garante que o projeto tem **demanda confirmada** antes de começar a obra;
- Reduz o risco de empreendimento parado por falta de vendas;
- Faz parte da análise de crédito da obra junto à Caixa (a **Geric** - Gerência de Risco de Crédito - avalia a saúde financeira da construtora).

## Relação com o nosso processo

A assinatura da demanda mínima é um **marco**: a partir dela, o empreendimento entra na fase de formalização e registro dos contratos.

- **Antes de assinar a demanda mínima**, o gestor deve acionar a **equipe comercial interna** para preparar o **RI Digital** e projetar os custos de registro - ver o procedimento Registro de Contratos (COMRC1).
- Em seguida, cada venda segue com o **Contrato Caixa (CEF)** e a **Confissão de Dívida**, assinados e vinculados no **CV CRM**.

> Os percentuais e as regras exatas de demanda mínima podem variar por empreendimento e por diretriz da Caixa - confirme as condições vigentes a cada projeto.`,
    },
{
        code: 'RI-DIGITAL',
        slug: 'ri-digital',
        title: 'RI Digital (ONR)',
        categorySlug: 'comercial',
        authorUserId: 1, // Gustavo Diniz
        audiences: ['INTERNAL'],
        aliases: ['RI Digital', 'RI Digital (ONR)'],
        body: `# RI Digital (ONR)

> **Base de Conhecimento - Comercial** · Guia introdutório

## O que é

O **RI Digital** é a plataforma oficial do **ONR** (Operador Nacional do Sistema de Registro Eletrônico de Imóveis) que **centraliza os serviços dos Cartórios de Registro de Imóveis** de todo o país em um único ambiente online. Foi criado a partir da **Lei nº 13.465/2017**.

É por meio dele que enviamos os contratos para registro e acompanhamos o processo de forma digital.

## Para que usamos

- **Enviar documentos** (como o **Contrato Caixa (CEF)** e a **Confissão de Dívida**) ao cartório para **prenotação** e posterior **registro**;
- **Consultar o valor** dos serviços do cartório (custas);
- **Adicionar saldo** à conta do empreendimento, de onde saem os pagamentos de prenotação e registro;
- Emitir **certidões** e visualizar a **matrícula** do imóvel.

## Conceitos

- **e-Protocolo** - envio eletrônico de títulos (contratos) direto ao cartório para prenotação e registro.
- **Prenotação** - o protocolo que reserva a prioridade do registro enquanto o cartório analisa a documentação.
- **Conta do empreendimento** - cada empreendimento tem (ou deve ter) a sua conta no RI Digital, com saldo de **uso exclusivo** para o registro daquele projeto.

## Acesso

Site: **registradores.onr.org.br**. O login é normalmente via **gov.br**, mas a incorporadora pode disponibilizar um acesso próprio para o **gestor** ou o **CCA** (responsável pelo Registro).

## No nosso processo

O provisionamento do saldo e o passo a passo de **consultar valor** e **adicionar saldo** estão detalhados no procedimento Registro de Contratos (COMRC1). O saldo deve ser usado **única e exclusivamente** para o registro do empreendimento, e a equipe interna acompanha o uso correto.`,
    },
{
        code: 'CV-COR-INICIO',
        slug: 'painel-do-corretor-guia-inicial',
        title: 'Guia Inicial - Corretor',
        categorySlug: 'construtor-de-vendas',
        authorUserId: 1,
        visibility: 'BOTH',
        aliases: ['Guia Inicial do Corretor', 'App do Corretor', 'CVCRM:Corretor'],
        body: `# Guia Inicial

> **Construtor de Vendas - Painel do Corretor** · Guia do módulo

## O que é

O **Painel do Corretor** é a área do CV CRM feita para quem vende: corretores e imobiliárias parceiras. É por ele que você cadastra seus leads, acompanha o funil, monta o Pré-cadastro do comprador e cria reservas de unidade.

Pode ser acessado pelo navegador ou pelo **aplicativo CVCRM: Corretor** (Android/iOS), que mantém tudo na palma da mão.

## Primeiros passos

1. **Acesso** - você recebe o convite/login da Menin. Externos entram com o acesso de corretor (não é o login Office).
2. **Instale o app** e ative as **notificações push** - é assim que você fica sabendo na hora de movimentações nos seus atendimentos (lead respondido, reserva aprovada, documentação pendente).
3. **Conheça a página inicial** - ela resume seus leads recentes, suas reservas em andamento e os avisos da incorporadora.

> 📸 **Espaço para print/GIF** - capture a página inicial do Painel do Corretor na nossa instância e cole aqui (edite o artigo e insira a imagem em markdown).

## O caminho da venda no CV

O fluxo padrão que você vai percorrer:

1. **Lead** - o interessado entra (por campanha, indicação ou cadastro manual).
2. **Pré-cadastro** - dados e documentos do comprador para análise.
3. **Reserva** - unidade travada + proposta enviada.
4. **Venda/Contrato** - aprovação, assinatura e repasse (conduzidos com o time Menin).

Cada etapa tem um artigo próprio nesta categoria.

## Passo a passo oficial (prints e GIFs)

Tutoriais ilustrados do módulo, direto na central do CV (abrem em nova aba):

- [Como utilizar o Aplicativo CVCRM: Corretor](https://ajuda.cvcrm.com.br/support/solutions/articles/157000366742-como-utilizar-o-aplicativo-cvcrm-corretor)
- [Notificações Push](https://ajuda.cvcrm.com.br/support/solutions/articles/157000363893-notificac%C3%B5es-push-painel-do-corretor)
- [Nova Página Inicial do CV](https://ajuda.cvcrm.com.br/support/solutions/articles/157000357856-nova-p%C3%A1gina-inicial-do-cv-painel-do-corretor)
- [Redefinição de senha de acesso](https://ajuda.cvcrm.com.br/support/solutions/articles/157000357142-redefinic%C3%A3o-de-senha-de-acesso-painel-do-corretor)

---

**📎 Documentação oficial (CV CRM):** [Guia Inicial - Painel do Corretor](https://ajuda.cvcrm.com.br/support/solutions/folders/157000592133)
*Passo a passo detalhado com prints e GIFs oficiais na central de ajuda do CV. Este guia é um resumo da Menin.*`,
    },
{
        code: 'CV-COR-LEADS',
        slug: 'cv-leads',
        title: 'Leads',
        categorySlug: 'construtor-de-vendas',
        subcategorySlug: 'leads',
        authorUserId: 1,
        visibility: 'BOTH',
        aliases: ['Leads no CV', 'Gestão de Leads'],
        body: `# Leads

> **Construtor de Vendas - Painel do Corretor** · Guia do módulo

## O que é

**Lead** é todo interessado em comprar que ainda não virou cliente: chegou por uma campanha, um portal, uma indicação ou um atendimento no plantão. O módulo de **Leads** é onde esse interessado entra no funil, é atendido e caminha até virar uma reserva - e, no fim, uma **Venda Realizada**.

## O workflow de Leads na Menin

Todo lead percorre as situações do nosso fluxo (configuradas pelo gestor). É a "régua" que diz onde cada interessado está:

| Situação | O que significa |
| --- | --- |
| **Novo Lead** | acabou de entrar no sistema (início do fluxo). |
| **Atendimento Externo** | em atendimento por canal externo antes da distribuição. |
| **Aguardando Atendimento Corretor** | enviado ao corretor, aguardando o primeiro contato. |
| **1ª Tentativa de Contato** | 1ª tentativa de falar com o lead. |
| **2ª Tentativa de Contato** | 2ª tentativa; lead voltará para a roleta se não houver avanço. |
| **Em Atendimento** | corretor em contato ativo com o lead. |
| **Lead Qualificado** | perfil e interesse confirmados. |
| **Em Negociação** | proposta e condições em discussão. |
| **Em Análise de Crédito** | virou Pré-cadastro e está em análise bancária. |
| **Com Reserva** | unidade reservada para o cliente (pode ter vínculo com a Reserva criada no CV). |
| **Venda Realizada** | negócio fechado (fim do fluxo). |
| **Descartado** | lead cancelado/sem oportunidade (pode sair de qualquer ponto). |

> A situação é o coração do acompanhamento: mantê-la atualizada é o que garante a distribuição correta e o histórico do atendimento.

---

## Vencimento das situações (configuração padrão Menin)

Nossa regra padrão é **rotelar o lead para outro corretor** via a roleta do CV sempre que o prazo de uma situação expira sem que a etapa seja avançada. Essa configuração pode ser ajustada por empreendimento pelo gestor.

| Situação | Prazo | Ação ao vencer | Pausa |
| --- | --- | --- | --- |
| **Aguardando Atendimento Corretor** | **180 minutos** | Usar a roleta | Feriados e fins de semana · 18h-08h · +30 min extra |
| **1ª Tentativa de Contato** | **24 horas** | Usar a roleta | Feriados e fins de semana · 18h-08h · +30 min extra |
| **2ª Tentativa de Contato** | **48 horas** | Usar a roleta | Feriados e fins de semana · 18h-08h · +30 min extra |
| **Em Atendimento** | **480 horas** (~20 dias) | Não executar ação | Feriados e fins de semana · 18h-08h · +30 min extra |
| **Demais situações** | - | Não rotelam | - |

> As situações de tentativa de contato ignoram a configuração de vencimento do empreendimento (opção "Ignorar Configuração de Vencimento" ativada) para garantir o fluxo padrão independentemente das regras locais.

> **Onde configurar:** Painel do Gestor → Configurações → Workflow de Leads → selecione a situação. Cada empreendimento pode ter prazos e ações diferentes - consulte o gestor responsável antes de alterar.

---

## Administrar o Lead

É no **Administrar do Lead** que você enxerga tudo sobre o interessado e age: editar dados, registrar interações, criar tarefas, mudar a situação e abrir reserva/pré-cadastro.

### Dados do Lead

Para abrir e editar, vá em **Leads › Listagem**, clique em **Abrir** no lead desejado e, na lateral esquerda, em **Editar**. Ao terminar, clique em **Salvar**.

![Leads › Listagem](https://cv.alfamaoraculo.com.br/storage/discovirtual/49/56/LEADS-ADM2.gif)

![Editar dados do lead](https://cv.alfamaoraculo.com.br/storage/discovirtual/49/56/LEADS-ADM4.png)

### Lead Score

Pontuação atribuída ao lead conforme a quantidade e a relevância dos dados preenchidos. Quanto mais completo o perfil, maior o score - e melhor a qualificação para conversão.

![Lead Score](https://cv.alfamaoraculo.com.br/storage/discovirtual/49/56/LEADS-ADM6.png)

### Bloqueio de Leads

Se o lead recebe dados por integração, **bloqueá-lo** faz com que as alterações só possam vir do próprio CV - atualizações que chegarem pela integração não são aplicadas.

![Bloqueio de leads](https://cv.alfamaoraculo.com.br/storage/discovirtual/49/56/LEADS-ADM7.png)

Ainda nessa lateral aparecem dados úteis: **nome, e-mail, telefone** (com atalho para abrir o WhatsApp), **campos fixos e adicionais**, **empreendimento de interesse**, **tags**, **valor de negócio**, **primeira origem**, **tempo de conversão** e o resumo de **interações, reservas e ganhos/perdas**.

![Tags do lead](https://cv.alfamaoraculo.com.br/storage/discovirtual/49/56/LEADS-ADM8.png)

![Resumo do lead](https://cv.alfamaoraculo.com.br/storage/discovirtual/49/56/LEADS-ADM9.png)

### Registrar interações

O CV registra cada contato com o lead, formando o histórico do atendimento. Os tipos são:

- **Anotação** - bloco de anotações gerais. A opção *"Recalcular vencimento do lead"* reinicia o prazo de vencimento ao salvar.
- **Ligação** - registra o que foi tratado (não disca; serve de histórico).
- **E-mail** - dispara um e-mail ao cliente (e, se quiser, ao gestor, imobiliária e corretor).
- **SMS** - dispara SMS (requer pacote de SMS contratado).
- **WhatsApp** - registra a conversa tratada por WhatsApp (não envia a mensagem).
- **Visita** - registra a visita, que entra automaticamente na agenda do responsável.

![Anotação](https://cv.alfamaoraculo.com.br/storage/discovirtual/49/56/LEADS-ADM10.png)

![Ligação](https://cv.alfamaoraculo.com.br/storage/discovirtual/49/56/LEADS-ADM11.png)

![E-mail](https://cv.alfamaoraculo.com.br/storage/discovirtual/49/56/LEADS-ADM12.png)

> **CVIA** - assistente de redação integrado ao e-mail (e às mensagens do pré-cadastro e da reserva). Ajuda a escrever anotações e e-mails mais claros e profissionais.

![CVIA](https://cv.alfamaoraculo.com.br/storage/discovirtual/49/56/LEADS-ADM15-1.png)

### Cadastrar uma Tarefa

Em cada interação você pode cadastrar uma **tarefa** - que vincula um lembrete na sua agenda (e pode disparar e-mail). Para uma tarefa avulsa, use o botão **Tarefa**: ele já traz uma descrição automática (editável), com **Data, Prioridade, Situação** e lembrete por e-mail.

![Cadastro de tarefa](https://cv.alfamaoraculo.com.br/storage/discovirtual/49/56/LEADS-ADM16.gif)

### Atividades do Lead

Toda interação e toda alteração (mudança de situação, edição de dados) é registrada automaticamente com **data, hora e responsável** - dando transparência e rastreabilidade à jornada do cliente.

![Atividades do lead](https://cv.alfamaoraculo.com.br/storage/discovirtual/49/56/LEADS-ADM19.gif)

### Nova Reserva / Pré-cadastro / Simulação

No topo da página do lead dá para iniciar uma **Reserva**, um **Pré-cadastro** ou uma **Simulação** - desde que habilitadas pelo gestor e o lead tenha pelo menos um interesse associado.

![Nova reserva / pré-cadastro / simulação](https://cv.alfamaoraculo.com.br/storage/discovirtual/49/56/LEADS-ADM20.png)

### Bolsão de Leads

Guarda contatos estratégicos para oportunidades futuras: quem demonstrou interesse mas ainda não está pronto, candidatos a lançamentos futuros, ou que desistiram temporariamente mas seguem com potencial.

![Bolsão de leads](https://cv.alfamaoraculo.com.br/storage/discovirtual/49/56/LEADS-ADM20-1.png)

### Possibilidade de Venda e Momento do Lead

- **Possibilidade de Venda** - nota de **1 a 5** indicando a chance de fechar (1 = baixa, 5 = alta).
- **Momento do Lead** - classifica o estágio (muito interessado, pouco interessado, em decisão, frio). Ajuda a priorizar os leads mais quentes.

![Possibilidade de venda](https://cv.alfamaoraculo.com.br/storage/discovirtual/49/56/LEADS-ADM21.png)

![Momento do lead](https://cv.alfamaoraculo.com.br/storage/discovirtual/49/56/LEADS-ADM21-1.png)

### Quem está atendendo, Interesses e Associações

- **Quem está atendendo** - mostra a imobiliária e o corretor responsáveis.
- **Associar Interesse** - adiciona empreendimentos de interesse ao perfil.
- **Reservas / Pré-cadastros / Simulações associados** - centraliza no lead o que veio por outros canais.
- **Contatos Associados** - vincula cônjuge, familiar ou sócio que compra junto.

![Quem está atendendo](https://cv.alfamaoraculo.com.br/storage/discovirtual/49/56/LEADS-ADM22.png)

![Associar interesse](https://cv.alfamaoraculo.com.br/storage/discovirtual/49/56/LEADS-ADM23.png)

![Contatos associados](https://cv.alfamaoraculo.com.br/storage/discovirtual/49/56/LEADS-ADM25.png)

### Situação do Lead

É aqui que você move o lead pelo workflow acima. Algumas mudanças exigem requisitos (ex.: registrar uma tarefa ou visita); as opções bloqueadas aparecem em **"Exibir Situações Bloqueadas"**. Manter a situação em dia é o que garante o acompanhamento correto da jornada.

![Situação do lead](https://cv.alfamaoraculo.com.br/storage/discovirtual/49/56/LEADS-ADM26.png)

## Boas práticas Menin

- Registre a interação **no momento em que ela acontece** - o histórico é o que protege a sua autoria do atendimento.
- Lead parado é lead perdido: use as **tarefas/agendamentos** para nunca deixar um interessado sem retorno.
- Atualize a **situação** a cada avanço real - é dela que saem a distribuição e os relatórios.

---

**📎 Documentação oficial (CV CRM):**
- [Administrar do Lead](https://ajuda.cvcrm.com.br/support/solutions/articles/157000363861-administrar-do-lead-painel-do-corretor)
- [Andamento dos Leads](https://ajuda.cvcrm.com.br/support/solutions/articles/157000363862-andamento-dos-leads-painel-do-corretor)
- [Cadastro de Leads](https://ajuda.cvcrm.com.br/support/solutions/articles/157000357141-cadastro-de-leads-painel-do-corretor)

---

### Boas vendas! 🚀`,
    },
{
        code: 'CV-COR-LEADS-AND',
        slug: 'cv-leads-andamento',
        title: 'Andamento dos Leads',
        categorySlug: 'construtor-de-vendas',
        subcategorySlug: 'leads',
        authorUserId: 1,
        visibility: 'BOTH',
        aliases: ['Andamento dos Leads', 'Kanban de Leads'],
        body: `# Andamento dos Leads

> **Construtor de Vendas - Painel do Corretor** · Guia do módulo

## O que é

O **Andamento dos Leads** é a visão em **pipeline** (kanban) do módulo de Leads. Em vez de uma listagem linear, os leads aparecem em **colunas** - cada coluna é uma situação do workflow - e você arrasta, visualiza e atua sem precisar abrir um por um. Também exibe em tempo real o **total de reservas e vendas do mês corrente**.

---

## Como acessar

No menu **Leads**, clique em **"Andamento"**.

![Navegando até Andamento dos Leads](https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/157008619606/original/H-5_klFIFkJczSuclGiXF3oyjGUxwJOSbw.gif?1752240590)

---

## Conhecendo a tela

Os leads são organizados em **blocos/cards** dentro de colunas. Cada coluna = uma situação do workflow de leads.

![Visão geral do kanban de leads](http://cv.alfamaoraculo.com.br/storage/discovirtual/49/56/LEADS-ANDAMENTO3.png)

No canto direito da tela fica a indicação do **mês de competência**: a coluna "Vendida" lista apenas as vendas daquele mês.

![Mês de competência](http://cv.alfamaoraculo.com.br/storage/discovirtual/49/56/LEADS-ANDAMENTO4.png)

Você também consegue ver o **valor total vendido no mês**, o **número de vendas** e a **quantidade de reservas ativas**.

![Resumo vendas e reservas](http://cv.alfamaoraculo.com.br/storage/discovirtual/49/56/LEADS-ANDAMENTO5.png)

---

## Cards e informações rápidas

Cada card possui o botão **"+ Informações"** que exibe detalhes adicionais. Para expandir todos de uma vez, clique em **"Mostrar + Informações"** no topo da coluna.

![Mostrar + Informações em todos os cards](https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/157008619678/original/OdPQffoJCZW03zMWWzFbAeJosJ250wrtRA.gif?1752240662)

### Os 5 ícones de cada card

Cada card traz **5 ícones** com acesso rápido a informações do lead:

**Ícone 1 - Tarefas**
Passe o mouse para verificar se o lead possui uma tarefa cadastrada.

![Ícone 1 - Tarefas](https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/157008619745/original/9KvpyVSM1t2USpcw9C9sra4UQhan9TAg7w.gif?1752240733)

**Ícone 2 - Gestor**
Exibe nome, e-mail e telefone do gestor associado ao lead.

![Ícone 2 - Gestor](https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/157008619769/original/3dho84amkyibDiEyLQ1V0aYAbNuaxcEVJw.gif?1752240753)

**Ícone 3 - Imobiliária**
Exibe nome, e-mail e telefone da imobiliária associada ao lead.

![Ícone 3 - Imobiliária](https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/157008619799/original/twxVvwY5W5pl4m_bJCSsTcrJnXlp1kNieg.gif?1752240772)

**Ícone 4 - Corretor**
Mostra os dados do corretor vinculado (as suas próprias informações).

![Ícone 4 - Corretor](https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/157008619809/original/0Sp50AUAnLGdm27WpIJFPdTn6Yn1779suw.gif?1752240786)

**Ícone 5 - Abrir lead (clicável)**
Abre a tela completa do lead, onde você registra interações, muda a situação e cria reservas.

![Ícone 5 - Abre administrar do lead](https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/157008619836/original/Gk9xS3FzrgzZG7DBHmjpBY5bWoyIJI10Wg.gif?1752240803)

Também é possível clicar em **"Clique aqui"** dentro do card expandido para abrir o administrar completo do lead.

![Clique aqui para abrir o lead completo](https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/157008619888/original/9Lm1qc-pHBawQlZ91CmpSN-Yp5xa275ixA.gif?1752240849)

---

## Filtros do Andamento

A tela possui filtros para refinar a visualização:

![Painel de filtros do andamento](https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/157008619966/original/p1C5XplGGZS-xRh4qZ5puhbN-McH4dkSyw.gif?1752240933)

| Filtro | O que faz |
| --- | --- |
| **Todas as Regiões** | Filtra leads por região dos empreendimentos. |
| **Todos os Empreendimentos** | Filtra por empreendimento específico. |
| **Todos os PDVs** | Filtra por ponto de venda vinculado. |
| **Todas as Origens** | Exibe leads conforme sua origem. |
| **Início / Fim da Data de Cadastro** | Define o período de cadastro para filtrar. |
| **Todos os Gestores** | Filtra pelos gestores responsáveis. |
| **Leads Inseridos no Bolsão** | "Sim" exibe apenas leads no bolsão. |
| **Registros por Coluna** | Controla quantos leads aparecem em cada coluna. |

![Lista de filtros disponíveis](https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/157008620017/original/108M6l1Bq8qbdSH5k_mI885YcKpjxOll5w.png?1752240983)

---

### Boas vendas! 🚀

**📎 Documentação oficial (CV CRM):** [Andamento dos Leads - Painel do Corretor](https://ajuda.cvcrm.com.br/support/solutions/articles/157000363862-andamento-dos-leads-painel-do-corretor)`,
    },
{
        code: 'CV-COR-LEADS-CAD',
        slug: 'cv-leads-cadastro',
        title: 'Cadastro de Leads',
        categorySlug: 'construtor-de-vendas',
        subcategorySlug: 'leads',
        authorUserId: 1,
        visibility: 'BOTH',
        aliases: ['Cadastro de Lead', 'Cadastro de Leads', 'Novo Lead'],
        body: `# Cadastro de Leads

> **Construtor de Vendas - Painel do Corretor** · Guia do módulo

## O que é

O **Cadastro de Leads** é onde você registra manualmente um novo interessado no sistema. Todo lead precisa existir no CV para ser acompanhado, distribuído e atendido - seja ele cadastrado por você, por integração com portais ou via campanha digital.

---

## Como os leads chegam ao sistema

Os leads podem ser cadastrados no CV por múltiplos canais:

- **Cadastro manual** - diretamente pelo Painel do Corretor, do Gestor, da Imobiliária ou do PDV.
- **Integrações automáticas** - captados de plataformas como Facebook Leads, Google Ads, portais imobiliários e o site da incorporadora.

> As funcionalidades visíveis variam conforme as permissões definidas pela incorporadora para cada perfil.

---

## Cadastrando um novo lead manualmente

Você pode iniciar o cadastro de duas formas:

**Opção 1 - Botão "Novo Lead" na tela inicial:**

![Botão Novo Lead na tela inicial](https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/157008616137/original/TfUWBeXLrZJ_4gCP9XvqjTUOvtbYozHBWA.png?1752236965)

**Opção 2 - Menu Leads:**
- **Leads > Novo Lead**, ou
- **Leads > Listagem > Novo Lead**

![Menu Leads > Novo Lead](https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/157008616149/original/IHC7HXk4aaQBbwYUJkrraGKxlHOg3kJQSQ.png?1752236975)

### Preenchendo o formulário

Na tela de cadastro, preencha os campos básicos: **nome**, **e-mail** e **telefone**. Outros campos obrigatórios - como **Empreendimento**, **Mídia de Visita** e **Ponto de Venda** - podem variar conforme a configuração da incorporadora.

![Campos básicos do cadastro](https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/157008616154/original/8Qq8PY1BnyjJXVggtkPF-9PtA4h0SGlesQ.png?1752236988)

Ao finalizar, clique em **"Cadastrar"** para adicionar o lead à listagem.

![Lead cadastrado na listagem](https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/157008616165/original/Hx4uogKJ9YmP_8og9lzcEd8UbGGme6Ohmg.png?1752237009)

---

## Mais dados e campos complementares

Clicando em **"+ Adicionar mais informações"** você pode enriquecer o cadastro com:

- Observações
- Informações secundárias de contato
- Campos personalizados definidos pela incorporadora

![Adicionar mais informações](https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/157008616331/original/Oyp_0SmWeFxiTC9w6KL9xz7AaTDnG3ShQw.png?1752237251)

> Quanto mais completo o cadastro, maior o **Lead Score** - e mais fácil qualificar e priorizar o atendimento.

---

## Fila de distribuição de leads

Além do cadastro manual, o CV permite a **distribuição automática de leads via roleta**, com base nas regras configuradas pela incorporadora.

| Ponto | Detalhe |
| --- | --- |
| Participação automática | Corretores adicionados à fila recebem leads sem necessidade de cadastro manual. |
| Disponibilidade online | Dependendo da configuração, é necessário estar online no sistema para receber leads. |
| Controle individual | Você pode ativar ou desativar sua disponibilidade na fila a qualquer momento. |
| Múltiplas filas | Se estiver em mais de uma fila, você escolhe em quais quer permanecer online. |

![Fila de distribuição - ativar/desativar](https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/157008616380/original/hADPN-mG_1-Jfs9k4999oxX__3kRq51yIQ.gif?1752237354)

> Na Menin, a regra padrão é rotelar o lead para outro corretor quando o prazo de uma situação vence sem avanço. Consulte as regras de vencimento no artigo de Leads para entender os prazos de cada etapa.

---

### Boas vendas! 🚀

**📎 Documentação oficial (CV CRM):** [Cadastro de Leads - Painel do Corretor](https://ajuda.cvcrm.com.br/support/solutions/articles/157000357141-cadastro-de-leads-painel-do-corretor)`,
    },
{
        code: 'CV-GES-INICIO',
        slug: 'painel-do-gestor-guia-inicial',
        title: 'Guia Inicial - Gestor',
        categorySlug: 'construtor-de-vendas',
        authorUserId: 1,
        visibility: 'BOTH',
        aliases: ['Guia Inicial do Gestor'],
        body: `# Guia Inicial

> **Construtor de Vendas - Painel do Gestor** · Guia do módulo

## O que é

O **Painel do Gestor** é a visão administrativa do CV CRM - onde a incorporadora opera: cadastros de empreendimentos e tabelas, gestão do funil comercial, financeiro da venda, jurídico, relacionamento com o cliente e configurações do sistema.

Se o Painel do Corretor é "onde se vende", o do Gestor é "onde a venda é administrada".

## Como se organiza

| Área | O que concentra |
| --- | --- |
| **Cadastros** | Empreendimentos, unidades, tabelas, corretores, imobiliárias |
| **Comercial** | Funil, reservas, vendas, contratos, comissões |
| **Financeiro** | Condições e séries de pagamento, fluxo da venda |
| **Jurídico** | Minutas e geração de contratos |
| **Relacionamento** | Pós-venda, atendimentos, comunicação |
| **Configurações** | Workflows, situações, permissões, automações |
| **Índices** | Correção monetária das parcelas |

Cada área tem um guia próprio nesta categoria.

> 📸 **Espaço para print/GIF** - capture o menu principal do Painel do Gestor da nossa instância.

## Boas práticas Menin

- Antes de mexer em **Configurações**, fale com a equipe comercial interna - mudanças de workflow afetam todos os empreendimentos.

## Passo a passo oficial (prints e GIFs)

Tutoriais ilustrados, direto na central do CV (abrem em nova aba):

- [Conhecendo o Painel do Gestor](https://ajuda.cvcrm.com.br/support/solutions/articles/157000357169-conhecendo-o-painel-do-gestor)
- [Como utilizar o Aplicativo CVCRM: Gestor](https://ajuda.cvcrm.com.br/support/solutions/articles/157000366723-como-utilizar-o-aplicativo-cvcrm-gestor)
- [Como Instalar o App do CV em seu Smartphone](https://ajuda.cvcrm.com.br/support/solutions/articles/157000357240-como-instalar-o-app-do-cv-em-seu-smartphone)
- [CV Magic](https://ajuda.cvcrm.com.br/support/solutions/articles/157000361283-cv-magic)
- [CV Magic | Assistente Virtual](https://ajuda.cvcrm.com.br/support/solutions/articles/157000358116-cv-magic-assistente-virtual)
- [Como abrir um atendimento com o suporte técnico do CV](https://ajuda.cvcrm.com.br/support/solutions/articles/157000358107-como-abrir-um-atendimento-com-o-suporte-t%C3%A9cnico-do-cv-crm-painel-do-gestor)
- [Acompanhando seus Atendimentos de Suporte](https://ajuda.cvcrm.com.br/support/solutions/articles/157000357273-acompanhando-seus-atendimentos-de-suporte-painel-do-gestor)
- [Como Enviar uma Sugestão de Melhoria](https://ajuda.cvcrm.com.br/support/solutions/articles/157000357370-como-enviar-uma-sugest%C3%A3o-de-melhoria)
- [Como acessar o CV Academy](https://ajuda.cvcrm.com.br/support/solutions/articles/157000357591-como-acessar-o-cv-academy)
- **[Ver todos os artigos do Guia Inicial →](https://ajuda.cvcrm.com.br/support/solutions/folders/157000592138)**

---

**📎 Documentação oficial (CV CRM):** [Guia Inicial - Painel do Gestor](https://ajuda.cvcrm.com.br/support/solutions/folders/157000592138)
*Visão geral oficial do painel, com prints e GIFs, na central do CV.*`,
    },
{
        code: 'CV-PORTAL',
        slug: 'portal-do-cliente',
        title: 'Visão Geral',
        categorySlug: 'construtor-de-vendas',
        subcategorySlug: 'portal-do-cliente',
        authorUserId: 1,
        visibility: 'BOTH',
        aliases: ['Portal do Cliente CV', 'Portal do Cliente'],
        body: `# Portal do Cliente

> **Construtor de Vendas - Portal do Cliente** · Guia do módulo

## O que é

O **Portal do Cliente** é a área que o **comprador** acessa depois da venda: o autoatendimento dele. Reduz ligações e dá transparência à jornada pós-compra.

## O que o cliente encontra

- **Extrato financeiro** - parcelas pagas e em aberto, com correção aplicada.
- **Boletos / 2ª via** - emissão sem precisar falar com o financeiro.
- **Documentos** - contrato e documentos da compra disponíveis para download.
- **Andamento da obra** - evolução por etapa, com fotos/percentuais quando publicados.
- **Atendimentos** - abertura e acompanhamento de solicitações (inclusive assistência técnica), que caem no módulo de Relacionamento do gestor.

> 📸 **Espaço para print/GIF** - capture a home do Portal do Cliente da nossa instância (com dados de um cliente de teste).

## Boas práticas Menin

- Oriente o cliente a usar o portal **desde a assinatura** - boleto e extrato em autoatendimento poupam o time financeiro.
- O que o cliente vê no portal depende do que publicamos (obra, documentos): mantenha as publicações em dia.

## Passo a passo oficial (prints e GIFs)

Tutoriais ilustrados, direto na central do CV (abrem em nova aba):

- [Como Utilizar o Novo Portal do Cliente](https://ajuda.cvcrm.com.br/support/solutions/articles/157000358655-como-utilizar-o-novo-portal-do-cliente-portal-do-cliente)
- [Como Efetuar o Primeiro Acesso no CV](https://ajuda.cvcrm.com.br/support/solutions/articles/157000357906-como-efetuar-o-primeiro-acesso-no-cv-portal-do-cliente)
- [Autocadastro do Cliente](https://ajuda.cvcrm.com.br/support/solutions/articles/157000357318-autocadastro-do-cliente-portal-do-cliente)
- [Como utilizar o Aplicativo CVCRM: Cliente](https://ajuda.cvcrm.com.br/support/solutions/articles/157000366854-como-utilizar-o-aplicativo-cvcrm-cliente)
- [Como Solicitar a Antecipação de suas Parcelas](https://ajuda.cvcrm.com.br/support/solutions/articles/157000357905-como-solicitar-a-antecipac%C3%A3o-de-suas-parcelas-portal-do-cliente)
- [Notificações PUSH](https://ajuda.cvcrm.com.br/support/solutions/articles/157000359421-notificac%C3%B5es-push-portal-do-cliente)
- [Como utilizar o Portal do Síndico](https://ajuda.cvcrm.com.br/support/solutions/articles/157000357981-como-utilizar-o-portal-do-s%C3%ADndico-portal-do-cliente)

---

**📎 Documentação oficial (CV CRM):** [Portal do Cliente](https://ajuda.cvcrm.com.br/support/solutions/folders/157000694473)
*Os artigos oficiais do portal estão na central do CV.*`,
    },
{
        code: 'CV-EMP-CORRESP',
        slug: 'cv-empresas-correspondentes',
        title: 'Cadastro de Empresas Correspondentes',
        categorySlug: 'construtor-de-vendas',
        visibility: 'INTERNAL',
        body: `O Correspondente é o elo principal antes do processo de venda - durante o pré-cadastro ou durante o processo de repasse. Para o correspondente acessar o painel, é necessário criar seu usuário. Antes disso, a **Empresa Correspondente** deve ser cadastrada no CV.

## Pré-requisitos

Para cadastrar uma empresa correspondente, você precisa ter as seguintes permissões liberadas no perfil de acesso (aba **"Cadastros"**):

![Permissões necessárias](https://assets.cvcrm.com.br/kb/data/medias/309977/0FB17AA4377433B1BFCC0612FADF47AA.png)

## Passo a passo

Pesquise por **"Empresas Correspondentes"**.

![Buscar empresas correspondentes](https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/157008824390/original/be4QhEkmjeWdFBvSuWurZppUKFPOnQE1yg.gif)

Em seguida, clique em **"Criar nova empresa correspondente"**.

![Criar nova empresa correspondente](https://assets.cvcrm.com.br/kb/data/medias/309977/A5D4656D2486E037D874057BDCCD78EB.png)

**Campos obrigatórios:**

- **Nome:** nome da empresa correspondente
- **Região:** selecione a região (deve ser cadastrada previamente no CV)
- **Estado:** estado em que a empresa está localizada
- **Cidade:** cidade em que a empresa está localizada
- **Endereço:** endereço da empresa
- **Ativo no painel:** se Inativo, não será possível selecionar a empresa ao criar um usuário

![Campos obrigatórios](https://assets.cvcrm.com.br/kb/data/medias/309977/73D89EA5E5FC1FF21EA80237A125E8F5.png)

**Campos opcionais:**

- **Telefone:** telefone da empresa
- **E-mail:** e-mail da empresa
- **Logo:** imagem do logo da empresa
- **Dias de agendamento:** quantidade de dias que o cliente pode agendar a partir da data atual

![Campos opcionais](https://assets.cvcrm.com.br/kb/data/medias/309977/E145F039F24D725B21305B2C4ACB89AB.png)

Também é possível cadastrar os dados do gerente da empresa.

![Dados do gerente](https://assets.cvcrm.com.br/kb/data/medias/309977/633F3746959B7F4F269F71481F45450E.png)

Clique em **"Salvar"**.

![Salvar](https://assets.cvcrm.com.br/kb/data/medias/309977/4027F23C8984C20821555B8608F59B0B.png)

## Configurando o Horário de Funcionamento

Após salvar a empresa, configure o horário de funcionamento para repasse, reserva e pré-cadastro. A configuração funciona da mesma maneira nos três fluxos, em telas diferentes. O exemplo abaixo usa Repasse.

Clique em **"Opções" > "Horário de funcionamento (Repasses)"**.

![Horário de funcionamento](https://assets.cvcrm.com.br/kb/data/medias/309977/2FD9A08EFD892FA30E3C71DA90D4DAEB.png)

Defina o(s) dia(s) da semana e o intervalo de horas.

![Configuração de horário](https://assets.cvcrm.com.br/kb/data/medias/309977/B4493531DCF09BD803448969218BF13F.png)

> **Obs.:** o sistema aceita apenas horários inteiros - se o padrão for 8:30-10:30, registre 8:00-10:00. Os agendamentos ficam limitados a no máximo 7 dias ou ao valor definido no campo de agendamento.

## Configurando as Agências

Em **"Agências"** você pode associar uma agência bancária ao correspondente.

![Agências](https://assets.cvcrm.com.br/kb/data/medias/309977/99E219717C1AE2DD543C2EE8AFFA92CD.png)

## Associando Situação (Repasse, Reserva e Pré-cadastro)

A associação funciona da mesma maneira para os três fluxos, em telas diferentes. O exemplo abaixo usa pré-cadastro.

Selecione as situações desejadas e clique em **"Adicionar"**. As opções exibidas são as criadas no **Workflow de Repasse, Reservas** e **Pré-cadastros**.

![Associar situação](https://assets.cvcrm.com.br/kb/data/medias/309977/46A4BDAEB67974343346D7DC67E96D88.png)

## Configurando Tipos de Visitas

Em **"Tipos de Visitas"** selecione o tipo (cadastrado em **"Tipos de Visitas de Financiamento"**) e defina um limite por empresa correspondente.

![Tipos de visitas](https://assets.cvcrm.com.br/kb/data/medias/309977/F78A382F8C5FEC4B97DB602E5B5B40DA.png)`,
    },
{
        code: 'CV-USR-CORRESP',
        slug: 'cv-usuario-correspondente',
        title: 'Cadastro de Usuário Correspondente',
        categorySlug: 'construtor-de-vendas',
        visibility: 'INTERNAL',
        body: `Para acessar o Painel do Correspondente é necessário cadastrar o **Usuário Correspondente**. Com as permissões liberadas e a **Empresa Correspondente** cadastrada, é possível criar o usuário.

## Pré-requisitos

Para cadastrar um usuário correspondente, você precisa ter as seguintes permissões liberadas no perfil de acesso (aba **"Cadastros"**):

![Permissões necessárias](https://assets.cvcrm.com.br/kb/data/medias/154322/2C2096FBD22075E762DA9A546C0AA6BA.png)

Além disso, é necessário que a **Empresa Correspondente** já esteja cadastrada.

## Passo a passo

**1.** Pesquise por **"Usuários Correspondentes"**.

![Buscar usuários correspondentes](https://assets.cvcrm.com.br/kb/data/medias/154322/34C7E282C356BD041B7D20700065B014.gif)

**2.** Clique em **"Criar novo usuário correspondente"**.

![Criar novo usuário](https://assets.cvcrm.com.br/kb/data/medias/154322/6A5E11E5555E0AA0F7072E16B86390B5.png)

**3.** Preencha os campos obrigatórios:

- **Nome:** nome do usuário
- **CPF:** CPF do usuário (apenas um cadastro por CPF)
- **Estado:** estado em que o usuário reside
- **Cidade:** cidade em que o usuário reside

![Campos obrigatórios parte 1](https://assets.cvcrm.com.br/kb/data/medias/154322/DAC958088848334EB3BF94DBFE3BD454.png)

- **E-mail:** e-mail do usuário
- **Empresa Correspondente:** selecione a empresa cadastrada previamente
- **Ativo Painel:** se Inativo, o usuário ficará oculto em outras funcionalidades
- **Gerente:** selecione "Sim" se o usuário for um gerente

![Campos obrigatórios parte 2](https://assets.cvcrm.com.br/kb/data/medias/154322/87F5D4095BF6F203CF48428CA40E0DCE.png)

**4.** Campos opcionais: data de nascimento, departamento, função, telefone, celular e observações. Também é possível configurar o recebimento de e-mails de aprovação e de ações do pré-cadastro e do workflow.

![Campos opcionais](https://assets.cvcrm.com.br/kb/data/medias/154322/3D3E6B166AD2C5634324889455B4FA6A.png)

**5.** Também é possível criar uma senha e ativar a gestão de mensagens. Com a **Gestão de Mensagem** ativa, o usuário visualiza mensagens enviadas do pré-cadastro, reserva e repasse - exibidas em **"Alertas para Você"** na tela inicial.

![Gestão de mensagens](https://assets.cvcrm.com.br/kb/data/medias/154322/645D14C6041BFA2260992A0A7F12ECF0.png)

**6.** Clique em **"Salvar"**.

![Salvar](https://assets.cvcrm.com.br/kb/data/medias/154322/8B4981F72DC0F6CF6E290461A9B1DC2A.png)`,
    },
{
        code: 'CV-IMOB',
        slug: 'cv-imobiliarias',
        title: 'Cadastro de Imobiliárias',
        categorySlug: 'construtor-de-vendas',
        visibility: 'INTERNAL',
        body: `Para acessar o Painel da Imobiliária, é necessário cadastrar um usuário da imobiliária. Antes disso, a **imobiliária** deve ser cadastrada no CV.

## Pré-requisito

Para cadastrar uma imobiliária, o seu perfil de acesso deve ter as seguintes permissões (aba **"Cadastros"**):

![Permissões necessárias](https://assets.cvcrm.com.br/kb/data/medias/136701/D2354F6E9F90C56CB698EB211DEAC528.png)

## Passo a passo

Pesquise por **"Imobiliárias"**.

![Buscar imobiliárias](https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/157008450671/original/3x1vY3ZfmksG8yHvG18O9dhX0YRKl5Vukw.gif)

Clique em **"Criar nova imobiliária"**.

![Criar nova imobiliária](https://assets.cvcrm.com.br/kb/data/medias/136701/34DE73E3393B0D55D726CA1BB9AC8B61.png)

**Campos obrigatórios em "Dados da Imobiliária":**

- **Nome Fantasia:** nome fantasia da imobiliária
- **Sigla:** sigla da imobiliária
- **Razão Social:** nome jurídico
- **CNPJ:** CNPJ da empresa
- **E-mail e Telefone**
- **Microempresa:** selecione "Sim" ou "Não"

![Dados obrigatórios - parte 1](https://assets.cvcrm.com.br/kb/data/medias/136701/C4C5FFF584090C48D42294CD0B525ABB.png)

- **Estado, Cidade, Logradouro, Endereço:** localidade da imobiliária
- **CRECI:** número do CRECI
- **Validade do CRECI:** data de validade conforme a imagem do CRECI anexada
- **Alterar login do corretor:** "Sim" para permitir que a imobiliária interfira no login do corretor
- **Autocadastro Corretor:** "Sim" para exibir a imobiliária no "Cadastre-se" do Painel do Corretor
- **Ativo no painel:** se Inativo, a imobiliária ficará oculta em outras funcionalidades

![Dados obrigatórios - parte 2](https://assets.cvcrm.com.br/kb/data/medias/136701/05FDAE42FBC0583E70B74DBC95A2EED6.png)

**Campos opcionais:**

- **CNPJ para Faturamento:** documento PJ para confirmação de pagamentos
- **Celular, Inscrição estadual e municipal, CEP**

![Campos opcionais - parte 1](https://assets.cvcrm.com.br/kb/data/medias/136701/708C68155BED198D3A1D6B694D9D4BC3.png)

- **Bairro, Número, Complemento**
- **Logo:** imagem recomendada de até 60 px de altura e 120 px de largura
- **Código interno:** usado para integrações

![Campos opcionais - parte 2](https://assets.cvcrm.com.br/kb/data/medias/136701/E8047E01ED39F5627BEFCD98EB3A9745.png)

Também é possível adicionar os dados do **Gerente** e do **Diretor** (nome, CPF, telefone, celular e e-mail).

![Dados de gerente e diretor](https://assets.cvcrm.com.br/kb/data/medias/136701/1B580169DDFD42663B1A8A46FFF42E38.png)

Em **"Informações Bancárias"** você pode adicionar: tipo de conta, banco, dados da agência e conta, CNPJ e nome do favorecido.

> **Obs.:** nenhum campo de "Informações Bancárias" é obrigatório para o cadastro da imobiliária.

![Informações bancárias](https://assets.cvcrm.com.br/kb/data/medias/136701/2BD4BD5F2FF62A53550EE37316D15052.png)

Por fim, clique em **"Salvar"**.

![Salvar](https://assets.cvcrm.com.br/kb/data/medias/136701/9472FEE220E0BC44AC5785E4551F20B7.png)

## Associando um Empreendimento

Após cadastrar a imobiliária, clique em **"Opções" > "Empreendimento"** para associar um ou mais empreendimentos.

![Menu empreendimento](https://assets.cvcrm.com.br/kb/data/medias/136701/3CCDE8513B5D1E6856290EB4D19B15EE.png)

Digite o nome do empreendimento, selecione-o e clique em **"Adicionar"**.

![Adicionar empreendimento](https://assets.cvcrm.com.br/kb/data/medias/136701/7256ABA8013AC285E6BC90BD108D53CA.png)

Os empreendimentos associados ficam listados abaixo. Para remover, marque a caixa e clique em **"Remover Selecionados"**.

![Lista de empreendimentos](https://assets.cvcrm.com.br/kb/data/medias/136701/ECAA34B9B21E1BBE1F08D676261AC88C.png)

## Bloqueando o Recebimento de Pagamento de Comissão

Em **"Bloquear recebimento de pagamento de comissão"** você informa se a imobiliária receberá o pagamento da comissão.

![Bloqueio de comissão](https://assets.cvcrm.com.br/kb/data/medias/136701/E42F1C6ADB2A178BED46E2FEA562400A.png)

## Documentos de Imobiliária

Nessa área é possível adicionar documentos referentes à imobiliária. Para cadastrar um documento, selecione o tipo de arquivo (deve ser cadastrado previamente em **"Tipos de Documentos"**).

![Documentos de imobiliária](https://assets.cvcrm.com.br/kb/data/medias/136701/E35DAF22218CB04F60131E653179CCDA.png)`,
    },
{
        code: 'CV-USR-IMOB',
        slug: 'cv-usuario-imobiliaria',
        title: 'Cadastro de Usuário Gestor de Imobiliária',
        categorySlug: 'construtor-de-vendas',
        visibility: 'INTERNAL',
        body: `O **Usuário da Imobiliária** acessa o painel da imobiliária e pode gerenciar corretores, leads, pré-cadastros, simulações e reservas, visualizar unidades e gerar relatórios. Você pode definir suas permissões de visualização.

## Pré-requisito

Para cadastrar/editar um usuário de imobiliária, o seu perfil de acesso deve ter as seguintes permissões (aba **"Cadastros"**):

![Permissões necessárias](https://assets.cvcrm.com.br/kb/data/medias/155135/AB8912155FFC3B439658ED0CB2DD3937.png)

## Cadastrando um usuário da imobiliária

Pesquise por **"Usuários Imobiliárias"**.

![Buscar usuários imobiliárias](https://assets.cvcrm.com.br/kb/data/medias/155135/CC0F5A329715C980B8CF871FD8C35E9F.gif)

Clique em **"Criar novo usuário da imobiliária"**.

![Criar novo usuário](https://assets.cvcrm.com.br/kb/data/medias/155135/A376D64587FEA0F65DF55FBC09237810.png)

Os campos obrigatórios estão em negrito com asterisco.

![Tela de cadastro](https://assets.cvcrm.com.br/kb/data/medias/155135/D53AFD0A413E2FD2ED1067D0906E9BD2.png)

**Em "Dados de Acesso"**, campos obrigatórios:

- **E-mail:** utilizado para acessar o painel da imobiliária
- **Imobiliária:** selecione a imobiliária que o usuário terá acesso
- **Acesso ao funil de vendas:** indica se o usuário poderá visualizar o funil de vendas

> **Obs.:** só é possível selecionar uma imobiliária por usuário. As opções exibidas são as imobiliárias previamente cadastradas.

![Dados de acesso](https://assets.cvcrm.com.br/kb/data/medias/155135/889B0736820CB312254604BB89418CC4.png)

**Em "Gestão de Mensagem"**, defina se o usuário poderá gerir as mensagens.

![Gestão de mensagem](https://assets.cvcrm.com.br/kb/data/medias/155135/1186D5EC0E74B48494CD37C4DF346AB7.png)

Por fim, informe os dados de faturamento do usuário.

![Dados de faturamento](https://assets.cvcrm.com.br/kb/data/medias/155135/E7EBFB1DC6A50FE00A7D9487A0C09408.png)`,
    },
{
        code: 'CV-CORRETOR',
        slug: 'cv-cadastro-corretor',
        title: 'Cadastro de Corretor',
        categorySlug: 'construtor-de-vendas',
        visibility: 'INTERNAL',
        body: `O cadastro do corretor cria o usuário corretor para acesso ao sistema com suas informações pessoais e profissionais.

## Pré-requisito

Para cadastrar um corretor, o seu perfil de acesso deve ter as seguintes permissões (aba **"Cadastros"**):

![Permissões necessárias](https://assets.cvcrm.com.br/kb/data/medias/133276/B0BD7E6946056D723AA1D9120CD27437.png)

## Como Cadastrar um Corretor

Pesquise por **"Corretores"**.

![Buscar corretores](https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/157008492671/original/uce5qjRzljhoi1jJhMVQpmxFjr7fyIfP-g.gif)

Você pode cadastrar um corretor **pessoa física** ou **pessoa jurídica**.

![Opções de cadastro](https://assets.cvcrm.com.br/kb/data/medias/133276/31BB0173DBE81A5D8393DDD2AD5DDBE8.png)

**Pessoa Física - campos obrigatórios em "Dados do Corretor":** CPF, nome, gênero, nascimento e telefone.

![Campos pessoa física](https://assets.cvcrm.com.br/kb/data/medias/133276/ED2E16EAFF542EBBD00DA9FB5018BC46.png)

**Pessoa Jurídica - campos obrigatórios em "Dados do Corretor":** CNPJ, razão social, nome fantasia e data de registro.

![Campos pessoa jurídica](https://assets.cvcrm.com.br/kb/data/medias/133276/B69EF742013BCA4ECC90B421B7E52FEA.png)

No cadastro de pessoa jurídica há também a área **"Representante Legal"**, onde é obrigatório preencher telefone e telefone do representante legal.

![Representante legal](https://assets.cvcrm.com.br/kb/data/medias/133276/ACD5BE83BDDDC58E148D861A1953F9A6.png)

**Em "Dados de Endereço":** nenhum campo obrigatório.

![Dados de endereço](https://assets.cvcrm.com.br/kb/data/medias/133276/589A5ED3C6D9C2C4EB429F9C89509A2C.png)

**Em "Formação Acadêmica":** nenhum campo obrigatório (somente para pessoa física).

> **Obs.:** esse campo aparece somente no cadastro de corretor pessoa física.

![Formação acadêmica](https://assets.cvcrm.com.br/kb/data/medias/133276/03AB16F36487034E1004310CAF2B63DD.png)

**Em "Dados de Acesso":** o e-mail é obrigatório. Você também pode criar uma senha para o corretor.

![Dados de acesso](https://assets.cvcrm.com.br/kb/data/medias/133276/B02DE483C5220F0ACAE707AE83AFCE5A.png)

**Em "Configurações do Painel"**, campos obrigatórios:

- **Imobiliária:** selecione a imobiliária cadastrada previamente

> **Obs.:** não é possível vincular um mesmo corretor a mais de uma imobiliária.

- **Notificar novos Leads:** "Sim" para notificar o corretor quando chegar novos leads
- **Receber e-mail dos leads à vencer:** "Sim" para o corretor receber alertas de leads prestes a vencer

![Configurações do painel](https://assets.cvcrm.com.br/kb/data/medias/133276/521FDA6771BD92F9F30B882DB79FBA91.png)

**Configurações opcionais do painel:**

- **Categoria:** deve ser cadastrada previamente no CV (ex.: Ouro, Prata, Bronze)
- **Nível do Corretor:** deve ser cadastrado previamente
- **Participa da roleta on-line:** "Sim" para o corretor receber leads quando estiver online
- **Classificação:** deve ser cadastrada previamente (ex.: Júnior, Sênior)

![Configurações opcionais](https://assets.cvcrm.com.br/kb/data/medias/133276/855AA9954AB861B87BB28584E195A67D.png)

**Em "Gestão de Mensagem":** se Ativo, o corretor é notificado quando uma mensagem for cadastrada no pré-cadastro e/ou reserva.

![Gestão de mensagem](https://assets.cvcrm.com.br/kb/data/medias/133276/D090060698CDFA6E79796D0E5550C02B.png)

**Em "Dados de Integrações":** o campo **"Código Interno"** é usado para integrações como o Sienge.

![Dados de integrações](https://assets.cvcrm.com.br/kb/data/medias/133276/308A69D92D92ADCBF6046D9F38E4872C.png)

**Em "Referências":** nenhum campo obrigatório (não aparece no cadastro de pessoa jurídica).

![Referências](https://assets.cvcrm.com.br/kb/data/medias/133276/95A3BDBADBAC91A234707A131EEFCF46.png)

**Em "Dados Profissionais":** nenhum campo obrigatório (não aparece no cadastro de pessoa jurídica).

![Dados profissionais](https://assets.cvcrm.com.br/kb/data/medias/133276/2AA46EB7114949DFCAD4C68B3AFA65DA.png)

**Em "Por que deseja se associar à empresa?":** campo opcional (não aparece no cadastro de pessoa jurídica).

![Motivo de associação](https://assets.cvcrm.com.br/kb/data/medias/133276/5C2C8DE8547E486B8AF00E0740976214.png)

**Em "CRECI":** obrigatório informar o CRECI. Campos opcionais: tipo, situação, estado do CRECI, cidade do CRECI e vencimento.

![CRECI](https://assets.cvcrm.com.br/kb/data/medias/133276/99F28998BBFA95807BBAEAA2F7254AD0.png)

**Em "Informações Bancárias":** nenhum campo obrigatório.

![Informações bancárias](https://assets.cvcrm.com.br/kb/data/medias/133276/EF5B93385DC05E6F157A291961772786.png)

**Em "Outras informações":** se o corretor tiver CNPJ, é possível cadastrar razão social, CNPJ, inscrição municipal, CEP, endereço completo, estado e cidade.

![Outras informações](https://assets.cvcrm.com.br/kb/data/medias/133276/A3D5671B452578A1D6EBFF67BEFD6FFB.png)

**Em "Faturamento":** escolha entre tipo física e jurídica para receber faturamentos, caso não queira em nome do corretor cadastrado.

![Faturamento](https://assets.cvcrm.com.br/kb/data/medias/133276/D1D75D5A1CE7CEF443BA2D7DA4BE5907.png)

Com todos os dados preenchidos, clique em **"Salvar"**.

![Salvar](https://assets.cvcrm.com.br/kb/data/medias/133276/9833EF2DE61C2AF4EA4DD7AD09208B30.png)

## Liberando o Acesso do Corretor

Após o cadastro, libere o acesso do corretor ao Painel do Corretor. Clique em **"Opções" > "Ativar/Desativar Login"**.

![Ativar/Desativar Login](https://assets.cvcrm.com.br/kb/data/medias/133276/940459A7FFBFE60547C0A731237B66B0.gif)

Todo novo corretor cadastrado tem login como **"Login Desativado"**.

![Login desativado](https://assets.cvcrm.com.br/kb/data/medias/133276/300E63CFD475569452D794F9A978033F.png)

Para liberar o acesso, clique no botão **"Login Ativado"**.

![Ativar login](https://assets.cvcrm.com.br/kb/data/medias/133276/F27F6FA6088AFB3FDD4D4EF67B83B730.gif)

> **Obs.:** para que o corretor receba os e-mails do CV, é necessário que ele acesse o link de ativação da conta enviado por e-mail após o cadastro.`,
    },
{
        code: 'CV-VINC-IMOB-EMP',
        slug: 'cv-vincular-imobiliaria-empreendimento',
        title: 'Vinculando uma Imobiliária a um Empreendimento',
        categorySlug: 'construtor-de-vendas',
        visibility: 'INTERNAL',
        body: `No empreendimento você pode vincular uma ou mais imobiliárias, definindo quem pode ou não visualizar determinado empreendimento.

> **Obs.:** se nenhuma imobiliária for vinculada, todas as imobiliárias cadastradas poderão visualizar o empreendimento.

## Pré-requisitos

Para vincular uma imobiliária a um empreendimento, o seu perfil de acesso deve ter as seguintes permissões (aba **"Comercial" > "Empreendimentos"**):

![Permissões necessárias](https://assets.cvcrm.com.br/kb/data/medias/136705/C6BAB75895FA69781B8D3AE573328074.png)

## Passo a passo

**1.** No menu **"Cadastros" > "Empreendimentos"**, clique em **"Administrar"** do empreendimento desejado.

![Administrar empreendimento](https://assets.cvcrm.com.br/kb/data/medias/136705/0AC764536A0B521FB93CAF360D13C2B7.png)

**2.** Clique no menu lateral **"Corretores e Imobiliárias"**.

![Menu Corretores e Imobiliárias](https://assets.cvcrm.com.br/kb/data/medias/136705/A55E576519993FB59F59AC41D627062B.png)

**3.** Selecione a(s) imobiliária(s) desejada(s) e clique em **"Adicionar"**.

![Adicionar imobiliária](https://assets.cvcrm.com.br/kb/data/medias/136705/82F4763B68C48CAEAF267FCAC871FD80.png)

**4.** As imobiliárias vinculadas ficam listadas abaixo. Para remover, marque a caixa e clique em **"Remover selecionados"**.

![Lista de imobiliárias vinculadas](https://assets.cvcrm.com.br/kb/data/medias/136705/415413A61352367ECD2F0BFA139AEED6.png)

**5.** Se a imobiliária for de coordenação, marque o círculo na coluna **"Coordenação"**.

![Coordenação](https://assets.cvcrm.com.br/kb/data/medias/136705/214B25F99EB42D769027697354D88E24.png)`,
    },
{
        code: 'CV-VINC-COR-EMP',
        slug: 'cv-vincular-corretor-empreendimento',
        title: 'Vinculando um Corretor a um Empreendimento',
        categorySlug: 'construtor-de-vendas',
        visibility: 'INTERNAL',
        body: `No empreendimento você pode vincular um ou mais corretores, definindo quem pode ou não visualizar determinado empreendimento.

> **Obs.:** se nenhum corretor for vinculado, todos os corretores cadastrados poderão visualizar o empreendimento.

## Pré-requisitos

Para vincular um corretor a um empreendimento, o seu perfil de acesso deve ter as seguintes permissões (aba **"Comercial" > "Empreendimentos"**):

![Permissões necessárias](https://assets.cvcrm.com.br/kb/data/medias/348225/5566DC18AE35F8A7111C202743E9420F.png)

## Passo a passo

**1.** No menu **"Cadastros" > "Empreendimentos"**, clique em **"Administrar"** do empreendimento desejado.

![Administrar empreendimento](https://assets.cvcrm.com.br/kb/data/medias/348225/0AC764536A0B521FB93CAF360D13C2B7.png)

**2.** Clique no menu lateral **"Corretores e Imobiliárias"**.

![Menu Corretores e Imobiliárias](https://assets.cvcrm.com.br/kb/data/medias/348225/A55E576519993FB59F59AC41D627062B.png)

**3.** Selecione o(s) corretor(es) desejado(s) e clique em **"Adicionar"**.

![Adicionar corretor](https://assets.cvcrm.com.br/kb/data/medias/348225/13169D19120577BF49974FDB82882F58.png)

**4.** Os corretores vinculados ficam listados abaixo. Para remover, clique no **"X"** e confirme.

![Lista de corretores vinculados](https://assets.cvcrm.com.br/kb/data/medias/348225/98519405DA63FD7625CF7F6E34FC54B0.png)`,
    },
{
        code: 'CV-CAMPOS-OBR',
        slug: 'cv-campos-obrigatorios-reservas',
        title: 'Campos de Cadastro Obrigatório nas Reservas e Pré-cadastros',
        categorySlug: 'construtor-de-vendas',
        visibility: 'INTERNAL',
        body: `O CV permite definir, por empreendimento, quais campos de cadastro serão obrigatórios nas **reservas e pré-cadastros**. Assim, sua empresa pode exigir determinados dados em empreendimentos específicos, tornando a coleta mais assertiva.

## Como Definir os Campos Obrigatórios

Acesse o menu **"Empreendimentos"**, localize o empreendimento e clique em **"Administrar"**.

![Administrar empreendimento](https://assets.cvcrm.com.br/kb/data/medias/280965/43FD5FEF76450283F69098FBDBA437AE.gif)

Clique no menu lateral **"Reservas e Simulações"**.

![Menu Reservas e Simulações](https://assets.cvcrm.com.br/kb/data/medias/280965/6D156BEDA8D50A2BD4BCFBC4B886B209.png)

Clique na aba **"Campos obrigatórios"**.

![Aba Campos obrigatórios](https://assets.cvcrm.com.br/kb/data/medias/280965/AC2DF1AEF7E6616ABEE44FB9A0B46621.png)

Selecione o tipo de formulário (CPF ou CNPJ) e clique em **"Buscar"**.

![Selecionar tipo de formulário](https://assets.cvcrm.com.br/kb/data/medias/280965/9AE332F9AE238DE99BE1F0E76BC6516D.png)

Os campos são divididos em 2 colunas:

- **Reserva e pré-cadastro:** controla os campos obrigatórios das reservas e pré-cadastros feitos pelos painéis do gestor, corretor e imobiliária.

![Coluna reserva e pré-cadastro](https://assets.cvcrm.com.br/kb/data/medias/280965/24AB4B66A3FD6FAAEB6835219DFA4D14.png)

- **Reserva e pré-cadastro (módulo do cliente):** controla os campos obrigatórios feitos pelo próprio cliente através do painel de cadastro.

![Coluna módulo do cliente - parte 1](https://assets.cvcrm.com.br/kb/data/medias/280965/3AE4429728EBE1BB2D024F6BDDBFB8C6.png)

![Coluna módulo do cliente - parte 2](https://assets.cvcrm.com.br/kb/data/medias/280965/ED155A5178261CC06A6EDC8A94569E17.png)

Cada coluna tem subcolunas que definem se o campo será **obrigatório** ou deve ser **retirado** do cadastro. Por exemplo, para tornar "País de origem" obrigatório na reserva (painéis do gestor/corretor/imobiliária) e removê-lo do pré-cadastro e do módulo do cliente:

![Exemplo de configuração](https://assets.cvcrm.com.br/kb/data/medias/280965/33C0909C26EEE4369FE7BE52772DC846.gif)

Se um campo não precisar ser obrigatório mas ainda dever aparecer, basta não marcar as colunas **"Obrigatório"** e **"Retirar"** - o campo continuará exibido com preenchimento opcional.`,
    },

    // ═══════════════════════════ CATEGORIA: PROCEDIMENTOS ═══════════════════════════
    // POPs (Procedimentos Operacionais) importados de PDF/Word. Criados como
    // rascunho (status: 'DRAFT') para validação e publicação manual pela equipe.
    // Visibilidade INTERNAL. Subcategorias temáticas (fluxo-de-repasse, reservas,
    // contratos, cartorio, financeiro). NÃO entram no LINK_TARGETS enquanto forem
    // rascunho (evita link "morto" a partir de artigos publicados); ligar quando publicar.

    // ── Fluxo de Repasse (4 etapas) ──
    {
        code: 'REPASSE-CONTRATACAO',
        slug: 'fluxo-repasse-contratacao',
        title: 'Fluxo de Repasse - Contratação (MCMV)',
        categorySlug: 'procedimentos',
        subcategorySlug: 'fluxo-de-repasse',
        authorUserId: 1, // Gustavo Diniz
        status: 'DRAFT',
        audiences: ['INTERNAL'],
        aliases: ['Fluxo de Repasse Contratação', 'Repasse Contratação', 'Contratação MCMV'],
        body: `# Fluxo de Repasse - Contratação (MCMV)

> **Construtor de Vendas** · Fluxo de Repasse (MCMV)
> **Parte 1 de 3** · Próxima etapa: [Aprovação](/academy/kb/procedimentos/fluxo-repasse-aprovacao)

O **workflow de Repasse** define as etapas e processos necessários para a conclusão dos contratos dentro do **CV CRM** da construtora. Cada etapa possui atribuições específicas para garantir a conformidade e a eficiência do trâmite. Este documento descreve a etapa de **Contratação**.

## Etapas do fluxo (Contratação)

**Em Espera**
O processo se inicia após a assinatura dos contratos da Menin, gerando um Repasse na etapa "Em Espera".

**Abertura SIOPI**
Informar no sistema a "Abertura do SIOPI".

**Ressarcimento FGTS**
Informar no sistema que o processo está em "Ressarcimento FGTS".

**Assinatura de Formulários**
Cliente e responsáveis assinam os documentos necessários para formalizar o processo.

**Enviado CEHOP**
Informar no sistema que o processo está em "Enviado CEHOP". Possível retorno com "Inconforme CEHOP" (reajustar e enviar novamente).

**Conforme CEHOP**
Informar no sistema que o processo está em "Conforme CEHOP". Caso já disponível, anexar a "Carta Proposta" na aba de Documentos do Repasse.

**Contratação CAIXA**
Informar no sistema que o processo está em "Contratação CAIXA".

**Entrevista Comercial CAIXA**
Informar no sistema que o processo está em "Entrevista Comercial CAIXA".

**Contrato Emitido CAIXA**
Informar no sistema que o processo está em "Contrato Emitido CAIXA". Anexar o **Contrato Caixa (CEF)** na aba de Documentos do CV, com o tipo **"CONTRATO CEF"**. Passar para a próxima etapa após anexar.

## Possíveis interrupções

- **Cancelamento** - o processo pode ser cancelado em qualquer etapa anterior à assinatura, caso não seja possível seguir com o Repasse.
- **Distrato** - formalização do cancelamento do contrato por ambas as partes.
- **Cessão** - transferência do contrato para um novo titular.

## Considerações finais

O fluxo de Repasse deve ser seguido conforme definido para garantir o pleno funcionamento; todo o processo é monitorado e historiado. É responsabilidade da construtora garantir o suporte e os ajustes técnicos necessários - em caso de problemas, erros ou ajustes no sistema, informar o suporte imediatamente. Cabe aos usuários, gestores e correspondentes, seguir as etapas e executar todos os passos (informativos ou de envio de documentos) para a sequência correta do fluxo.

---

**Dúvidas:** Gustavo Diniz - gustavo.diniz@menin.com.br`,
    },
    {
        code: 'REPASSE-APROVACAO',
        slug: 'fluxo-repasse-aprovacao',
        title: 'Fluxo de Repasse - Aprovação (MCMV)',
        categorySlug: 'procedimentos',
        subcategorySlug: 'fluxo-de-repasse',
        authorUserId: 1,
        status: 'DRAFT',
        audiences: ['INTERNAL'],
        aliases: ['Fluxo de Repasse Aprovação', 'Repasse Aprovação', 'Aprovação MCMV'],
        body: `# Fluxo de Repasse - Aprovação (MCMV)

> **Construtor de Vendas** · Fluxo de Repasse (MCMV)
> **Parte 2 de 3** · Etapa anterior: [Contratação](/academy/kb/procedimentos/fluxo-repasse-contratacao) · Próxima: [Cartório](/academy/kb/procedimentos/fluxo-repasse-cartorio)

Continuação do **workflow de Repasse** no **CV CRM**, a partir de "Contrato Emitido CAIXA". Este documento descreve a etapa de **Aprovação**.

## Etapas do fluxo (Aprovação)

**Aguardando Contrato Construtora**
Ao passar para esta etapa, o gerente responsável pelo empreendimento gera os documentos necessários (**Confissão de Dívida**) e os anexa na aba de Documentos do Repasse. Após finalizar, passar para a próxima etapa.

**Análise Contratos**
A construtora visualiza os documentos anexados - **Confissão de Dívida** e **Contrato CEF**. Em caso de erro em algum deles, retorno para "Inconforme Contrato" ou "Inconforme Confissão". Em caso de aprovação, passar para a próxima etapa.

> 🔎 É nesta etapa que atua a análise automática - veja o procedimento [Validador de Contratos](/academy/kb/procedimentos/validador-de-contratos).

**Autorizado Envio Assinatura**
As permissões voltam ao correspondente e os contratos anexados estão aptos para envio - já é possível enviar para assinatura digital ou coletar a assinatura. Após enviar, passar para a próxima etapa.

**Enviado Assinatura**
Informar no sistema que foi "Enviado assinatura". Quando assinados por todas as partes, anexar os contratos **"Confissão de Dívida"** e **"Contrato CEF" ASSINADOS** na aba de Documentos do Repasse, com os tipos **"CONTRATO CEF - ASSINADO"** e **"CONFISSÃO DE DÍVIDA - ASSINADO"** (em casos sem confissão, anexar documento em branco). Esses anexos são **obrigatórios** para seguir. Após, passar para a próxima etapa.

**Contratos Assinados MCMV**
Cabe à construtora coletar as informações do Repasse para seguir com o processo de **Faturamento**. Após finalizar, passar para a próxima etapa.

**Faturado SIENGE MCMV**
Informativo de que o contrato já seguiu para Faturamento e está liberado para prosseguir nas etapas de **Cartório**.

## Possíveis interrupções

- **Cancelamento** - em qualquer etapa anterior à assinatura.
- **Distrato** - formalização do cancelamento por ambas as partes.
- **Cessão** - transferência do contrato para um novo titular.

## Considerações finais

O fluxo de Repasse deve ser seguido conforme definido; todo o processo é monitorado e historiado. Em caso de problemas, erros ou ajustes no sistema, informar o suporte imediatamente. Cabe aos gestores e correspondentes seguir as etapas e executar todos os passos para a sequência correta do fluxo.

---

**Dúvidas:** Gustavo Diniz - gustavo.diniz@menin.com.br`,
    },
    {
        code: 'REPASSE-CARTORIO',
        slug: 'fluxo-repasse-cartorio',
        title: 'Fluxo de Repasse - Cartório (MCMV)',
        categorySlug: 'procedimentos',
        subcategorySlug: 'fluxo-de-repasse',
        authorUserId: 1,
        status: 'DRAFT',
        audiences: ['INTERNAL'],
        aliases: ['Fluxo de Repasse Cartório', 'Repasse Cartório', 'Cartório MCMV'],
        body: `# Fluxo de Repasse - Cartório (MCMV)

> **Construtor de Vendas** · Fluxo de Repasse (MCMV)
> **Parte 3 de 3** · Etapa anterior: [Aprovação](/academy/kb/procedimentos/fluxo-repasse-aprovacao)

Etapa final do **workflow de Repasse** no **CV CRM**, a partir de "Faturado SIENGE MCMV". Este documento descreve a etapa de **Cartório**.

> 📌 Para o detalhamento do registro (RI Digital, ITBI, saldo do empreendimento), veja o procedimento [Registro de Contratos](/academy/kb/comercial/registro-de-contratos-empreendimentos-mcmv).

## Etapas do fluxo (Cartório)

**ITBI**
Cálculo e pagamento do imposto necessário.

**Preparação para Envio Cartório**
Conferência final da documentação e preparação do envio ao cartório para registro.

**Entrada Cartório RI**
Documentação enviada ao cartório para registro oficial.

**Devolução**
Etapa utilizada para devoluções e ajustes do cartório. Após a correção, retornar para "Entrada Cartório RI".

**Contrato Registrado**
Finalização do registro no cartório.

**Envio para Conformidade CEHOP**
Validação final de conformidade.

**Inconforme CEHOP**
Etapa para ajustes da inconformidade. Após a correção, retornar para "Envio para Conformidade CEHOP".

**Conforme Contrato CEHOP**
Retorno CONFORME do CEHOP.

**Finalizado**
Após a entrega da garantia na Caixa e a finalização de TODO o fluxo de registro, finalizar o processo de Repasse do cliente nesta última etapa.

## Possíveis interrupções

- **Distrato** - formalização do cancelamento por ambas as partes.
- **Cessão** - transferência do contrato para um novo titular.

## Considerações finais

O fluxo de Repasse deve ser seguido conforme definido; todo o processo é monitorado e historiado. Em caso de problemas, erros ou ajustes no sistema, informar o suporte imediatamente. Cabe aos gestores e correspondentes seguir as etapas e executar todos os passos para a sequência correta do fluxo.

---

**Dúvidas:** Gustavo Diniz - gustavo.diniz@menin.com.br`,
    },
    {
        code: 'REPASSE-SBPE',
        slug: 'fluxo-repasse-sbpe',
        title: 'Fluxo de Repasse - SBPE',
        categorySlug: 'procedimentos',
        subcategorySlug: 'fluxo-de-repasse',
        authorUserId: 1,
        status: 'DRAFT',
        audiences: ['INTERNAL'],
        aliases: ['Fluxo de Repasse SBPE', 'Repasse SBPE', 'SBPE'],
        body: `# Fluxo de Repasse - SBPE

> **Construtor de Vendas** · Fluxo de Repasse (SBPE)

Fluxo de Repasse para contratos **SBPE** (Sistema Brasileiro de Poupança e Empréstimo) no **CV CRM** - distinto do fluxo MCMV. Cada etapa possui atribuições específicas para garantir a conformidade e a eficiência do trâmite.

## Etapas do fluxo (SBPE)

**Em Espera**
O processo se inicia após a assinatura do **Contrato de Compra e Venda** da Menin, gerando um Repasse na etapa "Em Espera". O gerente responsável pelo empreendimento deve anexar o **Contrato de Compra e Venda ASSINADO** do cliente na aba de Documentos, com o tipo **"CONTRATO SBPE"**. Após anexar, seguir para a próxima etapa.

**Contrato Assinado SBPE**
Cabe à construtora fazer o **faturamento** do cliente. Após o faturamento, passar para a próxima etapa.

**Finalizado**
Etapa que informa a finalização do processo de Repasse.

## Possíveis interrupções

- **Cancelamento** - em qualquer etapa anterior à assinatura, caso não seja possível seguir com o Repasse.
- **Distrato** - formalização do cancelamento por ambas as partes.
- **Cessão** - transferência do contrato para um novo titular.

## Considerações finais

O fluxo de Repasse deve ser seguido conforme definido; todo o processo é monitorado e historiado. Em caso de problemas, erros ou ajustes no sistema, informar o suporte imediatamente. Cabe aos gestores e correspondentes seguir as etapas e executar todos os passos para a sequência correta do fluxo.

---

**Dúvidas:** Gustavo Diniz - gustavo.diniz@menin.com.br`,
    },

    // ── Contratos ──
    {
        code: 'CONF01',
        slug: 'confissao-de-divida',
        title: 'Geração de Contratos de Confissão de Dívida',
        categorySlug: 'procedimentos',
        subcategorySlug: 'contratos',
        authorUserId: 1,
        status: 'DRAFT',
        audiences: ['INTERNAL'],
        aliases: ['CONF01', 'Confissão de Dívida', 'Geração de Contratos de Confissão de Dívida'],
        body: `# Geração de Contratos de Confissão de Dívida

> **Procedimento Operacional - Departamento Comercial**
> **Código:** CONF01 · **Revisão:** 02

**Objetivo:** estabelecer as diretrizes e responsabilidades para a geração, assinatura e certificação dos contratos de **Confissão de Dívida** vinculados ao **Programa Minha Casa Minha Vida (MCMV)**, assegurando conformidade com os contratos firmados com a **Caixa Econômica Federal**.

## 1. Responsável

O **gestor do empreendimento** é o responsável direto por:

- Gerar o contrato de confissão de dívida;
- Garantir que todas as informações estejam **corretas e compatíveis** com o **Contrato Caixa (CEF)**;
- Anexar a confissão de dívida no sistema **CV CRM** para conferência interna;
- Coletar as assinaturas de **TODOS os envolvidos** (associados, cônjuges e sócios);
- Garantir a **Certificação Digital** válida de todas as assinaturas;
- Vincular os documentos pós-assinatura, na etapa de **Repasse** no CV CRM, utilizando os tipos de documento **"Contrato CEF - ASSINADO"** e **"Confissão de Dívida - ASSINADO"**, autorizando-os e deixando na situação **"CONTRATOS ASSINADOS MCMV"**.

## 2. Regras gerais para a Confissão de Dívida

**Assinaturas e certificação**

- Todos os clientes e associados mencionados no **Contrato Caixa (CEF)** devem assinar o documento.
- Sócios, associados, cônjuges, fiadores - **quaisquer pessoas citadas** na confissão de dívida - devem assinar.
- A única certificação aceita é a do padrão **ICP-Brasil**, utilizando o **Certificado Digital** de cada assinante.
- Assinaturas físicas, ou com certificações como "GOV" ou outras, **não serão aceitas** (salvo exceções).

## 3. Requisitos de validação dos contratos

### 3.1 Da ordem de assinatura

- A **Confissão de Dívida** deve ser assinada **ANTERIORMENTE** em relação ao **Contrato Caixa (CEF)**.

### 3.2 Envio e validade contratual

- **NENHUM** contrato com a Caixa será considerado válido sem a **Confissão de Dívida** em anexo.

### 3.3 Coerência das informações

A confissão de dívida deve **refletir fielmente** as informações presentes no Contrato Caixa (CEF):

| Item | Regra |
| --- | --- |
| **Data de assinatura** | Deve ser a mesma no Contrato da Caixa e na confissão de dívida. |
| **Valor de venda** (B.4 no Contrato CEF) | Deve ser igual ao valor de venda do imóvel, mesmo que a avaliação divirja. |
| **Descontos Construtora** | São descritos somente na confissão de dívida; são retirados do valor da cláusula B.4.2 no Contrato CEF. |
| **Recursos próprios** (à vista ou parcelado) | Os valores somados - recurso à vista, parcelado e Desconto Construtora - devem bater **exatamente** com os descritos no B.4.2 do Contrato da Caixa. |
| **Subsídio** Estadual, Federal e FGTS | Todos os valores devem estar **rigorosamente iguais** nos dois documentos. |

## 4. Observações importantes

- **Diferenças de centavos**, divergência de datas ou assinatura inválida podem comprometer a formalização do contrato junto à Caixa, podendo gerar atrasos e retrabalho.
- Em casos em que o cliente teve recorrência de cobrança da entrada **antes** da assinatura do Contrato Caixa, é preciso solicitar ao setor de **Contas a Receber** o **extrato do cliente**, lançar a soma dos valores pagos e a data do último pagamento no campo **"Recurso Próprio à Vista"** no CV, informando que o valor já pago foi uma **"entrada"**, e recalculando o parcelamento restante.
- Recomenda-se realizar **validação dupla** dos dados antes do envio para conferência interna.
- Após a assinatura, caso seja encontrada divergência entre os contratos, é de responsabilidade do gestor **gerar um novo contrato** e garantir a assinatura do cliente o mais rápido possível - sendo aceitas correções **somente dentro do mês da assinatura**.

## 5. Conclusão

A correta emissão, assinatura e envio da confissão de dívida é fundamental para garantir a formalização da venda. O não cumprimento deste procedimento pode gerar **riscos jurídicos e comerciais** para o empreendimento.

---

**Dúvidas:** Departamento Comercial - comercial@menin.com.br`,
    },
    {
        code: 'VALC01',
        slug: 'validador-de-contratos',
        title: 'Validador de Contratos (Validação Automática)',
        categorySlug: 'procedimentos',
        subcategorySlug: 'contratos',
        authorUserId: 1,
        status: 'DRAFT',
        audiences: ['INTERNAL'],
        aliases: ['VALC01', 'Validador de Contratos', 'Validação Automática de Contratos'],
        body: `# Validador de Contratos (Validação Automática)

> **Procedimento Operacional - Departamento Comercial**
> **Código:** VALC01 · **Revisão:** 01

Este procedimento aplica-se a todos os contratos de **Confissão de Dívida** e **Contrato Caixa (CEF)**, e deve ser realizado **antes do processo de assinatura**.

> O **gestor do empreendimento** é o responsável final por garantir o cumprimento de todo o procedimento descrito.

## 1. Objetivo

Estabelecer o procedimento para utilização do **sistema validador integrado ao CV CRM**, destinado à análise automática dos contratos dos clientes na etapa de **Repasse** - posterior à emissão do contrato e anterior à assinatura.

## 2. Abrangência

Aplica-se a todos os contratos **MCMV** em que o cliente se encontra na etapa de Repasse, especificamente na fase **"Geração Contratos Construtora"**.

## 3. Procedimentos

### 3.1 Emissão e anexação dos documentos necessários

- O **CCA** é responsável por anexar o **Contrato Caixa** do cliente nos documentos do Repasse.
- Com base no Contrato Caixa, gerar o **termo de confissão de dívida** na etapa de contratos da reserva.
- Anexar o Contrato Caixa nos documentos da reserva, com o tipo definido como **"Contrato CEF"**.
- Anexar o termo de confissão de dívida nos documentos da reserva, com o tipo definido como **"Confissão de Dívida"**.
- Os documentos para validação devem sempre estar com o campo **"Pessoa"** definido como **"Titular"**.

> 📸 **Espaço para print** - exemplo de como os documentos devem ficar anexados (insira a imagem ao editar o artigo).

### 3.2 Envio para análise automatizada

- Após anexar ambos os documentos, alterar o Repasse para a etapa **"Análise Contratos"**.
- O sistema de automação realiza varreduras **a cada 15 minutos**, verificando se os documentos necessários foram anexados corretamente.
- Estando os documentos presentes, o sistema os envia automaticamente para o **validador de contratos com IA**.

### 3.3 Resultado da análise

- **Aprovado:** o Repasse segue automaticamente para **"Autorizado Envio Assinatura"**.
- **Reprovado:** o Repasse segue automaticamente para **"Reprovada Automação"**.
- Em ambos os casos, o campo de **mensagens** traz a descrição detalhada do resultado da análise.

## 4. Responsabilidades

- Os gestores dos empreendimentos são responsáveis por garantir que a **minuta** e o **termo de confissão de dívida** sejam corretamente gerados e anexados no CV CRM antes do envio para análise.
- O gestor deve acompanhar as mensagens geradas pelo sistema, garantindo os ajustes necessários em caso de reprovação.

## 5. Observações importantes

- O correto preenchimento e anexação dos documentos é **essencial** para que a automação funcione adequadamente.
- Qualquer divergência ou ausência de documentos **impedirá o andamento** do processo, trazendo também uma mensagem de erro no Repasse.
- Dúvidas devem ser direcionadas ao setor comercial responsável.
- Em caso de falhas no funcionamento, reportar diretamente ao setor comercial responsável.

---

**Autor e responsável:** Gustavo Diniz (Comercial) - gustavo.diniz@menin.com.br`,
    },

    // ── Reservas ──
    {
        code: 'SIER01',
        slug: 'envio-de-reservas-ao-sienge',
        title: 'Envio das Reservas ao Sienge',
        categorySlug: 'construtor-de-vendas', // movido: Construtor de Vendas › Reservas
        subcategorySlug: 'reservas',
        authorUserId: 1,
        status: 'DRAFT',
        audiences: ['INTERNAL'],
        aliases: ['SIER01', 'Envio de Reservas ao Sienge', 'Envio Sienge', 'Integração Sienge'],
        body: `# Envio das Reservas ao Sienge

> **Procedimento Operacional - Departamento Comercial**
> **Código:** SIER01 · **Revisão:** 01

Este procedimento aplica-se a **todos os contratos que assinaram o contrato de "Reserva"** na compra e venda, com foco em garantir o funcionamento e o recebimento correto das informações na integração entre o **CV CRM** e o **Sienge**.

> O **gestor da operação** é o responsável final por garantir o cumprimento de todo o procedimento descrito.

## 1. Identificação de erros de integração

- Por padrão, toda reserva no **CV CRM**, após a assinatura por todas as partes, é alterada para a etapa **"Envio Sienge"** e tem o módulo de **Repasse** do cliente criado.
- Alguns erros na integração entre o CV CRM e o Sienge podem causar a falha do envio. Os mais comuns são:
  - **Unidade não disponível**;
  - **Profissão não existente** na base de dados;
  - **Número de telefone** fora do padrão utilizado.
- Para diferenciar um erro de uma reserva funcional, acesse a **Listagem** no campo de **Reservas** no CV CRM. Somente as reservas na etapa **"Envio Sienge"** podem apresentar esse erro, caracterizado pelo **triângulo com a exclamação**.
- Ao abrir a reserva, o erro é informado logo na página inicial.

> 📸 **Espaço para print** - capture a listagem de reservas destacando o ícone de erro e a tela da reserva com a mensagem (insira a imagem ao editar o artigo).

## 2. Responsabilidades

É responsabilidade do **gestor** garantir:

- O **ajuste do problema** descrito na reserva e a habilitação do reenvio pelo botão **"HABILITAR REENVIO"**;
- Em caso de erros complexos ou desconhecimento da informação solicitada, o **setor comercial interno** fica à disposição para auxiliar no ajuste.

## 3. Observações importantes

- O ajuste da reserva deve ser feito **antes da assinatura do Contrato Caixa (CEF)** pelo cliente, pois é necessário ter a informação correta dentro do Sienge para seguir as etapas de faturamento internas.

---

**Dúvidas:** Departamento Comercial - comercial@menin.com.br`,
    },
    {
        code: 'CCC01',
        slug: 'cancelamento-de-reservas-pre-assinatura-caixa',
        title: 'Cancelamento de Reservas (Pré-assinatura Caixa)',
        categorySlug: 'construtor-de-vendas', // movido: Construtor de Vendas › Reservas
        subcategorySlug: 'reservas',
        authorUserId: 1,
        status: 'DRAFT',
        audiences: ['INTERNAL'],
        aliases: ['CCC01', 'Cancelamento de Reservas', 'Cancelamento de Contratos', 'Distrato Pré-assinatura'],
        body: `# Cancelamento de Reservas (Pré-assinatura Caixa)

> **Procedimento Operacional - Departamento Comercial**
> **Código:** CCC01 · **Revisão:** 01

Este procedimento aplica-se a todos os contratos que ainda se encontram **antes da etapa "Contratos Assinados MCMV"**, no módulo **Repasse** do **CV CRM**, e que por qualquer motivo venham a ser **cancelados, distratados ou desistidos antes da assinatura do contrato com a Caixa**.

> O **gestor da operação** é o responsável final por garantir o cumprimento de todo o procedimento descrito.

## 1. Identificação do cancelamento

Quando um cliente manifestar intenção de cancelar, distratar ou desistir da compra da unidade:

- Verifique se a reserva se encontra **antes da etapa "Contratos Assinados MCMV"**, no módulo Repasse do CV CRM;
- Confirme que **ainda não houve assinatura** do contrato com a Caixa Econômica Federal.

## 2. Atualização no CV CRM

- Acesse o módulo **Reservas** no CV CRM;
- Localize a reserva correspondente ao cliente;
- Altere a etapa da reserva para **"Cancelado"**, conforme o fluxo padrão do sistema.

> Os demais módulos são cancelados em conjunto: **Lead**, **Pré-cadastro**, **Reserva** e **Repasse**.

## 3. Comunicação formal

Após realizar o cancelamento no CV CRM, envie um e-mail com as informações:

- **Para:** isabela.scorsato@menin.com.br
- **Com cópia (Cc):** gustavo.diniz@menin.com.br
- **Conteúdo:** nome, documento, empreendimento, unidade e motivo da desistência.

> Em casos em que o cliente já tenha pago algum valor de **entrada** para a construtora, é necessária uma **carta de próprio punho** do cliente solicitando a desistência.

## 4. Responsabilidades

É responsabilidade do gestor garantir:

- O correto cancelamento no sistema CV CRM;
- O envio do e-mail de notificação à equipe responsável pela atualização no **Sienge**.

## 5. Observações importantes

- **Não** realizar este procedimento para contratos **já assinados** com a Caixa (etapas posteriores a "Contratos Assinados MCMV").
- Em casos em que o cliente já tenha assinado o Contrato Caixa (CEF), utilize o procedimento de cancelamento relacionado a essa situação - procure a **equipe comercial interna** para mais detalhes.
- A solicitação do cancelamento deve ser feita **imediatamente** após a confirmação do pedido pelo cliente.
- O cancelamento dentro do **Sienge** deve ser efetuado em até **2 dias úteis**, para que não haja problema na integração entre o CV CRM e o Sienge.

---

**Dúvidas:** Departamento Comercial - comercial@menin.com.br`,
    },

    // ── Financeiro ──
    {
        code: 'COM01',
        slug: 'pagamento-de-comissao-mcmv',
        title: 'Pagamento de Comissão - Empreendimentos MCMV',
        categorySlug: 'procedimentos',
        subcategorySlug: 'financeiro',
        authorUserId: 1,
        status: 'DRAFT',
        audiences: ['INTERNAL'],
        aliases: ['COM01', 'Pagamento de Comissão', 'Comissão MCMV'],
        body: `# Pagamento de Comissão - Empreendimentos MCMV

> **Procedimento Operacional - Departamento Comercial**
> **Código:** COM01 · **Revisão:** 03

**Objetivo:** padronizar a emissão da nota fiscal e do boleto e o pagamento da comissão dos prestadores nos empreendimentos do **Programa Minha Casa Minha Vida (MCMV)**.

## 1. Regras para emissão da nota fiscal

- **Condição para emissão:** a nota fiscal deve ser emitida somente após a confirmação da **assinatura do Contrato Caixa (CEF)** e a validação pelo departamento de **Contas a Receber** da Menin Engenharia.
- O contrato deve estar na etapa **"Faturado Sienge MCMV"** ou posterior, no ERP **Construtor de Vendas (CV CRM)**, na aba de **Repasse**.
- A nota fiscal deve ser emitida somente após a **autorização do Gestor** responsável pelo empreendimento.
- **Período para emissão:** do **dia 01 ao dia 20** de cada mês.
  > Exemplo: se a assinatura do Contrato Caixa (CEF) ocorrer no dia 21, a emissão da nota fiscal deve ser feita no dia 01 do mês seguinte.
- A nota fiscal deve conter:
  - Nome do empreendimento;
  - Unidade vendida;
  - Nome do cliente;
  - CPF do cliente.

## 2. Regras para emissão do boleto

- **Período de vencimento:** no mínimo **28 dias corridos** contando da data de envio ao Financeiro.

## 3. Dos responsáveis

- É responsabilidade do **Gestor** de cada empreendimento gerenciar e solicitar a emissão da NF e do boleto para pagamento da comissão.
- O Gestor é responsável por **coletar, validar e encaminhar** as informações ao departamento de Contas a Receber da Menin Engenharia.
- Caso seja a **primeira comissão** paga ao prestador, enviar em anexo o **cartão CNPJ** da empresa em questão.

## 4. Pagamento

- O pagamento será realizado em até **28 (vinte e oito) dias corridos** após o recebimento da nota fiscal pelo departamento de Contas a Receber da Menin Engenharia.
- O pagamento será feito via **boleto bancário**, que deve estar emitido no **mesmo nome e razão social** da nota fiscal.

## 5. Envio da documentação

- O Gestor responsável deverá enviar a **nota fiscal e o boleto** para o e-mail **isabela.scorsato@menin.com.br** até o **dia 20** de cada mês.

---

**Dúvidas:** Departamento Comercial - comercial@menin.com.br`,
    },
    {
        code: 'DOCP01',
        slug: 'documentacao-e-parcelamento',
        title: 'Documentação e Parcelamento',
        categorySlug: 'procedimentos',
        subcategorySlug: 'financeiro',
        authorUserId: 1,
        status: 'DRAFT',
        audiences: ['INTERNAL'],
        aliases: ['DOCP01', 'Documentação e Parcelamento', 'Parcelamento da Documentação'],
        body: `# Documentação e Parcelamento

> **Procedimento Operacional - Departamento Comercial**
> **Código:** DOCP01 · **Revisão:** 01

Este procedimento aplica-se a todos os contratos em que a construtora **não garante** o pagamento da documentação por campanha, e o cliente precisa **parcelar** o valor junto do seu **recurso próprio** no termo de confissão de dívida.

> O **gestor do empreendimento** é o responsável final por garantir o cumprimento de todo o procedimento descrito.

## 1. Objetivo

Estabelecer o padrão para a criação da documentação no **CV CRM**, contemplando os casos em que a documentação seja paga pela construtora, paga à vista pelo cliente ou parcelada pela construtora.

## 2. Abrangência

Aplica-se a todos os contratos registrados no CV CRM que demandem **registro da documentação** vinculada à unidade adquirida.

## 3. Procedimentos

### 3.1 Documentação paga pela construtora (campanha)

- **Nenhum lançamento adicional** deve ser feito no financeiro do cliente.
- A construtora assume integralmente o custo.

### 3.2 Documentação paga à vista pelo cliente

- A documentação será paga **diretamente entre o cliente e a instituição financeira**, sem necessidade de intermédio da construtora ou descrição dos valores em contrato.

### 3.3 Documentação parcelada pela construtora

Após o lançamento do financeiro da unidade (valores de venda, recursos próprios, financiamento, subsídios etc.), inclua uma **nova série**:

| Campo | Como preencher |
| --- | --- |
| **Série** | Documentação |
| **Como calcular** | Usando o valor total da série |
| **Dividido em** | Mesma quantidade de parcelas do recurso próprio do cliente |
| **Valor total** | Valor total da documentação a ser paga |
| **Primeiro vencimento** | Mesmo vencimento do recurso próprio do cliente |

> Exemplo: se o recurso próprio do cliente foi parcelado em **60 vezes**, a documentação também deverá ser lançada em **60 parcelas**.

## 4. Registro no sistema

- Todos os lançamentos devem ser feitos diretamente no **módulo de Financeiro** do CV CRM.

> 📸 **Espaço para print** - exemplo de como a série "Documentação" deve ser criada e vinculada (insira a imagem ao editar o artigo).

## 5. Responsabilidades

O gestor do empreendimento é o responsável final por garantir:

- A correta inserção das informações no CV CRM;
- O alinhamento entre os valores de venda da unidade e o lançamento da documentação;
- A comunicação clara ao cliente sobre a forma de pagamento da documentação.

## 6. Observações importantes

- O parcelamento da documentação **só poderá ser realizado se aprovado previamente** pela construtora ou definido como norma do empreendimento.
- Qualquer dúvida deverá ser direcionada ao setor comercial.

---

**Autor e responsável:** Gustavo Diniz (Comercial) - gustavo.diniz@menin.com.br`,
    },
    {
        code: 'REEM01',
        slug: 'reembolso-de-custas',
        title: 'Reembolso de Custas',
        categorySlug: 'procedimentos',
        subcategorySlug: 'financeiro',
        authorUserId: 1,
        status: 'DRAFT',
        audiences: ['INTERNAL'],
        aliases: ['REEM01', 'Reembolso', 'Reembolso de Custas', 'Relatório de Despesas'],
        body: `# Reembolso de Custas

> **Procedimento Operacional - Departamento Comercial**
> **Código:** REEM01 · **Revisão:** 04

**Objetivo:** padronizar o pagamento de **reembolso de custas** - despesas pessoais, de locomoção ou de **viagem** - aos colaboradores, garantindo a **autorização prévia** de todo gasto e a **documentação completa**.

## ⚠️ Autorização prévia obrigatória

Por diretriz da diretoria, está **terminantemente proibido** pagar custos ou solicitar reembolso **sem autorização prévia**. Para que qualquer valor seja processado, o fluxo é:

1. **Solicite a aprovação ANTES de realizar o gasto.**
2. **Receba o "ok" formal** do **gestor direto** - por **e-mail** ou **mensagem**.
3. **Siga o processo padrão de prestação de contas** (seções abaixo).

> ⛔ Gastos realizados **sem o "ok" formal prévio não serão reembolsados**. Dúvidas sobre o processo de aprovação: procure o gestor direto.

## 1. Regras para reembolso de valores

- **Autorização prévia (obrigatória):** o gasto só pode ocorrer **após o "ok" formal** do responsável/gestor direto (ver seção acima). Sem a autorização prévia, o valor **não é reembolsado**.
- **Método de reembolso:**
  - Somente para **Pessoa Física**;
  - Enviar **agência e conta** para devolução;
  - Enviar **chave Pix** para pagamento;
  - Valores **acima de R$ 5.000,00** são feitos **somente via TED**.

## Despesas de viagem - documentação obrigatória (CI 004/2026)

O pagamento de **despesas de viagem** é feito **somente** mediante o envio da **documentação completa**, **sem exceções**, e do preenchimento da planilha (modelo da empresa):

- **Relatório de viagem** preenchido e **assinado pelo responsável e pelo superior** (modelo da empresa);
- **Comprovantes digitalizados** anexados ao e-mail, **contendo o CPF** do colaborador na nota/comprovante;
- **Comprovantes de pedágio:**
  - Preferencialmente o **relatório do Sem Parar / Veloe** (ou outro sistema de passagem automática);
  - Na falta dele, o **ticket do pedágio** com **data e horário** para comprovação.
- **Prestadores PJ:** o pagamento é feito mediante **emissão de Nota Fiscal**, no valor previamente acordado entre as partes.

> O envio correto das informações e documentos evita **atrasos no pagamento**.

## 2. Termo de reembolso

- Preencher o **Relatório de Despesas** disponibilizado pela empresa com as informações do reembolso (despesas pessoais ou de locomoção).
- **Assinatura obrigatória:** o documento só é **válido** com a **assinatura da diretoria / liderança direta**. Sem ela, o reembolso **não é processado**.
- **Digitalize** o termo assinado para **anexá-lo no lançamento do Sienge** (ver seção 3).

> 📥 **Modelo - Relatório de Despesas:** [Baixar a planilha (.xlsx)](https://geeeswzhtzmiparmgpjp.supabase.co/storage/v1/object/public/Office%20Bucket/academy/procedimentos/reembolso/relatorio-de-despesas-reembolso-menin.xlsx?download=Relat%C3%B3rio%20de%20Despesas%20-%20Reembolso%20Menin.xlsx)
> Preencha esta planilha, assine e anexe na solicitação.

## 3. Efetivação do reembolso (lançamento no Sienge)

> 🔄 **Mudança de processo:** o reembolso deixou de ser pago por solicitação avulsa e passou a ser **lançado no Sienge**.

- O reembolso é **lançado no Sienge**, em **contrato específico de reembolso**, seguindo o **processo padrão de pagamento: Contrato → Medição → Título** (ver [Elaboração de Contratos no Sienge](/academy/kb/sienge/elaboracao-de-contratos) e [Medições no Sienge](/academy/kb/sienge/medicoes-no-sienge)).
- É aceito **somente para Pessoa Física (PF)**.
- O favorecido precisa estar **cadastrado como credor/fornecedor no Sienge**. Se ainda não estiver, **solicite o cadastro antes** do lançamento - ver [Cadastro de Credor / Fornecedor no Sienge](/academy/kb/procedimentos/cadastro-credor-fornecedor-sienge).
- O **documento assinado** (Relatório de Despesas + recibos digitalizados) deve ser **anexado no próprio lançamento do Sienge** - **sem o anexo, o pagamento não é liberado**. Para viagens, anexar também a documentação da seção de viagem.

---

**Dúvidas:** Departamento Comercial - comercial@menin.com.br`,
    },
    {
        code: 'PRE02',
        slug: 'pagamento-de-premiacao-de-venda',
        title: 'Pagamento de Premiação por Venda/Campanha',
        categorySlug: 'procedimentos',
        subcategorySlug: 'financeiro',
        authorUserId: 1,
        status: 'DRAFT',
        audiences: ['INTERNAL'],
        aliases: ['PRE02', 'Premiação', 'Pagamento de Premiação', 'Premiação de Venda', 'Campanha'],
        body: `# Pagamento de Premiação por Venda/Campanha

> **Procedimento Operacional - Departamento Comercial**
> **Código:** PRE02 · **Revisão:** 02

**Objetivo:** padronizar a emissão da nota fiscal e do boleto e o pagamento das **premiações de venda/campanha** nos empreendimentos.

## 1. Regras para emissão da nota fiscal

**Responsável e envio mensal**

- O **Gestor** do empreendimento é responsável por levantar **todas as premiações a pagar do período** e enviá-las em um **único e-mail** ao departamento Comercial da Menin **até o dia 10 de cada mês**.

**Condições e validação**

- A nota fiscal só deverá ser emitida após:
  - a confirmação da **assinatura do Contrato Caixa (CEF)**;
  - a **validação pelo departamento Comercial** da Menin, que retornará via e-mail solicitando a emissão das notas fiscais correspondentes.
- O contrato deve estar na etapa **"Faturado Sienge MCMV"** ou posterior, no **CV CRM**, aba **Repasse**.
- A emissão das NFs pode ocorrer **somente após autorização via e-mail**.

**Emissão, retorno e início das tratativas de pagamento**

- Após a validação e a solicitação do Comercial, o Gestor deve solicitar a emissão das NFs nos valores determinados e **reenviá-las** ao departamento Comercial, que iniciará as tratativas de pagamento.
- Neste momento **ainda não deve ser emitido nenhum boleto** nem informada qualquer programação de pagamento.

**Dados obrigatórios na NF**

- Nome do empreendimento;
- Unidade vendida;
- Nome do cliente;
- CPF do cliente;
- Campanha em questão.

## 2. Regras para emissão do boleto

- Após o envio da nota fiscal, o departamento fará toda a tratativa necessária para a **liberação do saldo** no empreendimento dentro do ERP **Sienge**.
- Com a confirmação da liberação, será solicitada a emissão dos boletos com **D+7 dias** após a solicitação.
- A solicitação dos boletos pode ser feita **em conjunto ou separadamente**, de acordo com as liberações no sistema e as demandas de pagamento.

## 3. Dos responsáveis

- É responsabilidade do **Gestor** de cada empreendimento gerenciar e solicitar a emissão da NF e do boleto para pagamento da premiação em suas determinadas etapas.
- O Gestor é responsável por **coletar, validar e encaminhar** as informações ao departamento Comercial da Menin.

## 4. Pagamento

- O pagamento será realizado em até **07 (sete) dias corridos** após o recebimento do boleto pelo departamento Comercial da Menin.
- O pagamento será feito via **boleto bancário**, que deve estar emitido no **mesmo nome e razão social** da nota fiscal.
- **Não informar prazos** para o pagamento - pode variar de acordo com o relacionamento já existente com a empresa.

## 5. Envio da documentação

- O Gestor responsável deverá enviar a **nota fiscal e o boleto**, em suas respectivas etapas, ao e-mail **comercial@menin.com.br**.

---

**Dúvidas:** Departamento Comercial - comercial@menin.com.br`,
    },

    // ── Reservas (vídeo-tutoriais do CV CRM) ──
    {
        code: 'CV-PRE-CADASTRO',
        slug: 'pre-cadastro-cv-crm',
        title: 'Como realizar um Pré-Cadastro (CV CRM)',
        categorySlug: 'construtor-de-vendas',
        subcategorySlug: 'pre-cadastro', // subcategoria própria do Pré-Cadastro
        authorUserId: 1,
        status: 'DRAFT',
        audiences: ['INTERNAL'],
        aliases: ['Pré-Cadastro', 'Pré-cadastro CV', 'Como fazer um pré-cadastro'],
        payload: { embeds: [{ type: 'VIDEO', ref: 'x-PDK2Qd1zY', url: 'https://youtu.be/x-PDK2Qd1zY', durationSec: 286, title: 'Treinamento Menin x CV CRM: Como realizar um Pré-Cadastro' }] },
        body: `# Como realizar um Pré-Cadastro (CV CRM)

> **Treinamento - Construtor de Vendas (CV CRM)** · Vídeo + passo a passo
> Primeira etapa da jornada de venda: o **pré-cadastro** leva o cliente à análise de crédito do correspondente bancário.

## 🎥 Vídeo do passo a passo

@[VIDEO:x-PDK2Qd1zY]

> Não vê o player acima? [Assista no YouTube](https://youtu.be/x-PDK2Qd1zY).

## Passo a passo

1. **Acesse o CV CRM.** Na página inicial, passe o mouse em **Pré-cadastro** e clique em **Novo pré-cadastro**.
2. **Selecione o empreendimento** desejado e clique em **Abrir empreendimento**.
3. **Dados do cliente:** informe o **CPF** e clique em **Buscar**. Preencha o formulário com o máximo de informações.
   - Os campos com **asterisco** são obrigatórios. Quanto mais completo, mais fácil a análise bancária.
   - **Profissão:** use o seletor; se a profissão não existir na lista, digite no campo abaixo e prossiga.
   - **Fator social:** use para adicionar **dependentes**, se necessário.
4. **Associado (cônjuge/participantes):** o processo é o mesmo do cliente - informe o **CPF**, clique em **Buscar** e preencha. Se a residência for a mesma, use **"Preencher com dados do cliente"**.
   - ⚠️ O **e-mail e o telefone do associado precisam ser diferentes** dos do cliente (são usados no envio de documentos para assinatura).
   - Use sempre **informações verdadeiras** - esses dados são apresentados ao correspondente bancário.
5. Confirme as informações e **dê sequência**. O pré-cadastro está criado.
6. Clique em **Administrar pré-cadastro**. Preencha os **campos adicionais** que auxiliam na avaliação.
7. **Documentos** (menu à esquerda): selecione o **tipo de documento** e a **pessoa** a quem pertence. São **4 documentos obrigatórios** (há outros opcionais que ajudam na análise). Arraste/anexe o arquivo e clique em **Adicionar**. Acompanhe a **barra de progresso**.
   - Para o **associado**, repita o processo - confira sempre o **tipo de associado** antes de enviar.
8. Volte à aba **Informações** e **passe para "pasta completa"** (libera novas opções).
9. **Enviar para análise:** clique em **Análise de crédito associativo** e confirme. Aguarde o retorno do correspondente.
10. **Acompanhar a situação:** menu do topo → **Pré-cadastro → Listagem**. À direita de cada pré-cadastro aparece a **situação** (ex.: *Aprovada*). Ao abrir, você vê as **condições aprovadas** para informar ao cliente.

> ✅ Com o pré-cadastro **aprovado**, o próximo passo é a **Reserva da unidade** - veja [Como realizar uma Reserva de Unidade](/academy/kb/construtor-de-vendas/reserva-de-unidade-cv-crm).

---

*Passo a passo transcrito do vídeo de treinamento. Em caso de divergência com a tela atual do CV, confirme com o setor Comercial.*`,
    },
    {
        code: 'CV-RESERVA',
        slug: 'reserva-de-unidade-cv-crm',
        title: 'Como realizar uma Reserva de Unidade (CV CRM)',
        categorySlug: 'construtor-de-vendas', // tutorial do CV CRM
        subcategorySlug: 'reservas',
        authorUserId: 1,
        status: 'DRAFT',
        audiences: ['INTERNAL'],
        aliases: ['Reserva de Unidade', 'Como fazer uma reserva', 'Reserva CV'],
        payload: { embeds: [{ type: 'VIDEO', ref: 'rl5cULIcH9c', url: 'https://youtu.be/rl5cULIcH9c', durationSec: 319, title: 'Treinamento Menin x CV CRM: Como realizar uma Reserva de Unidade' }] },
        body: `# Como realizar uma Reserva de Unidade (CV CRM)

> **Treinamento - Construtor de Vendas (CV CRM)** · Vídeo + passo a passo
> A **reserva** é feita a partir de um **pré-cadastro aprovado** e trava a unidade para o cliente.

## 🎥 Vídeo do passo a passo

@[VIDEO:rl5cULIcH9c]

> Não vê o player acima? [Assista no YouTube](https://youtu.be/rl5cULIcH9c).

## Passo a passo

1. No CV CRM, menu do topo → **Pré-cadastro → Listagem**. Abra o pré-cadastro **Aprovado** que deseja reservar (botão **Abrir**).
2. Confira as **condições aprovadas** e clique em **Iniciar reserva**.
3. **Selecione a unidade** disponível, veja os detalhes e clique em **Iniciar uma nova reserva**.
4. Confira/preencha os **dados do cliente** e do **associado** - é com base neles que o **contrato** é gerado, então tudo precisa estar correto.
5. **Tabela de preço:** confira previsão de entrega e vencimentos. O **financiamento** e o **subsídio** definidos pelo correspondente são puxados automaticamente (ex.: total de R$ 160.000), abaixo do valor da unidade (ex.: R$ 175.000).
6. **Ajuste o recurso próprio parcelado** (valor restante a ser pago pelo cliente). Regras:
   - **Parcela mínima:** R$ 500;
   - **Total máximo parcelável:** R$ 41.000.
7. Clique em **Recalcular** para ver os valores. Exemplo: 60 parcelas = R$ 250 (abaixo do mínimo) → altere para **30 parcelas** → **Salvar** → **Recalcular** → 30× R$ 500.
8. Com os valores batendo com o total da unidade, **Finalize a reserva**. Em seguida, **Administrar reserva** → **Análise comercial** e aguarde o retorno do time.

### Caso especial: aprovado condicionado (sem subsídio)

1. Abra um pré-cadastro **Aprovado condicionado** (ex.: R$ 130.000, sem subsídio) → **Iniciar reserva** → selecione a unidade (ex.: R$ 175.000).
2. **Exclua a opção de subsídio** (não disponível para o cliente).
3. No **recurso próprio parcelado**, clique em **Recalcular**: ex.: 60× R$ 750 = R$ 45.000 - **acima** do limite de R$ 41.000.
4. **Adicione uma nova série manualmente:** botão acima → série **"Recurso próprio à vista"** → **1 parcela** → valor = **saldo restante** (ex.: R$ 4.000) → informe uma **data de vencimento** → **Adicionar** (forma de pagamento não é necessária).
5. **Recalcule** o recurso próprio parcelado nas novas condições - a tabela passa a bater com o valor da unidade respeitando o máximo de R$ 41.000.
6. Dê sequência → reserva concluída → **Administrar reserva**. Para conferir/editar valores, use o menu **Financeiro** à esquerda. Volte a **Informações** e passe para **Análise comercial**.

---

*Passo a passo transcrito do vídeo de treinamento. Os valores são exemplos; confirme as regras de parcelamento com o setor Comercial.*`,
    },
    {
        code: 'CV-RESERVA-DIRETA',
        slug: 'reserva-direta-cv-crm',
        title: 'Reserva Direta - sem Pré-Cadastro (CV CRM)',
        categorySlug: 'construtor-de-vendas', // tutorial do CV CRM
        subcategorySlug: 'reservas',
        authorUserId: 1,
        status: 'DRAFT',
        audiences: ['INTERNAL'],
        aliases: ['Reserva Direta', 'Reserva sem pré-cadastro', 'Reserva Direta CV'],
        payload: { embeds: [{ type: 'VIDEO', ref: 'MPdc4WJ69Xc', url: 'https://youtu.be/MPdc4WJ69Xc', durationSec: 275, title: 'Treinamento Menin x CV CRM: Reserva Direta (Sem Pré-Cadastro)' }] },
        body: `# Reserva Direta - sem Pré-Cadastro (CV CRM)

> **Treinamento - Construtor de Vendas (CV CRM)** · Vídeo + passo a passo
> Alguns empreendimentos (ex.: **Residencial Verona**) **não exigem cadastro prévio** - a venda pode começar direto pela reserva da unidade.

## 🎥 Vídeo do passo a passo

@[VIDEO:MPdc4WJ69Xc]

> Não vê o player acima? [Assista no YouTube](https://youtu.be/MPdc4WJ69Xc).

## Passo a passo

1. No acesso de **corretor**, a tela inicial traz **Lead, Pré-cadastro, Disponibilidade e Reserva**. Você pode **iniciar direto pela Reserva** (ou consultar a **Disponibilidade** para ver as unidades já reservadas).
2. Clique em **iniciar uma nova reserva** e **selecione o empreendimento** - abre o **mapa de disponibilidade**.
3. **Selecione a unidade** (ex.: Bloco A, apartamento 103). O sistema traz as informações da unidade (tabela de preço oficial, plantas, metragem).
4. Clique em **Iniciar uma nova reserva**. Informe o cliente pelo **CPF** e clique em **Buscar** (procura na base).
   - Se o cliente **não existir**, preencha o formulário. Campos com **asterisco** são obrigatórios; os demais são importantes porque **aparecem no contrato**. A **profissão** é uma informação relevante. Clique em **Salvar e continuar**.
5. **Cônjuge:** se houver e for participar do contrato, adicione (informe o **CPF** e **Buscar**).
6. **Financeiro:** por padrão o sistema já traz a **tabela de preço** com o valor vinculado à unidade. É possível lançar valores manualmente, mas normalmente não é necessário neste momento. Siga com a reserva.
7. **Reserva finalizada:** aparecem **Administrar reserva** (folha para imprimir e entregar ao cliente) e a opção de **ver a reserva** no sistema. A situação inicia como **Nova reserva**.
8. **Documentos:** anexe a documentação do cliente. Por padrão pede-se **RG e CPF**; anexe outros documentos relevantes à venda.
9. Passe para **Análise comercial**. A partir daí o **gestor assume**: entra em contato com o corretor/imobiliária, entende a proposta e **gera os contratos** (intermediação, assinatura de planta, memorial descritivo e o contrato de compra e venda, enviado ao e-mail do cliente para assinatura). Concluído, a situação passa para **Vendida**.

---

*Passo a passo transcrito do vídeo de treinamento. O fluxo de reserva direta vale apenas para empreendimentos configurados para isso - confirme com o setor Comercial.*`,
    },

    // ── Financeiro (vídeo-tutorial do CV CRM) ──
    {
        code: 'CV-BOLETO-ATO',
        slug: 'emissao-boleto-de-ato-cv-crm',
        title: 'Emissão Automática de Boleto de Ato (CV CRM)',
        categorySlug: 'procedimentos', // movido: é procedimento (sai do Construtor de Vendas)
        subcategorySlug: null,
        authorUserId: 1,
        status: 'DRAFT',
        audiences: ['INTERNAL'],
        aliases: ['Boleto de Ato', 'Emissão de Boleto de Ato', 'Ato', 'Boleto Ato'],
        payload: { embeds: [{ type: 'VIDEO', ref: '_66V0eHf7Y8', url: 'https://youtu.be/_66V0eHf7Y8', durationSec: 425, title: 'Nova Funcionalidade: Emissão Automática de Boleto de Ato no CRM' }] },
        body: `# Emissão Automática de Boleto de Ato (CV CRM)

> **Treinamento - Construtor de Vendas (CV CRM)** · Vídeo + passo a passo
> Nova funcionalidade: após a assinatura dos contratos de reserva, o **boleto de ato** é **emitido automaticamente** conforme as regras do financeiro do CV.

## 🎥 Vídeo do passo a passo

@[VIDEO:_66V0eHf7Y8]

> Não vê o player acima? [Assista no YouTube](https://youtu.be/_66V0eHf7Y8).

## Como funciona

1. Na reserva, na etapa **Análise comercial**, a gestão administrativa/de produto faz a **conferência e validação** dos dados (menu **Financeiro**).
2. No **Financeiro**, preencha a tabela. As séries padrão do **Minha Casa Minha Vida** são: recurso próprio à vista, recurso próprio parcelado, financiamento e subsídio federal (alguns casos têm desconto e/ou subsídio estadual).
3. O **boleto de ato** usa a parcela **"recurso próprio à vista"**. ⚠️ **O ato é sempre uma única parcela** - defina o valor conforme o empreendimento.
4. **Gere os contratos** (reserva, uso de imagem etc.) para a assinatura do cliente.
5. Após o envio do contrato, o sistema passa para **Em assinatura**. Quando o cliente assina, passa para **Envio Sienge**.
6. No **Envio Sienge**, com o contrato assinado, o sistema **identifica a reserva MCMV com a série ATO e emite o boleto automaticamente**.
   - Se o cliente **não tiver ato** (apenas recurso), **não adicione** a série "recurso próprio à vista" - assim o sistema não emite o boleto.

## Regras de emissão do ato

- Sempre **uma única parcela**;
- Dentro dos **valores prescritos** para o empreendimento;
- Dentro das **datas propostas**: **não emitir boleto com vencimento superior a 10 dias** da data atual (ex.: no dia 11, não emitir com vencimento após o dia 21).

> As regras **variam por empreendimento**. Para consultá-las, use a **ficha comercial do produto**.

## Conferir a emissão e tratar problemas

- **Documentos:** se emitido, o boleto é anexado com o tipo **"boleto ato"**.
- **Ações:** permite **visualizar** o boleto com as condições do período.
- **Mensagens:** após 1-2 minutos do Envio Sienge, informa o resultado (emitido, falha ou já emitido).
- **Informações (etapas do cliente):** a etapa correta é **"ato emitido"**. Se houver erro, aparece **"ato divergente"** - geralmente **data de emissão, valor do boleto ou alguma regra não atingida** (detalhe no campo Mensagens). Depois seguem, de forma automática, **"ato pago"** e **"ato vencido"**.
- **Reemitir:** clique novamente em **Envio Sienge** para solicitar nova análise. As etapas de ato passam **automaticamente** - só clique para **voltar ao Envio Sienge** em caso de problema.
- Problemas que você não conseguir ajustar facilmente: **acione a equipe interna** para ajuste manual do boleto.
- O sistema valida **diariamente** pagamento e etapas. O **Envio Sienge** demora um pouco mais para atualizar (depende de o contrato estar corretamente no Sienge).

## Para o cliente

- O cliente recebe o boleto por **WhatsApp** (notificação com o boleto em anexo) e por **e-mail** (enviado pelo sistema @menin, com botão de download do PDF e link direto).
- ⚠️ O número de **WhatsApp é somente para notificações** - se o cliente responder, **não será atendido**. O **gestor deve manter contato direto** com o cliente e orientá-lo na emissão e no pagamento do ato.

---

*Passo a passo transcrito do vídeo de treinamento. As regras de valores e datas de cada empreendimento estão na respectiva ficha comercial.*`,
    },

    // ── Referência (Cartório / Contratos) ──
    {
        code: 'ITBI',
        slug: 'itbi',
        title: 'ITBI - Imposto sobre Transmissão de Bens Imóveis',
        categorySlug: 'comercial', // Cartório/Registro fica em Comercial
        subcategorySlug: 'cartorio',
        authorUserId: 1,
        status: 'DRAFT',
        audiences: ['INTERNAL'],
        aliases: ['ITBI', 'Imposto sobre Transmissão de Bens Imóveis', 'Imposto de Transmissão'],
        body: `# ITBI - Imposto sobre Transmissão de Bens Imóveis

> **Base de Conhecimento - Comercial** · Guia de referência
> Conteúdo educativo - confirme sempre as regras vigentes no município do imóvel.

## O que é

O **ITBI** (Imposto sobre a Transmissão de Bens Imóveis) é um **imposto municipal** cobrado quando um imóvel muda de dono por **ato oneroso entre pessoas vivas** (a compra e venda, por exemplo). É a etapa fiscal que antecede o **registro** da propriedade no Cartório de Registro de Imóveis: sem a comprovação do ITBI (pago ou isento), o cartório não registra a transferência.

Base constitucional: **art. 156, II, da Constituição Federal**, que dá aos municípios a competência para instituir o imposto sobre a transmissão "inter vivos", a qualquer título, por ato oneroso, de bens imóveis e de direitos reais sobre imóveis (exceto os de garantia).

## Quem paga e quando

- **Quem paga:** em regra, o **comprador** (adquirente), salvo disposição em contrário da lei municipal.
- **Quando:** antes do **registro** da transmissão no Cartório de Registro de Imóveis. No nosso fluxo, o comprovante de ITBI (guia paga) ou a **Certidão de Isenção** integra a documentação enviada ao cartório - veja o procedimento Registro de Contratos.

## Alíquota

A alíquota é definida por **cada município** e costuma ficar entre **2% e 3%** sobre a base de cálculo.

> ⚠️ A alíquota e as regras variam por município. Confirme sempre na prefeitura / secretaria de fazenda do município do imóvel.

**Financiamento pelo SFH:** em muitos municípios, a **parcela financiada** pelo Sistema Financeiro da Habitação (SFH) tem alíquota reduzida (frequentemente **0,5%**), enquanto a parte paga com recursos próprios segue a alíquota cheia. Isso também varia por município.

## Base de cálculo (STJ - Tema 1.113)

A base de cálculo é o **valor do imóvel transmitido em condições normais de mercado** - normalmente o **valor da transação** declarado.

O **STJ**, no julgamento do **Tema 1.113** (REsp 1.937.821, 2022), firmou pontos importantes:

1. A base de cálculo do ITBI é o **valor de mercado** do imóvel na transação; **não está vinculada** à base de cálculo do IPTU (o valor venal do IPTU **não pode** ser usado nem como piso).
2. O **valor declarado** pelo contribuinte goza de **presunção de veracidade**, que só pode ser afastada pelo fisco mediante **processo administrativo** próprio.
3. O município **não pode arbitrar** previamente a base de cálculo com base em "valor de referência" fixado unilateralmente.

## Isenções e reduções (variam por município)

Muitos municípios concedem **isenção ou redução** do ITBI para:

- **Primeira aquisição** de imóvel residencial; e/ou
- Imóveis do **Programa Minha Casa Minha Vida** ou financiados pelo **SFH**, normalmente até um teto de valor.

> Exemplo ilustrativo: o município de São Paulo concede isenção do ITBI na primeira aquisição / MCMV para imóveis até um teto de valor atualizado periodicamente. Cada município tem suas próprias regras e tetos - **confirme na prefeitura**.

Havendo isenção, anexa-se a **Certidão de Isenção** aos documentos do registro; sem isenção, anexa-se a **guia de ITBI paga**.

## Imunidade (não incidência)

O ITBI **não incide** (imunidade do art. 156, §2º, I, da CF) sobre:

- A transmissão de bens ou direitos **incorporados ao patrimônio de pessoa jurídica em realização de capital**; nem
- A transmissão decorrente de **fusão, incorporação, cisão ou extinção** de pessoa jurídica,

**salvo** quando a atividade **preponderante** do adquirente for a **compra e venda, locação ou arrendamento** de imóveis.

## Por que importa para a venda

- O ITBI é **pré-requisito do registro**: sem ele (pago ou isento), o Contrato Caixa (CEF) e a Confissão de Dívida não são registrados.
- Erro na base de cálculo gera **pagamento a maior** (passível de restituição) ou exigência do fisco.
- Havendo **isenção/redução** no município, é preciso protocolar o pedido com a documentação correta.

---

**Fontes:** Constituição Federal, art. 156 (gov.br/planalto); STJ, Tema 1.113 - REsp 1.937.821. Conteúdo educativo: alíquotas, isenções e procedimentos variam por município - confirme sempre na prefeitura do município do imóvel.`,
    },
    {
        code: 'CONF-CONTRATO',
        slug: 'confissao-de-divida-contrato',
        title: 'Confissão de Dívida - Estrutura do Contrato',
        categorySlug: 'procedimentos',
        subcategorySlug: 'contratos',
        authorUserId: 1,
        status: 'DRAFT',
        audiences: ['INTERNAL'],
        aliases: ['Confissão de Dívida Contrato', 'Instrumento de Confissão de Dívida', 'Estrutura da Confissão de Dívida'],
        body: `# Confissão de Dívida - Estrutura do Contrato

> **Base de Conhecimento - Comercial** · Entenda o instrumento
> Resumo explicativo do modelo de contrato gerado no Construtor de Vendas. Não substitui o contrato; em dúvida jurídica, consulte o Jurídico.

## O que é este documento

A **Confissão de Dívida** das vendas MCMV é o **"Instrumento Particular de Confissão de Dívida com Pacto Adjeto de Alienação Fiduciária Superveniente"**. Por meio dele, o comprador (DEVEDOR) **confessa dever** à construtora (CREDORA) o valor dos **recursos próprios** que não foram pagos à vista e ajusta o **parcelamento** desse valor.

É gerado automaticamente no **Construtor de Vendas (CV CRM)** a partir dos dados da reserva (empreendimento, unidade, cliente, associados e séries financeiras). O passo a passo de geração, assinatura e validação está no procedimento **CONF01 - Geração de Contratos de Confissão de Dívida**.

## Partes do contrato

- **Promitente Vendedora / CREDORA:** a construtora (empresa do grupo).
- **Promissário(s) Comprador(es) / DEVEDOR(A):** o titular e, quando houver, **cônjuge, sócios e associados** (cada um com sua cota de participação).
- **Fiador(es):** quando exigido pela CREDORA, respondem como **principais pagadores** (renunciam aos benefícios dos arts. 827, 835, 838 e 839 do Código Civil).

## Estrutura (quadros e cláusulas)

**A-C - Qualificação e imóvel:** identifica a vendedora, o(s) comprador(es) e associados, o empreendimento, a unidade e a **renda familiar** declarada.

**Composição do valor da unidade:** o valor de venda é integralizado por recursos próprios + financiamento da Caixa + FGTS + subsídios (federal, estadual, FPHIS, COHAPAR, Bônus Moradia etc.) + eventual desconto da construtora. *(Esses valores precisam bater com o Contrato Caixa - ver CONF01.)*

**D - Condições de pagamento:** valor do **ato**, valor **a parcelar** (recursos próprios e, quando houver, documentação) e o **parcelamento** (quantidade de parcelas, valor unitário e primeiro vencimento).

**Cláusulas (resumo):**

| Cláusula | O que trata |
| --- | --- |
| **1. Objeto** | O devedor confessa a dívida dos recursos próprios e a parcela nas condições do Quadro Resumo. |
| **2. Pagamento** | Pagamento por **boletos** mensais; a falta de recebimento do boleto não justifica o não pagamento. Cobrança: 0800 400 4200 / cobranca@menin.com.br. |
| **3. Correção monetária** | Parcelas corrigidas **mensalmente pelo INCC/FGV** até o "Habite-se"; depois, **IPCA/IBGE + juros de 1% ao mês**. Nunca há índice negativo. |
| **4. Inadimplência** | Atraso permite **protesto**, negativação (SERASA/SPC), **multa de 2%** e juros de 1% a.m., com **vencimento antecipado** de todo o saldo (título executivo - art. 784, III, do CPC). |
| **5. Encargos da obra** | Durante a construção, o devedor arca com **juros de evolução de obra** e correção devidos à Caixa. Inadimplência pode levar à **retenção das chaves**. |
| **6. Garantia (fiança)** | Os fiadores garantem o pagamento quando solicitado pela CREDORA. |
| **8. Cessão / CRI** | A CREDORA pode **ceder ou caucionar** os créditos (lastro para **CRI** - Lei 9.514/97). |
| **9. Alienação fiduciária superveniente** | O imóvel é alienado em garantia à CREDORA, com eficácia após o cancelamento da alienação anterior (Lei 9.514/97, com a Lei 14.711/2023). |
| **16. LGPD** | Tratamento de dados conforme a Lei 13.709/2018; informações confidenciais. |
| **17. Foro** | Foro da comarca do imóvel. |

## Assinaturas

Assinam **eletronicamente** a incorporadora, o cliente, os associados (quando houver) e **duas testemunhas**. A certificação aceita é a do padrão **ICP-Brasil** - ver CONF01.

## Pontos de atenção para o gestor

- Os **valores** da confissão (recursos próprios, ato, parcelas, subsídios) devem refletir **fielmente** o Contrato Caixa (CEF). Divergências comprometem a formalização - ver CONF01.
- A confissão deve ser assinada **antes** do Contrato Caixa e vinculada na etapa de Repasse no CV.

---

**Origem:** modelo de contrato do Construtor de Vendas (campos de mesclagem preenchidos automaticamente). Resumo explicativo - o texto vigente do contrato prevalece. Dúvidas jurídicas: Jurídico / Departamento Comercial.`,
    },
    {
        code: 'FECH-CONTABIL',
        slug: 'fechamento-periodo-contabil',
        title: 'Fechamento do Período Contábil',
        categorySlug: 'procedimentos',
        subcategorySlug: 'financeiro',
        authorUserId: 1,
        status: 'DRAFT',
        audiences: ['INTERNAL'],
        aliases: ['Período Contábil', 'Fechamento Contábil', 'Fechamento do Período Contábil', 'Período Fiscal', 'Fechamento de Mês'],
        body: `# Fechamento do Período Contábil

> **Procedimento Operacional - Departamento Comercial** · Uso interno
> Consolida os comunicados de fechamento (ex.: CI 007/2026). 🔒 **Confidencial - uso interno.**

**Objetivo:** garantir o **fechamento correto do período contábil**, assegurando a conformidade dos indicadores e o fluxo financeiro - com **todos os contratos atualizados** no sistema e **todas as notas lançadas** no prazo.

## 1. Responsabilidade do Comercial (contratos)

Até a **data-limite do fechamento** (informada no comunicado do mês), **TODOS os contratos** devem estar, obrigatoriamente, em uma das etapas:

- **"Faturado Sienge MCMV"**, ou
- **"Contratos Assinado 30/70"**.

E ainda:

- **Valide a integração com o Sienge** - não pode haver **erros de sincronização** (ver o procedimento Envio das Reservas ao Sienge).
- ⛔ **Não há prorrogação:** após a data-limite, o sistema **trava para auditoria interna**. Nenhum contrato pode ficar para trás.

## 2. Enquadramento dos períodos

Trabalhamos com dois enquadramentos:

- **Fiscal** - as **obras** estão enquadradas neste item; o fechamento ocorre no **3º dia útil** do mês seguinte.
- **Administrativo / Obra (adm/obra)**.

A abertura de período contábil é **rigorosamente controlada**.

## 3. Lançamento de notas no Sienge

- As notas devem ser lançadas no **Sienge** pela sua **data de EMISSÃO / COMPETÊNCIA**, e **não** pela data de **vencimento**.
- Providencie os **lançamentos, correções e ajustes** dentro do prazo.

## 4. Correção de pendências (dia 10)

**No dia 10** do mês seguinte, o período é **reaberto** especificamente para **regularizar pendências**: lançamento de **notas não realizadas no prazo legal**, **correções e ajustes**.

## Resumo dos prazos

| Item | Prazo |
| --- | --- |
| Contratos em "Faturado Sienge MCMV" ou "Contratos Assinado 30/70" | Data-limite do fechamento (comunicado do mês) |
| Encerramento | **3º dia útil** do mês seguinte |
| Correção de pendências / notas atrasadas | **Dia 10** do mês seguinte (reabertura) |
| Prorrogação | **Não há** - o sistema trava após o prazo |

---

🔒 **Confidencial - uso interno.** Dúvidas: Departamento Comercial / Contabilidade.`,
    },
    {
        code: 'CAD-FORNECEDOR',
        slug: 'cadastro-credor-fornecedor-sienge',
        title: 'Cadastro de Credor / Fornecedor no Sienge',
        categorySlug: 'procedimentos',
        subcategorySlug: 'financeiro',
        authorUserId: 1,
        status: 'DRAFT',
        audiences: ['INTERNAL'],
        aliases: ['Cadastro de Fornecedor', 'Cadastro de Credor', 'Ficha Cadastral de Fornecedor', 'Qualificação de Fornecedores', 'RID 12'],
        body: `# Cadastro de Credor / Fornecedor no Sienge

> **Procedimento Operacional - Suprimentos** · Uso interno
> Como cadastrar um novo credor (prestador de serviço / fornecedor) na base do Sienge.

**Objetivo:** orientar o cadastro de **novos credores** - prestadores de serviço e fornecedores - na base do **Sienge**, pré-requisito para qualquer pagamento (inclusive o **reembolso**, que é lançado em contrato específico e aceito **somente para pessoa física**).

## Quando é necessário cadastrar

Sempre que um pagamento for direcionado a um **credor ainda não cadastrado** no Sienge - por exemplo, ao lançar um **reembolso** (apenas PF) ou ao contratar um novo **prestador/fornecedor**.

O cadastro do credor é **pré-requisito** para **cadastrar o contrato no Sienge** (ver [Elaboração de Contratos no Sienge](/academy/kb/sienge/elaboracao-de-contratos)) e dar seguimento ao **processo de pagamento** (Contrato → Medição → Título).

## Como solicitar o cadastro

1. **Preencha a ficha cadastral** (modelo abaixo) com os dados do prestador/fornecedor.
2. **Encaminhe um e-mail para fornecedores@menin.com.br** com a ficha preenchida em anexo.
3. O time de **Suprimentos** (responsável pelos cadastros) realiza o cadastro **conforme as demandas**.

> 📥 **Modelo - Ficha Cadastral de Fornecedor (RID 12):** [Baixar o formulário (.pdf)](https://geeeswzhtzmiparmgpjp.supabase.co/storage/v1/object/public/Office%20Bucket/academy/procedimentos/fornecedores/ficha-cadastral-fornecedor-rid12.pdf)
> Preencha com os dados do fornecedor e anexe ao e-mail.

## Por que passa por análise

Alguns fornecedores são **controlados** e exigem **certificados de qualidade** dos produtos. Por isso, o cadastro do credor na base passa por **controle e análise** do Suprimentos (qualificação de fornecedores).

## Dica

Havendo necessidade ou urgência, acione o **gestor do seu departamento** para ajudar a **agilizar** o processo.

## Veja também

- [Reembolso de Custas](/academy/kb/procedimentos/reembolso-de-custas) - exige o favorecido (PF) cadastrado como credor.
- [Pagamento de Comissão](/academy/kb/procedimentos/pagamento-de-comissao-mcmv) · [Pagamento de Premiação](/academy/kb/procedimentos/pagamento-de-premiacao-de-venda) - pagamentos a prestadores PJ exigem o credor cadastrado.

---

🔒 **Uso interno.** Dúvidas: Suprimentos - fornecedores@menin.com.br`,
    },
];

function kebab(s) {
    return String(s || '')
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}

// ─────────────────────────────────────────────────────────────────────────
// AUTO-LINK de menções entre artigos
// Cada alvo é um artigo + TODAS as variações do termo (aliases). O autolink
// injeta `[texto](/academy/kb/cat/slug)` na 1ª ocorrência de CADA forma (assim
// "CV CRM" e "CV" são ambos linkados), preservando o texto. Pula o próprio
// artigo (selfSlug) e trechos protegidos (código e links já existentes).
// A ligação é bidirecional porque roda em todos os artigos.
// ─────────────────────────────────────────────────────────────────────────
const LINK_CATEGORY = 'comercial';

// `category` opcional por alvo (default = LINK_CATEGORY). Necessário porque os
// artigos passaram a viver em categorias diferentes (comercial × construtor-de-vendas)
// e o link precisa apontar para a categoria real do alvo.
const LINK_TARGETS = [
    { slug: 'programa-minha-casa-minha-vida', aliases: ['Programa Minha Casa Minha Vida', 'Minha Casa Minha Vida', 'MCMV'] },
    { slug: 'contrato-caixa-cef', aliases: ['Contrato Caixa (CEF)', 'Contrato Caixa', 'Contrato da Caixa', 'Contrato CEF', 'CEF'] },
    { slug: 'cv-crm', category: 'construtor-de-vendas', aliases: ['CV CRM', 'CVCRM', 'Construtor de Vendas', 'CV'] },
    { slug: 'certificacao-digital', aliases: ['Certificação Digital', 'Certificado Digital'] },
    { slug: 'icp-brasil', aliases: ['ICP-Brasil', 'ICP Brasil'] },
    { slug: 'registro-de-contratos-empreendimentos-mcmv', category: 'comercial', aliases: ['Registro de Contratos', 'COMRC1'] },
    { slug: 'demanda-minima', aliases: ['demanda mínima', 'demanda minima'] },
    { slug: 'ri-digital', aliases: ['RI Digital'] },
    { slug: 'painel-do-corretor-guia-inicial', category: 'construtor-de-vendas', aliases: ['Painel do Corretor'] },
    { slug: 'painel-do-gestor-guia-inicial', category: 'construtor-de-vendas', aliases: ['Painel do Gestor'] },
    { slug: 'portal-do-cliente', category: 'construtor-de-vendas', aliases: ['Portal do Cliente'] },
    { slug: 'cv-leads-andamento', category: 'construtor-de-vendas', aliases: ['Andamento dos Leads', 'Kanban de Leads'] },
    { slug: 'cv-leads-cadastro', category: 'construtor-de-vendas', aliases: ['Cadastro de Leads', 'Novo Lead'] },
    { slug: 'cv-empresas-correspondentes', category: 'construtor-de-vendas', aliases: ['Empresas Correspondentes', 'Empresa Correspondente'] },
    { slug: 'cv-usuario-correspondente', category: 'construtor-de-vendas', aliases: ['Usuário Correspondente', 'Usuários Correspondentes'] },
    { slug: 'cv-imobiliarias', category: 'construtor-de-vendas', aliases: ['Imobiliária', 'Imobiliárias'] },
    { slug: 'cv-usuario-imobiliaria', category: 'construtor-de-vendas', aliases: ['Usuário da Imobiliária', 'Usuários Imobiliárias'] },
    { slug: 'cv-cadastro-corretor', category: 'construtor-de-vendas', aliases: ['Cadastro de Corretor'] },
    { slug: 'cv-vincular-imobiliaria-empreendimento', category: 'construtor-de-vendas', aliases: ['Vincular Imobiliária ao Empreendimento'] },
    { slug: 'cv-vincular-corretor-empreendimento', category: 'construtor-de-vendas', aliases: ['Vincular Corretor ao Empreendimento'] },
    { slug: 'cv-campos-obrigatorios-reservas', category: 'construtor-de-vendas', aliases: ['Campos Obrigatórios nas Reservas', 'Campos obrigatórios'] },
];

function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function autolink(body, selfSlug) {
    // Liga menções a outros artigos. Divide o texto em trechos LIVRES e
    // PROTEGIDOS (código e links/imagens já existentes) e só linka nos livres.
    // Numa única varredura casa o termo mais longo primeiro (alternância
    // ordenada por tamanho) e linka a 1ª ocorrência de CADA forma - assim
    // "CV CRM" e "CV" são ambos linkados. Preserva o texto; é bidirecional
    // porque roda em todos os artigos.
    const entries = [];
    for (const t of LINK_TARGETS) {
        if (t.slug === selfSlug) continue;
        const category = t.category || LINK_CATEGORY;
        for (const alias of t.aliases) entries.push({ alias, slug: t.slug, category });
    }
    if (!entries.length) return String(body || '');
    entries.sort((a, b) => b.alias.length - a.alias.length);

    const combined = new RegExp(
        `(?<![\\p{L}\\p{N}])(${entries.map((e) => escapeRe(e.alias)).join('|')})(?![\\p{L}\\p{N}])`,
        'giu',
    );
    const metaByAlias = new Map(entries.map((e) => [e.alias.toLowerCase(), { slug: e.slug, category: e.category }]));
    const linkedForms = new Set(); // "slug|forma" já linkada (1ª ocorrência por forma)

    // índices pares = texto livre; ímpares = trecho protegido (capturado).
    const PROTECT_RE = /(```[\s\S]*?```|`[^`]*`|^#{1,6} .*$|!\[[^\]]*\]\([^)]*\)|\[[^\]]*\]\([^)]*\))/gm;
    const parts = String(body || '').split(PROTECT_RE);

    for (let i = 0; i < parts.length; i += 2) {
        const seg = parts[i];
        if (!seg) continue;
        let out = '';
        let last = 0;
        let m;
        combined.lastIndex = 0;
        while ((m = combined.exec(seg)) !== null) {
            const matched = m[1];
            const meta = metaByAlias.get(matched.toLowerCase());
            const slug = meta?.slug;
            const key = `${slug}|${matched.toLowerCase()}`;
            out += seg.slice(last, m.index);
            if (slug && !linkedForms.has(key)) {
                linkedForms.add(key);
                out += `[${matched}](/academy/kb/${meta.category}/${slug})`;
            } else {
                out += matched;
            }
            last = m.index + matched.length;
            if (combined.lastIndex === m.index) combined.lastIndex += 1;
        }
        out += seg.slice(last);
        parts[i] = out;
    }
    return parts.join('');
}

async function upsertProcedure(proc) {
    const slug = proc.slug || kebab(proc.title);
    // Canonicaliza para uma das 4 classes (INTERNO|EXTERNO|AMBOS|ADMIN).
    // `visibility` ('INTERNAL'|'EXTERNAL'|'BOTH'|'ADMIN') tem prioridade;
    // senão, `audiences` legado é canonicalizado; sem nada → INTERNO (seguro).
    const audiences = normalizeAudiences(proc.audiences);
    const finalAudiences = proc.visibility
        ? visibilityToAudiences(proc.visibility)
        : (audiences.length ? canonicalizeAudiences(audiences) : visibilityToAudiences('INTERNAL'));
    // Autor: o que o procedimento declara tem prioridade; senão cai no env.
    const author = Number.isFinite(Number(proc.authorUserId))
        ? Number(proc.authorUserId)
        : AUTHOR_USER_ID;

    const fields = {
        title: String(proc.title).trim(),
        categorySlug: String(proc.categorySlug).trim(),
        slug,
        subcategorySlug: proc.subcategorySlug || SUBCATEGORY_BY_SLUG[slug] || null,
        body: autolink(String(proc.body || ''), slug), // injeta cross-links automaticamente
        // `payload` opcional (JSONB). Markdown puro = null. Para vídeos, traz
        // `{ embeds: [{type:'VIDEO', ref:'<id>', url, title}] }` - o corpo usa o
        // token @[VIDEO:<id>] e o TokenRenderer resolve a URL pelo embed (iframe).
        payload: proc.payload || null,
        aliases: Array.isArray(proc.aliases) ? proc.aliases : [],
        audiences: finalAudiences,
        audience: deriveLegacyAudience(finalAudiences),
        updatedByUserId: author,
    };
    // Status: definido APENAS na criação (`proc.status`, default PUBLISHED; um
    // rascunho nasce 'DRAFT'). Em updates o status atual é PRESERVADO - re-rodar
    // o seed NÃO republica nem rebaixa um artigo. A publicação dos rascunhos é
    // feita pelo fluxo normal da UI (que também dispara a notificação).
    const initialStatus = proc.status || 'PUBLISHED';
    // Quando o autor é declarado, ele é a fonte de verdade da autoria - então
    // estabelece/corrige o createdBy também em updates. Sem autor declarado,
    // preserva o createdBy já existente (não sobrescreve).
    if (author != null) fields.createdByUserId = author;

    const existing = await db.AcademyArticle.findOne({ where: { slug } });
    if (existing) {
        await existing.update(fields); // status preservado (não está em `fields`)
        return { action: 'updated', article: existing };
    }

    const created = await db.AcademyArticle.create({
        ...fields,
        status: initialStatus,
        createdByUserId: author,
    });
    return { action: 'created', article: created };
}

async function run() {
    // Confirma a conexão antes de escrever.
    await db.sequelize.authenticate();
    const dbName = db.sequelize.config?.database;
    const dbHost = db.sequelize.config?.host;
    console.log(`🔌 Conectado em ${dbName} @ ${dbHost}`);

    // Garante a coluna de subcategoria (2º nível) - idempotente, p/ a seed rodar
    // sem depender de redeploy do app (que adicionaria via ensureAcademySchema).
    await db.sequelize.query('ALTER TABLE academy_articles ADD COLUMN IF NOT EXISTS subcategory_slug VARCHAR(255)');

    const out = [];
    for (const proc of PROCEDURES) {
        // eslint-disable-next-line no-await-in-loop
        const r = await upsertProcedure(proc);
        const a = r.article;
        out.push(r);
        const url = `/academy/kb/${a.categorySlug}/${a.slug}`;
        const aud = (a.audiences || []).join(', ') || '-';
        console.log(`  ${r.action === 'created' ? '➕ criado ' : '♻️  atualizado'}  [${proc.code}] ${a.title}`);
        console.log(`     id=${a.id} · status=${a.status} · audiences=[${aud}] · sub=${a.subcategorySlug || '-'}`);
        console.log(`     ${url}`);
    }
    return out;
}

const isDirectRun = process.argv[1] && process.argv[1].endsWith('academy_seed_procedimentos.js');
if (isDirectRun) {
    run()
        .then((out) => {
            const created = out.filter((r) => r.action === 'created').length;
            const updated = out.filter((r) => r.action === 'updated').length;
            console.log(`\n✅ Concluído: ${created} criado(s), ${updated} atualizado(s).`);
            process.exit(0);
        })
        .catch((err) => {
            console.error('❌ Erro no seed de procedimentos:', err);
            process.exit(1);
        });
}

export { run as seedProcedimentos, PROCEDURES, autolink, LINK_TARGETS };
