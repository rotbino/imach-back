/**
 * sharp pipeline smoke test — mirrors FilesService.processFile:
 * generate a 4000×3000 jpeg, expect a ≤1600 main + 400 thumb, both jpeg.
 * Run: node scripts/test-sharp.mjs
 */
import sharp from "sharp";

const big = await sharp({
  create: { width: 4000, height: 3000, channels: 3, background: { r: 249, g: 115, b: 22 } },
})
  .jpeg()
  .toBuffer();
console.log("input:", (big.length / 1024).toFixed(0), "KB 4000×3000 jpeg");

const main = await sharp(big).rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
const mainMeta = await sharp(main).metadata();
const thumb = await sharp(big).rotate().resize(400, 400, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 78, mozjpeg: true }).toBuffer();
const thumbMeta = await sharp(thumb).metadata();

console.log("main :", (main.length / 1024).toFixed(0), "KB", `${mainMeta.width}×${mainMeta.height}`, mainMeta.format);
console.log("thumb:", (thumb.length / 1024).toFixed(0), "KB", `${thumbMeta.width}×${thumbMeta.height}`, thumbMeta.format);

if (mainMeta.width !== 1600 || thumbMeta.width !== 400) throw new Error("unexpected dimensions");
if (mainMeta.format !== "jpeg" || thumbMeta.format !== "jpeg") throw new Error("unexpected format");

// PNG with alpha must survive as PNG (logos!)
const logo = await sharp({ create: { width: 800, height: 800, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .png()
  .toBuffer();
const logoMeta = await sharp(logo).metadata();
const logoOut = await sharp(logo).rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer();
const logoOutMeta = await sharp(logoOut).metadata();
console.log("logo :", (logoOut.length / 1024).toFixed(0), "KB", `${logoOutMeta.width}×${logoOutMeta.height}`, logoOutMeta.format, "hasAlpha:", logoOutMeta.hasAlpha);
if (!logoOutMeta.hasAlpha) throw new Error("alpha lost!");

console.log("\n✅ sharp OK — resize+thumb+alpha all correct");
