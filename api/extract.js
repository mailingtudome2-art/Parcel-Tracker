// Vercel Serverless Function
// POST /api/extract
// { image: "<base64>", mediaType: "image/jpeg" }
// -> { items: [{ seq: 1, tracking: "WB368998512TH" }, ...] }

const MODEL = 'openrouter/free';

const EXTRACTION_PROMPT = `
You are an OCR engine for Thai postal delivery manifests.

The image contains a table of parcel tracking numbers.

IMPORTANT:
- Read EVERY visible numbered parcel entry.
- There may be 50-100+ entries.
- Do not stop early.
- Ignore recipient names, addresses, status text, document numbers and all other text.
- Only extract parcel tracking numbers from the numbered parcel table.
- The tracking number format is exactly:
  2 English letters + 9 digits + TH

Examples:
WB 3689 9851 2 TH -> WB368998512TH
JG 0674 5041 2 TH -> JG067450412TH

The printed sequence number must also be returned.

Return ONLY one entry per line:
sequence|tracking_number

Example:
1|WB368998512TH
2|WB464939383TH
3|JG067450412TH

Do not use markdown.
Do not add explanations.
Do not add headers.
Do not use code fences.

If the tracking number is printed with spaces, remove the spaces.
If it is unclear, use the visible characters and the fixed format to make your best reading.

READ ALL ENTRIES IN THE TABLE.
`;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    res.status(500).json({
      error:
        'Server is missing OPENROUTER_API_KEY. Add it in Vercel Project Settings > Environment Variables, then redeploy.'
    });
    return;
  }

  let body = req.body;

  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      body = {};
    }
  }

  const { image, mediaType } = body || {};

  if (!image || !mediaType) {
    res.status(400).json({
      error: 'Missing image or mediaType in request body'
    });
    return;
  }

  try {
    const response = await fetch(
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
                    url: `data:${mediaType};base64,${image}`
                  }
                }
              ]
            }
          ],

          temperature: 0,
          max_tokens: 6000
        })
      }
    );

    const rawResponse = await response.text();

    if (!response.ok) {
      console.error('OpenRouter error:', rawResponse);

      res.status(502).json({
        error:
          `OpenRouter API error (${response.status}): ` +
          rawResponse.slice(0, 500)
      });
      return;
    }

    let data;

    try {
      data = JSON.parse(rawResponse);
    } catch (e) {
      console.error('Invalid OpenRouter JSON:', rawResponse);

      res.status(502).json({
        error: 'OpenRouter returned invalid JSON'
      });
      return;
    }

    const message = data?.choices?.[0]?.message;

    let text = '';

    if (typeof message?.content === 'string') {
      text = message.content;
    } else if (Array.isArray(message?.content)) {
      text = message.content
        .map(part => {
          if (typeof part === 'string') return part;
          return part?.text || '';
        })
        .join('\n');
    }

    text = String(text || '').trim();

    console.log('OCR raw response:', text);

    if (!text) {
      res.status(200).json({ items: [] });
      return;
    }

    const items = [];
    const seenSeq = new Set();
    const seenTracking = new Set();

    /*
      Tracking format:

      WB368998512TH
      WB 3689 9851 2 TH
      WB-3689-9851-2-TH
    */

    const trackingRegex =
      /\b([A-Z]{2})[\s\-]*(\d{4})[\s\-]*(\d{4})[\s\-]*(\d)[\s\-]*TH\b/gi;

    const lines = text.split(/\r?\n/);

    for (const rawLine of lines) {
      const line = rawLine.trim();

      if (!line) continue;

      /*
        First try the ideal format:

        12|WB368998512TH
        12 | WB 3689 9851 2 TH
        12. WB 3689 9851 2 TH
      */

      const seqMatch = line.match(/^\s*(\d{1,3})\s*(?:[.|):\-]\s*|\|)/);

      let seq = seqMatch ? parseInt(seqMatch[1], 10) : null;

      const matches = [...line.matchAll(trackingRegex)];

      if (matches.length === 0) {
        continue;
      }

      for (const match of matches) {
        const tracking =
          (
            match[1] +
            match[2] +
            match[3] +
            match[4] +
            'TH'
          ).toUpperCase();

        /*
          If sequence number wasn't detected at the beginning,
          try finding a number immediately before the tracking code.
        */
        if (!seq) {
          const before = line.slice(0, match.index);

          const numbers = before.match(/\b\d{1,3}\b/g);

          if (numbers && numbers.length) {
            seq = parseInt(numbers[numbers.length - 1], 10);
          }
        }

        if (
          seq &&
          seq >= 1 &&
          seq <= 300 &&
          /^[A-Z]{2}\d{9}TH$/.test(tracking)
        ) {
          if (!seenSeq.has(seq) && !seenTracking.has(tracking)) {
            items.push({
              seq,
              tracking
            });

            seenSeq.add(seq);
            seenTracking.add(tracking);
          }
        }
      }
    }

    /*
      Sort by the printed sequence number.
    */
    items.sort((a, b) => a.seq - b.seq);

    console.log(
      `OCR parsed ${items.length} tracking numbers`
    );

    res.status(200).json({ items });

  } catch (err) {
    console.error('Extract error:', err);

    res.status(500).json({
      error: err.message || 'Unexpected server error'
    });
  }
};
