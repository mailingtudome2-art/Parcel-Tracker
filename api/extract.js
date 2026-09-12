export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Method Not Allowed'
    });
  }

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

    // ใช้ Free Router
    const MODEL = 'google/gemma-4-26b-a4b-it:free';

    // ทำให้เป็น Data URL ถ้ายังไม่ได้เป็น
    const imageDataUrl = image.startsWith('data:')
      ? image
      : `data:${mediaType || 'image/jpeg'};base64,${image}`;

    const prompt = `
คุณเป็น AI สำหรับอ่านเลขพัสดุจากภาพ

หน้าที่ของคุณคืออ่านข้อความบนฉลากพัสดุ
และหา "เลขพัสดุไปรษณีย์ไทย" ที่มองเห็นในภาพ

รูปแบบที่ต้องการ:

ตัวอักษรภาษาอังกฤษ 2 ตัว
+
ตัวเลข 9 หลัก
+
TH

ตัวอย่าง:
EM123456789TH
ED123456789TH
RR123456789TH

กฎสำคัญ:

1. อ่านจากภาพจริงเท่านั้น
2. ห้ามสร้างหรือเดาเลขที่มองไม่เห็น
3. ถ้ามีหลายพัสดุ ให้หาให้ครบทุกเลข
4. ตัวอักษรต้องเป็นภาษาอังกฤษ
5. ตัวเลขต้องมี 9 หลัก
6. ลงท้ายด้วย TH
7. ใช้ตัวพิมพ์ใหญ่ทั้งหมด
8. ไม่ต้องอธิบาย
9. ไม่ต้องใส่ Markdown
10. ไม่ต้องใส่หมายเลขลำดับ
11. ให้ตอบเลขพัสดุทีละบรรทัดเท่านั้น
12. ถ้าอ่านเลขพัสดุไม่ได้ ให้ตอบ NONE

ตัวอย่างคำตอบที่ถูกต้อง:

EM123456789TH
RR987654321TH

ถ้าไม่พบเลขพัสดุ:

NONE
`;

    const response = await fetch(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',

        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer':
            'https://parcel-tracker-mailing.vercel.app'
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

          max_tokens: 300
        })
      }
    );

    const data = await response.json();

    // ถ้า OpenRouter มี error
    if (!response.ok) {
      console.error(
        'OpenRouter Error:',
        JSON.stringify(data, null, 2)
      );

      return res.status(response.status).json({
        error:
          `OpenRouter API error (${response.status}): ` +
          (
            data?.error?.message ||
            JSON.stringify(data)
          )
      });
    }

    // -----------------------------
    // อ่าน response จาก AI
    // -----------------------------

    const rawContent =
      data?.choices?.[0]?.message?.content;

    let text = '';

    if (Array.isArray(rawContent)) {
      text = rawContent
        .map(part => part?.text || '')
        .join('\n');
    } else {
      text = String(rawContent || '');
    }

    console.log(
      'OpenRouter raw response:',
      text
    );

    // -----------------------------
    // ทำความสะอาดข้อความ
    // -----------------------------

    const cleaned = text
      .toUpperCase()
      .replace(/\r/g, '\n')
      .replace(/[“”"'`*#()[\]{}<>]/g, ' ');

    console.log(
      'Cleaned response:',
      cleaned
    );

    // -----------------------------
    // หาเลขแบบปกติ
    // รองรับ:
    // EM123456789TH
    // EM 123456789 TH
    // EM-123456789-TH
    // EM.123456789.TH
    // -----------------------------

    const matches = [];

    const regex =
      /\b([A-Z]{2})[\s\-._:/]*(\d{9})[\s\-._:/]*TH\b/gi;

    for (const match of cleaned.matchAll(regex)) {
      const tracking =
        `${match[1]}${match[2]}TH`.toUpperCase();

      matches.push(tracking);
    }

    // -----------------------------
    // ลองหาอีกครั้งจากแต่ละบรรทัด
    // เผื่อ AI ใส่ข้อความประกอบ
    // -----------------------------

    const lines = cleaned.split('\n');

    for (const line of lines) {
      const compactLine =
        line.replace(/[^A-Z0-9]/g, '');

      const lineMatches =
        compactLine.match(
          /[A-Z]{2}\d{9}TH/g
        ) || [];

      for (const tracking of lineMatches) {
        matches.push(tracking);
      }
    }

    // -----------------------------
    // ลบเลขซ้ำ
    // -----------------------------

    const uniqueTracking = [
      ...new Set(matches)
    ];

    console.log(
      'Detected tracking numbers:',
      uniqueTracking
    );

    // -----------------------------
    // ไม่มีเลข
    // -----------------------------

    if (uniqueTracking.length === 0) {
      return res.status(200).json({
        items: []
      });
    }

    // -----------------------------
    // ส่งกลับ frontend
    // -----------------------------

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
    console.error(
      'Server Error:',
      error
    );

    return res.status(500).json({
      error:
        error.message ||
        'เกิดข้อผิดพลาดในเซิร์ฟเวอร์'
    });
  }
}
