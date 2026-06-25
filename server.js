// server.js
import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// مجلد الميديا الافتراضي ومجلد الكاش الذكي
const uploadDir = './uploads';
const cacheDir = path.join(uploadDir, 'cache');

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

// إعداد كائن تخزين multer لحفظ الملفات المرفوعة مؤقتاً باسمائها الأصلية
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  },
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // حد أقصى 2 جيجابايت
});

app.use(cors());
app.use(express.json());

const apiId = parseInt(process.env.API_ID || "3333"); 
const apiHash = process.env.API_HASH || "your_api_hash_here";
const channelId = process.env.CHANNEL_ID ? parseInt(process.env.CHANNEL_ID) : null;

const sessionFile = path.join(__dirname, 'session.txt');
let sessionString = '';
if (fs.existsSync(sessionFile)) {
  sessionString = fs.readFileSync(sessionFile, 'utf8').trim();
}

const stringSession = new StringSession(sessionString);
let client;
let streamClient; 

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

async function getClient() {
  if (client && client.connected) return client;
  console.log("🔌 جاري الاتصال بحساب تليغرام الأساسي...");
  client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
    useWSS: false,
    disableUpdates: true,
  });
  await client.start({
    phoneNumber: async () => new Promise((resolve) => rl.question('أدخل رقم هاتفك بالتنسيق الدولي: ', resolve)),
    phoneCode: async () => new Promise((resolve) => rl.question('أدخل كود التأكيد: ', resolve)),
    onError: (err) => console.error('❌ خطأ أثناء الاتصال:', err.message),
  });
  
  // حفظ الجلسة إذا كانت جديدة
  const newSessionString = client.session.save();
  await fs.promises.writeFile(sessionFile, newSessionString, 'utf8');
  
  console.log("✅ الحساب الأساسي متصل وجاهز.");
  return client;
}

async function getStreamClient() {
  if (streamClient && streamClient.connected) return streamClient;

  console.log("⚙️ [اتصال أول مرة] إنشاء أنبوب البث المستمر مع تليغرام...");
  streamClient = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 10,
    useWSS: false,
    disableUpdates: true,
    autoReconnect: true
  });

  await streamClient.connect();
  streamClient._updatesLoop = false;
  
  console.log("🛰️ أنبوب البث العالمي جاهز الآن وسريع جداً.");
  return streamClient;
}

// -------------------------------------------------------------
// 🚀 مسار الرفع المطور
// -------------------------------------------------------------
app.post('/api/upload', upload.single('video'), async (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ success: false, error: 'لم يتم إرسال أي ملف فيديو!' });
  }

  try {
    console.log(`📥 استلام ملف جديد من الواجهة: ${file.originalname} (${(file.size / 1024 / 1024).toFixed(2)} ميجابايت)`);

    const clientInstance = await getClient();
    const destination = channelId || 'me';

    // استخدام Buffer لتفادي مشكلة مسارات الويندوز
    const fileBuffer = await fs.promises.readFile(file.path);

    const uploadResult = await clientInstance.sendFile(destination, {
      file: fileBuffer,
      caption: `🎬 تم الرفع لمنصة Anicord: ${file.originalname}`,
      supportsStreaming: true,
      workers: 4,
      progressCallback: (progress) => {
        console.log(`⏳ نسبة تقدم الرفع: ${(progress * 100).toFixed(2)}%`);
      }
    });

    let fileId = null;
    let accessHash = '0';
    let fileRefHex = '0';
    let fileSize = '0';

    if (uploadResult?.media?.document) {
      fileId = uploadResult.media.document.id.toString();
      accessHash = uploadResult.media.document.accessHash.toString();
      fileRefHex = uploadResult.media.document.fileReference.toString('hex');
      fileSize = uploadResult.media.document.size.toString();
    } else if (uploadResult?.media?.video) {
      fileId = uploadResult.media.video.id.toString();
      accessHash = uploadResult.media.video.accessHash.toString();
      fileRefHex = uploadResult.media.video.fileReference.toString('hex');
      fileSize = uploadResult.media.video.size.toString();
    }

    if (!fileId) {
      throw new Error('فشل استخراج بيانات الملف من رد تليغرام');
    }

    // تنظيف الملف المؤقت باستخدام النسخة غير الحاصرة
    fs.promises.unlink(file.path).catch(err => console.warn('⚠️ تنبيه: فشل حذف الملف المؤقت:', err));

    const combinedId = `${fileId}_${accessHash}_${fileRefHex}_${fileSize}`;
    console.log(`✅ اكتمل الرفع بنجاح! الـ file_id المدمج: ${combinedId}`);
    
    res.json({
      success: true,
      file_id: combinedId, 
      mime_type: file.mimetype,
      file_size: file.size,
    });

  } catch (error) {
    console.error('❌ خطأ فادح أثناء الرفع:', error);
    if (file && fs.existsSync(file.path)) {
      fs.promises.unlink(file.path).catch(() => {});
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// -------------------------------------------------------------
// 🔥 دوال محرك البث التدفقي والـ Cache الذكي (النسخة المضادة للقنابل)
// -------------------------------------------------------------
const CHUNK_SIZE = 128 * 1024; 
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 💡 خريطة تخزين الوعود لمنع تكرار التحميل لنفس القطعة (Promise Deduplication)
const activeDownloads = new Map();

async function fetchChunkWithCache(fileId, accessHash, fileRefHex, chunkIndex, totalSize) {
  // 💡 إنشاء مجلد خاص لكل حلقة لتفادي انفجار عدد الملفات في مجلد واحد
  const episodeCacheDir = path.join(cacheDir, fileId);
  await fs.promises.mkdir(episodeCacheDir, { recursive: true });
  
  const cachePath = path.join(episodeCacheDir, `chunk_${chunkIndex}.dat`);

  // 💡 القراءة غير الحاصرة (Async) لحماية Event Loop
  if (fs.existsSync(cachePath)) {
    return await fs.promises.readFile(cachePath);
  }

  const tgOffset = chunkIndex * CHUNK_SIZE;
  if (totalSize && tgOffset >= totalSize) return Buffer.alloc(0);

  const taskKey = `${fileId}_${chunkIndex}`;

  // 💡 نظام دمج الطلبات: إذا كانت القطعة قيد التحميل مسبقاً، انتظر النتيجة بدلاً من طلبها مجدداً
  if (activeDownloads.has(taskKey)) {
    return await activeDownloads.get(taskKey);
  }

  // إذا لم تكن قيد التحميل، ابدأ التحميل واحفظ الوعد (Promise)
  const downloadPromise = (async () => {
    let tgLimit = CHUNK_SIZE;
    const tgStreamClient = await getStreamClient();
    const fileResult = await tgStreamClient.invoke(
      new Api.upload.GetFile({
        location: new Api.InputDocumentFileLocation({
          id: BigInt(fileId),
          accessHash: BigInt(accessHash),
          fileReference: fileRefHex !== '0' ? Buffer.from(fileRefHex, 'hex') : Buffer.alloc(0),
          thumbSize: ""
        }),
        offset: BigInt(tgOffset),
        limit: tgLimit
      })
    );

    if (fileResult && fileResult.bytes && fileResult.bytes.length > 0) {
      // 💡 الكتابة غير الحاصرة لحماية السيرفر
      await fs.promises.writeFile(cachePath, fileResult.bytes);
      return fileResult.bytes;
    }
    return Buffer.alloc(0);
  })();

  activeDownloads.set(taskKey, downloadPromise);

  try {
    return await downloadPromise;
  } finally {
    // 💡 تنظيف الخريطة فور انتهاء التحميل
    activeDownloads.delete(taskKey);
  }
}

// 💡 إدارة الجلب المسبق بهدوء لمنع اختناق الشبكة
const activePrefetches = new Set();
async function prefetchNextChunks(fileId, accessHash, fileRefHex, currentChunkIndex, totalSize) {
  const PREFETCH_COUNT = 2; 
  await delay(200);

  for (let i = 1; i <= PREFETCH_COUNT; i++) {
    const nextIndex = currentChunkIndex + i;
    const maxChunks = Math.ceil(totalSize / CHUNK_SIZE);
    if (nextIndex >= maxChunks) break;

    const taskKey = `prefetch_${fileId}_${nextIndex}`;
    const episodeCacheDir = path.join(cacheDir, fileId);
    const cachePath = path.join(episodeCacheDir, `chunk_${nextIndex}.dat`);

    if (fs.existsSync(cachePath) || activePrefetches.has(taskKey)) {
      continue;
    }

    try {
      activePrefetches.add(taskKey);
      await fetchChunkWithCache(fileId, accessHash, fileRefHex, nextIndex, totalSize);
      console.log(`⚡ [Prefetch الهادئ] تم تجهيز الكتلة [${nextIndex}] بنجاح.`);
      await delay(300); 
    } catch (err) {
      break; 
    } finally {
      activePrefetches.delete(taskKey);
    }
  }
}

// -------------------------------------------------------------
// 2️⃣ مسار البث الاحترافي الخارق
// -------------------------------------------------------------
app.get('/api/video/stream/:combinedId', async (req, res) => {
  const { combinedId } = req.params;
  const requestId = Math.random().toString(36).substring(7);

  let isStreamDestroyed = false;
  req.on('close', () => { isStreamDestroyed = true; });

  try {
    const parts = combinedId.split('_');
    if (parts.length < 2) return res.status(400).json({ error: 'معرف غير صالح' });

    const fileId = parts[0];
    const accessHash = parts[1];
    const fileRefHex = parts[2] && parts[2] !== 'undefined' ? parts[2] : '0';
    const totalSize = parts[3] ? parseInt(parts[3], 10) : 0; 

    const rangeHeader = req.headers.range;
    let startByte = 0;
    let endByte = totalSize ? totalSize - 1 : 0;

    if (rangeHeader) {
      const rangeParts = rangeHeader.replace(/bytes=/, "").split("-");
      startByte = parseInt(rangeParts[0], 10);
      if (rangeParts[1]) {
        endByte = parseInt(rangeParts[1], 10);
      }
    }

    const currentChunkIndex = Math.floor(startByte / CHUNK_SIZE);
    const chunkStartByte = currentChunkIndex * CHUNK_SIZE;
    const extraBytes = startByte - chunkStartByte;

    const chunkBuffer = await fetchChunkWithCache(fileId, accessHash, fileRefHex, currentChunkIndex, totalSize);

    if (!chunkBuffer || chunkBuffer.length === 0) {
      return res.status(404).end();
    }

    let availableLength = chunkBuffer.length - extraBytes;
    if (availableLength < 0) availableLength = 0;

    let calculatedEnd = startByte + availableLength - 1;

    if (rangeHeader && rangeHeader.replace(/bytes=/, "").split("-")[1]) {
      const browserEnd = parseInt(rangeHeader.replace(/bytes=/, "").split("-")[1], 10);
      if (browserEnd < calculatedEnd) {
        calculatedEnd = browserEnd;
        availableLength = calculatedEnd - startByte + 1;
      }
    }

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    if (totalSize) {
      res.setHeader('Content-Length', availableLength.toString());
      res.setHeader('Content-Range', `bytes ${startByte}-${calculatedEnd}/${totalSize}`);
      res.status(206);
    } else {
      res.status(200);
    }

    if (isStreamDestroyed) return;

    const cleanBuffer = chunkBuffer.subarray(extraBytes, extraBytes + availableLength);
    res.write(cleanBuffer);
    res.end();

    prefetchNextChunks(fileId, accessHash, fileRefHex, currentChunkIndex, totalSize);

  } catch (error) {
    console.error(`[${requestId}] ❌ خطأ في محرك البث المطور:`, error.message);
    if (!res.headersSent) res.status(500).json({ error: 'خطأ داخلي في السيرفر' });
  }
});

// -------------------------------------------------------------
// تهيئة السيرفر والإقلاع
// -------------------------------------------------------------
app.listen(PORT, async () => {
  console.log(`🚀 محرك الأنمي والـ Cache المطور يعمل الآن باستقرار تام على: http://localhost:${PORT}`);
  try {
    await getClient();
  } catch (err) {
    console.error('⚠️ تنبيه: فشل الاتصال الأولي بالتليغرام.', err);
  }
});
