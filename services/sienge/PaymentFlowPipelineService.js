// services/sienge/PaymentFlowPipelineService.js
//
// Fachada da esteira do Fluxo de Pagamento. O código mora em módulos
// (services/sienge/paymentFlow/):
//
//   modules/fornecedor.js        Fornecedor (credor no Sienge)
//   modules/contratoBusca.js     Contrato - busca (modo auto), saldo, poll de autorização
//   modules/contratoCriacao.js   Contrato - criação (Playwright)
//   modules/contratoAditivo.js   Contrato - aditivo (Playwright)
//   modules/contratoExistente.js Contrato - existente (receita: sem criar nada)
//   modules/medicao.js           Medição (Playwright) + poll de autorização
//   modules/titulo.js            Título (NFS/NFE/..., boleto/transferência) + documento depois
//   runner.js                    Executor: lê a receita do tipo e encadeia os módulos
//   recipe.js / gate.js          Receita por tipo e portão de regras
//
// Quem importava daqui (controller, schedulers) segue importando daqui.

export { stepFindCreditor } from './paymentFlow/modules/fornecedor.js';
export { stepFindContract, stepValidateItems, pollContractStatus } from './paymentFlow/modules/contratoBusca.js';
export { stepCreateContract } from './paymentFlow/modules/contratoCriacao.js';
export { stepCreateAdditive } from './paymentFlow/modules/contratoAditivo.js';
export { stepUseExistingContract } from './paymentFlow/modules/contratoExistente.js';
export { stepCreateMeasurement, pollMeasurementStatus } from './paymentFlow/modules/medicao.js';
export {
    stepCreateTitulo,
    stepRegisterBoleto,
    pollTituloStatus,
    stepUpdateBoleto,
    stepAttachDocument,
    isPermanentBoletoError,
} from './paymentFlow/modules/titulo.js';
export { runFullPipeline, continueExistingContractPipeline, abortPipeline } from './paymentFlow/runner.js';
