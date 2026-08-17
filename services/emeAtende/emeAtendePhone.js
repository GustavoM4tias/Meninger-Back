// services/emeAtende/emeAtendePhone.js
// Normalização de telefone BR pro formato da Cloud API (E.164 sem "+").
//
// A implementação foi promovida pra services/whatsapp/whatsappPhone.js quando o
// Office passou a usar o telefone do perfil como número de WhatsApp (2026-08-17)
// — os dois lados precisam comparar número do MESMO jeito. Este arquivo segue
// existindo só como fachada: o comportamento é idêntico ao anterior.

export {
    normalizePhone,
    phoneSuffix,
    phoneKey,
    samePhone,
} from '../whatsapp/whatsappPhone.js';
