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

    /*
    =====================================================
    ใช้โมเดลฟรีตัวใหม่โดยตรง
    =====================================================
    */

    const MODEL =
      'inclusionai/ling-3.0-flash-vl:free';


    const imageDataUrl =
      image.startsWith('data:')
        ? image
        : `data:${mediaType || 'image/jpeg'};base64,${image}`;


    /*
    =====================================================
    PROMPT
    =====================================================
    */

    const prompt = `
อ่านข้อความเลขพัสดุจากภาพนี้

ภาพนี้เป็นตารางใบนำจ่าย ป.303 ของไปรษณีย์ไทย

เลขพัสดุมีรูปแบบ:

AA 1234 5678 9 TH

หรือ

AA123456789TH

โดย:
- AA = ตัวอักษรภาษาอังกฤษ 2 ตัว
- ตามด้วยตัวเลข 9 หลัก
- ลงท้ายด้วย TH

ตัวอย่าง:

WB 3689 9851 2 TH
JG 0674 5041 2 TH
OB 4102 5193 1 TH

ต้องตอบเป็น:

WB368998512TH
JG067450412TH
OB410251931TH

กติกาสำคัญมาก:

- อ่านเฉพาะเลขที่เห็นจริงในภาพ
- ห้ามเดา
- ห้ามสร้างเลข
- ห้ามแก้เลขที่อ่านไม่ชัดโดยการเดา
- ถ้ามีหลายแถว ให้ตรวจทุกแถว
- รวมช่องว่างระหว่างตัวอักษรและตัวเลข
- ใช้ตัวพิมพ์ใหญ่
- ตอบเฉพาะเลขพัสดุ
- หนึ่งเลขต่อหนึ่งบรรทัด
- ห้ามใส่คำอธิบาย
- ห้ามใส่หมายเลขลำดับ
- ห้ามใส่ Markdown

ตัวอย่าง:

WB368998512TH
WB464939383TH
WB462670430TH

ถ้าอ่านเลขไม่ได้จริง ๆ ให้ตอบ:

NONE
`;


    /*
    =====================================================
    OPENROUTER
    =====================================================
    */

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

          max_tokens: 800

        })
      }
    );


    /*
    =====================================================
    อ่าน response
    =====================================================
    */

    const data =
      await response.json();


    /*
    =====================================================
    ERROR
    =====================================================
    */

    if (!response.ok) {

      console.error(
        'OPENROUTER ERROR:',
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


    /*
    =====================================================
    DEBUG
    =====================================================
    */

    console.log(
      'MODEL USED:',
      data?.model
    );


    console.log(
      'FULL RESPONSE:',
      JSON.stringify(data, null, 2)
    );


    /*
    =====================================================
    CONTENT
    =====================================================
    */

    const rawContent =
      data?.choices?.[0]?.message?.content;


    let text = '';


    if (Array.isArray(rawContent)) {

      text =
        rawContent
          .map(
            part => part?.text || ''
          )
          .join('\n');

    } else {

      text =
        String(
          rawContent || ''
        );

    }


    console.log(
      'AI RAW TEXT:',
      text
    );


    /*
    =====================================================
    CLEAN
    =====================================================
    */

    const cleaned =
      text
        .toUpperCase()
        .replace(/\r/g, '\n');


    console.log(
      'CLEANED:',
      cleaned
    );


    /*
    =====================================================
    ดึงเลขแบบติดกัน
    =====================================================
    */

    const matches = [];


    const normalRegex =
      /([A-Z]{2})[^A-Z0-9]*(\d{9})[^A-Z0-9]*TH/gi;


    for (
      const match of cleaned.matchAll(
        normalRegex
      )
    ) {

      const tracking =
        `${match[1]}${match[2]}TH`
          .toUpperCase();

      matches.push(tracking);

    }


    /*
    =====================================================
    ดึงเลขแบบ:

    WB 3689 9851 2 TH
    =====================================================
    */

    const spacedRegex =
      /([A-Z]{2})\s*(\d{4})\s*(\d{4})\s*(\d)\s*TH/gi;


    for (
      const match of cleaned.matchAll(
        spacedRegex
      )
    ) {

      const tracking =
        `${match[1]}${match[2]}${match[3]}${match[4]}TH`
          .toUpperCase();

      matches.push(tracking);

    }


    /*
    =====================================================
    เผื่อ AI ใส่เลขติดกัน
    =====================================================
    */

    const compact =
      cleaned.replace(
        /[^A-Z0-9]/g,
        ''
      );


    const compactMatches =
      compact.match(
        /[A-Z]{2}\d{9}TH/g
      ) || [];


    matches.push(
      ...compactMatches
    );


    /*
    =====================================================
    VALIDATE
    =====================================================
    */

    const valid =
      matches.filter(
        x =>
          /^[A-Z]{2}\d{9}TH$/.test(x)
      );


    /*
    =====================================================
    REMOVE DUPLICATE
    =====================================================
    */

    const unique =
      [...new Set(valid)];


    console.log(
      'FINAL TRACKING:',
      unique
    );


    /*
    =====================================================
    สำคัญ:
    ส่ง raw text กลับมาด้วยตอน debug
    =====================================================
    */

    if (unique.length === 0) {

      return res.status(200).json({

        items: [],

        debug: {
          model: data?.model || MODEL,
          raw: text
        }

      });

    }


    /*
    =====================================================
    RESULT
    =====================================================
    */

    const items =
      unique.map(
        (tracking, index) => ({

          seq:
            index + 1,

          tracking

        })
      );


    return res.status(200).json({

      items,

      debug: {
        model: data?.model || MODEL
      }

    });


  } catch (error) {

    console.error(
      'SERVER ERROR:',
      error
    );


    return res.status(500).json({

      error:
        error.message ||
        'เกิดข้อผิดพลาดในเซิร์ฟเวอร์'

    });

  }

}
