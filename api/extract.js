// Vercel Serverless Function
// POST /api/extract
//
// MODE 1:
// detect_total
// อ่านจำนวนทั้งหมดจากหัวใบ เช่น "จำนวน 82 ชิ้น"
//
// MODE 2:
// column
// อ่านเลขพัสดุจาก 1 คอลัมน์
//
// Environment:
// GEMINI_API_KEY
//
// Optional:
// GEMINI_MODEL
//
// Default:
// gemini-3.8-flash


const MODEL =
  process.env.GEMINI_MODEL ||
  "gemini-3.8-flash";


const MAX_TOTAL = 100;


/* =========================
   JSON response
========================= */

function json(
  res,
  status,
  data
) {

  res
    .status(status)
    .setHeader(
      "Content-Type",
      "application/json; charset=utf-8"
    );

  return res.end(
    JSON.stringify(data)
  );
}


/* =========================
   Expected sequences
========================= */

function expectedSequences(
  columnIndex,
  total
) {

  const result = [];

  for (
    let seq = columnIndex + 1;
    seq <= total;
    seq += 4
  ) {

    result.push(seq);
  }

  return result;
}


/* =========================
   Tracking normalize
========================= */

function normalizeTracking(
  value
) {

  let s =
    String(value || "")
      .toUpperCase()
      .replace(
        /[^A-Z0-9]/g,
        ""
      );


  /*
   * ถ้าไม่มี TH
   * ลองเติม TH
   */

  if (
    /^[A-Z]{2}[0-9]{9}$/.test(s)
  ) {

    s += "TH";
  }


  if (
    !/^[A-Z]{2}[0-9]{9}TH$/.test(s)
  ) {

    return "";
  }


  return s;
}


/* =========================
   Clean Gemini text
========================= */

function cleanText(
  text
) {

  return String(text || "")
    .replace(
      /```(?:text|txt)?/gi,
      ""
    )
    .replace(
      /```/g,
      ""
    )
    .trim();
}


/* =========================
   Parse column items
========================= */

function parseItems(
  text,
  columnIndex,
  total
) {

  const expected =
    new Set(
      expectedSequences(
        columnIndex,
        total
      )
    );


  const map =
    new Map();


  const lines =
    cleanText(text)
      .replace(/\r/g, "")
      .split("\n")
      .map(
        line =>
          line.trim()
      )
      .filter(Boolean);


  for (
    const line of lines
  ) {

    let match =
      line.match(
        /^\s*(\d{1,3})\s*\|\s*([A-Za-z0-9\s]+)\s*$/
      );


    /*
     * เผื่อ Gemini ใช้ :
     * หรือ -
     */

    if (!match) {

      match =
        line.match(
          /^\s*(\d{1,3})\s*[:\-]\s*([A-Za-z0-9\s]+)\s*$/
        );
    }


    if (!match) {
      continue;
    }


    const seq =
      Number(match[1]);


    /*
     * รับเฉพาะเลขของคอลัมน์นี้
     */

    if (
      !expected.has(seq)
    ) {
      continue;
    }


    const tracking =
      normalizeTracking(
        match[2]
      );


    if (!tracking) {
      continue;
    }


    map.set(
      seq,
      {
        seq,
        tracking
      }
    );
  }


  return [
    ...map.values()
  ].sort(
    (a, b) =>
      a.seq - b.seq
  );
}


/* =========================
   Parse total
========================= */

function parseTotal(
  text
) {

  const t =
    String(text || "")
      .replace(
        /\r/g,
        " "
      );


  const patterns = [

    /*
     * จำนวน 82 ชิ้น
     */

    /จำนวน\s*(?:ทั้งหมด\s*)?(\d{1,3})\s*ชิ้น/i,


    /*
     * จำนวน NON-COD ทั้งหมด 82 ชิ้น
     */

    /NON[\s-]*COD\s*ทั้งหมด\s*(\d{1,3})\s*ชิ้น/i,


    /*
     * ทั้งหมด 82 ชิ้น
     */

    /ทั้งหมด\s*(\d{1,3})\s*ชิ้น/i,


    /*
     * 82 ชิ้น
     */

    /(\d{1,3})\s*ชิ้น/i,


    /*
     * TOTAL 82
     */

    /\b(?:TOTAL|COUNT)\s*[:=]?\s*(\d{1,3})\b/i
  ];


  for (
    const regex of patterns
  ) {

    const match =
      t.match(regex);


    if (!match) {
      continue;
    }


    const number =
      Number(match[1]);


    if (
      Number.isInteger(number) &&
      number >= 1 &&
      number <= MAX_TOTAL
    ) {

      return number;
    }
  }


  return null;
}


/* =========================
   Total prompt
========================= */

function buildTotalPrompt() {

  return `
You are reading the header of a Thai postal delivery manifest
(บัญชีนำจ่าย ป.303).

TASK:

Find the TOTAL NUMBER OF PARCELS/ITEMS on this document.

Look specifically for text such as:

"จำนวน 82 ชิ้น"

or

"จำนวน NON-COD ทั้งหมด 82 ชิ้น"

Return ONLY the integer.

Examples:

82

Do not return explanation.
Do not return words.
Do not guess.

If the total number is not visible, return:

0
`.trim();
}


/* =========================
   Column prompt
========================= */

function buildColumnPrompt(
  columnIndex,
  total
) {

  const expected =
    expectedSequences(
      columnIndex,
      total
    );


  return `
You are a HIGH-ACCURACY OCR engine for a Thai postal delivery manifest
(บัญชีนำจ่าย ป.303).

This image contains ONE VERTICAL CROPPED COLUMN from the document.

Total parcels on the complete sheet:
${total}

This is column:
${columnIndex + 1} of 4

The ONLY sequence numbers that belong to this column are:

${expected.join(", ")}


YOUR TASK:

Read EVERY VISIBLE parcel row in this column.

For every visible row, extract:

sequence|tracking_number


TRACKING NUMBER FORMAT:

Exactly:
2 English letters
+
9 digits
+
TH

Example:

WB487680177TH


IMPORTANT RULES:

1. Read the tracking number EXACTLY from the image.

2. Do not invent any tracking number.

3. Do not invent a sequence number.

4. Do not omit a visible parcel row.

5. Ignore names.

6. Ignore addresses.

7. Ignore status text.

8. Ignore prices.

9. Ignore other document numbers.

10. Spaces inside a tracking number are formatting only.

11. Return ONE LINE PER PARCEL.

12. Use exactly this format:

sequence|tracking_number

Example:

1|WB487680177TH
5|JG123456789TH

13. Return ONLY the lines.

14. Do NOT use Markdown.

15. Do NOT add explanations.

16. The sequence numbers must come only from this column:

${expected.join(", ")}

17. If a row is actually visible, make every effort to read it.

18. If a row is not visible, DO NOT invent it.
`.trim();
}


/* =========================
   Gemini text extraction
========================= */

function getGeminiText(
  data
) {

  const parts =
    data
      ?.candidates
      ?.[0]
      ?.content
      ?.parts;


  if (
    !Array.isArray(parts)
  ) {

    return "";
  }


  return parts
    .map(
      part =>
        typeof part?.text === "string"
          ? part.text
          : ""
    )
    .filter(Boolean)
    .join("\n")
    .trim();
}


/* =========================
   Call Gemini
========================= */

async function callGemini({
  image,
  mediaType,
  prompt,
  timeoutMs = 30000
}) {

  const apiKey =
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY;


  if (!apiKey) {

    const error =
      new Error(
        "ไม่พบ GEMINI_API_KEY ใน Vercel"
      );

    error.code =
      "NO_KEY";

    throw error;
  }


  const url =
    "https://generativelanguage.googleapis.com/" +
    "v1beta/models/" +
    encodeURIComponent(MODEL) +
    ":generateContent";


  const controller =
    new AbortController();


  const timer =
    setTimeout(
      () =>
        controller.abort(),
      timeoutMs
    );


  try {

    const response =
      await fetch(
        url,
        {
          method: "POST",

          headers: {

            "Content-Type":
              "application/json",

            "x-goog-api-key":
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
                          mediaType ||
                          "image/jpeg",

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


              /*
               * ไม่ใส่ temperature
               * ไม่ใส่ thinkingConfig
               *
               * เพื่อให้เข้ากันได้กับ
               * Gemini 3.8 Flash
               */

              generationConfig: {

                maxOutputTokens:
                  3000
              }

            }),


          signal:
            controller.signal
        }
      );


    const raw =
      await response.text();


    let data;


    try {

      data =
        JSON.parse(raw);

    } catch {

      const error =
        new Error(
          `Gemini ตอบกลับไม่ใช่ JSON (HTTP ${response.status})`
        );

      error.httpStatus =
        response.status;

      error.details =
        raw.slice(0, 1500);

      throw error;
    }


    if (!response.ok) {

      const message =
        data
          ?.error
          ?.message ||
        data
          ?.error
          ?.status ||
        `Gemini HTTP ${response.status}`;


      const error =
        new Error(message);


      error.httpStatus =
        response.status;

      error.details =
        data;


      throw error;
    }


    return data;


  } finally {

    clearTimeout(timer);
  }
}


/* =========================
   MAIN HANDLER
========================= */

module.exports =
  async function handler(
    req,
    res
  ) {


    /*
     * POST only
     */

    if (
      req.method !== "POST"
    ) {

      return json(
        res,
        405,
        {
          error:
            "Method not allowed"
        }
      );
    }


    try {

      let body =
        req.body;


      /*
       * Vercel บางกรณีส่ง string
       */

      if (
        typeof body === "string"
      ) {

        try {

          body =
            JSON.parse(body);

        } catch {

          return json(
            res,
            400,
            {
              error:
                "Request body ไม่ใช่ JSON"
            }
          );
        }
      }


      body =
        body || {};


      const mode =
        body.mode ||
        "column";


      const image =
        body.image;


      const mediaType =
        body.mediaType ||
        "image/jpeg";


      if (
        !image ||
        typeof image !== "string"
      ) {

        return json(
          res,
          400,
          {
            error:
              "ไม่พบ image ใน request"
          }
        );
      }


      /* ==================================================
         MODE 1
         DETECT TOTAL
      ================================================== */

      if (
        mode ===
        "detect_total"
      ) {

        const data =
          await callGemini({

            image,

            mediaType,

            prompt:
              buildTotalPrompt(),

            timeoutMs:
              30000
          });


        const text =
          getGeminiText(data);


        let total =
          parseTotal(text);


        /*
         * กรณี Gemini ตอบแค่:
         *
         * 82
         */

        if (!total) {

          const match =
            text.match(
              /\b([1-9]\d?|100)\b/
            );


          if (match) {

            total =
              Number(match[1]);
          }
        }


        if (
          !total
        ) {

          return json(
            res,
            422,
            {
              error:
                "อ่านจำนวนทั้งหมดจากหัวใบไม่สำเร็จ",

              raw:
                text.slice(
                  0,
                  500
                )
            }
          );
        }


        console.log(
          `[extract] total=${total}`
        );


        return json(
          res,
          200,
          {
            total
          }
        );
      }


      /* ==================================================
         MODE 2
         COLUMN
      ================================================== */

      const columnIndex =
        Number(
          body.columnIndex
        );


      const sheetTotal =
        Number(
          body.sheetTotal
        );


      if (
        !Number.isInteger(
          columnIndex
        ) ||
        columnIndex < 0 ||
        columnIndex > 3
      ) {

        return json(
          res,
          400,
          {
            error:
              "columnIndex ต้องเป็น 0, 1, 2 หรือ 3"
          }
        );
      }


      if (
        !Number.isInteger(
          sheetTotal
        ) ||
        sheetTotal < 1 ||
        sheetTotal > MAX_TOTAL
      ) {

        return json(
          res,
          400,
          {
            error:
              "sheetTotal ไม่ถูกต้อง"
          }
        );
      }


      const expected =
        expectedSequences(
          columnIndex,
          sheetTotal
        );


      console.log(
        `[extract] ` +
        `model=${MODEL} ` +
        `column=${columnIndex + 1}/4 ` +
        `total=${sheetTotal} ` +
        `expected=${expected.join(",")} ` +
        `imageChars=${image.length}`
      );


      const data =
        await callGemini({

          image,

          mediaType,

          prompt:
            buildColumnPrompt(
              columnIndex,
              sheetTotal
            ),

          timeoutMs:
            30000
        });


      const text =
        getGeminiText(data);


      const items =
        parseItems(
          text,
          columnIndex,
          sheetTotal
        );


      const got =
        new Set(
          items.map(
            item =>
              item.seq
          )
        );


      const missing =
        expected.filter(
          seq =>
            !got.has(seq)
        );


      console.log(
        `[extract] ` +
        `column=${columnIndex + 1} ` +
        `got=${items.length}/${expected.length} ` +
        `missing=${missing.join(",") || "none"}`
      );


      console.log(
        `[extract] raw=` +
        text.slice(
          0,
          2000
        )
      );


      /*
       * คืน complete ให้ frontend
       *
       * frontend จะเป็นคนตัดสินใจว่า
       * คอลัมน์ผ่านหรือไม่
       */

      return json(
        res,
        200,
        {

          items,

          columnIndex,

          sheetTotal,

          expectedCount:
            expected.length,

          gotCount:
            items.length,

          missing,

          complete:
            missing.length === 0

        }
      );


    } catch (error) {

      console.error(
        "[extract] error:",
        error
      );


      /*
       * Timeout
       */

      if (
        error.name ===
        "AbortError"
      ) {

        return json(
          res,
          504,
          {
            error:
              "Gemini ใช้เวลานานเกินไป",

            details:
              "timeout"
          }
        );
      }


      /*
       * API key
       */

      if (
        error.code ===
        "NO_KEY"
      ) {

        return json(
          res,
          500,
          {
            error:
              error.message
          }
        );
      }


      const status =
        Number(
          error.httpStatus
        ) || 500;


      let message =
        error.message ||
        "Server error";


      /*
       * Rate limit
       */

      if (
        status === 429
      ) {

        message =
          "Gemini จำกัดการใช้งานชั่วคราว (429)";
      }


      /*
       * Request ใหญ่เกิน
       */

      else if (
        status === 413
      ) {

        message =
          "รูปใหญ่เกินไป (413)";
      }


      /*
       * Key ผิด
       */

      else if (
        status === 401 ||
        status === 403
      ) {

        message =
          "GEMINI_API_KEY ไม่ถูกต้องหรือไม่มีสิทธิ์ใช้งาน";
      }


      /*
       * Model ไม่พบ
       */

      else if (
        status === 404
      ) {

        message =
          `ไม่พบ Gemini model: ${MODEL}`;
      }


      return json(
        res,
        status >= 400 &&
        status < 600
          ? status
          : 500,
        {

          error:
            message,

          details:
            typeof error.details ===
            "string"
              ? error.details.slice(
                  0,
                  1500
                )
              : undefined

        }
      );
    }
  };
