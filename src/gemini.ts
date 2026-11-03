import https from 'node:https';
import { GEMINI_EMBED_MODEL, GEMINI_TEXT_MODEL, GOOGLE_API_KEY } from './config.js';

// Simple is better than complex: native https, no SDK for two endpoints.
// Model names + key come from config.ts (single .env reader).
export { GEMINI_EMBED_MODEL, GEMINI_TEXT_MODEL };
export const EMBEDDING_DIMS = 768;

function postJson(url: string, body: unknown): Promise<unknown> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer | string) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error(`Gemini returned non-JSON: ${String(err)}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(60_000, () => req.destroy(new Error('Gemini request timed out')));
    req.write(payload);
    req.end();
  });
}

function extractText(resp: unknown): string {
  const r = resp as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    error?: { message?: string };
  };
  if (r.error) throw new Error(`Gemini API error: ${r.error.message ?? 'unknown'}`);
  const parts = r.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text ?? '').join('').trim();
}

/** Text generation via gemini-3-flash-preview. Returns raw model text. */
export async function callGemini(prompt: string, systemInstruction?: string): Promise<string> {
  const key = GOOGLE_API_KEY;
  if (!key) throw new Error('GOOGLE_API_KEY is missing (memory=full_v2 needs it)');
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${key}`;
  const body: Record<string, unknown> = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2 },
  };
  if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };
  return extractText(await postJson(url, body));
}

/** 768-dim embedding via gemini-embedding-001. */
export async function getEmbedding(text: string): Promise<number[]> {
  const key = GOOGLE_API_KEY;
  if (!key) throw new Error('GOOGLE_API_KEY is missing (memory=full_v2 needs it)');
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBED_MODEL}:embedContent?key=${key}`;
  const resp = (await postJson(url, {
    content: { parts: [{ text }] },
    outputDimensionality: EMBEDDING_DIMS,
  })) as { embedding?: { values?: number[] }; error?: { message?: string } };
  if (resp.error) throw new Error(`Gemini embedding error: ${resp.error.message ?? 'unknown'}`);
  const values = resp.embedding?.values ?? [];
  if (values.length === 0) throw new Error('Gemini returned an empty embedding');
  return values;
}
