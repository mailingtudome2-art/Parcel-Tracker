export default async function handler(req, res) {
  // ==============================
  // ตรวจสอบ Method
  // ==============================
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Method Not Allowed'
    });
  }

  // ==============================
  // ตรวจสอบ API Key
  // ==============================
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: 'ไม่พบ OPENROUTER_API_KEY ใน Vercel'
    });
  }

  try {
    const { image, mediaType } = req.body || {};

    if (!image) {
      return res.status(400).json({
        error: 'ไม่พบรูปภาพ'
      });
    }

    // ==============================
    // OpenRouter Vision Model
    // ==============================
    const MODEL = 'openrouter/free';

    // ถ้า image มี data:image/... อยู่แล้ว
    // จะใช้ 그대로
    // ถ้าไม่มี จะสร้าง data URL ให้
    const imageDataUrl = image.startsWith('data:')
      ? image
      : `data:${mediaType || 'image/jpeg'};base64,${image}`;

    // ==============================
    // Prompt สำหรับอ่านเลขพัสดุ
    // ==============================
    const prompt = `
คุณเป็น AI สำหรับอ่านเลขพัสดุจากภาพถ่าย

วิเคราะห์ภาพนี้อย่างละเอียด และหาเลขพัสดุที่มองเห็นทั้งหมด

รูปแบบเลขพัสดุที่ต้องการคือ:
ตัวอักษรภาษาอังกฤษ 2 ตัว
ตามด้วยตัวเลข 9 หลัก
และลงท้ายด้วย TH

ตัวอย่าง:
EM123456789TH
ED123456789TH
RR123456789TH
TH123456789TH

กฎสำคัญ:
1. อ่านจากภาพจริงเท่านั้น
2. ห้ามเดาเลขที่มองไม่เห็น
3. ถ้ามีหลายพัสดุ ให้แสดงทุกเลข
4. ถ้าเลขบางตัวไม่ชัด ให้พยายามตรวจสอบจากบริบทของภาพ
5. ตัดช่องว่างและเครื่องหมายที่ไม่เกี่ยวข้องออก
6. เปลี่ยนตัวอักษรเป็นตัวพิมพ์ใหญ่
7. ต้องตรวจสอบให้มีรูปแบบ 2 ตัวอักษร + 9 ตัวเลข + TH
8. ถ้าอ่านเลขพัสดุไม่ได้ ให้ตอบ NONE

ตอบกลับในรูปแบบนี้เท่านั้น:

1. EM123456789TH
2. ED987654321TH

หรือถ้าไม่พบเลขพัสดุ:

NONE
`;

    // ==============================
    // เรียก OpenRouter
    // ==============================
    const response = await fetch(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',

headers: {
  'Authorization': `Bearer ${apiKey}`,
  'Content-Type': 'application/json',
  'HTTP-Referer': 'https://parcel-tracker-mailing.vercel.app',
  'X-Title': 'Parcel-Tracker'
},

        body: JSON.stringify({
          model: MODEL,

          messages: [
            {
              role: 'user',

              content: [
                {
                  type: 'text',
                  text: prompt
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: imageDataUrl
                  }
                }
              ]
            }
          ],

          temperature: 0,

          max_tokens: 500
        })
      }
    );

    // ==============================
    // อ่าน Response
    // ==============================
    const data = await response.json();

    if (!response.ok) {
      console.error('OpenRouter Error:', data);

      return res.status(response.status).json({
        error: `OpenRouter API error (${response.status}): ${
          data?.error?.message ||
          JSON.stringify(data)
        }`
      });
    }

    const text =
      data?.choices?.[0]?.message?.content || '';

    console.log('OpenRouter response:', text);

    // ==============================
    // ถ้า AI บอกว่าไม่พบ
    // ==============================
    if (!text || text.trim().toUpperCase() === 'NONE') {
      return res.status(200).json({
        items: []
      });
    }

    // ==============================
    // ดึงเลขพัสดุจากคำตอบ AI
    // ==============================
    const matches = text.match(
      /\b[A-Z]{2}\d{9}TH\b/gi
    ) || [];

    // ลบเลขซ้ำ
    const uniqueTracking = [
      ...new Set(
        matches.map(x => x.toUpperCase())
      )
    ];

    // ==============================
    // สร้าง items ให้เหมือน API เดิม
    // ==============================
    const items = uniqueTracking.map(
      (tracking, index) => ({
        seq: index + 1,
        tracking
      })
    );

    return res.status(200).json({
      items
    });

  } catch (error) {
    console.error('Server Error:', error);

    return res.status(500).json({
      error: error.message || 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์'
    });
  }
}
