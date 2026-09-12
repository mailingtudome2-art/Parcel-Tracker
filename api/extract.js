export default async function handler(req, res) {

  /*
  =========================================================
  METHOD
  =========================================================
  */

  if(req.method !== 'POST'){

    return res.status(405).json({
      error:'Method Not Allowed'
    });

  }


  /*
  =========================================================
  API KEY
  =========================================================
  */

  const apiKey =
    process.env.OPENROUTER_API_KEY;


  if(!apiKey){

    return res.status(500).json({

      error:
        'ไม่พบ OPENROUTER_API_KEY ใน Vercel'

    });

  }


  try{

    /*
    =======================================================
    รับข้อมูล
    =======================================================
    */

    const {
      image,
      mediaType
    } = req.body || {};


    if(!image){

      return res.status(400).json({

        error:
          'ไม่พบรูปภาพ'

      });

    }


    /*
    =======================================================
    MODEL
    =======================================================

    openrouter/free

    จะเลือก free model ที่รองรับ
    image input ให้โดยอัตโนมัติ
    =======================================================
    */

    const MODEL =
      'openrouter/free';


    /*
    =======================================================
    IMAGE DATA URL
    =======================================================
    */

    const imageDataUrl =
      image.startsWith('data:')
        ? image
        : `data:${mediaType || 'image/jpeg'};base64,${image}`;


    /*
    =======================================================
    PROMPT
    =======================================================
    */

    const prompt = `

คุณเป็นระบบ OCR สำหรับอ่านเลขพัสดุไปรษณีย์ไทยจากภาพ

ภาพที่ส่งมาเป็นบริเวณตารางของใบนำจ่าย ป.303

หน้าที่ของคุณคือ:
อ่านข้อความเลขพัสดุที่มองเห็นจริงในภาพ
และส่งกลับเฉพาะเลขพัสดุเท่านั้น

รูปแบบเลขพัสดุ:

ตัวอักษรอังกฤษ 2 ตัว
+
ตัวเลข 9 หลัก
+
TH

ตัวอย่าง:

EM123456789TH
RR987654321TH
WB368998512TH

ในเอกสารจริง เลขอาจถูกพิมพ์เว้นวรรค เช่น:

WB 3689 9851 2 TH
JG 0674 5041 2 TH
OB 4102 5193 1 TH

ให้รวมช่องว่างกลับเป็น:

WB368998512TH
JG067450412TH
OB410251931TH

กฎสำคัญ:

1. อ่านจากภาพจริงเท่านั้น
2. ห้ามเดาเลขที่มองไม่เห็น
3. ห้ามสร้างเลขขึ้นมาเอง
4. ถ้ามีหลายรายการ ให้หาให้ครบทุกเลขที่มองเห็น
5. ตัวอักษรต้องเป็นภาษาอังกฤษ
6. ต้องมีตัวเลขทั้งหมด 9 หลัก
7. ต้องลงท้ายด้วย TH
8. ใช้ตัวพิมพ์ใหญ่ทั้งหมด
9. ห้ามใส่คำอธิบาย
10. ห้ามใส่ Markdown
11. ห้ามใส่ bullet
12. ห้ามใส่หมายเลขลำดับ
13. ให้ตอบเลขพัสดุทีละบรรทัด
14. ถ้าอ่านไม่ได้จริง ๆ ให้ตอบ NONE

ตัวอย่างคำตอบ:

WB368998512TH
WB464939383TH
JG067450412TH

ถ้าไม่พบเลข:

NONE

`;


    /*
    =======================================================
    CALL OPENROUTER
    =======================================================
    */

    const response =
      await fetch(
        'https://openrouter.ai/api/v1/chat/completions',
        {

          method:'POST',

          headers:{

            'Authorization':
              `Bearer ${apiKey}`,

            'Content-Type':
              'application/json',

            /*
            X-Title ไม่ใส่
            เพื่อป้องกันปัญหา ByteString
            จากภาษาไทยใน HTTP header
            */

            'HTTP-Referer':
              'https://parcel-tracker-mailing.vercel.app'

          },


          body:JSON.stringify({

            model:MODEL,


            messages:[

              {

                role:'user',

                content:[

                  {

                    type:'text',

                    text:prompt

                  },


                  {

                    type:'image_url',

                    image_url:{

                      url:imageDataUrl

                    }

                  }

                ]

              }

            ],


            /*
            OCR ไม่ต้องการ randomness
            */

            temperature:0,


            /*
            เผื่อกรณีมีเลขหลายสิบรายการ
            */

            max_tokens:600

          })

        }
      );


    /*
    =======================================================
    RESPONSE JSON
    =======================================================
    */

    const data =
      await response.json();


    /*
    =======================================================
    OPENROUTER ERROR
    =======================================================
    */

    if(!response.ok){

      console.error(
        'OpenRouter Error:',
        JSON.stringify(
          data,
          null,
          2
        )
      );


      return res
        .status(response.status)
        .json({

          error:
            `OpenRouter API error (${response.status}): ` +
            (
              data?.error?.message ||
              JSON.stringify(data)
            )

        });

    }


    /*
    =======================================================
    ดูว่า free router เลือก model ตัวไหน
    =======================================================
    */

    console.log(
      'OpenRouter selected model:',
      data?.model
    );


    /*
    =======================================================
    อ่าน content
    =======================================================
    */

    const rawContent =
      data?.choices?.[0]?.message?.content;


    let text = '';


    if(Array.isArray(rawContent)){

      text =
        rawContent
          .map(
            part =>
              part?.text || ''
          )
          .join('\n');

    }else{

      text =
        String(
          rawContent || ''
        );

    }


    console.log(
      'OpenRouter raw response:',
      text
    );


    /*
    =======================================================
    CLEAN TEXT
    =======================================================
    */

    const cleaned =
      text
        .toUpperCase()
        .replace(
          /\r/g,
          '\n'
        )
        .replace(
          /[“”"'`*#()[\]{}<>]/g,
          ' '
        );


    console.log(
      'Cleaned response:',
      cleaned
    );


    /*
    =======================================================
    เก็บผลลัพธ์
    =======================================================
    */

    const matches = [];


    /*
    =======================================================
    FORMAT 1

    WB368998512TH
    EM123456789TH
    =======================================================
    */

    const normalRegex =
      /\b([A-Z]{2})[\s\-._:/]*(\d{9})[\s\-._:/]*TH\b/gi;


    for(
      const match of cleaned.matchAll(
        normalRegex
      )
    ){

      const tracking =
        `${match[1]}${match[2]}TH`
          .toUpperCase();


      matches.push(
        tracking
      );

    }


    /*
    =======================================================
    FORMAT 2

    WB 3689 9851 2 TH

    2 letters
    +
    4 digits
    +
    4 digits
    +
    1 digit
    +
    TH
    =======================================================
    */

    const spacedRegex =
      /\b([A-Z]{2})\s*[-._:/]?\s*(\d{4})\s*[-._:/]?\s*(\d{4})\s*[-._:/]?\s*(\d)\s*[-._:/]?\s*TH\b/gi;


    for(
      const match of cleaned.matchAll(
        spacedRegex
      )
    ){

      const tracking =
        (
          `${match[1]}` +
          `${match[2]}` +
          `${match[3]}` +
          `${match[4]}` +
          'TH'
        ).toUpperCase();


      matches.push(
        tracking
      );

    }


    /*
    =======================================================
    FORMAT 3

    เผื่อ AI ใส่ข้อความประกอบ
    หรือใส่เลขลำดับ

    เช่น:

    1. WB 3689 9851 2 TH
    2. WB 4649 3938 3 TH

    จะดึงเฉพาะเลขออกมา
    =======================================================
    */

    const lines =
      cleaned.split('\n');


    for(
      const line of lines
    ){

      /*
      เอาเฉพาะ A-Z และ 0-9
      */

      const compactLine =
        line.replace(
          /[^A-Z0-9]/g,
          ''
        );


      /*
      แบบติดกัน
      */

      const compactMatches =
        compactLine.match(
          /[A-Z]{2}\d{9}TH/g
        ) || [];


      for(
        const tracking of compactMatches
      ){

        matches.push(
          tracking
        );

      }

    }


    /*
    =======================================================
    FORMAT 4

    บาง model อาจคืน:

    WB3689 9851 2TH

    หรือมี punctuation แปลก ๆ

    ลองทำ compact ทั้ง response
    =======================================================
    */

    const compactAll =
      cleaned.replace(
        /[^A-Z0-9]/g,
        ''
      );


    const compactAllMatches =
      compactAll.match(
        /[A-Z]{2}\d{9}TH/g
      ) || [];


    for(
      const tracking of compactAllMatches
    ){

      matches.push(
        tracking
      );

    }


    /*
    =======================================================
    VALIDATE
    =======================================================
    */

    const validTracking =
      matches.filter(
        tracking =>
          /^[A-Z]{2}\d{9}TH$/
            .test(tracking)
      );


    /*
    =======================================================
    REMOVE DUPLICATES
    =======================================================
    */

    const uniqueTracking = [
      ...new Set(
        validTracking
      )
    ];


    console.log(
      'Detected tracking numbers:',
      uniqueTracking
    );


    /*
    =======================================================
    NO RESULT
    =======================================================
    */

    if(
      uniqueTracking.length === 0
    ){

      return res.status(200).json({

        items:[]

      });

    }


    /*
    =======================================================
    BUILD ITEMS
    =======================================================
    */

    const items =
      uniqueTracking.map(
        (
          tracking,
          index
        ) => ({

          seq:
            index + 1,

          tracking

        })
      );


    /*
    =======================================================
    RETURN
    =======================================================
    */

    return res.status(200).json({

      items

    });


  }catch(error){

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
