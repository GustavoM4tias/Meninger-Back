// exemplo rápido: gerar notificações de engajamento (sem imagem)
import { sendEmail } from '../email/email.service.js';
import { EmailType } from '../email/types.js';

const nudges = [
  { title: 'Resumo semanal', preview: 'Veja o que aconteceu no time', body: 'Seu resumo está pronto.' },
  { title: 'Dica do dia', preview: 'Produtividade +1', body: 'Use atalhos para criar eventos rapidamente.' },
];

export async function sendRandomNudge(to) {
  const pick = nudges[Math.floor(Math.random()*nudges.length)];
  await sendEmail(EmailType.GENERIC_NOTIFICATION, to, {
    title: pick.title,
    preview: pick.preview,
    description: pick.body, 
  });
}
