// utils/cpf.js
// Validação de CPF (dígitos verificadores) reutilizável. Mesma regra já usada no
// boleto (services/boleto/titularValidator.js), extraída aqui para o bolão público
// e qualquer outro consumidor.

export function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

// True se o CPF tem 11 dígitos e os dígitos verificadores batem (rejeita também as
// sequências repetidas tipo 000... / 111..., que passam na conta mas são inválidas).
export function isValidCPF(cpf) {
  const d = onlyDigits(cpf);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(d[i], 10) * (10 - i);
  let dv = (sum * 10) % 11;
  if (dv === 10) dv = 0;
  if (dv !== parseInt(d[9], 10)) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(d[i], 10) * (11 - i);
  dv = (sum * 10) % 11;
  if (dv === 10) dv = 0;
  return dv === parseInt(d[10], 10);
}

// 123.456.789-09 a partir de 11 dígitos (apenas para exibição; nunca para chave).
export function formatCPF(cpf) {
  const d = onlyDigits(cpf);
  if (d.length !== 11) return String(cpf || '');
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

export default { onlyDigits, isValidCPF, formatCPF };
