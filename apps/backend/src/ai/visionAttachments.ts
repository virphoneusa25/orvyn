import type { Attachment } from "@orvyn/ai-core";
import { chromium } from "playwright";

/** Convert ICO model inputs while preserving the original customer file. */
export async function normalizeVisionAttachments(attachments: Attachment[]): Promise<Attachment[]> {
 return Promise.all(attachments.map(async attachment=>{
  if(attachment.kind!=="image"||(!/\.ico$/i.test(attachment.name??"")&&!/icon/i.test(attachment.mediaType??"")))return attachment;
  const bytes=Buffer.from(attachment.b64??"","base64");
  if(bytes.length<22||bytes.length>10*1024*1024||bytes.readUInt32LE(0)!==65536)throw new Error("This icon could not be read. Upload it as PNG, JPEG or WebP.");
  const count=bytes.readUInt16LE(4);
  if(!count||count>256||6+count*16>bytes.length)throw new Error("This icon could not be read. Upload it as PNG.");
  const frames=Array.from({length:count},(_,index)=>{
   const p=6+index*16;return {pixels:(bytes[p]||256)*(bytes[p+1]||256),size:bytes.readUInt32LE(p+8),offset:bytes.readUInt32LE(p+12)};
  }).filter(f=>f.size>0&&f.offset>=6+count*16&&f.offset+f.size<=bytes.length).sort((a,b)=>b.pixels-a.pixels);
  for(const f of frames){const png=bytes.subarray(f.offset,f.offset+f.size);if(png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {...attachment,mediaType:"image/png",b64:png.toString("base64")};}
  // Decode legacy bitmap frames using existing Chromium. Only bounded icon
  // bytes enter this page; networking is blocked and no credential is passed.
  const browser=await chromium.launch({headless:true,args:["--no-sandbox"],timeout:15000});
  try{
   const page=await browser.newPage();await page.route("**/*",route=>route.abort());
   await page.setContent(`<img id="icon" src="data:image/x-icon;base64,${bytes.toString("base64")}">`);
   const png=await page.locator("#icon").evaluate(async element=>{
    const image=element as HTMLImageElement;await image.decode();
    if(!image.naturalWidth||image.naturalWidth>256||image.naturalHeight>256)throw new Error("Invalid icon size");
    const canvas=document.createElement("canvas");canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
    canvas.getContext("2d")!.drawImage(image,0,0);return canvas.toDataURL("image/png").split(",")[1]!;
   },undefined,{timeout:10000});
   return {...attachment,mediaType:"image/png",b64:png};
  }catch{throw new Error("This icon could not be read. Upload it as PNG, JPEG or WebP.");}finally{await browser.close();}
 }));
}
