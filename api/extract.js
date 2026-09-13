// Vercel Serverless Function — Google Gemini backend
// POST /api/extract  { image: "<base64 jpeg>", mediaType: "image/jpeg" }
// -> { items: [{ seq: 1, tracking: "OB092923817TH" }, ...] }
//
// Your Gemini API key lives only here, as an environment variable on the
// server (set it in your Vercel project's Settings -> Environment Variables
// as GOOGLE_API_KEY). It is never sent to the browser.
//
// NOTE on model names: Google renames/rotates its free "Flash" model
// fairly often. GEMINI_MODEL defaults to "gemini-flash-latest", a floating
// alias Google keeps pointed at a current Flash model. If that ever 404s,
// check https://ai.google.dev/gemini-api/docs/models for the current
// recommended Flash model name, and set GEMINI_MODEL to it (no code change
// needed — it's an environment variable).

const EXTRACTION_PROMPT = `This image is a Thai postal/courier delivery manifest listing parcels (e.g. บัญชีนำจ่าย ป.303, or a plain ลำดับที่ / หมายเลขสิ่งของ list). Layouts vary between sheets: it might be a repeating multi-column grid, or a simple table with a sequence number column next to a tracking number column, possibly split into several side-by-side column groups on one page. Some tracking numbers are printed with spaces (e.g. "WB 3689 9851 2 TH"), others are printed as one unspaced string (e.g. "ED147663597TH"). Some entries are marked with a highlighter in yellow, orange, or another color — some sheets have no highlighting at all. Ignore highlight color entirely; read every entry regardless of whether or how it's marked. Recipient names may sit immediately next to the tracking number with no space, or be redacted with asterisks — ignore names entirely, only extract the tracking number.

Every tracking number follows the fixed format: 2 letters + 9 digits + "TH" (13 characters total). The trailing "TH" is always the same, so to keep your answer short, do NOT include it in your output — only output the 2 letters + 9 digits (11 characters).

Read EVERY numbered entry visible in the image — there may be 50-100+ entries on one sheet, read all of them, in order of their printed sequence number (ลำดับ / ลำดับที่), regardless of which column group it physically sits in. Completeness matters more than anything else: never stop partway through.

Output ONLY plain text, one entry per line, in this exact compact format with no extra text, no markdown, no headers, no code fences, no blank lines:
<seq>|<2 letters><9 digits>

Example line (for a tracking number printed as "OB 4102 5193 1 TH"):
6|OB410251931

If a tracking number is unclear, do your best to read it using the fixed format (2 letters, then 9 digits) as a guide. If the image contains no such table, output nothing.`;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: 'Server is missing GOOGLE_API_KEY. Add it in Vercel Project Settings > Environment Variables, then redeploy.'
    });
    return;
  }

  const model = process.env.GEMINI_MODEL || 'gemini-flash-latest';

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const { image, mediaType } = body || {};
  if (!image || !mediaType) {
    res.status(400).json({ error: 'Missing image or mediaType in request body' });
    return;
  }

  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: mediaType, data: image } },
            { text: EXTRACTION_PROMPT }
          ]
        }],
        generationConfig: { maxOutputTokens: 6000 }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      res.status(502).json({ error: 'Gemini API error (' + response.status + '): ' + errText.slice(0, 400) });
      return;
    }

    const data = await response.json();
    const candidate = (data.candidates || [])[0];
    const parts = (candidate && candidate.content && candidate.content.parts) || [];
    const text = parts.map((p) => p.text || '').join('\n').trim();

    const items = [];
    if (text) {
      const lines = text.split('\n');
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.indexOf('|') === -1) continue;
        const [seqPart, codePart] = line.split('|');
        const seq = parseInt(seqPart.replace(/[^0-9]/g, ''), 10);
        const code = codePart.trim().toUpperCase().replace(/\s+/g, '').replace(/TH$/, '');
        if (!isNaN(seq) && /^[A-Z]{2}[0-9]{9}$/.test(code)) {
          items.push({ seq, tracking: code + 'TH' });
        }
      }
    }

    res.status(200).json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Unexpected server error' });
  }
};

