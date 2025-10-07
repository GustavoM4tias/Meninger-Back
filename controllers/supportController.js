// controllers/supportController.js
import db from '../models/sequelize/index.js';
import crypto from 'crypto';
import { sendEmail } from '../email/email.service.js';
import { EmailType } from '../email/types.js';
import { fn, col } from 'sequelize';

const { SupportTicket, SupportMessage, User } = db;

const genProtocol = () => {
  const ts = Date.now().toString().slice(-6);
  const rnd = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `${ts}${rnd}`;
};

const priorityLabel = (p) => ({ critical: 'Crítica', high: 'Alta', medium: 'Média', low: 'Baixa' })[p] || p;

//
// POST /support/tickets
//
export const createTicket = async (req, res) => {
  const {
    userName, email, problemType, priority, module,
    title, description, stepsToReproduce = '',
    browser = '', os = '', pageUrl = '',
    attachments = [],
    allowContact = true,
  } = req.body;

  try {
    const requester = await User.findOne({
      where: { email },
      attributes: ['id', 'email', 'username'],
    });

    const protocol = genProtocol();

    const ticket = await SupportTicket.create({
      protocol,
      title,
      description,
      problem_type: problemType,
      priority,
      module,
      status: 'pending',
      requester_id: requester?.id ?? null,
      thread_token: crypto.randomBytes(12).toString('hex'),
      browser: browser || null,
      os: os || null,
      page_url: pageUrl || null,
    });

    await SupportMessage.create({
      ticket_id: ticket.id,
      author_id: requester?.id ?? null,
      author_name: userName,
      author_email: email,
      body: [
        description,
        stepsToReproduce && `\n\nPassos para reproduzir:\n${stepsToReproduce}`,
        `\n\nInfo técnica: URL=${pageUrl || '-'} • Navegador=${browser || '-'} • SO=${os || '-'}`,
      ].filter(Boolean).join(''),
      attachments,
      origin: 'web',
    });

    // responde http
    res.status(201).json({ message: 'Ticket aberto', protocol, ticketId: ticket.id });

    // e-mails (assíncrono)
    const mailData = {
      ticketId: `#${protocol}`,
      priority: priorityLabel(priority),
      summary: title,
      latestUpdate: 'Ticket criado',
      // viewUrl: `${process.env.APP_URL}/support/${ticket.id}`,
    };

    // solicitante
    email && sendEmail(EmailType.SUPPORT_OPENED, email, mailData)
      .catch(err => console.error('[email] suporte/opened solicitante', err));

    // equipe
    const SUPPORT_TEAM = process.env.SUPPORT_EMAIL;
    SUPPORT_TEAM && sendEmail(EmailType.SUPPORT_OPENED, SUPPORT_TEAM, {
      ...mailData,
      summary: `${title} — por ${userName} (${email})`,
    }).catch(err => console.error('[email] suporte/opened equipe', err));

  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Falha ao abrir ticket' });
  }
};

//
// GET /support/tickets/:id
//
export const getTicket = async (req, res) => {
  try {
    const { id } = req.params;

    const ticket = await SupportTicket.findByPk(id, {
      attributes: [
        'id', 'protocol', 'title', 'priority', 'status',
        'created_at', 'updated_at', 'module', 'problem_type',
      ],
      include: [
        { model: User, as: 'requester', attributes: ['id', 'username', 'email'] },
        {
          model: SupportMessage,
          as: 'messages',
          attributes: [
            'id', 'author_id', 'author_name', 'author_email',
            'body', 'attachments', 'created_at', 'origin',
          ],
          separate: true,
          order: [['created_at', 'ASC']],
        },
      ],
    });

    if (!ticket) return res.status(404).json({ error: 'Ticket não encontrado' });
    res.json(ticket);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Falha ao buscar ticket' });
  }
};

//
// POST /support/tickets/:id/messages  (ADMIN)
//
export const addMessage = async (req, res) => {
  const { id } = req.params;
  const { body, attachments = [] } = req.body;

  try {
    const ticket = await SupportTicket.findByPk(id, { include: [{ model: User, as: 'requester', attributes: ['email'] }] });
    if (!ticket) return res.status(404).json({ error: 'Ticket não encontrado' });

    // dados do autor = admin autenticado (middleware já garantiu)
    const authorId = req.user?.id ?? null;
    const authorName = req.user?.username ?? 'Admin';
    const authorEmail = req.user?.email ?? null;

    const msg = await SupportMessage.create({
      ticket_id: ticket.id,
      author_id: authorId,
      author_name: authorName,
      author_email: authorEmail,
      body,
      attachments,
      origin: 'web',
    });

    res.status(201).json({ message: 'Mensagem adicionada', messageId: msg.id });

    // email para solicitante + equipe
    const recipients = [ticket.requester?.email, process.env.SUPPORT_EMAIL].filter(Boolean);
    const mailData = {
      ticketId: `#${ticket.protocol}`,
      latestUpdate: body.slice(0, 140) + (body.length > 140 ? '…' : ''),
      summary: ticket.title,
    };

    recipients.length && sendEmail(EmailType.SUPPORT_UPDATED, recipients, mailData)
      .catch(err => console.error('[email] suporte/updated', err));

  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Falha ao adicionar mensagem' });
  }
};

//
// PATCH /support/tickets/:id/status  (ADMIN)
//
export const updateStatus = async (req, res) => {
  const { id } = req.params;
  const { status } = req.body; // 'pending'|'in_progress'|'resolved'|'closed'

  try {
    const ticket = await SupportTicket.findByPk(id, { include: [{ model: User, as: 'requester', attributes: ['email'] }] });
    if (!ticket) return res.status(404).json({ error: 'Ticket não encontrado' });

    ticket.status = status;
    await ticket.save();

    res.json({ message: 'Status atualizado', status });

    const recipients = [ticket.requester?.email, process.env.SUPPORT_EMAIL].filter(Boolean);
    recipients.length && sendEmail(EmailType.SUPPORT_UPDATED, recipients, {
      ticketId: `#${ticket.protocol}`,
      latestUpdate: `Status alterado para "${status}".`,
    }).catch(err => console.error('[email] suporte/status', err));

  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Falha ao atualizar status' });
  }
};

//
// GET /support/tickets?status=&mine=1
//
export const listTickets = async (req, res) => {
  try {
    const { status, mine } = req.query;
    const whereClause = {};
    if (status) whereClause.status = status;
    if (mine && req.user?.id) whereClause.requester_id = req.user.id;

    const items = await SupportTicket.findAll({
      where: whereClause,
      order: [['created_at', 'DESC']],
      limit: 100,
      attributes: ['id', 'protocol', 'title', 'priority', 'status', 'created_at', 'updated_at'],
    });

    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Falha ao listar tickets' });
  }
};

//
// GET /support/tickets/counts
//
export const countByStatus = async (_req, res) => {
  try {
    const rows = await SupportTicket.findAll({
      attributes: ['status', [fn('COUNT', col('id')), 'count']],
      group: ['status'],
    });
    const out = { pending: 0, in_progress: 0, resolved: 0, closed: 0 };
    rows.forEach(r => { out[r.get('status')] = Number(r.get('count')); });
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Falha ao contar tickets' });
  }
};

//
// GET /support/stats
//
export const statsOverview = async (_req, res) => {
  try {
    const totalReports = await SupportTicket.count();
    const resolved = await SupportTicket.count({ where: { status: 'resolved' } });

    const resolvedRows = await SupportTicket.findAll({
      where: { status: 'resolved' },
      attributes: ['created_at', 'updated_at'],
    });

    let avgMs = 0;
    if (resolvedRows.length) {
      avgMs = resolvedRows.reduce((sum, t) => {
        const a = new Date(t.updated_at).getTime();
        const b = new Date(t.created_at).getTime();
        return sum + Math.max(a - b, 0);
      }, 0) / resolvedRows.length;
    }
    const hours = Math.round(avgMs / 36e5);
    const avgResponseTime = hours >= 24 ? `${Math.round(hours / 24)}d` : `${Math.max(hours, 1)}h`;

    res.json({ totalReports, resolved, avgResponseTime });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Falha ao calcular estatísticas' });
  }
};
