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
// รองรับสูงสุด 100 รายการ / 1 แผ่น
// อ่านทีละคอลัมน์ เพื่อลดปัญหา 413 และช่วยให้ OCR แม่นขึ้น

const MODEL =
  process.env.GEMINI_MODEL || 'gemini-3.8-flash';


// ======================================================
// สร้าง sequence ที่คาดว่าจะอยู่ในแต่ละคอลัมน์
//
// รองรับ 1-100
//
// Column 1:
// 1,5,9,13,...,97
//
// Column 2:
// 2,6,10,14,...,98
//
// Column 3:
// 3,7,11,15,...,99
//
// Column 4:
// 4,8,12,16,...,100
// ======================================================

function getExpectedSequences(columnIndex){

  const column =
    Number.isInteger(Number(columnIndex))
      ? Number(columnIndex)
      : 0;

  const start =
    Math.max(1, Math.min(4, column + 1));

  const sequences = [];

  for(let seq = start; seq <= 100; seq += 4){
    sequences.push(seq);
  }

  return sequences;
}


// ======================================================
// Prompt สำหรับ Gemini
// ======================================================

function buildExtractionPrompt(columnIndex){

  const expected =
    getExpectedSequences(columnIndex);

  const expectedText =
    expected.join(', ');

  return `
You are a high-accuracy OCR engine for Thai postal delivery manifests
(บัญชีนำจ่าย ป.303).

You are receiving ONE cropped vertical column from a postal delivery sheet.

This is NOT the whole sheet.
Only read the parcel rows visible in this image.

The sheet can contain up to 100 parcel entries.

This image is column ${Number(columnIndex) + 1} of 4.

Expected sequence numbers for this column are:

${expectedText}

IMPORTANT OCR RULES:

1. Read EVERY visible parcel row in this column.
2. Do NOT stop early.
3. Do NOT skip rows.
4. Do NOT merge two rows.
5. Do NOT invent a parcel that is not visible.
6. Preserve the printed sequence number.
7. Use the expected sequence pattern above to help identify rows.
8. If a row is visible but the tracking number is difficult to read,
   make the best possible reading from the visible characters.
9. Highlighted rows are still valid rows and MUST be read.
10. Ignore recipient names.
11. Ignore addresses.
12. Ignore phone numbers.
13. Ignore dates.
14. Ignore status text.
15. Ignore prices.
16. Ignore headers and other non-tracking text.

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

The printed tracking number may contain spaces, for example:

WB 3689 9851 2 TH

Remove all spaces and hyphens.

Convert letters to uppercase.

The final result must look like:

WB368998512TH

OUTPUT FORMAT:

Return exactly ONE line for each visible parcel:

sequence|tracking_number

Example:

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

Completeness is more important than explanation.

Before answering, carefully inspect EVERY row in the image from top to bottom.
`;
}


// ======================================================
// Clean Gemini output
// ======================================================

function cleanText(text){

  return String(text || '')
    .replace(/\r/g, '')
    .replace(/```(?:text|plaintext)?/gi, '')
    .replace(/```/g, '')
    .trim();

}


// ======================================================
// Normalize tracking number
// ======================================================

function normalizeTracking(value){

  if(!value){
    return null;
  }

  const s =
    String(value)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');

  // Correct format:
  // 2 letters + 9 digits + TH

  let match =
    s.match(/^([A-Z]{2})(\d{9})TH$/);

  if(match){

    return (
      `${match[1]}${match[2]}TH`
    );

  }


  // Gemini may occasionally omit TH.
  // Add it back.

  match =
    s.match(/^([A-Z]{2})(\d{9})$/);

  if(match){

    return (
      `${match[1]}${match[2]}TH`
    );

  }


  return null;

}


// ======================================================
// Parse Gemini output
// ======================================================

function parseItems(text, columnIndex){

  const cleaned =
    cleanText(text);

  const items = [];

  const seenSeq =
    new Set();

  const seenTracking =
    new Set();

  if(!cleaned){
    return items;
  }

  const expectedSequences =
    new Set(
      getExpectedSequences(columnIndex)
    );


  for(const rawLine of cleaned.split('\n')){

    const line =
      rawLine.trim();

    if(!line){
      continue;
    }


    const parts =
      line.split('|');

    if(parts.length < 2){
      continue;
    }


    // --------------------------------------------------
    // Sequence
    // --------------------------------------------------

    const seqText =
      String(parts[0])
        .replace(/[^0-9]/g, '');

    const seq =
      parseInt(seqText, 10);

    if(
      !Number.isInteger(seq) ||
      seq < 1 ||
      seq > 100
    ){
      continue;
    }


    // ต้องเป็น sequence ที่ควรอยู่ในคอลัมน์นี้
    if(!expectedSequences.has(seq)){
      continue;
    }


    // --------------------------------------------------
    // Tracking
    // --------------------------------------------------

    const tracking =
      normalizeTracking(
        parts.slice(1).join('|')
      );

    if(!tracking){
      continue;
    }


    // --------------------------------------------------
    // ป้องกัน sequence ซ้ำ
    // --------------------------------------------------

    if(seenSeq.has(seq)){
      continue;
    }


    // --------------------------------------------------
    // ป้องกัน tracking ซ้ำ
    // --------------------------------------------------

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


  items.sort(
    (a, b) => a.seq - b.seq
  );


  return items;

}


// ======================================================
// Main Vercel Function
// ======================================================

module.exports = async (req, res) => {

  // ----------------------------------------------------
  // Method
  // ----------------------------------------------------

  if(req.method !== 'POST'){

    res.status(405).json({
      error: 'Method not allowed'
    });

    return;

  }


  // ----------------------------------------------------
  // API KEY
  // ----------------------------------------------------

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


  // ----------------------------------------------------
  // Parse request body
  // ----------------------------------------------------

  let body =
    req.body;


  if(typeof body === 'string'){

    try{

      body =
        JSON.parse(body);

    }catch(e){

      body = {};

    }

  }


  // ----------------------------------------------------
  // Get image
  // ----------------------------------------------------

  const image =
    body?.image;


  const mediaType =
    body?.mediaType ||
    'image/jpeg';


  let columnIndex =
    Number(body?.columnIndex);


  if(
    !Number.isInteger(columnIndex) ||
    columnIndex < 0 ||
    columnIndex > 3
  ){

    columnIndex = 0;

  }


  // ----------------------------------------------------
  // Validate image
  // ----------------------------------------------------

  if(
    !image ||
    typeof image !== 'string'
  ){

    res.status(400).json({

      error:
        'ไม่พบรูปภาพสำหรับ OCR'

    });

    return;

  }


  // ----------------------------------------------------
  // Expected sequence
  // ----------------------------------------------------

  const expectedSequences =
    getExpectedSequences(columnIndex);


  console.log(
    'OCR column:',
    columnIndex + 1
  );


  console.log(
    'Expected sequences:',
    expectedSequences.join(',')
  );


  try{

    // --------------------------------------------------
    // Gemini request
    // --------------------------------------------------

    const prompt =
      buildExtractionPrompt(
        columnIndex
      );


    const url =
      'https://generativelanguage.googleapis.com/v1beta/models/' +
      MODEL +
      ':generateContent';


    const controller =
      new AbortController();


    // จำกัดเวลาต่อคอลัมน์
    // แต่ไม่ retry
    const timeout =
      setTimeout(
        () => controller.abort(),
        30000
      );


    let response;


    try{

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


              generationConfig: {

                temperature: 0,

                maxOutputTokens: 2500,

                thinkingConfig: {

                  thinkingLevel:
                    'low'

                }

              }

            }),


          signal:
            controller.signal

        });


    }finally{

      clearTimeout(timeout);

    }


    // --------------------------------------------------
    // Read response
    // --------------------------------------------------

    const responseText =
      await response.text();


    console.log(
      'Gemini status:',
      response.status
    );


    if(!response.ok){

      console.error(
        'Gemini API error:',
        response.status,
        responseText
      );


      // ------------------------------------------------
      // Rate limit
      // ------------------------------------------------

      if(response.status === 429){

        res.status(429).json({

          error:
            'Gemini จำกัดจำนวนคำขอชั่วคราว (HTTP 429)'

        });

        return;

      }


      // ------------------------------------------------
      // Request too large
      // ------------------------------------------------

      if(response.status === 413){

        res.status(413).json({

          error:
            'รูปภาพคอลัมน์ใหญ่เกินไป (HTTP 413)'

        });

        return;

      }


      res.status(response.status).json({

        error:
          'Gemini API error (' +
          response.status +
          '): ' +
          responseText.slice(0, 500)

      });

      return;

    }


    // --------------------------------------------------
    // Parse Gemini JSON
    // --------------------------------------------------

    let data;


    try{

      data =
        JSON.parse(responseText);

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


    // --------------------------------------------------
    // Get generated text
    // --------------------------------------------------

    const candidate =
      data?.candidates?.[0];


    const outputParts =
      candidate?.content?.parts || [];


    const text =
      outputParts
        .map(
          part => part?.text || ''
        )
        .join('\n')
        .trim();


    console.log(
      'Gemini model:',
      MODEL
    );


    console.log(
      'Column:',
      columnIndex + 1
    );


    console.log(
      'OCR output length:',
      text.length
    );


    // --------------------------------------------------
    // Parse OCR result
    // --------------------------------------------------

    const items =
      parseItems(
        text,
        columnIndex
      );


    console.log(
      'OCR parsed items:',
      items.length
    );


    // --------------------------------------------------
    // Log raw output for troubleshooting
    // --------------------------------------------------

    console.log(
      'Gemini OCR raw output:',
      text.slice(0, 5000)
    );


    // --------------------------------------------------
    // No result
    // --------------------------------------------------

    if(items.length === 0){

      res.status(200).json({

        items: [],

        warning:
          'Gemini ไม่พบเลขพัสดุที่อ่านได้ในคอลัมน์นี้'

      });

      return;

    }


    // --------------------------------------------------
    // Success
    // --------------------------------------------------

    res.status(200).json({

      items

    });


  }catch(error){

    console.error(
      'extract.js error:',
      error
    );


    // --------------------------------------------------
    // Timeout
    // --------------------------------------------------

    if(error?.name === 'AbortError'){

      res.status(504).json({

        error:
          'OCR คอลัมน์นี้ใช้เวลานานเกิน 30 วินาที'

      });

      return;

    }


    // --------------------------------------------------
    // Other error
    // --------------------------------------------------

    res.status(500).json({

      error:
        error?.message ||
        'OCR processing failed'

    });

    return;

  }

};
