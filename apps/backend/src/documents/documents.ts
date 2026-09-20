import { promises as fs } from "fs";
import path from "path";
import { Worker } from "worker_threads";
import { Document, Packer, Paragraph, HeadingLevel } from "docx";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import ExcelJS from "exceljs";
import PptxGenJS from "pptxgenjs";

export const DOCUMENT_LIMIT = 6 * 1024 * 1024;
export const DOCUMENT_EXTENSIONS = new Set([".docx", ".pdf", ".xlsx", ".pptx", ".csv", ".txt", ".md"]);

// Resolve existing ancestors too: lexical checks alone allow symlink escapes.
export async function documentPath(root: string, relative: string): Promise<string> {
  if (!relative || path.isAbsolute(relative)) throw new Error("Use a path relative to the current project.");
  const base = await fs.realpath(root);
  const target = path.resolve(base, relative);
  const inside = (p: string) => { const rel = path.relative(base, p); return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
  if (!inside(target)) throw new Error("Document path is outside the current project.");
  let ancestor = target;
  for (;;) {
    try { if (!inside(await fs.realpath(ancestor))) throw new Error("Document symlink is outside the current project."); break; }
    catch (e: any) { if (e.code !== "ENOENT") throw e; ancestor = path.dirname(ancestor); }
  }
  return target;
}

let activeReaders = 0;
export async function extractDocument(name: string, buffer: Buffer): Promise<{ text: string; truncated: boolean; note?: string }> {
  if (!DOCUMENT_EXTENSIONS.has(path.extname(name).toLowerCase())) throw new Error("Supported formats: DOCX, PDF, XLSX, PPTX, CSV, TXT and Markdown. Convert older .doc files to .docx first.");
  if (!buffer.length || buffer.length > DOCUMENT_LIMIT) throw new Error("Documents must be nonempty and at most 6 MB.");
  if (activeReaders >= 3) throw new Error("Document readers are busy. Please try again shortly.");
  activeReaders++;
  try {
    return await new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, "documentWorker.js"), { workerData: { name, buffer }, resourceLimits: { maxOldGenerationSizeMb: 192 } });
      const timer = setTimeout(() => { void worker.terminate(); reject(new Error("Document processing exceeded 20 seconds.")); }, 20_000);
      const cleanup = () => { clearTimeout(timer); void worker.terminate(); };
      worker.once("message", message => { cleanup(); message.error ? reject(new Error(message.error)) : resolve(message); });
      worker.once("error", e => { cleanup(); reject(e); });
      worker.once("exit", code => { clearTimeout(timer); if (code !== 0) reject(new Error("Document reader stopped before finishing.")); });
    });
  } finally { activeReaders--; }
}

export async function writeDocument(root: string, input: Record<string, unknown>): Promise<string> {
  const name = String(input.name ?? "");
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,115}\.(docx|pdf|xlsx|pptx|csv|md|txt)$/u.test(name)) throw new Error("Use a filename such as report.docx, report.pdf, budget.xlsx or slides.pptx (no folders).");
  const title = String(input.title ?? path.parse(name).name).slice(0, 200);
  const content = String(input.content ?? "");
  if (content.length > 100_000 || JSON.stringify(input).length > 250_000) throw new Error("Document input is too large; split it into smaller documents.");
  const relative = `.orvyn/artifacts/${name}`;
  const target = await documentPath(root, relative);
  const ext = path.extname(name);
  let data: Uint8Array | Buffer | string;
  if ([".docx", ".pdf", ".md", ".txt"].includes(ext) && !content.trim()) throw new Error("content is required.");
  if (ext === ".docx") {
    const paragraphs = content.split(/\r?\n/).map(line => {
      const heading = line.match(/^(#{1,3})\s+(.+)/);
      return new Paragraph(heading ? { text: heading[2], heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][heading[1].length - 1] } : /^[-*] /.test(line) ? {text: line.slice(2), bullet: {level: 0}} : {text: line, spacing: {after: 120}});
    });
    data = await Packer.toBuffer(new Document({ title, creator: "ORVYN", sections: [{children: [new Paragraph({text: title, heading: HeadingLevel.TITLE}), ...paragraphs]}] }));
  } else if (ext === ".pdf") {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(await fs.readFile(require.resolve("@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff")), {subset: true});
    const supported = new Set(font.getCharacterSet());
    if ([...title + content].some(char => !/[\r\n\t]/.test(char) && !supported.has(char.codePointAt(0)!))) throw new Error("This PDF font does not support some characters. Create a DOCX to preserve this text instead.");
    let page = doc.addPage([595, 842]); let y = 786;
    const line = (text: string, size: number) => {
      if (y < 58) { page = doc.addPage([595, 842]); y = 786; }
      page.drawText(text, {x: 48, y, size, font, color: rgb(.12, .16, .22)}); y -= size * 1.55;
    };
    for (const [paragraph, size] of [[title, 20], ...content.split(/\r?\n/).map(p => [p.replace(/^#{1,3}\s+/, ""), /^#/.test(p) ? 15 : 11])] as [string, number][]) {
      let current = "";
      for (const char of paragraph) {
        if (current && font.widthOfTextAtSize(current + char, size) > 499) { line(current, size); current = ""; }
        current += char;
      }
      line(current, size); y -= 5;
    }
    doc.setTitle(title); data = await doc.save();
  } else if (ext === ".xlsx" || ext === ".csv") {
    const rows = input.rows;
    if (!Array.isArray(rows) || rows.length > 2000 || !rows.every(row => Array.isArray(row) && row.length <= 100 && row.every(cell => cell === null || ["string", "number", "boolean"].includes(typeof cell)))) throw new Error("rows must be an array of up to 2,000 rows of plain values, at most 100 columns each.");
    const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet("Data");
    sheet.addRows(rows);
    sheet.getRow(1).font = {bold: true, color: {argb:"FFFFFFFF"}};
    sheet.getRow(1).fill = {type: "pattern", pattern: "solid", fgColor:{argb:"FF253F63"}};
    sheet.columns.forEach(column => {column.width = 24;});
    sheet.views = [{state:"frozen", ySplit:1}];
    // Prevent spreadsheet formula injection when a CSV is opened in Excel.
    if (ext === ".csv") sheet.eachRow(row => row.eachCell(cell => { if (typeof cell.value === "string" && /^[=+@\-\t\r]/.test(cell.value)) cell.value = `'${cell.value}`; }));
    data = Buffer.from(ext === ".xlsx" ? await book.xlsx.writeBuffer() : await book.csv.writeBuffer());
  } else if (ext === ".pptx") {
    if (!Array.isArray(input.slides) || !input.slides.length || input.slides.length > 30) throw new Error("slides must contain 1–30 objects with title and body.");
    const deck = new PptxGenJS(); deck.layout = "LAYOUT_WIDE"; deck.title = title; deck.author = "ORVYN";
    for (const item of input.slides) {
      if (!item || typeof item.title !== "string" || typeof item.body !== "string" || item.title.length > 120 || item.body.length > 800) throw new Error("Each slide needs a title (up to 120 characters) and body (up to 800 characters).");
      const slide = deck.addSlide(); slide.background = {color:"F6F8FC"};
      slide.addText(item.title, {x:.6,y:.5,w:12.1,h:1,fontSize:28,color:"253F63",bold:true,breakLine:false,fit:"shrink"});
      slide.addText(item.body, {x:.6,y:1.8,w:12.1,h:4.8,fontSize:20,color:"253F63",breakLine:false,fit:"shrink",valign:"top"});
    }
    data = await deck.write({outputType:"nodebuffer"}) as Buffer;
  } else data = content;
  await fs.mkdir(path.dirname(target), {recursive:true});
  // Exclusive creation avoids silently overwriting a previous deliverable.
  await fs.writeFile(target, data, {flag:"wx"});
  return relative;
}
