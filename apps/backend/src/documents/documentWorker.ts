import { parentPort, workerData } from "worker_threads";
import path from "path";
import mammoth from "mammoth";
import JSZip from "jszip";
import ExcelJS from "exceljs";

(async () => {
  const buffer = Buffer.from(workerData.buffer);
  const ext = path.extname(workerData.name).toLowerCase();
  let text = "";
  let note: string | undefined;
  let zip: JSZip | undefined;
  if ([".docx", ".xlsx", ".pptx"].includes(ext)) {
    zip = await JSZip.loadAsync(buffer);
    const entries = Object.values(zip.files);
    const bytes = entries.reduce((sum, file) => sum + Number((file as any)._data?.uncompressedSize ?? 0), 0);
    if (entries.length > 5000 || bytes > 40 * 1024 * 1024) throw new Error("Document expands beyond the supported size.");
  }
  if (ext === ".docx") text = (await mammoth.extractRawText({buffer})).value;
  else if (ext === ".pdf") {
    const pdfjs = await (new Function('return import("pdfjs-dist/legacy/build/pdf.mjs")')());
    const task = pdfjs.getDocument({data: new Uint8Array(buffer), isEvalSupported:false, useSystemFonts:false});
    const pdf = await task.promise;
    try {
      if (pdf.numPages > 200) throw new Error("PDFs are limited to 200 pages.");
      for (let i=1; i<=pdf.numPages && text.length < 100000; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        text += `\n[Page ${i}]\n` + content.items.map((item: any) => item.str ?? "").join(" ");
      }
      note = "Text extraction only; scanned pages may require OCR. Layout and images are not included.";
    } finally { await task.destroy(); }
  } else if (ext === ".xlsx") {
    const book = new ExcelJS.Workbook(); await book.xlsx.load(buffer as any);
    for (const sheet of book.worksheets) {
      text += `\n[Sheet: ${sheet.name}]\n`;
      sheet.eachRow(row => { if (text.length < 100000) text += (row.values as any[]).slice(1).map(value => typeof value === "object" ? JSON.stringify(value) : String(value ?? "")).join("\t") + "\n"; });
    }
  } else if (ext === ".pptx") {
    const files = Object.keys(zip!.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a,b) => a.localeCompare(b, undefined, {numeric:true}));
    for (const name of files) {
      const xml = await zip!.file(name)!.async("string");
      text += `\n[${path.basename(name)}]\n` + [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map(m => m[1].replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,"&")).join("\n");
      if (text.length > 100000) break;
    }
  } else text = buffer.toString("utf8");
  parentPort!.postMessage({text: text.slice(0,100000), truncated:text.length > 100000, note});
})().catch(error => parentPort!.postMessage({error: error.message ?? "Could not read this document."}));
