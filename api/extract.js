// api/extract.js
// Gemini OCR for ป.303 SCANNER

const MODEL = 'gemini-3.8-flash';

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY;

const MAX_OUTPUT_TOKENS = 2500;
const TIMEOUT_MS = 30000;


// ============================================================
// Normalize tracking number
// ============================================================

function normalizeTracking(value) {
  if (!value) return null;

  let s = String(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

  // รูปแบบ:
  // XX + 9 digits + TH
  const match = s.match(/^([A-Z]{2})(\d{9})TH$/);

  if (!match) return null;

  return `${match[1]}${match[2]}TH`;
}


// ============================================================
// Extract tracking numbers from Gemini text
// ============================================================

function extractTrackingNumbers(text) {
  if (!text) return [];

  const found = [];

  // ----------------------------------------------------------
  // Pattern 1:
  // WB 4245 7161 1 TH
  // ----------------------------------------------------------

  const spacedRegex =
    /\b([A-Z]{2})\s*(\d{4})\s*(\d{4})\s*(\d)\s*TH\b/gi;

  let match;

  while ((match = spacedRegex.exec(text)) !== null) {

    const code = normalizeTracking(
      `${match[1]}${match[2]}${match[3]}${match[4]}TH`
    );

    if (code) {
      found.push(code);
    }
  }


  // ----------------------------------------------------------
  // Pattern 2:
  // WB424571611TH
  // ----------------------------------------------------------

  const compactRegex =
    /\b[A-Z]{2}\d{9}TH\b/gi;

  while ((match = compactRegex.exec(text)) !== null) {

    const code = normalizeTracking(match[0]);

    if (code) {
      found.push(code);
    }
  }


  // ----------------------------------------------------------
  // Pattern 3:
  // WB-4245-7161-1-TH
  // ----------------------------------------------------------

  const looseRegex =
    /\b([A-Z]{2})[^A-Z0-9]{0,5}(\d{4})[^A-Z0-9]{0,5}(\d{4})[^A-Z0-9]{0,5}(\d)[^A-Z0-9]{0,5}TH\b/gi;

  while ((match = looseRegex.exec(text)) !== null) {

    const code = normalizeTracking(
      `${match[1]}${match[2]}${match[3]}${match[4]}TH`
    );

    if (code) {
      found.push(code);
    }
  }


  // ----------------------------------------------------------
  // Remove duplicates
  // ----------------------------------------------------------

  const unique = [];
  const seen = new Set();

  for (const code of found) {

    if (!seen.has(code)) {
      seen.add(code);
      unique.push(code);
    }

  }

  return unique;
}


// ============================================================
// Convert to the exact format expected by index.html
// ============================================================

function makeItems(codes) {

  return codes.map((tracking, index) => ({
    seq: index + 1,
    tracking: tracking
  }));

}


// ============================================================
// Gemini API handler
// ============================================================

export default async function handler(req, res) {

  // ----------------------------------------------------------
  // CORS
  // ----------------------------------------------------------

  res.setHeader(
    'Access-Control-Allow-Origin',
    '*'
  );

  res.setHeader(
    'Access-Control-Allow-Methods',
    'POST, OPTIONS'
  );

  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type'
  );


  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }


  if (req.method !== 'POST') {

    return res.status(405).json({
      error: 'Method not allowed'
    });

  }


  // ----------------------------------------------------------
  // API KEY
  // ----------------------------------------------------------

  if (!GEMINI_API_KEY) {

    return res.status(500).json({
      error:
        'ไม่พบ GEMINI_API_KEY ใน Environment Variables ของ Vercel'
    });

  }


  try {

    const body = req.body || {};

    const image = body.image;

    const mediaType =
      body.mediaType || 'image/jpeg';


    if (!image) {

      return res.status(400).json({
        error: 'ไม่พบรูปภาพ'
      });

    }


    // --------------------------------------------------------
    // Allowed image types
    // --------------------------------------------------------

    const allowedTypes = [
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/webp'
    ];

    const safeMediaType =
      allowedTypes.includes(mediaType)
        ? mediaType
        : 'image/jpeg';


    // ========================================================
    // OCR PROMPT
    // ========================================================

    const prompt = `
คุณคือ OCR สำหรับอ่านเลขพัสดุจากใบนำจ่ายไปรษณีย์ไทย ป.303

ภาพนี้เป็น "ตาราง NON-COD"
มีรายการพัสดุทั้งหมดประมาณ 82 รายการ

ภาพที่ได้รับอาจถูก crop และจัดเป็นภาพ 2x2
โดยมีข้อมูลจากตารางเดิมทั้งหมด 4 คอลัมน์

สำคัญมาก:

ต้องอ่านทั้ง 4 ช่องของภาพ
ห้ามอ่านเฉพาะช่องใดช่องหนึ่ง

ให้ตรวจทุกแถวตั้งแต่ด้านบนจนถึงด้านล่าง
และพยายามอ่านเลขพัสดุทุกเลขที่มองเห็น

เลขพัสดุมีรูปแบบ:

XX 1234 5678 9 TH

หรือ

XX123456789TH

ตัวอย่าง:

WB 4876 8017 7 TH
WB 5016 6616 3 TH
WB 4245 7161 1 TH
JD 0852 7423 2 TH

รูปแบบที่ถูกต้องคือ:

ตัวอักษรอังกฤษ 2 ตัว
+
ตัวเลข 9 ตัว
+
TH

เช่น:

WB424571611TH

กฎสำคัญ:

1. อ่านเฉพาะเลขพัสดุ
2. ไม่ต้องอ่านชื่อ
3. ไม่ต้องอ่านที่อยู่
4. ไม่ต้องอ่านสถานะ
5. ไม่ต้องอ่านจำนวนเงิน
6. ไม่ต้องอ่านหัวเอกสาร
7. ไม่ต้องอ่าน barcode ด้านบน
8. ไม่ต้องอ่านข้อความที่เขียนด้วยลายมือด้านล่าง
9. ห้ามสร้างเลขพัสดุขึ้นมาเอง
10. ถ้าเลขใดอ่านไม่ชัดจริง ๆ ให้ข้ามเลขนั้น
11. ต้องตรวจทั้ง 4 คอลัมน์
12. อย่าหยุดหลังจากอ่านได้บางส่วน
13. พยายามอ่านให้ครบทุกแถว

สำคัญมาก:
เลขที่อยู่ในภาพมีการเน้นสีเหลืองบางส่วน
สีเหลืองเป็นเพียงการทำเครื่องหมายในเอกสาร
ไม่ใช่ส่วนหนึ่งของเลขพัสดุ

OUTPUT:

ให้ตอบ "เฉพาะเลขพัสดุ" เท่านั้น
หนึ่งเลขต่อหนึ่งบรรทัด

ตัวอย่าง:

WB487680177TH
WB501666163TH
WB424571611TH
JD085274232TH

ห้ามใส่:
- เลขลำดับ
- เครื่องหมาย |
- bullet
- markdown
- คำอธิบาย
- JSON

ตรวจสอบก่อนตอบ:
- ทุกเลขต้องมี 2 ตัวอักษร
- ตามด้วยตัวเลข 9 ตัว
- ลงท้าย TH
- อย่าตัดเลขกลางทาง
- อย่าเพิ่มเลขที่ไม่มีในภาพ

อ่านทั้ง 4 คอลัมน์ให้ครบที่สุด
`;


    // ========================================================
    // Gemini endpoint
    // ========================================================

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/` +
      `${MODEL}:generateContent`;


    const controller =
      new AbortController();

    const timeout =
      setTimeout(() => {
        controller.abort();
      }, TIMEOUT_MS);


    let response;

    try {

      response = await fetch(url, {

        method: 'POST',

        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY
        },

        body: JSON.stringify({

          contents: [
            {
              role: 'user',

              parts: [

                {
                  inlineData: {
                    mimeType: safeMediaType,
                    data: image
                  }
                },

                {
                  text: prompt
                }

              ]
            }
          ],

          generationConfig: {

            maxOutputTokens:
              MAX_OUTPUT_TOKENS,

            thinkingConfig: {
              thinkingLevel: 'low'
            }

          }

        }),

        signal: controller.signal

      });

    } finally {

      clearTimeout(timeout);

    }


    // ========================================================
    // Read Gemini response
    // ========================================================

    let data = null;

    try {

      data = await response.json();

    } catch {

      data = null;

    }


    // ========================================================
    // Gemini error
    // ========================================================

    if (!response.ok) {

      console.error(
        'Gemini API error:',
        data
      );


      const message =
        data?.error?.message ||
        data?.error?.status ||
        `HTTP ${response.status}`;


      if (
        response.status === 429 ||
        String(message)
          .toLowerCase()
          .includes('quota') ||
        String(message)
          .toLowerCase()
          .includes('rate')
      ) {

        return res.status(429).json({

          error:
            'Gemini ถึงขีดจำกัดการใช้งาน กรุณารอสักครู่แล้วลองใหม่',

          detail: message

        });

      }


      return res.status(
        response.status
      ).json({

        error: 'Gemini API error',

        detail: message

      });

    }


    // ========================================================
    // Get Gemini text
    // ========================================================

    const parts =
      data?.candidates?.[0]?.content?.parts || [];


    const text =
      parts
        .filter(
          part =>
            typeof part?.text === 'string'
        )
        .map(
          part => part.text
        )
        .join('\n');


    console.log(
      'Gemini OCR text:',
      text
    );


    if (!text) {

      return res.status(200).json({
        items: []
      });

    }


    // ========================================================
    // Extract tracking numbers
    // ========================================================

    const codes =
      extractTrackingNumbers(text);


    const items =
      makeItems(codes);


    console.log(
      `Gemini OCR found ${items.length} tracking numbers`
    );


    // ========================================================
    // IMPORTANT:
    // index.html expects:
    //
    // {
    //   seq: 1,
    //   tracking: "WB424571611TH"
    // }
    // ========================================================

    return res.status(200).json({
      items
    });


  } catch (error) {

    console.error(
      'OCR error:',
      error
    );


    if (
      error?.name === 'AbortError'
    ) {

      return res.status(504).json({

        error:
          'Gemini OCR ใช้เวลานานเกิน 30 วินาที กรุณาลองใหม่'

      });

    }


    return res.status(500).json({

      error:
        error?.message ||
        'เกิดข้อผิดพลาดในการประมวลผล OCR'

    });

  }

}
