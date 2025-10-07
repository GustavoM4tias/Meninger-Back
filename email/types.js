// api/email/types.js
export const EmailType = {
    EVENT_CREATED: 'event.created',
    EVENT_REMINDER: 'event.reminder',
    SUPPORT_OPENED: 'support.opened',
    SUPPORT_UPDATED: 'support.updated',
    INVITE_USER: 'invite.user',
    GENERIC_NOTIFICATION: 'generic.notification',
};

// Contratos mínimos de dados por tipo (JSDoc p/ intellisense)
/**
 * @typedef {Object} EventEmailData
 * @property {string} title
 * @property {string} description
 * @property {string} eventDateISO  // ISO (UTC)
 * @property {string=} eventDateFormatted
 * @property {string[]=} tags
 * @property {string[]=} images
 * @property {{street?:string, number?:string, neighborhood?:string, city?:string, state?:string}=} address
 * @property {{name:string, email?:string, position?:string}[]=} organizers
 */
