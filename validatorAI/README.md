# 📄 ValidatorAI – API de Validação de Contratos (Gemini 2.0)

Esta API permite validar dois documentos obrigatórios (Contrato Caixa e Confissão de Dívida), assegurando conformidade com as diretrizes internas de uma construtora, utilizando IA (Google Gemini 2.0).

---

## 🚀 Instalação

### 1. Clone o projeto ou acesse a pasta `validatorAI` dentro do seu backend existente:

```bash
cd validatorAI
```

### 2. Instale as dependências:

```bash
npm install express multer cors helmet pdf-parse @google/generative-ai
```

### 3. Configure seu `.env` (opcional):

```env
CONFISSAO_REGRAS="Texto completo do procedimento interno da empresa"
```

Caso prefira, insira o texto diretamente no `DocumentValidator.js` como `systemPrompt` (já incluso no código).

---

## 🔧 Executando a API

Adicione a linha abaixo no seu `main` backend (por exemplo, `server.js`, `app.js`, etc):

```js
import validatorAI from './validatorAI/index.js';
app.use('/ai', validatorAI);
```

Em seguida, execute seu servidor normalmente:

```bash
npm run dev
# ou
node app.js
```

---

## 📫 Como testar via Terminal

1. Crie uma pasta `testes/` com os dois arquivos PDF:

```
testes/
├── contrato_caixa.pdf
└── confissao_divida.pdf
```

2. Execute o seguinte comando usando `curl`:

```bash
curl -X POST http://localhost:3000/ai/validate \
  -F "contrato_caixa=@testes/contrato_caixa.pdf" \
  -F "confissao_divida=@testes/confissao_divida.pdf"
```

3. Resposta esperada (exemplo):

```json
{
  "status": "ERRO",
  "resultado": "status: ERRO\nmensagens: [\"Data de assinatura não coincide.\", \"Valor do recurso próprio está divergente em R$ 0,03.\"]"
}
```

---

## 📦 Estrutura de Diretórios

```
validatorAI/
├── index.js
├── src/
│   ├── config/
│   │   └── geminiClient.js
│   ├── services/
│   │   └── DocumentValidator.js
│   ├── utils/
│   │   └── TokenCounter.js
│   └── middleware/
│       ├── validation.js
│       └── errorHandler.js
```

---

## 🧠 Expansão futura

* Cache de resultados com Redis
* Interface web de upload e resultado
* Dashboard de validações realizadas
* Histórico por responsável ou empreendimento

---

## 📮 Suporte

Para dúvidas, contate o departamento comercial: **[comercial@menin.com.br](mailto:comercial@menin.com.br)**

---

**ValidatorAI © 2025 – Menin Engenharia**
