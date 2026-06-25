// server.js
import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { CustomFile } from 'telegram/client/uploads/index.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// مجلد الميديا الافتراضي للرفع المؤقت فقط (لن نستخدمه للكاش بعد الآن)
const uploadDir = './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname),
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 جيجابايت
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

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

async function getClient() {
  if (client && client.connected) return client;
  console.log("🔌 جاري الاتصال بحساب تليغرام الأساسي...");
  client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
    useWSS: false,
    disableUpdates: true,
  });
  await client.start({
    phoneNumber: async () => new Promise((resolve) => rl.question('أدخل رقم هاتفك: ', resolve)),
    phoneCode: async () => new Promise((resolve) => rl.question('أدخل كود التأكيد: ', resolve)),
    onError: (err) => console.error('❌ خطأ أثناء الاتصال:', err.message),
  });
  
  await fs.promises.writeFile(sessionFile, client.session.save(), 'utf8');
  console.log("✅ الحساب الأساسي متصل وجاهز.");
  return client;
}

async function getStreamClient() {
  if (streamClient && streamClient.connected) return streamClient;
  console.log("⚙️ إنشاء أنبوب البث المستمر مع تليغرام...");
  streamClient = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 10,
    useWSS: false,
    disableUpdates: true,
    autoReconnect: true
  });
  await streamClient.connect();
  streamClient._updatesLoop = false;
  return streamClient;
}

// -------------------------------------------------------------
// 🚀 1. الرفع بالتدفق (بدون readFile المدمرة للرام)
// -------------------------------------------------------------
app.post('/api/upload', upload.single('video'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ success: false, error: 'لم يتم إرسال أي ملف فيديو!' });

  try {
    console.log(`📥 استلام ورفع مباشر (Stream): ${file.originalname}`);
    const clientInstance = await getClient();
    const destination = channelId || 'me';

    // استخدام CustomFile لتمرير مسار الملف مباشرة لتليغرام لكي يقرأه بالتدفق (بدون خنق الرام)
    const stat = fs.statSync(file.path);
    const customFile = new CustomFile(file.originalname, stat.size, file.path);

    const uploadResult = await clientInstance.sendFile(destination, {
      file: customFile,
      caption: `🎬 تم الرفع لمنصة Anicord: ${file.originalname}`,
      supportsStreaming: true,
      workers: 4,
      progressCallback: (progress) => {
        console.log(`⏳ تقدم الرفع: ${(progress * 100).toFixed(2)}%`);
      }
    });

    let fileId, accessHash, fileRefHex, fileSize;
    const media = uploadResult?.media?.document || uploadResult?.media?.video;
    
    if (media) {
      fileId = media.id.toString();
      accessHash = media.accessHash.toString();
      fileRefHex = media.fileReference.toString('hex');
      fileSize = media.size.toString();
    } else {
      throw new Error('فشل استخراج بيانات الملف من رد تليغرام');
    }

    // تنظيف الهارد ديسك فوراً
    fs.promises.unlink(file.path).catch(() => {});

    const combinedId = `${fileId}_${accessHash}_${fileRefHex}_${fileSize}`;
    console.log(`✅ اكتمل الرفع بنجاح! ID: ${combinedId}`);
    res.json({ success: true, file_id: combinedId, mime_type: file.mimetype, file_size: file.size });

  } catch (error) {
    console.error('❌ خطأ فادح أثناء الرفع:', error);
    if (file && fs.existsSync(file.path)) fs.promises.unlink(file.path).catch(() => {});
    res.status(500).json({ success: false, error: error.message });
  }
});

// -------------------------------------------------------------
// 🔥 2. نظام الكاش الخارق في الرام (In-Memory LRU Cache) + 1MB Chunks
// -------------------------------------------------------------
const CHUNK_SIZE = 1024 * 1024; // تم الرفع إلى 1 ميجابايت لتقليل الطلبات
const MAX_RAM_CHUNKS = 150; // أقصى عدد للكتل في الرام (حوالي 150 ميجابايت لحماية Render)

const ramCache = new Map();
const activeDownloads = new Map();

async function fetchChunkFromTelegram(fileId, accessHash, fileRefHex, chunkIndex, totalSize) {
  const taskKey = `${fileId}_${chunkIndex}`;

  // 1. هل هي موجودة في كاش الرام السريع؟
  if (ramCache.has(taskKey)) {
    const data = ramCache.get(taskKey);
    // نقل الكتلة لآخر الخريطة (لتبقى حديثة ولا تُحذف - LRU Logic)
    ramCache.delete(taskKey);
    ramCache.set(taskKey, data);
    return data;
  }

  // 2. هل يتم تحميلها الآن من قبل مستخدم آخر؟ (Promise Deduplication)
  if (activeDownloads.has(taskKey)) {
    return await activeDownloads.get(taskKey);
  }

  const tgOffset = chunkIndex * CHUNK_SIZE;
  if (totalSize && tgOffset >= totalSize) return Buffer.alloc(0);

  // 3. الجلب من تليغرام
  const downloadPromise = (async () => {
    try {
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
          limit: CHUNK_SIZE
        })
      );

      if (fileResult && fileResult.bytes && fileResult.bytes.length > 0) {
        // حماية الرام: إذا امتلأت، احذف أقدم كتلة
        if (ramCache.size >= MAX_RAM_CHUNKS) {
          const oldestKey = ramCache.keys().next().value;
          ramCache.delete(oldestKey);
        }
        // حفظ في الرام
        ramCache.set(taskKey, fileResult.bytes);
        return fileResult.bytes;
      }
      return Buffer.alloc(0);
    } catch (err) {
      // التقاط خطأ FILE_REFERENCE_EXPIRED
      if (err.message.includes('FILE_REFERENCE_EXPIRED')) {
        console.error(`🚨 [تنبيه] مرجع الملف منتهي الصلاحية لـ ${fileId}. يجب تجديده من قاعدة البيانات!`);
      }
      throw err;
    }
  })();

  activeDownloads.set(taskKey, downloadPromise);

  try {
    return await downloadPromise;
  } finally {
    activeDownloads.delete(taskKey);
  }
}

// -------------------------------------------------------------
// 3️⃣ مسار البث (Stream) الخالي من أخطاء الـ Range
// -------------------------------------------------------------
app.get('/api/video/stream/:combinedId', async (req, res) => {
  const { combinedId } = req.params;

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

    const chunkBuffer = await fetchChunkFromTelegram(fileId, accessHash, fileRefHex, currentChunkIndex, totalSize);

    if (!chunkBuffer || chunkBuffer.length === 0) return res.status(404).end();

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

    // 💡 4. Cache-Control: إجبار المتصفح على تخزين الفيديو محلياً
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    if (totalSize) {
      res.setHeader('Content-Length', availableLength.toString());
      res.setHeader('Content-Range', `bytes ${startByte}-${calculatedEnd}/${totalSize}`);
      res.status(206);
    } else {
      res.status(200);
    }

    const cleanBuffer = chunkBuffer.subarray(extraBytes, extraBytes + availableLength);
    res.write(cleanBuffer);
    res.end();

  } catch (error) {
    if (!res.headersSent) res.status(500).end();
  }
});

// -------------------------------------------------------------
// 📊 نظام المراقبة الحي للرام (لود تيست)
// -------------------------------------------------------------
setInterval(() => {
  const mem = process.memoryUsage();
  console.log(`[📊] الرام: ${(mem.rss / 1024 / 1024).toFixed(2)} MB | الكاش: ${ramCache.size}/${MAX_RAM_CHUNKS} كتل | طلبات معلقة: ${activeDownloads.size}`);
}, 10000);

app.listen(PORT, async () => {
  console.log(`🚀 محرك أنيكورد V3 الخارق يعمل الآن على: http://localhost:${PORT}`);
  try { await getClient(); } catch (err) {}
});
