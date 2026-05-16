import originalMessageHandler from '../../../WA Bot/messageHandler.js';

export default async function messageHandler(sock, m, store, userId) {
    return originalMessageHandler(sock, m, store, userId);
}
