// Vercel Serverless Function — Google Gemini OCR backend
// POST /api/extract
//
// Request:
// {
//   images: ["<base64 jpeg>", "<base64 jpeg>", "<base64 jpeg>", "<base64 jpeg>"],
//   mediaType: "image/jpeg"
// }
//
// The browser sends FOUR cropped column images in ONE Gemini request.
// Response:
// { items: [{ seq: 1, tracking: "WB368998512TH" }, ...] }

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

const EXTRACTION_PROMPT = `
You are an OCR engine for Thai postal delivery manifests (บัญชีนำจ่าย ป.303).

IMPORTANT:
You are receiving FOUR images in ONE request.
They are the four original vertical column groups from the SAME sheet.

Image 1 = original column 1
Expected sequence numbers in image 1:
1, 5, 9, 13, 17, 21, 25, 29, 33, 37, 41, 45, 49, 53, 57, 61, 65, 69, 73, 77, 81

Image 2 = original column 2
Expected sequence numbers in image 2:
2, 6, 10, 14, 18, 22, 26, 30, 34, 38, 42, 46, 50, 54, 58, 62, 66, 70, 74, 78, 82

Image 3 = original column 3
Expected sequence numbers in image 3:
3, 7, 11, 15, 19, 23, 27, 31, 35, 39, 43, 47, 51, 55, 59, 63, 67, 71, 75, 79

Image 4 = original column 4
Expected sequence numbers in image 4:
4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 68, 72, 76, 80

This sheet should contain 82 parcel entries total.

YOUR MAIN TASK:
Read every visible parcel tracking number from ALL FOUR images.
Do not stop early.
Do not skip rows.
Completeness is more important than explanation.

Tracking-number format:
- exactly 2 English letters
- followed by exactly 9 digits
- followed by TH
- examples: WB368998512TH, JG067450412TH
- the printed form may contain spaces, for example:
  WB 3689 9851 2 TH

Output:
- one line per parcel
- preserve the printed sequence number
- output exactly:
  sequence|tracking_number

Examples:
1|WB368998512TH
2|WB464939383TH
3|WB462670430TH

Rules:
- Remove spaces and hyphens from tracking numbers.
- Convert letters to uppercase.
- Always include the final TH.
- Ignore recipient names, addresses, phone numbers, dates, status text, prices, headers, and other non-tracking text.
- If a tracking number is difficult to read, use the fixed 2-letters + 9-digits + TH format to make the best possible reading.
- Do NOT invent a parcel that is not visible.
- Do NOT merge two rows.
- Do NOT return markdown.
- Do NOT return a header.
- Do NOT return explanations.
- Do NOT return blank lines.
- Return all visible rows, including highlighted rows.
`;

function cleanText(text){
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/```(?:text|plaintext)?/gi, '')
    .replace(/```/g, '')
    .trim();
}

function normalizeTracking(value){
  if(!value) return null;

  const s = String(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

  let match = s.match(/^([A-Z]{2})(\d{9})TH$/);

  if(match){
    return `${match[1]}${match[2]}TH`;
  }

  // Accept output where Gemini omitted the final TH.
  match = s.match(/^([A-Z]{2})(\d{9})$/);

  if(match){
    return `${match[1]}${match[2]}TH`;
  }

  return null;
}

function parseItems(text){
  const cleaned = cleanText(text);

  const items = [];
  const seenSeq = new Set();
  const seenTracking = new Set();

  if(!cleaned){
    return items;
  }

  for(const rawLine of cleaned.split('\n')){
    const line = rawLine.trim();

    if(!line){
      continue;
    }

    const parts = line.split('|');

    if(parts.length < 2){
      continue;
    }

    const seqText = String(parts[0])
      .replace(/[^0-9]/g, '');

    const seq = parseInt(seqText, 10);

    if(!Number.isInteger(seq) || seq < 1 || seq > 999){
      continue;
    }

    const tracking = normalizeTracking(
      parts.slice(1).join('|')
    );

    if(!tracking){
      continue;
    }

    if(seenSeq.has(seq)){
      continue;
    }

    if(seenTracking.has(tracking)){
      continue;
    }

    seenSeq.add(seq);
    seenTracking.add(tracking);

    items.push({
      seq,
      tracking
    });
  }

  items.sort((a, b) => a.seq - b.seq);

  return items;
}

module.exports = async (req, res) => {

  if(req.method !== 'POST'){
    res.status(405).json({
      error: 'Method not allowed'
    });

    return;
  }

  const apiKey =
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY;

  if(!apiKey){
    res.status(500).json({
      error:
        'ไม่พบ GEMINI_API_KEY หรือ GOOGLE_API_KEY ใน Vercel'
    });

    return;
  }

  let body = req.body;

  if(typeof body === 'string'){
    try{
      body = JSON.parse(body);
    }catch(e){
      body = {};
    }
  }

  const mediaType =
    body?.mediaType || 'image/jpeg';

  let images =
    Array.isArray(body?.images)
      ? body.images
      : [];

  // Backward compatibility with old one-image frontend.
  if(images.length === 0 && body?.image){
    images = [body.image];
  }

  if(images.length === 0){
    res.status(400).json({
      error: 'ไม่พบรูปภาพสำหรับ OCR'
    });

    return;
  }

  // Maximum 4 columns.
  if(images.length > 4){
    images = images.slice(0, 4);
  }

  try{

    const parts = [];

    for(let i = 0; i < images.length; i++){

      if(
        !images[i] ||
        typeof images[i] !== 'string'
      ){
        continue;
      }

      parts.push({
        inline_data: {
          mime_type: mediaType,
          data: images[i]
        }
      });
    }

    if(parts.length === 0){
      res.status(400).json({
        error: 'รูปภาพไม่ถูกต้อง'
      });

      return;
    }

    parts.push({
      text: EXTRACTION_PROMPT
    });

    const url =
      'https://generativelanguage.googleapis.com/v1beta/models/' +
      MODEL +
      ':generateContent';

    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () => controller.abort(),
        30000
      );

    let response;

    try{

      response = await fetch(url, {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },

        body: JSON.stringify({

          contents: [
            {
              parts
            }
          ],

          generationConfig: {
            temperature: 0,

            maxOutputTokens: 3000,

            thinkingConfig: {
              thinkingLevel: 'low'
            }
          }

        }),

        signal: controller.signal
      });

    }finally{

      clearTimeout(timeout);

    }

    const responseText =
      await response.text();

    if(!response.ok){

      console.error(
        'Gemini error:',
        response.status,
        responseText
      );

      res.status(response.status).json({
        error:
          'Gemini API error (' +
          response.status +
          '): ' +
          responseText.slice(0, 500)
      });

      return;
    }

    let data;

    try{

      data = JSON.parse(responseText);

    }catch(e){

      console.error(
        'Invalid Gemini JSON:',
        responseText
      );

      res.status(502).json({
        error:
          'Gemini ตอบกลับข้อมูลไม่ถูกต้อง'
      });

      return;
    }

    const candidate =
      data?.candidates?.[0];

    const outputParts =
      candidate?.content?.parts || [];

    const text =
      outputParts
        .map(part => part?.text || '')
        .join('\n')
        .trim();

    console.log(
      'Gemini model:',
      MODEL
    );

    console.log(
      'OCR output length:',
      text.length
    );

    const items =
      parseItems(text);

    console.log(
      'OCR parsed items:',
      items.length
    );

    if(items.length === 0){

      console.error(
        'Gemini OCR raw output:',
        text.slice(0, 5000)
      );

      res.status(200).json({
        items: [],
        warning:
          'Gemini ไม่พบเลขพัสดุที่อ่านได้'
      });

      return;
    }

    res.status(200).json({
      items
    });

  }catch(error){

    console.error(
      'extract.js error:',
      error
    );

    if(error?.name === 'AbortError'){

      res.status(504).json({
        error:
          'OCR ใช้เวลานานเกิน 30 วินาที กรุณาลองใหม่'
      });

      return;
    }

    res.status(500).json({
      error:
        error?.message ||
        'OCR processing failed'
    });

  }

};
