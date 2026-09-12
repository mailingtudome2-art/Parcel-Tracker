// api/extract.js

const MODEL = 'gemini-3.8-flash';
const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

const MAX_TOKENS = 2500;
const TIMEOUT_MS = 25000;

function normalizeTracking(value) {
  if (!value) return null;

  let s = String(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

  // แก้กรณี TH ติดมาแบบแปลก ๆ
  if (!s.endsWith('TH')) {
    const thIndex = s.lastIndexOf('TH');
    if (thIndex >= 0 && thIndex >= s.length - 4) {
      s = s.slice(0, thIndex + 2);
    }
  }

  // รูปแบบเลขพัสดุไทยที่เราต้องการ:
  // 2 ตัวอักษร + 9 ตัวเลข + TH
  const match = s.match(/^([A-Z]{2})(\d{9})TH$/);

  if (!match) return null;

  return `${match[1]}${match[2]}TH`;
}

function extractTrackingNumbers(text) {
  if (!text) return [];

  const found = [];

  // ---------------------------------------------------------
  // 1) หาเลขพัสดุแบบมีช่องว่าง เช่น
  // WB 3689 9851 2 TH
  // WB 4649 3938 3 TH
  // ---------------------------------------------------------
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

  // ---------------------------------------------------------
  // 2) หาแบบติดกัน เช่น
  // WB368998512TH
  // ---------------------------------------------------------
  const compactRegex = /\b[A-Z]{2}\d{9}TH\b/gi;

  while ((match = compactRegex.exec(text)) !== null) {
    const code = normalizeTracking(match[0]);

    if (code) {
      found.push(code);
    }
  }

  // ---------------------------------------------------------
  // 3) เผื่อ Gemini ใส่เครื่องหมาย/ขีดกลาง
  // เช่น WB-3689-9851-2-TH
  // ---------------------------------------------------------
  const looseRegex =
    /\b([A-Z]{2})[^A-Z0-9]{0,4}(\d{4})[^A-Z0-9]{0,4}(\d{4})[^A-Z0-9]{0,4}(\d)[^A-Z0-9]{0,4}TH\b/gi;

  while ((match = looseRegex.exec(text)) !== null) {
    const code = normalizeTracking(
      `${match[1]}${match[2]}${match[3]}${match[4]}TH`
    );

    if (code) {
      found.push(code);
    }
  }

  // ---------------------------------------------------------
  // ลบเลขซ้ำ แต่คงลำดับเดิม
  // ---------------------------------------------------------
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

function makeItems(codes) {
  return codes.map((tracking_number, index) => ({
    sequence: index + 1,
    tracking_number
  }));
}

export default async function handler(req, res) {
  // ---------------------------------------------------------
  // CORS / method
  // ---------------------------------------------------------
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
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

  // ---------------------------------------------------------
  // ตรวจ API KEY
  // ---------------------------------------------------------
  if (!GEMINI_API_KEY) {
    return res.status(500).json({
      error:
        'ไม่พบ GEMINI_API_KEY ใน Environment Variables ของ Vercel'
    });
  }

  try {
    const body = req.body || {};

    const image = body.image;
    const mediaType = body.mediaType || 'image/jpeg';

    if (!image) {
      return res.status(400).json({
        error: 'ไม่พบรูปภาพ'
      });
    }

    // -------------------------------------------------------
    // จำกัด MIME type ให้เป็น image เท่านั้น
    // -------------------------------------------------------
    const allowedTypes = [
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/webp'
    ];

    const safeMediaType = allowedTypes.includes(mediaType)
      ? mediaType
      : 'image/jpeg';

    // -------------------------------------------------------
    // Prompt สำหรับ OCR ตารางเลขพัสดุ
    // -------------------------------------------------------
    const prompt = `
คุณคือระบบ OCR สำหรับอ่านเลขพัสดุไปรษณีย์ไทยจากภาพ

ภาพที่แนบมาอาจเป็นภาพที่ถูก crop และจัดเรียงใหม่เป็นตาราง 2x2
เพื่อให้ตัวหนังสือใหญ่ขึ้น

สำคัญมาก:
- ต้องอ่านข้อความจาก "ทั้ง 4 ช่อง" ของภาพ
- ช่องทั้ง 4 ช่องเป็นข้อมูลต่อเนื่องของตารางเดียวกัน
- ห้ามอ่านเฉพาะช่องใดช่องหนึ่ง
- ให้ไล่อ่านจากบนลงล่างตามลำดับของแต่ละช่อง
- ห้ามข้ามรายการที่อ่านได้
- ภาพอาจมีเลขพัสดุประมาณ 50-100 รายการ
- ต้องพยายามอ่านให้ครบทุกเลขที่มองเห็นได้ชัดเจน

เลขพัสดุที่ต้องการมีรูปแบบ:

XX 1234 5678 9 TH

หรือ

XX123456789TH

โดย:
- XX = ตัวอักษรภาษาอังกฤษ 2 ตัว
- ตามด้วยตัวเลข 9 ตัว
- ลงท้ายด้วย TH

ตัวอย่าง:
WB 3689 9851 2 TH
WB 4649 3938 3 TH
WB 4626 7043 0 TH
JG 0674 5041 2 TH

สิ่งที่ต้องทำ:
1. อ่านเฉพาะเลขพัสดุ
2. ไม่ต้องอ่านชื่อผู้รับ
3. ไม่ต้องอ่านที่อยู่
4. ไม่ต้องอ่านสถานะ
5. ไม่ต้องอ่าน COD
6. ไม่ต้องอ่านข้อความหัวกระดาษ
7. ไม่ต้องอธิบายผล
8. ไม่ต้องใส่ markdown
9. ไม่ต้องใส่ JSON
10. ห้ามสร้างเลขพัสดุขึ้นมาเอง
11. ถ้าเลขใดอ่านไม่ชัด ให้ข้ามเลขนั้นแทนการเดา

ให้ตอบเป็นบรรทัดละ 1 รายการเท่านั้น:

1|WB368998512TH
2|WB464939383TH
3|WB462670430TH

หมายเลขด้านหน้าคือ "ลำดับที่อ่านพบ" ไม่ใช่ส่วนหนึ่งของเลขพัสดุ

ถ้ามี 95 รายการ ให้พยายามส่งออกทั้ง 95 รายการ
ถ้ามี 70 รายการ ให้ส่งออก 70 รายการ

ย้ำอีกครั้ง:
ต้องอ่านเลขพัสดุจากทั้ง 4 ช่องของภาพ 2x2 ให้ครบที่สุด
`;

    // -------------------------------------------------------
    // Gemini API
    // -------------------------------------------------------
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/` +
      `${MODEL}:generateContent`;

    const controller = new AbortController();

    const timeout = setTimeout(() => {
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
            maxOutputTokens: MAX_TOKENS,

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

    // -------------------------------------------------------
    // อ่าน response
    // -------------------------------------------------------
    let data = null;

    try {
      data = await response.json();
    } catch {
      data = null;
    }

    // -------------------------------------------------------
    // Gemini error
    // -------------------------------------------------------
    if (!response.ok) {
      console.error('Gemini API error:', data);

      const apiMessage =
        data?.error?.message ||
        data?.error?.status ||
        `HTTP ${response.status}`;

      // Rate limit
      if (
        response.status === 429 ||
        String(apiMessage).toLowerCase().includes('quota') ||
        String(apiMessage).toLowerCase().includes('rate')
      ) {
        return res.status(429).json({
          error:
            'Gemini ถึงขีดจำกัดการใช้งานชั่วคราว กรุณารอสักครู่แล้วลองใหม่',
          detail: apiMessage
        });
      }

      return res.status(response.status).json({
        error: 'Gemini API error',
        detail: apiMessage
      });
    }

    // -------------------------------------------------------
    // ดึงข้อความจาก Gemini
    // -------------------------------------------------------
    const parts =
      data?.candidates?.[0]?.content?.parts || [];

    const text = parts
      .filter(part => typeof part?.text === 'string')
      .map(part => part.text)
      .join('\n');

    console.log('Gemini raw OCR:', text);

    if (!text) {
      return res.status(200).json({
        items: []
      });
    }

    // -------------------------------------------------------
    // Parse tracking numbers
    // -------------------------------------------------------
    const codes = extractTrackingNumbers(text);
    const items = makeItems(codes);

    console.log(
      `Gemini OCR found ${items.length} tracking numbers`
    );

    // -------------------------------------------------------
    // ส่งกลับ frontend
    // -------------------------------------------------------
    return res.status(200).json({
      items
    });

  } catch (error) {
    console.error('OCR error:', error);

    if (error?.name === 'AbortError') {
      return res.status(504).json({
        error:
          'Gemini OCR ใช้เวลานานเกิน 25 วินาที กรุณาลองใหม่'
      });
    }

    return res.status(500).json({
      error:
        error?.message ||
        'เกิดข้อผิดพลาดในการประมวลผล OCR'
    });
  }
}
