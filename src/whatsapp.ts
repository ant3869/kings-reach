// src/whatsapp.ts - WhatsApp bridge stub (whatsapp-web.js + QR login).
// Stub means thin: connect, receive, reply. Queue encryption lives in db.ts tables.

import { Client, LocalAuth, type Message } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';

export type WhatsAppHandler = (from: string, body: string) => Promise<string | void>;

let client: Client | null = null;

/** Start the WhatsApp client. Prints a QR code in the terminal on first login. */
export function initWhatsApp(onMessage: WhatsAppHandler): Client {
  if (client) return client;
  client = new Client({
    authStrategy: new LocalAuth({ dataPath: 'store/wa-auth' }),
    puppeteer: { args: ['--no-sandbox'] },
  });

  client.on('qr', (qr: string) => {
    console.log('[whatsapp] scan this QR code with your phone:');
    qrcode.generate(qr, { small: true });
  });
  client.on('ready', () => console.log('[whatsapp] client ready'));
  client.on('auth_failure', (msg: string) => console.error(`[whatsapp] auth failure: ${msg}`));

  client.on('message', async (msg: Message) => {
    if (msg.fromMe) return;
    try {
      const reply = await onMessage(msg.from, msg.body ?? '');
      if (reply && client) await client.sendMessage(msg.from, String(reply).slice(0, 4000));
    } catch (err) {
      console.error(`[whatsapp] handler error: ${String(err)}`);
    }
  });

  void client.initialize();
  return client;
}

/** Send a plain-text message. No-op (with warning) if the client is not started. */
export async function sendWhatsApp(to: string, text: string): Promise<void> {
  if (!client) {
    console.error('[whatsapp] sendWhatsApp called before initWhatsApp');
    return;
  }
  await client.sendMessage(to, text.slice(0, 4000));
}
