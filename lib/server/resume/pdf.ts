import { Document, Packer, Paragraph, TextRun } from "docx"
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib"

const PAGE = { width: 595.28, height: 841.89, margin: 54 }
const BULLET = /^\s*(?:[-*•▪◦]|\d+[.)])\s+/

// Standard fonts only encode WinAnsi; map common typography, drop the rest.
function encodable(font: PDFFont, text: string) {
  const supported = new Set(font.getCharacterSet())
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\t/g, "  ")
    .split("")
    .filter((char) => supported.has(char.codePointAt(0)!))
    .join("")
}

function wrap(font: PDFFont, size: number, text: string, width: number) {
  const lines: string[] = []
  let line = ""
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word
    if (font.widthOfTextAtSize(next, size) <= width || !line) line = next
    else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  return lines
}

function isHeading(line: string) {
  const text = line.replace(/^#+\s*/, "").replace(/:$/, "")
  return (
    /^#+\s/.test(line) ||
    (text.length <= 40 &&
      /[A-Z]/.test(text) &&
      text === text.toUpperCase() &&
      !/[.,;]$/.test(text))
  )
}

export async function resumePdf(content: string, title = "Resume") {
  const pdf = await PDFDocument.create()
  pdf.setTitle(title)
  pdf.setProducer("Next Move")
  const regular = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const width = PAGE.width - PAGE.margin * 2
  let page = pdf.addPage([PAGE.width, PAGE.height])
  let y = PAGE.height - PAGE.margin

  const ensure = (height: number) => {
    if (y - height >= PAGE.margin) return
    page = pdf.addPage([PAGE.width, PAGE.height])
    y = PAGE.height - PAGE.margin
  }
  const draw = (
    text: string,
    font: PDFFont,
    size: number,
    indent = 0,
    color = rgb(0.13, 0.13, 0.15)
  ) => {
    for (const line of wrap(font, size, text, width - indent)) {
      ensure(size * 1.4)
      y -= size * 1.4
      page.drawText(line, { x: PAGE.margin + indent, y, size, font, color })
    }
  }

  const lines = content.replace(/\r\n?/g, "\n").split("\n")
  const first = lines.findIndex((line) => line.trim())
  for (const [index, raw] of lines.entries()) {
    const line = encodable(regular, raw.trimEnd())
    if (!line.trim()) {
      y -= 6
      continue
    }
    if (index === first && !isHeading(line.trim())) {
      draw(line.trim().replace(/^#+\s*/, ""), bold, 18)
      y -= 4
    } else if (isHeading(line.trim())) {
      ensure(30)
      y -= 8
      draw(
        line
          .trim()
          .replace(/^#+\s*/, "")
          .replace(/:$/, ""),
        bold,
        11
      )
      y -= 3
      page.drawLine({
        start: { x: PAGE.margin, y },
        end: { x: PAGE.width - PAGE.margin, y },
        thickness: 0.6,
        color: rgb(0.75, 0.75, 0.78),
      })
      y -= 3
    } else if (BULLET.test(line)) {
      const text = line.replace(BULLET, "")
      ensure(15)
      page.drawText("•", {
        x: PAGE.margin + 4,
        y: y - 10.5 * 1.4,
        size: 10.5,
        font: regular,
      })
      draw(text, regular, 10.5, 16)
    } else draw(line.trim(), regular, 10.5)
  }
  return pdf.save()
}

export function pdfResponse(
  bytes: Uint8Array,
  filename: string,
  inline: boolean
) {
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  })
}

export async function resumeDocx(content: string) {
  const bytes = await Packer.toBuffer(
    new Document({
      sections: [
        {
          children: content.split("\n").map(
            (text) =>
              new Paragraph({
                children: [new TextRun({ text, size: 22 })],
                spacing: { after: 100 },
              })
          ),
        },
      ],
    })
  )
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": 'attachment; filename="resume.docx"',
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
