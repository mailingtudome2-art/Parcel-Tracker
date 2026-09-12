const MODEL = 'openrouter/free';

const EXTRACTION_PROMPT = `
You are an OCR assistant for Thai postal delivery manifests (บัญชีนำจ่าย ป.303).

The image has been preprocessed for OCR. The original parcel table has FOUR vertical column groups.
They may appear as a 2x2 layout in the image:
- top-left = original column 1
- top-right = original column 2
- bottom-left = original column 3
- bottom-right = original column 4

Read EVERY numbered parcel entry visible in ALL FOUR groups.
This particular type of sheet can contain 50-100+ entries. Do NOT stop after a few rows.

IMPORTANT:
- The printed sequence number is the number at the beginning of each parcel entry.
- Tracking numbers normally look like: 2 English letters + 9 digits + TH.
- They may be printed with spaces, for example: WB 3689 9851 2 TH.
- Remove all spaces and hyphens in the output.
- Convert letters to uppercase.
- Ignore recipient names, addresses, phone numbers, status text, prices, dates, and asterisks.
- Ignore the NON-COD/header text outside the parcel table.
- Read rows even when the recipient name touches the tracking number.
- Completeness is more important than explaining anything.

OUTPUT ONLY one line per parcel:
sequence|tracking_number

Example:
1|WB368998512TH
2|WB464939383TH
3|WB462670430TH

Rules:
- Keep the original printed sequence number.
- Include the final TH.
- No markdown.
- No code fences.
- No header.
- No explanation.
- No blank lines.
- Do not combine multiple entries on one line.
- Try to return all entries from 1 through the highest visible sequence number.
`;

function cleanText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/```(?:text|plaintext)?/gi, '')
    .replace(/```/g, '');
}

function normalizeTracking(value) {
  if (!value) return null;

  const s = String(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

  const match = s.match(/^([A-Z]{2})(\d{9})TH$/);
  if (!match) return null;

  return `${match[1]}${match[2]}TH`;
}

function parseItems(text) {
  const cleaned = cleanText(text);
  const items = [];
  const seenSeq = new Set();
  const seenTracking = new Set();

  // Match a tracking number even when spaces/hyphens are present.
  const trackingRegex = /\b([A-Z]{2})[\s\-]*(\d{4})[\s\-]*(\d{4})[\s\-]*(\d)[\s\-]*TH\b/gi;

  // First pass: line-oriented parsing. This is the preferred path because
  // the model was instructed to preserve the printed sequence number.
  for (const rawLine of cleaned.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    let seq = null;

    // Accept: 1|..., 1. ..., 1) ..., 1: ..., 1- ...
    const startSeq = line.match(/^\s*(\d{1,3})\s*(?:[.|):\-]\s*|\|\s*)/);
    if (startSeq) seq = Number(startSeq[1]);

    const match = line.match(trackingRegex);
    if (!match) continue;

    const tracking = normalizeTracking(
      `${match[1]}${match[2]}${match[3]}${match[4]}TH`
    );
    if (!tracking) continue;

    // If the line did not start with a sequence number, look immediately
    // before the tracking number for a printed sequence number.
    if (seq === null) {
      const before = line.slice(0, match.index);
      const fallback = before.match(/(?:^|\s)(\d{1,3})\s*$/);
      if (fallback) seq = Number(fallback[1]);
    }

    if (seq === null || seq < 1 || seq > 300) continue;
    if (seenSeq.has(seq) || seenTracking.has(tracking)) continue;

    seenSeq.add(seq);
    seenTracking.add(tracking);
    items.push({ seq, tracking });
  }

  // Second pass: sometimes a vision model returns the sequence and tracking
  // number with unusual punctuation or puts several values on one line.
  // Search for tracking numbers and infer a sequence from nearby text when
  // possible. If no sequence can be recovered, use the next available number.
  if (items.length < 1) {
    trackingRegex.lastIndex = 0;

    let match;
    while ((match = trackingRegex.exec(cleaned)) !== null) {
      const tracking = normalizeTracking(
        `${match[1]}${match[2]}${match[3]}${match[4]}TH`
      );
      if (!tracking || seenTracking.has(tracking)) continue;

      const before = cleaned.slice(Math.max(0, match.index - 30), match.index);
      const seqMatch = before.match(/(?:^|\D)(\d{1,3})\s*$/);
      let seq = seqMatch ? Number(seqMatch[1]) : null;

      if (seq === null || seq < 1 || seq > 300 || seenSeq.has(seq)) {
        seq = 1;
        while (seenSeq.has(seq)) seq++;
      }

      seenSeq.add(seq);
      seenTracking.add(tracking);
      items.push({ seq, tracking });
    }
  }

  items.sort((a, b) => a.seq - b.seq);
  return items;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const apiKey = process.env.OPENROUTER_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: 'OPENROUTER_API_KEY is not configured'
      });
    }

    let body = req.body || {};
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }

    const { image, mediaType } = body;

    if (!image) {
      return res.status(400).json({
        error: 'No image provided'
      });
    }

    const finalMediaType = mediaType || 'image/jpeg';

    // Stop waiting if the selected free provider is too slow.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    let response;

    try {
      response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'text',
                text: EXTRACTION_PROMPT
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${finalMediaType};base64,${image}`
                }
              }
            ]
          }],
          temperature: 0,
          max_tokens: 2500
        }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    const responseText = await response.text();

    if (!response.ok) {
      console.error('OpenRouter error:', response.status, responseText);
      return res.status(response.status).json({
        error: 'OpenRouter request failed',
        details: responseText.slice(0, 500)
      });
    }

    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      console.error('Invalid OpenRouter JSON:', responseText);
      return res.status(502).json({
        error: 'Invalid response from OpenRouter'
      });
    }

    let content = data?.choices?.[0]?.message?.content || '';

    if (Array.isArray(content)) {
      content = content.map(part => {
        if (typeof part === 'string') return part;
        return part?.text || '';
      }).join('\n');
    }

    content = String(content || '');

    console.log('OpenRouter model:', data?.model || MODEL);
    console.log('OCR output length:', content.length);

    const items = parseItems(content);

    console.log('OCR parsed items:', items.length);

    return res.status(200).json({
      items
    });

  } catch (error) {
    console.error('extract.js error:', error);

    if (error?.name === 'AbortError') {
      return res.status(504).json({
        error: 'OCR ใช้เวลานานเกิน 30 วินาที กรุณาลองใหม่'
      });
    }

    return res.status(500).json({
      error: error?.message || 'OCR processing failed'
    });
  }
}
