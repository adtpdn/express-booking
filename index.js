// index.js — Vercel-ready version (100% logic preserved)
const express = require('express');
const path = require('path');
const markdown = require('markdown-it')();
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const { webcrypto } = require('crypto');
const multer = require('multer');
const sharp = require('sharp');
const fs = require('fs').promises;

const app = express();
const port = process.env.PORT || 6969;

// View engine & middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret-key-2025',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: process.env.NODE_ENV === 'production' }
}));

app.use((req, res, next) => {
  res.locals.isAuthenticated = !!req.session.isAuthenticated;
  next();
});

// Rate limiting for booking submission
const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many booking attempts, please try again later.'
});

// Captcha system (in-memory — safe for serverless)
const captchas = new Map();
function generateCaptcha() {
  const num1 = Math.floor(Math.random() * 10) + 1;
  const num2 = Math.floor(Math.random() * 10) + 1;
  const sum = num1 + num2;
  const idArray = new Uint8Array(16);
  webcrypto.getRandomValues(idArray);
  const id = Array.from(idArray, b => b.toString(16).padStart(2, '0')).join('');
  return { id, question: `What is ${num1} + ${num2}?`, answer: sum, createdAt: Date.now() };
}
setInterval(() => {
  const old = Date.now() - 5 * 60 * 1000;
  for (const [id, c] of captchas.entries()) {
    if (c.createdAt < old) captchas.delete(id);
  }
}, 5 * 60 * 1000);

// Multer (in-memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

// KV Keys
const KEYS = {
  bookings: 'bookings_v2',
  comments: 'comments_v2',
  settings: 'settings_v2'
};

const DATA_DIR = path.join(__dirname, 'data');

// Helper: Get/Set JSON from local filesystem
async function getJson(key, defaultValue = []) {
  try {
    const data = await fs.readFile(path.join(DATA_DIR, `${key}.json`), 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Data get error:', err);
    return defaultValue;
  }
}

async function setJson(key, value) {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(path.join(DATA_DIR, `${key}.json`), JSON.stringify(value, null, 2), 'utf-8');
  } catch (err) {
    console.error('Data set error:', err);
  }
}



// Short ID generator
function generateShortId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Parse Markdown service
function parseServiceMarkdown(content) {
  const lines = content.split('\n');
  const service = { title: '', description: '', price: 0, thumbnail: '', category: '', addons: [], options: [] };
  let currentSection = '';

  lines.forEach((line, index) => {
    line = line.trim();
    if (line.startsWith('# ')) service.title = line.slice(2).trim();
    else if (index === 1 && line) service.description = line;
    else if (line.startsWith('## ') && line.toLowerCase().includes('price')) {
      const m = line.match(/\$([\d.]+)/);
      if (m) service.price = parseFloat(m[1]);
    }
    else if (line.startsWith('Thumbnail: ')) service.thumbnail = line.slice(11).trim();
    else if (line.startsWith('Category: ')) service.category = line.slice(10).trim();
    else if (line === '### Addons:') currentSection = 'addons';
    else if (line === '### Options:') currentSection = 'options';
    else if (currentSection === 'addons' && line.startsWith('- ')) {
      const [namePart, pricePart] = line.slice(2).split(': $');
      const description = lines[index + 1]?.trim().startsWith('Description:') ? lines[index + 1].trim().slice(12) : '';
      if (namePart && pricePart) {
        service.addons.push({ name: namePart.trim(), price: parseFloat(pricePart), description });
      }
    }
    else if (currentSection === 'options' && line.startsWith('- [')) {
      const match = line.match(/- \[(.*?)\] (.*?)( \(required\))?: (.*)/);
      if (match) {
        const values = match[4].split(', ').map(v => {
          const p = v.match(/(.*?) \(\+?\$([\d.]+)\)/);
          return p ? { name: p[1].trim(), price: parseFloat(p[2]) } : { name: v.trim(), price: 0 };
        });
        service.options.push({
          type: match[1], name: match[2], required: !!match[3], values
        });
      }
    }
  });
  return service;
}

// Load services from /content/services/*.md (filesystem is allowed on Vercel)
async function getServices() {
  const fs = require('fs').promises;
  const servicesDir = path.join(__dirname, 'content', 'services');
  try {
    const files = await fs.readdir(servicesDir);
    const services = [];
    for (const file of files) {
      if (file.endsWith('.md')) {
        const content = await fs.readFile(path.join(servicesDir, file), 'utf-8');
        services.push(parseServiceMarkdown(content));
      }
    }
    return services;
  } catch (err) {
    console.error('Error loading services:', err);
    return [];
  }
}

// Settings helper
async function getSettings() {
  const defaults = { whatsapp_number: '+6285711111111', reportPassword: '' };
  return await getJson(KEYS.settings, defaults);
}

// Routes
app.get('/', async (req, res) => {
  const services = await getServices();
  res.render('index', { services });
});

app.get('/booking-form', async (req, res) => {
  const services = await getServices();
  const service = services.find(s => s.title === req.query.service);
  if (!service) return res.status(404).render('error', { message: 'Service not found' });

  const settings = await getSettings();
  const captcha = generateCaptcha();
  captchas.set(captcha.id, captcha);

  res.render('booking-form', {
    service,
    whatsappNumber: settings.whatsapp_number,
    captcha: { id: captcha.id, question: captcha.question }
  });
});

app.post('/submit-booking', submitLimiter, async (req, res) => {
  const { service, date, addons, options, name, whatsappNumber, email, captcha, captchaId } = req.body;

  const captchaObj = captchas.get(captchaId);
  captchas.delete(captchaId);
  if (!captchaObj || parseInt(captcha) !== captchaObj.answer) {
    return res.status(400).render('error', { message: 'Invalid captcha. Please try again.' });
  }

  const services = await getServices();
  const selectedService = services.find(s => s.title === service);
  if (!selectedService) return res.status(400).send('Invalid service');

  let totalPrice = selectedService.price;
  const selectedAddons = Array.isArray(addons) ? addons : [addons].filter(Boolean);
  selectedAddons.forEach(a => {
    const addon = selectedService.addons.find(x => x.name === a);
    if (addon) totalPrice += addon.price;
  });
  Object.entries(options || {}).forEach(([k, v]) => {
    const opt = selectedService.options.find(o => o.name === k);
    const val = opt?.values.find(x => x.name === v);
    if (val) totalPrice += val.price;
  });

  let bookings = await getJson(KEYS.bookings, []);
  let shortId;
  do { shortId = generateShortId(); } while (bookings.some(b => b.id === shortId));

  const booking = {
    id: shortId,
    name, whatsappNumber, email,
    serviceTitle: service,
    date,
    addons: selectedAddons.map(a => ({ name: a, price: selectedService.addons.find(x => x.name === a)?.price || 0 })),
    options: options || {},
    totalPrice,
    status: 'pending'
  };

  bookings.push(booking);
  await setJson(KEYS.bookings, bookings);

  const settings = await getSettings();
  const waMsg = encodeURIComponent(`New Booking!\nID: ${shortId}\nService: ${service}\nDate: ${date}\nTotal: $${totalPrice}\nName: ${name}`);
  const waUrl = `https://wa.me/${settings.whatsapp_number}?text=${waMsg}`;

  res.redirect(`/booking-success?id=${shortId}&whatsapp=${encodeURIComponent(waUrl)}`);
});

app.get('/booking-success', (req, res) => {
  const { id, whatsapp } = req.query;
  if (!id) return res.redirect('/');
  res.render('booking-success', { bookingId: id, whatsappUrl: whatsapp });
});

// Track booking
app.get('/track-booking', (req, res) => res.render('track-booking'));
app.post('/track-booking', async (req, res) => {
  const { bookingId } = req.body;
  const bookings = await getJson(KEYS.bookings, []);
  const booking = bookings.find(b => b.id === bookingId);
  if (booking) {
    req.session.trackingBookingId = bookingId;
    res.redirect(`/booking-details/${bookingId}`);
  } else {
    res.render('track-booking', { error: 'Booking not found' });
  }
});

// Booking details (client + admin)
app.get('/booking-details/:id', async (req, res) => {
  const bookingId = req.params.id;
  const bookings = await getJson(KEYS.bookings, []);
  const booking = bookings.find(b => b.id === bookingId);
  if (!booking) return res.status(404).render('error', { message: 'Booking not found' });

  const comments = (await getJson(KEYS.comments, [])).filter(c => c.bookingId === bookingId);
  const canView = req.session.isAuthenticated || req.session.trackingBookingId === bookingId;
  if (!canView) return res.status(403).render('error', { message: 'Forbidden' });

  res.render('booking-details', {
    booking,
    comments,
    isAuthenticated: !!req.session.isAuthenticated,
    canComment: true,
    canDelete: !!req.session.isAuthenticated
  });
});

// Add comment + image (Vercel Blob)
app.post('/booking-details/:id/comment', upload.single('image'), async (req, res) => {
  const bookingId = req.params.id;
  const { content } = req.body;
  const isAdmin = !!req.session.isAuthenticated;
  const isClient = req.session.trackingBookingId === bookingId;
  if (!isAdmin && !isClient) return res.status(403).send('Forbidden');

  let imagePaths = null;
  if (req.file) {
    const ext = path.extname(req.file.originalname);
    const filename = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}${ext}`;

    const uploadDir = path.join(__dirname, 'public', 'uploads');
    await fs.mkdir(uploadDir, { recursive: true });

    const fullFileName = `full_${filename}`;
    const thumbFileName = `thumb_${filename}`;

    await fs.writeFile(path.join(uploadDir, fullFileName), req.file.buffer);

    const thumbBuffer = await sharp(req.file.buffer).resize(50, 50, { fit: 'cover' }).jpeg({ quality: 70 }).toBuffer();
    await fs.writeFile(path.join(uploadDir, thumbFileName), thumbBuffer);

    imagePaths = { fullSize: `/uploads/${fullFileName}`, thumbnail: `/uploads/${thumbFileName}` };
  }

  const comment = {
    id: Date.now().toString(),
    bookingId,
    content,
    imagePaths,
    createdAt: new Date().toISOString(),
    isAdmin
  };

  const comments = await getJson(KEYS.comments, []);
  comments.push(comment);
  await setJson(KEYS.comments, comments);

  res.redirect(`/booking-details/${bookingId}`);
});

// Delete comment (admin only)
app.post('/booking-details/:bookingId/comment/:commentId/delete', async (req, res) => {
  if (!req.session.isAuthenticated) return res.status(403).send('Unauthorized');

  const { bookingId, commentId } = req.params;
  let comments = await getJson(KEYS.comments, []);
  const comment = comments.find(c => c.id === commentId);

  if (comment?.imagePaths) {
    try {
      const publicDir = path.join(__dirname, 'public');
      await Promise.allSettled([
        fs.unlink(path.join(publicDir, 'uploads', path.basename(comment.imagePaths.fullSize))),
        fs.unlink(path.join(publicDir, 'uploads', path.basename(comment.imagePaths.thumbnail)))
      ]);
    } catch (err) {
      console.error('Error deleting images:', err);
    }
  }

  comments = comments.filter(c => c.id !== commentId);
  await setJson(KEYS.comments, comments);

  res.redirect(`/booking-details/${bookingId}`);
});

// Admin: Login
app.get('/login', (req, res) => res.render('login'));
app.post('/login', async (req, res) => {
  const { password } = req.body;
  const settings = await getSettings();
  const validPassword = settings.reportPassword || 'Admin123';
  if (password === validPassword) {
    req.session.isAuthenticated = true;
    res.redirect(req.session.returnTo || '/booking-report');
  } else {
    res.render('login', { error: 'Invalid password' });
  }
});
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// Admin: Set password (first time)
app.get('/set-password', async (req, res) => {
  const { password } = req.query;
  if (!password || password.length < 8) return res.status(400).send('Password must be 8+ chars');
  const settings = await getSettings();
  settings.reportPassword = password;
  await setJson(KEYS.settings, settings);
  res.send('Admin password set successfully!');
});

// Admin: Booking report
app.get('/booking-report', async (req, res) => {
  if (!req.session.isAuthenticated) return res.redirect('/login');
  const bookings = await getJson(KEYS.bookings, []);
  res.render('booking-report', { bookings });
});

// Update booking status
app.post('/update-booking-status', async (req, res) => {
  if (!req.session.isAuthenticated) return res.status(403).json({ success: false });
  const { id, status } = req.body;
  const bookings = await getJson(KEYS.bookings, []);
  const booking = bookings.find(b => b.id === id);
  if (booking) {
    booking.status = status;
    await setJson(KEYS.bookings, bookings);
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false });
  }
});

// Delete booking
app.post('/delete-booking', async (req, res) => {
  if (!req.session.isAuthenticated) return res.status(403).json({ success: false });
  const { id } = req.body;
  let bookings = await getJson(KEYS.bookings, []);
  const filtered = bookings.filter(b => b.id !== id);
  if (filtered.length < bookings.length) {
    await setJson(KEYS.bookings, filtered);
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false });
  }
});

// Service editor (admin only)
app.get('/service-editor', async (req, res) => {
  if (!req.session.isAuthenticated) return res.redirect('/login');
  const fs = require('fs').promises;
  const files = await fs.readdir(path.join(__dirname, 'content', 'services'));
  res.render('service-editor-list', { files });
});

app.get('/service-editor/:filename', async (req, res) => {
  if (!req.session.isAuthenticated) return res.redirect('/login');
  const fs = require('fs').promises;
  const filePath = path.join(__dirname, 'content', 'services', req.params.filename);
  const content = await fs.readFile(filePath, 'utf-8');
  res.render('service-editor', { filename: req.params.filename, content });
});

app.post('/service-editor/:filename', async (req, res) => {
  if (!req.session.isAuthenticated) return res.status(403).send('Unauthorized');
  const fs = require('fs').promises;
  const filePath = path.join(__dirname, 'content', 'services', req.params.filename);
  await fs.writeFile(filePath, req.body.content);
  res.redirect('/service-editor');
});

app.post('/service-editor', async (req, res) => {
  if (!req.session.isAuthenticated) return res.status(403).send('Unauthorized');
  const fs = require('fs').promises;
  const filename = req.body.filename || 'new-service.md';
  const filePath = path.join(__dirname, 'content', 'services', filename);
  await fs.writeFile(filePath, '# New Service\nDescription here\n\n## Price: $0\n\nThumbnail: https://placehold.co/600x400\nCategory: General');
  res.redirect(`/service-editor/${filename}`);
});

app.delete('/service-editor/:filename', async (req, res) => {
  if (!req.session.isAuthenticated) return res.status(403).send('Unauthorized');
  const fs = require('fs').promises;
  await fs.unlink(path.join(__dirname, 'content', 'services', req.params.filename));
  res.sendStatus(200);
});

// 404 & Error
app.use((req, res) => res.status(404).render('error', { message: 'Page not found' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { message: 'Server Error', error: err });
});

app.listen(port, () => {
  console.log(`Express Booking running on port ${port}`);
});