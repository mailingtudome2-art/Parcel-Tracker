const MODEL = 'openrouter/free';

const EXTRACTION_PROMPT = `
You are an OCR assistant for Thai postal delivery manifests.

Read the parcel tracking numbers from the image.

IMPORTANT:
- Read EVERY numbered parcel entry that is visible.
- The sheet may contain 50-100+ parcel entries.
- Do NOT stop after finding a few entries.
- Ignore recipient names, addresses, phone numbers, prices, status text, dates, and other fields.
- The tracking number normally has this format:
  2 English letters + 9 digits + TH

Examples:
1|WB368998512TH
2|WB464939383TH
3|WB462670430TH
4|JG067450412TH

Output ONLY:
sequence|tracking_number

Rules:
- One parcel per line.
- Keep the original sequence number.
- Remove spaces and hyphens from tracking numbers.
- Convert letters to uppercase.
- Do not output markdown.
- Do not output explanations.
- Do not output a header.
- Do not output extra text.
- If a tracking number is slightly unclear, choose the most likely reading.
- Try very hard to read all rows, including rows near the bottom of the table.
`;

function cleanText(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, (block) =>
      block
        .replace(/```[a-zA-Z]*\n?/g, '')
        .replace(/```/g, '')
    )
    .replace(/\r/g, '');
}

function normalizeTracking(value) {
  if (!value) return null;

  let s = String(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

  // Expected format: AA + 9 digits + TH
  const match = s.match(/^([A-Z]{2})(\d{9})TH$/);

  if (!match) return null;

  return `${match[1]}${match[2]}TH`;
}

function parseItems(text) {
  const items = [];
  const seenSeq = new Set();
  const seenTracking = new Set();

  const cleaned = cleanText(text);

  // --------------------------------------------------
  // Method 1:
  // Parse explicit lines such as:
  // 1|WB368998512TH
  // 2. WB464939383TH
  // 3: JG067450412TH
  // --------------------------------------------------

  const lines = cleaned.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) continue;

    // Find sequence number at the beginning of the line
    const seqMatch = line.match(
      /^\s*(\d{1,3})\s*(?:[.|):\-]\s*|\|)\s*/
    );

    let seq = null;

    if (seqMatch) {
      seq = Number(seqMatch[1]);
    }

    // Find tracking number in the line
    const trackingMatch = line.match(
      /\b([A-Z]{2})[\s\-]*(\d{4})[\s\-]*(\d{4})[\s\-]*(\d)[\s\-]*TH\b/i
    );

    if (!trackingMatch) continue;

    const tracking = normalizeTracking(
      `${trackingMatch[1]}${trackingMatch[2]}${trackingMatch[3]}${trackingMatch[4]}TH`
    );

    if (!tracking) continue;

    // If no sequence was detected at the beginning,
    // try to find a number immediately before the tracking number.
    if (seq === null) {
      const beforeTracking = line.slice(
        0,
        trackingMatch.index
      );

      const fallbackSeq = beforeTracking.match(
        /(?:^|\s)(\d{1,3})\s*$/
      );

      if (fallbackSeq) {
        seq = Number(fallbackSeq[1]);
      }
    }

    if (seq === null) continue;

    if (seq < 1 || seq > 300) continue;

    if (seenSeq.has(seq)) continue;
    if (seenTracking.has(tracking)) continue;

    seenSeq.add(seq);
    seenTracking.add(tracking);

    items.push({
      seq,
      tracking
    });
  }

  // --------------------------------------------------
  // Method 2:
  // If the model did not format the output correctly,
  // scan the whole response for tracking numbers.
  // --------------------------------------------------

  if (items.length === 0) {
    const regex =
      /\b([A-Z]{2})[\s\-]*(\d{4})[\s\-]*(\d{4})[\s\-]*(\d)[\s\-]*TH\b/gi;

    let match;

    while ((match = regex.exec(cleaned)) !== null) {
      const tracking = normalizeTracking(
        `${match[1]}${match[2]}${match[3]}${match[4]}TH`
      );

      if (!tracking) continue;

      if (seenTracking.has(tracking)) continue;

      seenTracking.add(tracking);

      items.push({
        seq: items.length + 1,
        tracking
      });
    }
  }

  // Sort by sequence number
  items.sort((a, b) => a.seq - b.seq);

  return items;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Method not allowed'
    });
  }

  try {
    const apiKey = process.env.OPENROUTER_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: 'OPENROUTER_API_KEY is not configured'
      });
    }

    const { image, mediaType } = req.body || {};

    if (!image) {
      return res.status(400).json({
        error: 'No image provided'
      });
    }

    const finalMediaType =
      mediaType || 'image/jpeg';

    // --------------------------------------------------
    // 30-second timeout
    // Prevent the app from waiting forever if the
    // selected free provider is slow or stuck.
    // --------------------------------------------------

    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, 30000);

    let response;

    try {
      response = await fetch(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          method: 'POST',

          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
          },

          body: JSON.stringify({
            model: MODEL,

            messages: [
              {
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
              }
            ],

            temperature: 0,

            // Reduced from 6000.
            // 2500 is enough for roughly 100+ OCR lines
            // while limiting unnecessarily long generation.
            max_tokens: 2500
          }),

          signal: controller.signal
        }
      );
    } finally {
      clearTimeout(timeout);
    }

    // --------------------------------------------------
    // Handle timeout
    // --------------------------------------------------

    if (!response) {
      return res.status(504).json({
        error: 'OCR request timed out'
      });
    }

    const responseText = await response.text();

    if (!response.ok) {
      console.error(
        'OpenRouter error:',
        response.status,
        responseText
      );

      return res.status(response.status).json({
        error: 'OpenRouter request failed',
        details: responseText
      });
    }

    let data;

    try {
      data = JSON.parse(responseText);
    } catch (err) {
      console.error(
        'Invalid OpenRouter JSON:',
        responseText
      );

      return res.status(502).json({
        error: 'Invalid response from OpenRouter'
      });
    }

    // --------------------------------------------------
    // Extract model output
    // --------------------------------------------------

    let content =
      data?.choices?.[0]?.message?.content || '';

    // Some providers may return content as an array.
    if (Array.isArray(content)) {
      content = content
        .map(part => {
          if (typeof part === 'string') {
            return part;
          }

          if (part?.text) {
            return part.text;
          }

          return '';
        })
        .join('\n');
    }

    content = String(content || '');

    console.log(
      'OpenRouter model:',
      data?.model || MODEL
    );

    console.log(
      'OCR raw output:',
      content.slice(0, 5000)
    );

    // --------------------------------------------------
    // Parse tracking numbers
    // --------------------------------------------------

    const items = parseItems(content);

    console.log(
      'OCR parsed items:',
      items.length
    );

    if (items.length === 0) {
      return res.status(200).json({
        items: [],
        raw: content
      });
    }

    return res.status(200).json({
      items
    });

  } catch (error) {

    console.error(
      'extract.js error:',
      error
    );

    // AbortController timeout
    if (error?.name === 'AbortError') {
      return res.status(504).json({
        error: 'OCR ใช้เวลานานเกิน 30 วินาที'
      });
    }

    return res.status(500).json({
      error:
        error?.message ||
        'OCR processing failed'
    });
  }
}
