// Vercel Serverless Function — Google Gemini OCR backend
// POST /api/extract
//
// Request:
// {
//   image: "<base64 jpeg>",
//   mediaType: "image/jpeg",
//   columnIndex: 0
// }
//
// columnIndex:
// 0 = column 1
// 1 = column 2
// 2 = column 3
// 3 = column 4
//
// Response:
// {
//   items: [
//     { seq: 1, tracking: "WB368998512TH" }
//   ]
// }
//
// อ่านทีละคอลัมน์
// ไม่ retry
// รองรับ sequence 1-100

const MODEL =
  process.env.GEMINI_MODEL || 'gemini-3.8-flash';


// ======================================================
// Expected sequence ของแต่ละคอลัมน์
// ======================================================

function getExpectedSequences(columnIndex) {

  const column = Number(columnIndex);

  const safeColumn =
    Number.isInteger(column) && column >= 0 && column <= 3
      ? column
      : 0;

  const start = safeColumn + 1;

  const sequences = [];

  for (let seq = start; seq <= 100; seq += 4) {
    sequences.push(seq);
  }

  return sequences;
}


// ======================================================
// Prompt
// ======================================================

function buildExtractionPrompt(columnIndex) {

  const expected =
    getExpectedSequences(columnIndex);

  return `
You are a high-accuracy OCR engine for Thai postal delivery manifests
(บัญชีนำจ่าย ป.303).

You are receiving ONE cropped vertical column from a postal delivery sheet.

This image contains ONLY ONE COLUMN of the original sheet.

Column number:
${Number(columnIndex) + 1}

Expected sequence numbers for this column:

${expected.join(', ')}

TASK:

Read EVERY visible parcel row in this image from top to bottom.

IMPORTANT RULES:

1. Read every visible parcel row.
2. Do not stop early.
3. Do not skip visible rows.
4. Do not merge two rows.
5. Do not invent rows that are not visible.
6. Preserve the printed sequence number.
7. Use the expected sequence pattern to help identify the row.
8. If a tracking number is difficult to read, inspect the characters carefully and make the best reading possible.
9. Highlighted rows are valid and must be read.
10. Ignore recipient names.
11. Ignore addresses.
12. Ignore phone numbers.
13. Ignore dates.
14. Ignore prices.
15. Ignore status text.
16. Ignore headers.
17. Ignore other document numbers.

TRACKING NUMBER FORMAT:

Exactly:

2 English letters
+
9 digits
+
TH

Example:

WB368998512TH
JG067450412TH

Printed tracking numbers may contain spaces:

WB 3689 9851 2 TH

Remove spaces and hyphens.

Convert letters to uppercase.

OUTPUT:

Return exactly one line for every visible parcel:

sequence|tracking_number

Examples:

1|WB368998512TH
5|WB464939383TH
9|WB462670430TH

DO NOT output markdown.
DO NOT output a code block.
DO NOT output a header.
DO NOT output explanations.
DO NOT output comments.
DO NOT output blank lines.

ONLY output:

sequence|tracking_number

Before answering, carefully inspect the entire image from top to bottom.
Completeness is more important than explanation.
`;
}


// ======================================================
// Clean text
// ======================================================

function cleanText(text) {

  return String(text || '')
    .replace(/\r/g, '')
    .replace(/```(?:text|plaintext|txt)?/gi, '')
    .replace(/```/g, '')
    .trim();
}


// ======================================================
// Normalize tracking
// ======================================================

function normalizeTracking(value) {

  if (!value) {
    return null;
  }

  const s =
    String(value)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');

  // Correct format
  // XX123456789TH

  let match =
    s.match(/^([A-Z]{2})(\d{9})TH$/);

  if (match) {

    return (
      match[1] +
      match[2] +
      'TH'
    );
  }


  // Sometimes Gemini omits TH

  match =
    s.match(/^([A-Z]{2})(\d{9})$/);

  if (match) {

    return (
      match[1] +
      match[2] +
      'TH'
    );
  }


  return null;
}


// ======================================================
// Parse Gemini output
// ======================================================

function parseItems(text, columnIndex) {

  const cleaned =
    cleanText(text);

  const items = [];

  if (!cleaned) {
    return items;
  }


  const expectedSequences =
    new Set(
      getExpectedSequences(columnIndex)
    );


  const seenSeq =
    new Set();

  const seenTracking =
    new Set();


  const lines =
    cleaned.split('\n');


  for (const rawLine of lines) {

    const line =
      rawLine.trim();

    if (!line) {
      continue;
    }


    // -----------------------------------------------
    // ต้องมี |
    // -----------------------------------------------

    if (!line.includes('|')) {
      continue;
    }


    const parts =
      line.split('|');


    if (parts.length < 2) {
      continue;
    }


    // -----------------------------------------------
    // Sequence
    // -----------------------------------------------

    const seqText =
      String(parts[0])
        .replace(/[^0-9]/g, '');

    const seq =
      parseInt(seqText, 10);


    if (
      !Number.isInteger(seq) ||
      seq < 1 ||
      seq > 100
    ) {
      continue;
    }


    // ต้องอยู่ในคอลัมน์นี้เท่านั้น

    if (!expectedSequences.has(seq)) {
      continue;
    }


    // -----------------------------------------------
    // Tracking
    // -----------------------------------------------

    const tracking =
      normalizeTracking(
        parts
          .slice(1)
          .join('|')
      );


    if (!tracking) {
      continue;
    }


    // -----------------------------------------------
    // กัน sequence ซ้ำ
    // -----------------------------------------------

    if (seenSeq.has(seq)) {
      continue;
    }


    // -----------------------------------------------
    // กัน tracking ซ้ำ
    // -----------------------------------------------

    if (seenTracking.has(tracking)) {
      continue;
    }


    seenSeq.add(seq);
    seenTracking.add(tracking);


    items.push({
      seq,
      tracking
    });
  }


  items.sort(
    (a, b) => a.seq - b.seq
  );


  return items;
}


// ======================================================
// Main
// ======================================================

module.exports = async (req, res) => {

  // ====================================================
  // POST only
  // ====================================================

  if (req.method !== 'POST') {

    return res.status(405).json({
      error: 'Method not allowed'
    });
  }


  // ====================================================
  // API KEY
  // ====================================================

  const apiKey =
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY;


  if (!apiKey) {

    return res.status(500).json({

      error:
        'ไม่พบ GEMINI_API_KEY หรือ GOOGLE_API_KEY ใน Vercel'

    });
  }


  // ====================================================
  // Request body
  // ====================================================

  let body = req.body;


  if (typeof body === 'string') {

    try {

      body =
        JSON.parse(body);

    } catch (error) {

      return res.status(400).json({

        error:
          'Request body ไม่ใช่ JSON ที่ถูกต้อง'

      });
    }
  }


  if (!body || typeof body !== 'object') {

    return res.status(400).json({

      error:
        'ไม่พบข้อมูล request'

    });
  }


  // ====================================================
  // Image
  // ====================================================

  const image =
    body.image;


  if (
    !image ||
    typeof image !== 'string'
  ) {

    return res.status(400).json({

      error:
        'ไม่พบรูปภาพสำหรับ OCR'

    });
  }


  // ====================================================
  // Media type
  // ====================================================

  let mediaType =
    body.mediaType ||
    'image/jpeg';


  // ป้องกัน MIME แปลก ๆ

  if (
    mediaType !== 'image/jpeg' &&
    mediaType !== 'image/png' &&
    mediaType !== 'image/webp' &&
    mediaType !== 'image/heic' &&
    mediaType !== 'image/heif'
  ) {

    mediaType = 'image/jpeg';
  }


  // ====================================================
  // Column index
  // ====================================================

  let columnIndex =
    Number(body.columnIndex);


  if (
    !Number.isInteger(columnIndex) ||
    columnIndex < 0 ||
    columnIndex > 3
  ) {

    columnIndex = 0;
  }


  // ====================================================
  // Expected sequences
  // ====================================================

  const expectedSequences =
    getExpectedSequences(columnIndex);


  console.log(
    '======================================'
  );

  console.log(
    'OCR COLUMN:',
    columnIndex + 1
  );

  console.log(
    'MODEL:',
    MODEL
  );

  console.log(
    'IMAGE SIZE:',
    image.length
  );

  console.log(
    'EXPECTED:',
    expectedSequences.join(',')
  );

  console.log(
    '======================================'
  );


  try {

    // ==================================================
    // Build prompt
    // ==================================================

    const prompt =
      buildExtractionPrompt(
        columnIndex
      );


    // ==================================================
    // Gemini endpoint
    // ==================================================

    const url =
      'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(MODEL) +
      ':generateContent';


    // ==================================================
    // Timeout 30 sec
    // ==================================================

    const controller =
      new AbortController();


    const timeout =
      setTimeout(() => {

        controller.abort();

      }, 30000);


    let response;


    try {

      response =
        await fetch(url, {

          method: 'POST',

          headers: {

            'Content-Type':
              'application/json',

            'x-goog-api-key':
              apiKey

          },


          body:
            JSON.stringify({

              contents: [

                {

                  parts: [

                    {
                      inline_data: {

                        mime_type:
                          mediaType,

                        data:
                          image

                      }
                    },

                    {
                      text:
                        prompt
                    }

                  ]

                }

              ],


              // ตั้งใจไม่ใส่ temperature
              // และไม่ใส่ thinkingConfig
              // เพื่อให้เข้ากับ Gemini API ได้กว้างขึ้น

              generationConfig: {

                maxOutputTokens: 3000

              }

            }),


          signal:
            controller.signal

        });


    } finally {

      clearTimeout(timeout);
    }


    // ==================================================
    // Read Gemini response
    // ==================================================

    const responseText =
      await response.text();


    console.log(
      'Gemini HTTP status:',
      response.status
    );


    // ==================================================
    // Gemini error
    // ==================================================

    if (!response.ok) {

      console.error(
        'Gemini API ERROR:',
        response.status,
        responseText
      );


      // -----------------------------------------------
      // 400
      // -----------------------------------------------

      if (response.status === 400) {

        return res.status(400).json({

          error:
            'Gemini ปฏิเสธคำขอ (HTTP 400)',

          details:
            responseText.slice(0, 1000)

        });
      }


      // -----------------------------------------------
      // 401 / 403
      // -----------------------------------------------

      if (
        response.status === 401 ||
        response.status === 403
      ) {

        return res.status(response.status).json({

          error:
            'Gemini API Key ใช้งานไม่ได้หรือไม่มีสิทธิ์',

          details:
            responseText.slice(0, 1000)

        });
      }


      // -----------------------------------------------
      // 404
      // -----------------------------------------------

      if (response.status === 404) {

        return res.status(404).json({

          error:
            'ไม่พบ Gemini model: ' + MODEL,

          details:
            responseText.slice(0, 1000)

        });
      }


      // -----------------------------------------------
      // 413
      // -----------------------------------------------

      if (response.status === 413) {

        return res.status(413).json({

          error:
            'รูปภาพคอลัมน์ใหญ่เกินไป (HTTP 413)'

        });
      }


      // -----------------------------------------------
      // 429
      // -----------------------------------------------

      if (response.status === 429) {

        return res.status(429).json({

          error:
            'Gemini จำกัดจำนวนคำขอชั่วคราว (HTTP 429)'

        });
      }


      // -----------------------------------------------
      // Other
      // -----------------------------------------------

      return res.status(response.status).json({

        error:
          'Gemini API error (' +
          response.status +
          ')',

        details:
          responseText.slice(0, 1000)

      });
    }


    // ==================================================
    // Parse JSON
    // ==================================================

    let data;


    try {

      data =
        JSON.parse(responseText);

    } catch (error) {

      console.error(
        'Gemini returned invalid JSON:',
        responseText
      );


      return res.status(502).json({

        error:
          'Gemini ตอบกลับข้อมูลไม่ถูกต้อง',

        details:
          responseText.slice(0, 1000)

      });
    }


    // ==================================================
    // Candidate
    // ==================================================

    const candidate =
      data?.candidates?.[0];


    if (!candidate) {

      console.error(
        'No Gemini candidate:',
        JSON.stringify(data).slice(0, 3000)
      );


      return res.status(502).json({

        error:
          'Gemini ไม่ส่งผล OCR กลับมา',

        details:
          JSON.stringify(data).slice(0, 1000)

      });
    }


    // ==================================================
    // Get text
    // ==================================================

    const outputParts =
      candidate?.content?.parts || [];


    const text =
      outputParts
        .map(part => part?.text || '')
        .join('\n')
        .trim();


    console.log(
      'Gemini output length:',
      text.length
    );


    console.log(
      'Gemini raw output:',
      text.slice(0, 5000)
    );


    // ==================================================
    // Parse OCR
    // ==================================================

    const items =
      parseItems(
        text,
        columnIndex
      );


    console.log(
      'Parsed items:',
      items.length
    );


    console.log(
      'Parsed:',
      JSON.stringify(items)
    );


    // ==================================================
    // Success but no result
    // ==================================================

    if (items.length === 0) {

      return res.status(200).json({

        items: [],

        columnIndex,

        warning:
          'Gemini ไม่พบเลขพัสดุที่อ่านได้ในคอลัมน์นี้'

      });
    }


    // ==================================================
    // Success
    // ==================================================

    return res.status(200).json({

      items,

      columnIndex

    });


  } catch (error) {

    console.error(
      'extract.js ERROR:',
      error
    );


    // ==================================================
    // Timeout
    // ==================================================

    if (
      error &&
      error.name === 'AbortError'
    ) {

      return res.status(504).json({

        error:
          'OCR คอลัมน์นี้ใช้เวลานานเกิน 30 วินาที'

      });
    }


    // ==================================================
    // Other error
    // ==================================================

    return res.status(500).json({

      error:
        error?.message ||
        'OCR processing failed'

    });
  }

};
